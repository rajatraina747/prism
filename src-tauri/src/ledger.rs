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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

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

/// The one form paths are stored and looked up in.
///
/// On Windows `canonicalize` gives a verbatim `\\?\C:\…` path, while callers
/// hold `C:\…` (`validate_open_path` strips the prefix) or the page's own
/// strings, `/`-separated and in whatever case — and NTFS ignores case. Storing
/// the verbatim form meant no lookup ever matched, so Play, Open, Move to Trash,
/// Convert and the Missing badge all refused every download on Windows. Strip
/// the prefix, use `\`, lower-case. Elsewhere the path is already the key.
fn key(p: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(crate::canonical_string(p).replace('/', "\\").to_lowercase())
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

impl Ledger {
    /// Build the lookup set, rekeying entries as they load: a ledger saved
    /// before `key` existed holds verbatim `\\?\` paths on Windows.
    fn rebuild_index(&mut self) {
        let mut seen = HashSet::new();
        self.entries = std::mem::take(&mut self.entries)
            .into_iter()
            .map(|e| key(&e))
            .filter(|k| seen.insert(k.clone()))
            .collect();
        self.index = seen;
    }

    /// Record a finished download (canonicalised and keyed, so later checks
    /// compare like with like). Returns whether anything changed.
    pub(crate) fn record(&mut self, path: &Path) -> bool {
        // A verbatim `\\?\` path takes `/` literally, so a mixed one (a verbatim
        // destination + "/file") wouldn't resolve: drop the prefix first.
        let path = PathBuf::from(crate::canonical_string(path));
        let Ok(canonical) = path.canonicalize() else { return false };
        let canonical = key(&canonical);
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

    /// For each path, whether it was recorded and is no longer on disk.
    /// The record is checked first: only a path Prism wrote is ever looked for
    /// on disk, so the page can't make it touch `\\server\share` (on Windows
    /// that alone sends the user's login hash to the server — REVIEW
    /// 2026-09-28 S-3).
    pub(crate) fn missing(&self, paths: &[PathBuf]) -> Vec<bool> {
        paths.iter().map(|p| self.index.contains(&key(p)) && !p.exists()).collect()
    }

    /// Whether `canonical` is a recorded file, or inside a recorded folder.
    pub(crate) fn contains(&self, canonical: &Path) -> bool {
        key(canonical).ancestors().any(|p| self.index.contains(p))
    }

    /// The one-time seed, for Libraries from before the ledger existed: every
    /// file the Library's records point at. Only files, and only ones that
    /// are there — never a folder. `history.json` is a file the page can
    /// write, and a planted `"outputFolder": "~/Documents"` used to make the
    /// whole of Documents count as downloaded (REVIEW 2026-09-28 S-5). A
    /// multi-file torrent's folder is recorded file by file instead, from its
    /// own list.
    pub(crate) fn seed_from_history(&mut self, history_json: &str) {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Item {
            file_path: Option<String>,
            output_folder: Option<String>,
            files: Option<Vec<File>>,
        }
        #[derive(Deserialize)]
        struct File {
            name: Option<String>,
        }
        let is_plain_file = |p: &Path| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_file());
        let items: Vec<Item> = serde_json::from_str(history_json).unwrap_or_default();
        for item in items {
            if let Some(file) = item.file_path.as_deref().map(crate::expand_tilde) {
                if is_plain_file(Path::new(&file)) {
                    self.record(Path::new(&file));
                }
            }
            let (Some(folder), Some(files)) = (item.output_folder.as_deref().map(crate::expand_tilde), item.files) else {
                continue;
            };
            for name in files.iter().filter_map(|f| f.name.as_deref()) {
                let inside = Path::new(name);
                let stays_inside = inside.components().all(|c| matches!(c, std::path::Component::Normal(_)));
                let path = Path::new(&folder).join(inside);
                if stays_inside && is_plain_file(&path) {
                    self.record(&path);
                }
            }
        }
        self.seeded = true;
    }
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

/// A save is waiting to run (see `schedule_save`).
static SAVE_PENDING: AtomicBool = AtomicBool::new(false);
/// How long records gather before the file is rewritten.
const SAVE_DELAY: Duration = Duration::from_millis(750);

/// Rewrite the ledger soon rather than now. It holds up to 20,000 paths, and
/// saving on every record rewrote all of them per finished item — a 500-video
/// playlist rewrote it 500 times (REVIEW 2026-09-26 M3). Records arriving
/// within `SAVE_DELAY` share one save; `flush` writes anything pending at exit.
fn schedule_save(file: PathBuf) {
    if SAVE_PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(SAVE_DELAY);
        save_pending(&file);
    });
}

/// Save now if a save is waiting. Pending is cleared under the lock, before
/// serialising, so a record made during the write schedules another save.
fn save_pending(file: &Path) {
    let guard = store().lock().unwrap_or_else(|p| p.into_inner());
    if !SAVE_PENDING.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(ledger) = guard.as_ref() {
        save(file, ledger);
    }
}

/// Write any recorded-but-unsaved entries. Called on app exit.
pub fn flush(app: &AppHandle) {
    if let Some(file) = ledger_file(app) {
        save_pending(&file);
    }
}

/// Record what an engine finished. Call with the final path, after any move.
pub fn record(app: &AppHandle, path: &str) {
    let path = PathBuf::from(crate::expand_tilde(path));
    let changed = with_ledger(app, |ledger| ledger.record(&path)).unwrap_or(false);
    if changed {
        if let Some(file) = ledger_file(app) {
            schedule_save(file);
        }
    }
}

/// Of `paths`, which are recorded downloads that are no longer on disk.
/// Only recorded paths are ever reported missing, so the page can't use this
/// to ask whether some other file exists.
pub fn missing(app: &AppHandle, paths: &[String]) -> Vec<bool> {
    let expanded: Vec<PathBuf> = paths.iter().map(|p| PathBuf::from(crate::expand_tilde(p))).collect();
    with_ledger(app, |ledger| ledger.missing(&expanded)).unwrap_or_else(|| vec![false; paths.len()])
}

/// Whether Prism recorded `path` (or a folder holding it) as a finished
/// download. Such a path is never a cancelled download's leftovers.
pub fn is_finished_download(app: &AppHandle, path: &Path) -> bool {
    let canonical = path.canonicalize().map(|p| PathBuf::from(crate::canonical_string(&p))).unwrap_or_else(|_| path.to_path_buf());
    with_ledger(app, |ledger| ledger.contains(&canonical)).unwrap_or(false)
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
    fn only_recorded_paths_can_be_reported_missing() {
        let dir = tmp("missing");
        let kept = dir.join("kept.mp4");
        let gone = dir.join("gone.mp4");
        std::fs::write(&kept, b"x").unwrap();
        std::fs::write(&gone, b"x").unwrap();
        let mut ledger = Ledger::default();
        ledger.record(&kept);
        ledger.record(&gone);
        std::fs::remove_file(&gone).unwrap();
        let never = dir.join("never-downloaded.mp4");
        assert_eq!(ledger.missing(&[kept, gone, never]), [false, true, false], "an unrecorded path is never reported, present or not");
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

    // Regressions: REVIEW 2026-09-23 B-3 (a single-file torrent recorded the
    // shared destination as its path) and 2026-09-28 S-5 (a planted
    // outputFolder authorised a whole folder). The seed records files only.
    #[test]
    fn seeding_records_files_never_folders() {
        let dir = tmp("seed");
        let dest = dir.join("Downloads");
        std::fs::create_dir_all(dest.join("Pack/Extras")).unwrap();
        std::fs::write(dest.join("film.mkv"), b"x").unwrap();
        std::fs::write(dest.join("Pack/ep1.mkv"), b"x").unwrap();
        std::fs::write(dest.join("Pack/Extras/ep1.srt"), b"x").unwrap();
        std::fs::write(dest.join("mine.docx"), b"x").unwrap();
        // JSON-escaped: a Windows path's backslashes are escapes otherwise, the
        // history fails to parse, and nothing is seeded.
        let quoted = serde_json::to_string(&dest.to_string_lossy()).unwrap();
        let d = &quoted[1..quoted.len() - 1];
        let history = format!(
            r#"[
              {{"filePath":"{d}/film.mkv"}},
              {{"filePath":"{d}","outputFolder":"{d}","files":[{{}}]}},
              {{"outputFolder":"{d}/Pack","files":[{{"name":"ep1.mkv"}},{{"name":"Extras/ep1.srt"}},{{"name":"../mine.docx"}}]}},
              {{"outputFolder":"{d}","files":[{{}},{{}}]}}
            ]"#
        );
        let mut ledger = Ledger::default();
        ledger.seed_from_history(&history);
        assert!(ledger.seeded);
        assert!(ledger.contains(&dest.join("film.mkv")));
        assert!(ledger.contains(&dest.join("Pack/ep1.mkv")));
        assert!(ledger.contains(&dest.join("Pack/Extras/ep1.srt")));
        assert!(!ledger.contains(&dest.join("Pack")), "never a folder");
        assert!(!ledger.contains(&dest), "never the destination");
        assert!(!ledger.contains(&dest.join("mine.docx")), "a name can't climb out of its folder");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Regression (Windows test run 2026-09-26): entries were stored verbatim
    // (`\\?\C:\…`) and looked up in the caller's form, so nothing ever matched.
    #[test]
    fn lookups_match_the_form_each_caller_holds() {
        let dir = tmp("forms");
        let file = dir.join("Clip.mp4");
        std::fs::write(&file, b"x").unwrap();
        let mut ledger = Ledger::default();
        assert!(ledger.record(&file));
        // What `validate_open_path` hands `require_recorded`: prefix stripped.
        assert!(ledger.contains(Path::new(&crate::canonical_string(&file))), "Play / Open / Trash / Convert");
        // What the page sends `missing_files`: its own string — on Windows
        // possibly `/`-separated and in another case.
        std::fs::remove_file(&file).unwrap();
        let page = if cfg!(windows) {
            crate::canonical_string(&file).replace('\\', "/").to_uppercase()
        } else {
            file.to_string_lossy().into_owned()
        };
        assert_eq!(ledger.missing(&[PathBuf::from(page)]), [true], "the Missing badge");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ledger_saved_with_verbatim_paths_still_matches() {
        let dir = tmp("verbatim");
        let file = dir.join("a.mp4");
        std::fs::write(&file, b"x").unwrap();
        // How builds before `key` saved an entry: `canonicalize()` as is.
        let old = Ledger { entries: vec![file.canonicalize().unwrap()], seeded: true, index: HashSet::new() };
        let mut back: Ledger = serde_json::from_str(&serde_json::to_string(&old).unwrap()).unwrap();
        back.rebuild_index();
        assert!(back.contains(Path::new(&crate::canonical_string(&file))));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(windows)]
    #[test]
    fn unc_paths_key_the_same_with_or_without_the_verbatim_prefix() {
        assert_eq!(key(Path::new(r"\\?\UNC\nas\Media\Film.mkv")), key(Path::new(r"\\NAS\media/film.mkv")));
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
