//! Downloads that finished, as the engines saw it, kept by Rust.
//!
//! The queue lives in the page and reaches `queue.json` only when the page
//! saves it. Twice that gap caused the worst bug Prism has had: a download
//! finished, the save never landed (a debounce that never fired in 1.8.x and
//! 2.0.0, or a quit right after completion), and on relaunch the item was
//! still queued, so it downloaded again (REVIEW 2026-09-23 B-1). Here every
//! successful completion is written down by Rust as it is emitted, in a folder
//! the page cannot write to, and the page marks those items completed at
//! launch before anything can start. Kept to the most recent entries; applying
//! them is idempotent, so nothing ever needs clearing.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::download_manager::DownloadComplete;

/// Enough for any batch that could finish between two page saves.
const MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    id: String,
    completed_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    output_folder: Option<String>,
}

fn journal_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ledger").join("finished-ids.json"))
}

fn lock() -> &'static Mutex<()> {
    static LOCK: Mutex<()> = Mutex::new(());
    &LOCK
}

fn read(path: &std::path::Path) -> Vec<Finished> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Append one entry, newest last, dropping the oldest past the cap.
pub(crate) fn append(entries: &mut Vec<Finished>, entry: Finished) {
    entries.retain(|e| e.id != entry.id);
    entries.push(entry);
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(..excess);
    }
}

fn record(app: &AppHandle, complete: &DownloadComplete) {
    let Some(path) = journal_file(app) else { return };
    let _guard = lock().lock().unwrap_or_else(|p| p.into_inner());
    let mut entries = read(&path);
    append(
        &mut entries,
        Finished {
            id: complete.id.clone(),
            completed_at: chrono::Utc::now().to_rfc3339(),
            file_path: complete.file_path.clone(),
            file_size: complete.file_size,
            output_folder: complete.output_folder.clone(),
        },
    );
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string(&entries) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Emit a completion to the page, writing it down first when it succeeded.
/// Every engine sends `download-complete-{id}` through here.
pub fn emit(app: &AppHandle, complete: DownloadComplete) {
    if complete.success {
        record(app, &complete);
    }
    // The queue (queue.rs) hears it first, then the page.
    crate::queue::on_complete(app, &complete);
    let _ = app.emit(&format!("download-complete-{}", complete.id), complete);
}

/// What finished recently, for the queue to apply as it loads (queue.rs).
pub(crate) fn entries(app: &AppHandle) -> Vec<serde_json::Value> {
    let Some(path) = journal_file(app) else { return Vec::new() };
    let _guard = lock().lock().unwrap_or_else(|p| p.into_inner());
    read(&path).into_iter().filter_map(|f| serde_json::to_value(f).ok()).collect()
}

/// What finished recently, for the page to apply at launch.
#[tauri::command]
pub async fn finished_downloads(app: AppHandle) -> Vec<Finished> {
    let Some(path) = journal_file(&app) else { return Vec::new() };
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock().lock().unwrap_or_else(|p| p.into_inner());
        read(&path)
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> Finished {
        Finished { id: id.into(), completed_at: String::new(), file_path: None, file_size: None, output_folder: None }
    }

    #[test]
    fn keeps_the_newest_entries_one_per_id() {
        let mut entries = Vec::new();
        for i in 0..(MAX_ENTRIES + 20) {
            append(&mut entries, entry(&format!("id-{i}")));
        }
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert_eq!(entries.first().unwrap().id, "id-20", "the oldest went first");

        // A repeat (a retried item finishing again) moves to the end, once.
        append(&mut entries, entry("id-100"));
        assert_eq!(entries.iter().filter(|e| e.id == "id-100").count(), 1);
        assert_eq!(entries.last().unwrap().id, "id-100");
    }
}
