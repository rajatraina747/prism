//! The files Prism downloaded, as recorded by the engines themselves.
//!
//! Open, Move to Trash, Convert, the content index and the player used to take
//! any path under an allowed root that the page named. That trusted the page's
//! own records (a single-file torrent once stored the whole download folder as
//! its path, and trashing it trashed everything: REVIEW 2026-09-23 B-3), and
//! let any code in the page act on any file in Home. Now those commands accept
//! only what an engine recorded here when it finished: a file, or the folder a
//! multi-file torrent owns (and anything inside it). A single-file torrent's
//! folder is the shared destination and is never recorded.
//!
//! Kept in `app_data/ledger/`, a folder the page cannot write to (its fs scope
//! is Prism's top-level JSON files only). The first launch with a ledger seeds
//! it once from the Library, so downloads from before it keep working.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Entries kept. The Library holds 2,000; torrents add folders, conversions
/// add files. Oldest go first.
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct Ledger {
    /// Canonical paths, oldest first.
    entries: Vec<PathBuf>,
    /// Whether the one-time seed from the Library has run.
    #[serde(default)]
    seeded: bool,
    #[serde(skip)]
    index: HashSet<PathBuf>,
}

impl Ledger {
    fn rebuild_index(&mut self) {
        self.index = self.entries.iter().cloned().collect();
    }

    /// Record a finished download (canonicalised, so later checks compare
    /// like with like). Returns whether anything changed.
    pub(crate) fn record(&mut self, path: &Path) -> bool {
        let Ok(canonical) = path.canonicalize() else { return false };
        if !self.index.insert(canonical.clone()) {
            return false;
        }
        self.entries.push(canonical);
        if self.entries.len() > MAX_ENTRIES {
            let excess = self.entries.len() - MAX_ENTRIES;
            for gone in self.entries.drain(..excess) {
                self.index.remove(&gone);
            }
        }
        true
    }

    /// Whether `canonical` is a recorded file, or inside a recorded folder.
    pub(crate) fn contains(&self, canonical: &Path) -> bool {
        canonical.ancestors().any(|p| self.index.contains(p))
    }

    /// The one-time seed: every path the Library's records point at. A torrent's
    /// output folder counts only when it had several files (then it owns the
    /// folder); otherwise it is the shared destination.
    pub(crate) fn seed_from_history(&mut self, history_json: &str) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Item {
            file_path: Option<String>,
            output_folder: Option<String>,
            files: Option<Vec<serde_json::Value>>,
            settings: Option<Settings>,
        }
        #[derive(Deserialize)]
        struct Settings {
            destination: Option<String>,
        }
        let items: Vec<Item> = serde_json::from_str(history_json).unwrap_or_default();
        for item in items {
            let destination = item.settings.and_then(|s| s.destination).map(|d| crate::expand_tilde(&d));
            let shared = |p: &str| destination.as_deref().is_some_and(|d| same_path(p, d));
            if let Some(file) = item.file_path.as_deref().map(crate::expand_tilde) {
                if !shared(&file) {
                    self.record(Path::new(&file));
                }
            }
            if item.files.as_ref().is_some_and(|f| f.len() > 1) {
                if let Some(folder) = item.output_folder.as_deref().map(crate::expand_tilde) {
                    if !shared(&folder) {
                        self.record(Path::new(&folder));
                    }
                }
            }
        }
        self.seeded = true;
    }
}

fn same_path(a: &str, b: &str) -> bool {
    a.trim_end_matches(['/', '\\']) == b.trim_end_matches(['/', '\\'])
}

// ── Process-wide store ──────────────────────────────────────────────────

fn store() -> &'static Mutex<Option<Ledger>> {
    static STORE: Mutex<Option<Ledger>> = Mutex::new(None);
    &STORE
}

fn ledger_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("ledger").join("finished.json"))
}

fn save(path: &Path, ledger: &Ledger) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let Ok(text) = serde_json::to_string(ledger) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// Run `f` on the loaded ledger (loading and, the first time, seeding it).
fn with_ledger<T>(app: &AppHandle, f: impl FnOnce(&mut Ledger) -> T) -> Option<T> {
    let path = ledger_file(app)?;
    let mut guard = store().lock().unwrap_or_else(|p| p.into_inner());
    if guard.is_none() {
        let mut loaded: Ledger = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        loaded.rebuild_index();
        if !loaded.seeded {
            let history = app
                .path()
                .app_data_dir()
                .ok()
                .and_then(|d| std::fs::read_to_string(d.join("history.json")).ok())
                .unwrap_or_default();
            loaded.seed_from_history(&history);
            save(&path, &loaded);
            log::info!("ledger: seeded {} path(s) from the Library", loaded.entries.len());
        }
        *guard = Some(loaded);
    }
    guard.as_mut().map(f)
}

/// Record what an engine finished. Call with the final path, after any move.
pub fn record(app: &AppHandle, path: &str) {
    let path = PathBuf::from(crate::expand_tilde(path));
    let file = ledger_file(app);
    with_ledger(app, |ledger| {
        if ledger.record(&path) {
            if let Some(file) = &file {
                save(file, ledger);
            }
        }
    });
}

/// Refuse a path no engine recorded. `validated` is `validate_open_path`'s
/// canonical result.
pub fn require_recorded(app: &AppHandle, validated: &str) -> Result<(), String> {
    let known = with_ledger(app, |ledger| ledger.contains(Path::new(validated))).unwrap_or(false);
    if known {
        Ok(())
    } else {
        Err("Prism only does this with files it downloaded. Use Show in Folder to find this one.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-ledger-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn a_recorded_file_or_anything_in_a_recorded_folder_is_known() {
        let dir = tmp("contains");
        std::fs::create_dir_all(dir.join("Pack/sub")).unwrap();
        std::fs::write(dir.join("clip.mp4"), b"x").unwrap();
        std::fs::write(dir.join("other.mp4"), b"x").unwrap();
        std::fs::write(dir.join("Pack/sub/ep1.mkv"), b"x").unwrap();
        let mut ledger = Ledger::default();
        assert!(ledger.record(&dir.join("clip.mp4")));
        assert!(!ledger.record(&dir.join("clip.mp4")), "recorded once");
        assert!(ledger.record(&dir.join("Pack")));

        assert!(ledger.contains(&dir.join("clip.mp4")));
        assert!(ledger.contains(&dir.join("Pack/sub/ep1.mkv")), "inside a torrent's own folder");
        assert!(!ledger.contains(&dir.join("other.mp4")), "never downloaded");
        assert!(!ledger.contains(&dir), "the folder downloads land in is not a download");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_that_does_not_exist_is_recorded() {
        let mut ledger = Ledger::default();
        assert!(!ledger.record(Path::new("/definitely/not/here.mp4")));
    }

    // Regression (REVIEW 2026-09-23 B-3): a single-file torrent recorded the
    // shared destination as its path; seeding must never trust that.
    #[test]
    fn seeding_skips_the_shared_destination() {
        let dir = tmp("seed");
        let dest = dir.join("Downloads");
        std::fs::create_dir_all(dest.join("Pack")).unwrap();
        std::fs::write(dest.join("film.mkv"), b"x").unwrap();
        let d = dest.to_string_lossy();
        let history = format!(
            r#"[
              {{"filePath":"{d}/film.mkv","settings":{{"destination":"{d}"}}}},
              {{"filePath":"{d}","outputFolder":"{d}","files":[{{}}],"settings":{{"destination":"{d}"}}}},
              {{"outputFolder":"{d}/Pack","files":[{{}},{{}}],"settings":{{"destination":"{d}"}}}},
              {{"outputFolder":"{d}","files":[{{}},{{}}],"settings":{{"destination":"{d}"}}}}
            ]"#
        );
        let mut ledger = Ledger::default();
        ledger.seed_from_history(&history);
        assert!(ledger.seeded);
        assert!(ledger.contains(&dest.join("film.mkv")));
        assert!(ledger.contains(&dest.join("Pack")));
        assert!(!ledger.contains(&dest), "the destination itself is never recorded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn it_survives_a_round_trip() {
        let dir = tmp("json");
        std::fs::write(dir.join("a.mp4"), b"x").unwrap();
        let mut ledger = Ledger::default();
        ledger.record(&dir.join("a.mp4"));
        ledger.seeded = true;
        let mut back: Ledger = serde_json::from_str(&serde_json::to_string(&ledger).unwrap()).unwrap();
        back.rebuild_index();
        assert!(back.seeded && back.contains(&dir.join("a.mp4")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
