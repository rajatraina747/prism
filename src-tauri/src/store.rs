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
    /// what loaded came from `prism.bak.db` or, failing that, the JSON files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_from: Option<String>,
    /// Where the recovered data came from: "backup" (`prism.bak.db`, as of the
    /// last launch) or "older-files" (the JSON files from before 2.3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovered_with: Option<String>,
}

/// A damaged database, set aside, and what replaced it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Recovery {
    /// The damaged file's new name (`prism.corrupt-….db`).
    pub kept_as: String,
    /// Restored from `prism.bak.db` rather than rebuilt from the JSON files.
    pub from_backup: bool,
}

pub struct Store {
    conn: Mutex<Option<Connection>>,
    /// Set when opening had to set a damaged database aside.
    recovered: Mutex<Option<Recovery>>,
}

impl Store {
    pub fn new() -> Self {
        Store { conn: Mutex::new(None), recovered: Mutex::new(None) }
    }
}

/// The copy kept beside the database, refreshed each launch it opens cleanly.
fn backup_path(path: &Path) -> PathBuf {
    path.with_file_name("prism.bak.db")
}

/// Refresh `prism.bak.db` from the open database: `VACUUM INTO` a temporary
/// file, then rename it over the old backup, so a crash never leaves a
/// half-written one. Like `settings.bak.json`, it is the fallback if the
/// database is ever damaged — before, a damaged database was rebuilt from the
/// pre-2.3 JSON files and the Library went back in time (Windows test run
/// 2026-09-26, G2).
pub(crate) fn refresh_backup(conn: &Connection, path: &Path) {
    let backup = backup_path(path);
    let tmp = backup.with_extension("db.tmp");
    let _ = std::fs::remove_file(&tmp);
    match conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy()]) {
        Ok(_) => {
            if let Err(e) = std::fs::rename(&tmp, &backup) {
                log::warn!("store: couldn't keep the backup: {e}");
            }
        }
        Err(e) => {
            log::warn!("store: couldn't write the backup: {e}");
            let _ = std::fs::remove_file(&tmp);
        }
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

/// Open, and if the file is damaged, set it aside and carry on from the
/// backup, or a new database when there is no usable backup.
fn open_or_recover(path: &Path) -> Result<(Connection, Option<Recovery>), String> {
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
            let kept_as = aside.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // The backup from the last clean launch, if it opens.
            let backup = backup_path(path);
            if backup.exists() && std::fs::copy(&backup, path).is_ok() {
                match open_at(path) {
                    Ok(conn) => {
                        log::info!("store: restored the database from {}", backup.display());
                        return Ok((conn, Some(Recovery { kept_as, from_backup: true })));
                    }
                    Err(e) => {
                        log::warn!("store: the backup is damaged too: {e}");
                        let _ = std::fs::remove_file(path);
                    }
                }
            }
            let conn = open_at(path).map_err(|e| format!("Couldn't create the database: {e}"))?;
            Ok((conn, Some(Recovery { kept_as, from_backup: false })))
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
        match recovered {
            // A clean open: this is the state worth falling back to. Copied
            // on a thread of its own, through its own read-only connection:
            // the first open happens during setup on the main thread, and the
            // copy grows with the Library, which has no cap (REVIEW
            // 2026-09-28 P-6). WAL lets it read while the app writes.
            None => {
                let path = path.clone();
                let _ = std::thread::Builder::new().name("prism-db-backup".into()).spawn(move || {
                    match Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) {
                        Ok(reader) => refresh_backup(&reader, &path),
                        Err(e) => log::warn!("store: couldn't open the database to back it up: {e}"),
                    }
                });
            }
            Some(r) => *store.recovered.lock().unwrap_or_else(|p| p.into_inner()) = Some(r),
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

/// What the queue manager saves: every row (after loading, or after a save
/// failed), or only what changed. Every save used to delete the table and
/// insert every item again — every two seconds while anything downloaded,
/// megabytes for a long playlist (REVIEW 2026-09-28 P-1).
pub(crate) enum QueueDelta {
    Full(Vec<Value>),
    Changes {
        /// (id, position, item)
        upsert: Vec<(String, i64, Value)>,
        remove: Vec<String>,
        /// Every (id, position), when the order moved or an item joined.
        positions: Option<Vec<(String, i64)>>,
    },
}

/// Save the queue (the queue manager's save).
pub(crate) fn save_queue_delta(app: &AppHandle, delta: &QueueDelta) -> Result<(), String> {
    with_db(app, |conn| {
        let tx = conn.transaction().map_err(sql_err)?;
        apply_queue_delta(&tx, delta).map_err(sql_err)?;
        tx.commit().map_err(sql_err)
    })
}

fn apply_queue_delta(tx: &rusqlite::Transaction, delta: &QueueDelta) -> rusqlite::Result<()> {
    match delta {
        QueueDelta::Full(items) => write_queue(tx, items),
        QueueDelta::Changes { upsert, remove, positions } => {
            let mut gone = tx.prepare("DELETE FROM queue WHERE id = ?1")?;
            for id in remove {
                gone.execute(params![id])?;
            }
            let mut put = tx.prepare("INSERT OR REPLACE INTO queue (id, position, data) VALUES (?1, ?2, ?3)")?;
            for (id, position, item) in upsert {
                put.execute(params![id, position, item.to_string()])?;
            }
            if let Some(positions) = positions {
                let mut place = tx.prepare("UPDATE queue SET position = ?2 WHERE id = ?1")?;
                for (id, position) in positions {
                    place.execute(params![id, position])?;
                }
            }
            Ok(())
        }
    }
}

/// Add finished items to the Library (the queue manager's archive).
pub(crate) fn add_history(app: &AppHandle, entries: &[Value]) -> Result<(), String> {
    with_db(app, |conn| {
        let tx = conn.transaction().map_err(sql_err)?;
        put_history(&tx, entries).map_err(sql_err)?;
        tx.commit().map_err(sql_err)
    })
}

/// Remove one Library entry.
pub(crate) fn remove_history(app: &AppHandle, id: &str) -> Result<(), String> {
    with_db(app, |conn| conn.execute("DELETE FROM history WHERE id = ?1", params![id]).map(|_| ()).map_err(sql_err))
}

/// The ids the Library holds.
pub(crate) fn history_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    with_db(app, |conn| {
        let mut stmt = conn.prepare("SELECT id FROM history").map_err(sql_err)?;
        let ids = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(sql_err)?;
        Ok(ids.flatten().collect())
    })
    .unwrap_or_default()
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
                recovered_with: None,
            })
        })?;
        if let Some(r) = app.state::<Store>().recovered.lock().unwrap_or_else(|p| p.into_inner()).take() {
            snapshot.recovered_with = Some(if r.from_backup { "backup" } else { "older-files" }.into());
            snapshot.recovered_from = Some(r.kept_as);
        }
        Ok(snapshot)
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

    // P-6: the startup backup now runs through a read-only connection.
    #[test]
    fn a_read_only_connection_can_write_the_backup() {
        let dir = tmp("robackup");
        let path = dir.join("prism.db");
        let conn = open_at(&path).unwrap();
        conn.execute("INSERT INTO queue (id, position, data) VALUES ('a', 0, '{}')", []).unwrap();
        let reader = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        refresh_backup(&reader, &path);
        let copy = Connection::open(backup_path(&path)).unwrap();
        let n: i64 = copy.query_row("SELECT COUNT(*) FROM queue", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // REVIEW 2026-09-28 P-1: saves write only what changed, and the queue
    // loads back the same, in the same order.
    #[test]
    fn a_saved_delta_loads_back_as_the_queue() {
        let dir = tmp("delta");
        let mut conn = open_at(&dir.join("prism.db")).unwrap();
        let apply = |conn: &mut Connection, delta: QueueDelta| {
            let tx = conn.transaction().unwrap();
            apply_queue_delta(&tx, &delta).unwrap();
            tx.commit().unwrap();
        };
        let ids = |conn: &Connection| load_queue(conn).unwrap().iter().map(|v| v["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        apply(&mut conn, QueueDelta::Full(vec![json!({"id": "a", "p": 0}), json!({"id": "b", "p": 0}), json!({"id": "c", "p": 0})]));
        // b progresses, a leaves, d joins at the end (every position rewritten).
        apply(&mut conn, QueueDelta::Changes {
            upsert: vec![("b".into(), 0, json!({"id": "b", "p": 50})), ("d".into(), 2, json!({"id": "d", "p": 0}))],
            remove: vec!["a".into()],
            positions: Some(vec![("b".into(), 0), ("c".into(), 1), ("d".into(), 2)]),
        });
        assert_eq!(ids(&conn), ["b", "c", "d"]);
        assert_eq!(load_queue(&conn).unwrap()[0]["p"], 50);
        // Progress alone: one row, order untouched.
        apply(&mut conn, QueueDelta::Changes { upsert: vec![("c".into(), 1, json!({"id": "c", "p": 9}))], remove: vec![], positions: None });
        assert_eq!(ids(&conn), ["b", "c", "d"]);
        assert_eq!(load_queue(&conn).unwrap()[1]["p"], 9);
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn the_queue_comes_back_in_the_order_it_was_saved() {
        let dir = tmp("order");
        let mut conn = open_at(&dir.join("prism.db")).unwrap();
        for order in [["x", "y", "z"], ["z", "x", "y"]] {
            let items: Vec<Value> = order.iter().map(|id| json!({"id": id})).collect();
            let tx = conn.transaction().unwrap();
            write_queue(&tx, &items).unwrap();
            tx.commit().unwrap();
            let ids: Vec<String> = load_queue(&conn).unwrap().iter().map(|i| i["id"].as_str().unwrap().to_string()).collect();
            assert_eq!(ids, order);
        }
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

    /// How long a very large Library takes to load:
    /// `cargo test --release --lib library_load_time -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn library_load_time() {
        let dir = tmp("loadtime");
        let mut conn = open_at(&dir.join("prism.db")).unwrap();
        let settings = json!({"format": {"id": "bestvideo[height=1080]+bestaudio/best", "label": "1080p · H.264", "resolution": "1080p"}, "destination": "~/Downloads/Prism", "filename": "A reasonably long video title for realism"});
        let items: Vec<Value> = (0..20_000)
            .map(|i| json!({"id": format!("h{i}"), "status": "completed", "completedAt": format!("2026-01-01T00:{:02}:{:02}Z", (i / 60) % 60, i % 60),
                "metadata": {"title": "A reasonably long video title for realism", "duration": 612.0, "thumbnail": "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg",
                "source": {"url": format!("https://www.youtube.com/watch?v=v{i:010}"), "domain": "youtube.com", "addedAt": "2026-01-01T00:00:00Z"}, "formats": [], "uploader": "Someone"},
                "settings": settings, "fileSize": 123456789, "filePath": format!("/Users/me/Downloads/Prism/A reasonably long video title {i}.mp4")}))
            .collect();
        let tx = conn.transaction().unwrap();
        put_history(&tx, &items).unwrap();
        tx.commit().unwrap();
        let started = std::time::Instant::now();
        let loaded = load_history(&conn).unwrap();
        let json = serde_json::to_string(&loaded).unwrap();
        println!("20,000 rows: loaded and serialised in {:?}, {} MB", started.elapsed(), json.len() / 1_000_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_damaged_database_is_set_aside_not_lost() {
        let dir = tmp("corrupt");
        let path = dir.join("prism.db");
        std::fs::write(&path, b"this is not a database, just bytes that look like nothing at all").unwrap();
        let (conn, recovery) = open_or_recover(&path).unwrap();
        let recovery = recovery.expect("set aside");
        assert!(recovery.kept_as.starts_with("prism.corrupt-"));
        assert!(dir.join(&recovery.kept_as).exists());
        assert!(!recovery.from_backup, "no backup to restore");
        assert!(load_queue(&conn).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Windows test run 2026-09-26, G2: a damaged database came back as the
    // pre-2.3 JSON files; the backup from the last clean launch comes first now.
    #[test]
    fn a_damaged_database_comes_back_from_the_backup() {
        let dir = tmp("restore");
        let path = dir.join("prism.db");
        {
            let conn = open_at(&path).unwrap();
            conn.execute(
                "INSERT OR REPLACE INTO docs (name, data) VALUES ('stats', ?1)",
                params![r#"{"downloads":7}"#],
            )
            .unwrap();
            refresh_backup(&conn, &path);
        }
        assert!(backup_path(&path).exists());
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(PathBuf::from(format!("{}{suffix}", path.display())));
        }
        std::fs::write(&path, b"damaged damaged damaged damaged damaged damaged damaged").unwrap();
        let (conn, recovery) = open_or_recover(&path).unwrap();
        assert!(recovery.expect("set aside").from_backup);
        assert_eq!(load_doc(&conn, "stats").unwrap(), Some(serde_json::json!({"downloads": 7})));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
