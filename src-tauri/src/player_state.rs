//! Where you stopped watching, remembered between launches.
//!
//! The player window already observes `time-pos` and `duration`, and Rust
//! already knows what it last loaded — a path from `player_load`, a torrent
//! file from `player_load_stream` — so the UI only reports the number and
//! never gets to say *what* it is reporting about. That keeps the key for a
//! saved position out of reach of the window.
//!
//! State lives in `player-state.json` beside `settings.json`, capped at the
//! most recent `MAX_ENTRIES` items so it can't grow without bound.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

/// Positions kept. A few hundred is more than anyone revisits, and the file
/// stays small enough to rewrite whole on every save.
const MAX_ENTRIES: usize = 500;

/// Below this, there is nothing to resume — you had barely started.
const MIN_RESUME_SECS: f64 = 15.0;

/// Within this much of the end (or past `FINISHED_FRACTION`), you finished it:
/// resuming there would drop you at the credits.
const END_MARGIN_SECS: f64 = 60.0;
const FINISHED_FRACTION: f64 = 0.95;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Entry {
    pub key: String,
    pub position: f64,
    pub duration: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub at: String,
}

/// What the player window currently has open. Set by the load commands, read
/// by the save/resume commands.
#[derive(Debug, Clone)]
pub struct Current {
    pub key: String,
    pub title: Option<String>,
}

#[derive(Default)]
pub struct PlayerState {
    current: Mutex<Option<Current>>,
}

impl PlayerState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what was just loaded. Called by `player_load` (a path) and
    /// `player_load_stream` (a torrent's file).
    pub fn set_current(&self, key: String, title: Option<String>) {
        if let Ok(mut guard) = self.current.lock() {
            *guard = Some(Current { key, title });
        }
    }

    pub fn current(&self) -> Option<Current> {
        self.current.lock().ok().and_then(|g| g.clone())
    }
}

/// A file on disk is keyed by a hash of its path, not the path itself: the
/// state file is not a list of what has been watched in plain text.
pub fn key_for_path(path: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path.as_bytes());
    format!("file:{:x}", hasher.finalize())
}

/// A torrent's file is keyed by the torrent and the index within it, so it
/// resumes whether it is played as a stream or, once finished, from disk.
pub fn key_for_stream(torrent_id: &str, file_idx: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(torrent_id.as_bytes());
    format!("torrent:{:x}:{file_idx}", hasher.finalize())
}

fn state_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("player-state.json"))
}

pub fn read_entries(file: &Path) -> Vec<Entry> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str::<Vec<Entry>>(&raw).ok())
        .unwrap_or_default()
}

/// Whether a position is worth keeping. Saying "no" also *clears* any earlier
/// position for that item — finishing something should forget it, not leave
/// the next play offering to resume at the credits.
pub fn worth_remembering(position: f64, duration: f64) -> bool {
    if !position.is_finite() || !duration.is_finite() || position < MIN_RESUME_SECS {
        return false;
    }
    // Duration is unknown for a live or still-growing source; keep it anyway.
    if duration <= 0.0 {
        return true;
    }
    position < duration - END_MARGIN_SECS && position / duration < FINISHED_FRACTION
}

/// Write the entry to the front of the list, dropping any earlier entry for
/// the same key, and cap the file. `None` removes the key instead.
pub fn write_entry(file: &Path, key: &str, entry: Option<Entry>) -> std::io::Result<()> {
    let mut entries = read_entries(file);
    entries.retain(|e| e.key != key);
    if let Some(entry) = entry {
        entries.insert(0, entry);
    }
    entries.truncate(MAX_ENTRIES);

    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write beside the target and rename, so a crash mid-write can't leave a
    // truncated file that loses every remembered position.
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&entries)?)?;
    std::fs::rename(&tmp, file)
}

pub fn lookup(file: &Path, key: &str) -> Option<Entry> {
    read_entries(file).into_iter().find(|e| e.key == key)
}

/// Save (or clear) the position of whatever the player currently has open.
pub fn save_current(app: &AppHandle, position: f64, duration: f64) -> Result<(), String> {
    let Some(current) = app.state::<PlayerState>().current() else {
        return Ok(());
    };
    let Some(file) = state_file(app) else {
        return Ok(());
    };
    let entry = worth_remembering(position, duration).then(|| Entry {
        key: current.key.clone(),
        position,
        duration,
        title: current.title.clone(),
        at: chrono::Utc::now().to_rfc3339(),
    });
    write_entry(&file, &current.key, entry).map_err(|e| e.to_string())
}

/// The position to offer for what is open now, if there is one.
pub fn resume_current(app: &AppHandle) -> Option<f64> {
    let current = app.state::<PlayerState>().current()?;
    let file = state_file(app)?;
    lookup(&file, &current.key).map(|e| e.position)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, position: f64) -> Entry {
        Entry {
            key: key.into(),
            position,
            duration: 3600.0,
            title: None,
            at: "2026-09-16T00:00:00Z".into(),
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-player-state-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("player-state.json")
    }

    #[test]
    fn a_missing_file_reads_as_empty() {
        assert!(read_entries(Path::new("/nonexistent/player-state.json")).is_empty());
    }

    #[test]
    fn the_newest_entry_comes_first_and_replaces_its_earlier_self() {
        let file = temp_file("newest");
        let _ = std::fs::remove_file(&file);
        write_entry(&file, "a", Some(entry("a", 10.0))).unwrap();
        write_entry(&file, "b", Some(entry("b", 20.0))).unwrap();
        write_entry(&file, "a", Some(entry("a", 30.0))).unwrap();

        let entries = read_entries(&file);
        assert_eq!(entries.len(), 2, "the same key must not be stored twice");
        assert_eq!(entries[0].key, "a");
        assert_eq!(entries[0].position, 30.0);
        assert_eq!(lookup(&file, "a").unwrap().position, 30.0);
    }

    #[test]
    fn clearing_a_key_removes_only_that_key() {
        let file = temp_file("clear");
        let _ = std::fs::remove_file(&file);
        write_entry(&file, "a", Some(entry("a", 10.0))).unwrap();
        write_entry(&file, "b", Some(entry("b", 20.0))).unwrap();
        write_entry(&file, "a", None).unwrap();

        assert!(lookup(&file, "a").is_none());
        assert!(lookup(&file, "b").is_some());
    }

    #[test]
    fn the_file_is_capped_at_the_most_recent_entries() {
        let file = temp_file("cap");
        let _ = std::fs::remove_file(&file);
        for i in 0..MAX_ENTRIES + 20 {
            write_entry(&file, &format!("k{i}"), Some(entry(&format!("k{i}"), i as f64))).unwrap();
        }
        let entries = read_entries(&file);
        assert_eq!(entries.len(), MAX_ENTRIES);
        // The oldest keys fell off the end, the newest is still at the front.
        assert_eq!(entries[0].key, format!("k{}", MAX_ENTRIES + 19));
        assert!(lookup(&file, "k0").is_none());
    }

    #[test]
    fn barely_started_and_as_good_as_finished_are_not_remembered() {
        assert!(!worth_remembering(5.0, 3600.0), "barely started");
        assert!(worth_remembering(600.0, 3600.0), "halfway");
        assert!(!worth_remembering(3580.0, 3600.0), "inside the end margin");
        assert!(!worth_remembering(3500.0, 3600.0), "past the finished fraction");
        // A short clip: the end margin alone would rule out all of it.
        assert!(!worth_remembering(20.0, 30.0));
    }

    #[test]
    fn an_unknown_duration_is_still_remembered() {
        assert!(worth_remembering(120.0, 0.0));
        assert!(!worth_remembering(f64::NAN, 100.0));
        assert!(!worth_remembering(120.0, f64::INFINITY));
    }

    #[test]
    fn keys_identify_an_item_without_naming_it() {
        let key = key_for_path("/Users/someone/Movies/A Film.mkv");
        assert!(key.starts_with("file:"));
        assert!(!key.contains("A Film"), "the path must not be readable in the state file");
        assert_eq!(key, key_for_path("/Users/someone/Movies/A Film.mkv"));
        assert_ne!(key, key_for_path("/Users/someone/Movies/Another.mkv"));

        let stream = key_for_stream("abc123", 2);
        assert!(stream.starts_with("torrent:"));
        assert_eq!(stream, key_for_stream("abc123", 2));
        assert_ne!(stream, key_for_stream("abc123", 3));
    }
}
