//! The queue, the Library, statistics and subscriptions, in one SQLite
//! database (`app_data/prism.db`).
//!
//! They were JSON files the page rewrote whole: the Library was capped at
//! 2,000 entries so that rewrite stayed cheap (older downloads silently fell
//! off it), and a file damaged mid-write had to be recovered from a backup
//! copy. Here a finished download is one row inserted in a transaction, and
//! nothing is capped.
//!
//! The first open copies the JSON files in (and never deletes them: they stay
//! as a fallback, as `migrate.rs` treats the pre-2.0 data). Settings stay in
//! `settings.json`, which Rust reads key by key.
//!
//! Rows hold the page's JSON as written, so the shape of an item stays the
//! page's business; the database adds order (the queue), time (the Library)
//! and atomicity.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, completed_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS history_by_time ON history (completed_at DESC);
CREATE TABLE IF NOT EXISTS docs (name TEXT PRIMARY KEY, data TEXT NOT NULL);
";

/// Documents kept whole (small, and read and written as one).
const DOCS: [&str; 2] = ["subscriptions", "stats"];

/// What the page loads at start.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub queue: Vec<Value>,
    pub history: Vec<Value>,
    pub subscriptions: Option<Value>,
    pub stats: Option<Value>,
    /// The database couldn't be opened and was set aside (`prism.corrupt-…`);
    /// what loaded came from the JSON files instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
}

pub struct Store {
    conn: Mutex<Option<Connection>>,
    /// Set when opening had to set a damaged database aside.
    recovered_from: Mutex<Option<String>>,
}

impl Store {
    pub fn new() -> Self {
        Store { conn: Mutex::new(None), recovered_from: Mutex::new(None) }
    }
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| format!("No app data folder: {e}"))?.join("prism.db"))
}

/// Open (or create) the database at `path` and bring its schema up to date.
pub(crate) fn open_at(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // WAL: a crash mid-write leaves the last committed state, and reads don't
    // wait on writes. NORMAL is durable at every checkpoint, which is plenty
    // for a download list.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Open, and if the file is damaged, set it aside and start a new one.
fn open_or_recover(path: &Path) -> Result<(Connection, Option<String>), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create the data folder: {e}"))?;
    }
    match open_at(path) {
        Ok(conn) => Ok((conn, None)),
        Err(e) => {
            log::warn!("store: couldn't open {}: {e}; setting it aside", path.display());
            let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
            let aside = path.with_file_name(format!("prism.corrupt-{stamp}.db"));
            std::fs::rename(path, &aside).map_err(|e| format!("Couldn't set the damaged database aside: {e}"))?;
            for suffix in ["-wal", "-shm"] {
                let mut side = path.as_os_str().to_os_string();
                side.push(suffix);
                let _ = std::fs::remove_file(PathBuf::from(side));
            }
            let conn = open_at(path).map_err(|e| format!("Couldn't create the database: {e}"))?;
            Ok((conn, Some(aside.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())))
        }
    }
}

/// Run `f` on the open database, opening it (and importing the JSON files
/// once) the first time.
pub(crate) fn with_db<T>(app: &AppHandle, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
    let store = app.state::<Store>();
    let mut guard = store.conn.lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let path = db_path(app)?;
        let (mut conn, recovered) = open_or_recover(&path)?;
        let dir = path.parent().map(Path::to_path_buf).unwrap_or_default();
        import_json_once(&mut conn, &dir).map_err(|e| format!("Couldn't copy the saved data in: {e}"))?;
        if recovered.is_some() {
            *store.recovered_from.lock().unwrap_or_else(|p| p.into_inner()) = recovered;
        }
        *guard = Some(conn);
    }
    f(guard.as_mut().expect("opened above"))
}

/// A JSON file's contents, or its `.bak.json` copy (src/lib/json-store.ts)
/// when the file itself is missing or damaged.
fn read_json_file(dir: &Path, name: &str) -> Option<Value> {
    let parse = |file: PathBuf| std::fs::read(file).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    parse(dir.join(format!("{name}.json"))).or_else(|| parse(dir.join(format!("{name}.bak.json"))))
}

/// Copy the JSON files the page used to write into the database, once.
pub(crate) fn import_json_once(conn: &mut Connection, dir: &Path) -> rusqlite::Result<bool> {
    let done: Option<String> =
        conn.query_row("SELECT value FROM meta WHERE key = 'imported_json'", [], |r| r.get(0)).optional()?;
    if done.is_some() {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    if let Some(Value::Array(items)) = read_json_file(dir, "queue") {
        write_queue(&tx, &items)?;
    }
    if let Some(Value::Array(items)) = read_json_file(dir, "history") {
        put_history(&tx, &items)?;
    }
    for name in DOCS {
        if let Some(value) = read_json_file(dir, name) {
            tx.execute(
                "INSERT OR REPLACE INTO docs (name, data) VALUES (?1, ?2)",
                params![name, value.to_string()],
            )?;
        }
    }
    tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('imported_json', ?1)", params![chrono::Utc::now().to_rfc3339()])?;
    tx.commit()?;
    log::info!("store: copied the JSON data into prism.db (the files are kept)");
    Ok(true)
}

fn item_id(item: &Value) -> Option<&str> {
    item.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
}

fn write_queue(tx: &rusqlite::Transaction, items: &[Value]) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM queue", [])?;
    let mut insert = tx.prepare("INSERT OR REPLACE INTO queue (id, position, data) VALUES (?1, ?2, ?3)")?;
    for (position, item) in items.iter().enumerate() {
        if let Some(id) = item_id(item) {
            insert.execute(params![id, position as i64, item.to_string()])?;
        }
    }
    Ok(())
}

fn put_history(tx: &rusqlite::Transaction, items: &[Value]) -> rusqlite::Result<()> {
    let mut insert = tx.prepare("INSERT OR REPLACE INTO history (id, completed_at, data) VALUES (?1, ?2, ?3)")?;
    for item in items {
        if let Some(id) = item_id(item) {
            let at = item.get("completedAt").and_then(Value::as_str).unwrap_or("");
            insert.execute(params![id, at, item.to_string()])?;
        }
    }
    Ok(())
}

fn rows(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = conn.prepare(sql)?;
    let texts = stmt.query_map([], |r| r.get::<_, String>(0))?;
    Ok(texts.flatten().filter_map(|t| serde_json::from_str(&t).ok()).collect())
}

pub(crate) fn load_queue(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    rows(conn, "SELECT data FROM queue ORDER BY position")
}

fn load_history(conn: &Connection) -> rusqlite::Result<Vec<Value>> {
    rows(conn, "SELECT data FROM history ORDER BY completed_at DESC, rowid DESC")
}

fn load_doc(conn: &Connection, name: &str) -> rusqlite::Result<Option<Value>> {
    let text: Option<String> = conn.query_row("SELECT data FROM docs WHERE name = ?1", params![name], |r| r.get(0)).optional()?;
    Ok(text.and_then(|t| serde_json::from_str(&t).ok()))
}

/// The queue as saved, for Rust's own readers (the torrent session's prune).
pub(crate) fn queue_items(app: &AppHandle) -> Option<Vec<Value>> {
    with_db(app, |conn| load_queue(conn).map_err(|e| e.to_string())).ok()
}

fn sql_err(e: rusqlite::Error) -> String {
    format!("Database: {e}")
}

#[tauri::command]
pub async fn store_load(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut snapshot = with_db(&app, |conn| {
            Ok(Snapshot {
                queue: load_queue(conn).map_err(sql_err)?,
                history: load_history(conn).map_err(sql_err)?,
                subscriptions: load_doc(conn, "subscriptions").map_err(sql_err)?,
                stats: load_doc(conn, "stats").map_err(sql_err)?,
                recovered_from: None,
            })
        })?;
        snapshot.recovered_from = app.state::<Store>().recovered_from.lock().unwrap_or_else(|p| p.into_inner()).take();
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("Database: {e}"))?
}

#[tauri::command]
pub async fn store_save_queue(app: AppHandle, items: Vec<Value>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_db(&app, |conn| {
            let tx = conn.transaction().map_err(sql_err)?;
            write_queue(&tx, &items).map_err(sql_err)?;
            tx.commit().map_err(sql_err)
        })
    })
    .await
    .map_err(|e| format!("Database: {e}"))?
}

/// Add or replace Library entries, and remove others, in one transaction.
#[tauri::command]
pub async fn store_update_history(app: AppHandle, put: Vec<Value>, remove: Vec<String>, clear: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_db(&app, |conn| {
            let tx = conn.transaction().map_err(sql_err)?;
            if clear {
                tx.execute("DELETE FROM history", []).map_err(sql_err)?;
            }
            {
                let mut delete = tx.prepare("DELETE FROM history WHERE id = ?1").map_err(sql_err)?;
                for id in &remove {
                    delete.execute(params![id]).map_err(sql_err)?;
                }
            }
            put_history(&tx, &put).map_err(sql_err)?;
            tx.commit().map_err(sql_err)
        })
    })
    .await
    .map_err(|e| format!("Database: {e}"))?
}

#[tauri::command]
pub async fn store_save_doc(app: AppHandle, name: String, data: Value) -> Result<(), String> {
    if !DOCS.contains(&name.as_str()) {
        return Err(format!("Unknown document {name}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_db(&app, |conn| {
            conn.execute("INSERT OR REPLACE INTO docs (name, data) VALUES (?1, ?2)", params![name, data.to_string()])
                .map(|_| ())
                .map_err(sql_err)
        })
    })
    .await
    .map_err(|e| format!("Database: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-store-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_json_files_come_in_once_and_stay_on_disk() {
        let dir = tmp("import");
        std::fs::write(dir.join("queue.json"), json!([{"id": "b", "status": "queued"}, {"id": "a", "status": "paused"}]).to_string()).unwrap();
        // A damaged history.json: its backup copy is what comes in.
        std::fs::write(dir.join("history.json"), "[{broken").unwrap();
        std::fs::write(
            dir.join("history.bak.json"),
            json!([{"id": "h1", "completedAt": "2026-09-01T00:00:00Z"}, {"id": "h2", "completedAt": "2026-09-02T00:00:00Z"}]).to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("stats.json"), json!({"completed": 7}).to_string()).unwrap();

        let mut conn = open_at(&dir.join("prism.db")).unwrap();
        assert!(import_json_once(&mut conn, &dir).unwrap());
        assert!(!import_json_once(&mut conn, &dir).unwrap(), "only once");

        let queue = load_queue(&conn).unwrap();
        assert_eq!(queue.iter().map(|i| i["id"].as_str().unwrap()).collect::<Vec<_>>(), ["b", "a"], "order kept");
        let history = load_history(&conn).unwrap();
        assert_eq!(history.iter().map(|i| i["id"].as_str().unwrap()).collect::<Vec<_>>(), ["h2", "h1"], "newest first");
        assert_eq!(load_doc(&conn, "stats").unwrap(), Some(json!({"completed": 7})));
        assert!(dir.join("queue.json").exists(), "never deleted");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Regression (REVIEW 2026-09-26): the Library was capped at 2,000.
    #[test]
    fn the_library_has_no_cap() {
        let dir = tmp("nocap");
        let mut conn = open_at(&dir.join("prism.db")).unwrap();
        let items: Vec<Value> = (0..2500).map(|i| json!({"id": format!("h{i}"), "completedAt": format!("2026-01-01T00:00:{:02}Z", i % 60)})).collect();
        let tx = conn.transaction().unwrap();
        put_history(&tx, &items).unwrap();
        tx.commit().unwrap();
        assert_eq!(load_history(&conn).unwrap().len(), 2500);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_database_is_set_aside_not_lost() {
        let dir = tmp("corrupt");
        let path = dir.join("prism.db");
        std::fs::write(&path, b"this is not a database, just bytes that look like nothing at all").unwrap();
        let (conn, aside) = open_or_recover(&path).unwrap();
        let aside = aside.expect("set aside");
        assert!(aside.starts_with("prism.corrupt-"));
        assert!(dir.join(&aside).exists());
        assert!(load_queue(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
