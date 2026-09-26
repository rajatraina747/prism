//! Where every engine reports a finished run.
//!
//! Before 2.3 this also kept a journal of successful completions
//! (`ledger/finished-ids.json`): the queue lived in the page and reached disk
//! only when the page saved it, and a completion whose save never landed
//! downloaded again on the next launch (REVIEW 2026-09-23 B-1). The queue is
//! Rust's now (queue.rs), and it writes a completion to the database as it
//! happens, so the journal is no longer kept. One left by 2.2.x is read once,
//! at the first 2.3 launch, and then set aside (renamed, not deleted).

use std::path::PathBuf;

use tauri::{AppHandle, Emitter, Manager};

use crate::download_manager::DownloadComplete;

fn journal_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ledger").join("finished-ids.json"))
}

/// Report a finished run: to the queue first, then to the page.
pub fn emit(app: &AppHandle, complete: DownloadComplete) {
    crate::queue::on_complete(app, &complete);
    let _ = app.emit(&format!("download-complete-{}", complete.id), complete);
}

/// The journal 2.2.x kept, once: its entries, and the file renamed so it is
/// not applied again.
pub(crate) fn take_legacy_entries(app: &AppHandle) -> Vec<serde_json::Value> {
    let Some(path) = journal_file(app) else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let entries: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap_or_default();
    let _ = std::fs::rename(&path, path.with_file_name("finished-ids.applied.json"));
    entries
}
