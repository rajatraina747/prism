//! Moving finished downloads out of the download folder.
//!
//! "Move completed to" keeps the working folder tidy: a finished file — or a
//! torrent's own folder — is moved into a folder the user picked. The move
//! happens before completion is reported, so the Library records where the
//! file actually is.
//!
//! A rename is tried first. Across devices (an external drive, a NAS) it
//! fails, so the contents are copied and the original is removed only once
//! every byte has arrived. Nothing is ever overwritten: a clash becomes
//! `name (1)`. Any failure leaves the download exactly where it is — moving
//! it is a convenience, never a reason to spoil a finished download.

use std::io;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

/// Where finished downloads should go, when the user asked for that: the
/// setting is on, set, allowed (the same rules as a download folder) and the
/// folder exists or can be created.
fn target(app: &AppHandle) -> Option<PathBuf> {
    if !crate::setting_bool(app, "moveCompletedEnabled", false) {
        return None;
    }
    let raw = crate::read_setting(app, "moveCompletedTo")?
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.trim().is_empty())?;
    let validated = crate::validate_download_path(&raw, &crate::picked_dirs(app))
        .inspect_err(|e| log::warn!("move completed: {e}"))
        .ok()?;
    let dir = PathBuf::from(validated);
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("move completed: could not create {}: {e}", dir.display());
        return None;
    }
    Some(dir)
}

/// Move a finished file; `None` when nothing moved (not configured, already
/// there, or it failed — the caller keeps the path it had).
pub fn move_file(app: &AppHandle, path: &str) -> Option<String> {
    move_entry(app, Path::new(path))
}

/// Move a finished file that lives somewhere under `root` (its download
/// folder), keeping the subfolders a file name template made (`a/b/{title}`
/// moves to `<target>/a/b/`), then remove the folders it left empty — never
/// `root` itself. A file directly in `root`, or outside it, moves like
/// `move_file`.
pub fn move_file_from(app: &AppHandle, path: &str, root: &Path) -> Option<String> {
    let from = Path::new(path);
    let dir = target(app)?;
    let rel_dir = from.parent().and_then(|p| p.strip_prefix(root).ok()).filter(|r| !r.as_os_str().is_empty());
    let Some(rel_dir) = rel_dir else { return move_entry(app, from) };
    let dest_dir = dir.join(rel_dir);
    if let Err(e) = std::fs::create_dir_all(&dest_dir) {
        log::warn!("move completed: could not create {}: {e}", dest_dir.display());
        return None;
    }
    let to = unique(&dest_dir.join(from.file_name()?));
    match relocate(from, &to) {
        Ok(()) => {
            log::info!("moved {} to {}", from.display(), to.display());
            if let Some(old) = from.parent() {
                remove_empty_parents(old, root);
            }
            Some(to.to_string_lossy().into_owned())
        }
        Err(e) => {
            log::warn!("could not move {} to {}: {e}", from.display(), to.display());
            None
        }
    }
}

// ── Cleaning up what a download leaves behind ────────────────────────────

/// Attempts at removing a file the stopping transfer may still hold open.
const RELEASE_ATTEMPTS: u32 = 20;
const RELEASE_PAUSE: std::time::Duration = std::time::Duration::from_millis(250);

/// Delete what a cancelled download wrote. On Windows the transfer being
/// stopped can hold its files for a moment after the stop, so each removal
/// is retried for up to ~5 s. Blocking: call off the async workers.
pub fn remove_files(paths: &[PathBuf]) {
    for path in paths {
        for attempt in 0..RELEASE_ATTEMPTS {
            match std::fs::remove_file(path) {
                Ok(()) => break,
                Err(e) if e.kind() == io::ErrorKind::NotFound => break,
                Err(e) if attempt + 1 == RELEASE_ATTEMPTS => {
                    log::warn!("could not remove {}: {e}", path.display());
                }
                Err(_) => std::thread::sleep(RELEASE_PAUSE),
            }
        }
    }
}

/// Remove `dir` and every folder inside it that is empty, deepest first.
/// Files are never touched: a folder that still holds anything stays. An
/// empty folder the stopped engine still has open (librqbit, for a moment
/// after an abandoned add) is retried for up to ~5 s, as `remove_files` does.
/// Blocking: call off the async workers.
pub fn remove_empty_tree(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            remove_empty_tree(&entry.path());
        }
    }
    for _ in 0..RELEASE_ATTEMPTS {
        match std::fs::remove_dir(dir) {
            Ok(()) => return,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return,
            Err(_) => {
                let still_empty = std::fs::read_dir(dir).is_ok_and(|mut d| d.next().is_none());
                if !still_empty {
                    return;
                }
                std::thread::sleep(RELEASE_PAUSE);
            }
        }
    }
}

/// Walk up from `dir`, removing each folder while it is empty, and stop at
/// `root` (never removed) or at anything outside it.
pub fn remove_empty_parents(dir: &Path, root: &Path) {
    let mut current = dir.to_path_buf();
    while current != root && current.starts_with(root) && std::fs::remove_dir(&current).is_ok() {
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => break,
        }
    }
}

/// Move a finished torrent's own folder. Only call this once seeding has
/// ended: librqbit holds the files open until then.
pub fn move_folder(app: &AppHandle, dir: &str) -> Option<String> {
    move_entry(app, Path::new(dir))
}

fn move_entry(app: &AppHandle, from: &Path) -> Option<String> {
    let dir = target(app)?;
    if from.parent() == Some(dir.as_path()) || from == dir {
        return None; // already where it belongs
    }
    let to = unique(&dir.join(from.file_name()?));
    match relocate(from, &to) {
        Ok(()) => {
            log::info!("moved {} to {}", from.display(), to.display());
            Some(to.to_string_lossy().into_owned())
        }
        Err(e) => {
            log::warn!("could not move {} to {}: {e}", from.display(), to.display());
            None
        }
    }
}

/// `wanted`, or `name (1)`, `name (2)`… — never something that exists.
fn unique(wanted: &Path) -> PathBuf {
    if !wanted.exists() {
        return wanted.to_path_buf();
    }
    let parent = wanted.parent().unwrap_or(Path::new(""));
    let stem = wanted.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = wanted.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..10_000)
        .map(|n| parent.join(format!("{stem} ({n}){ext}")))
        .find(|candidate| !candidate.exists())
        .unwrap_or_else(|| wanted.to_path_buf())
}

/// Rename, or copy and then remove when the target is on another device.
fn relocate(from: &Path, to: &Path) -> io::Result<()> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    copy_tree(from, to)?;
    if from.is_dir() {
        std::fs::remove_dir_all(from)
    } else {
        std::fs::remove_file(from)
    }
}

/// Copy a file or a whole folder, checking each file's size afterwards.
/// Symlinks are skipped rather than followed.
fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    let kind = std::fs::symlink_metadata(from)?.file_type();
    if kind.is_symlink() {
        return Ok(());
    }
    if kind.is_file() {
        let copied = std::fs::copy(from, to)?;
        let expected = std::fs::metadata(from)?.len();
        if copied != expected {
            let _ = std::fs::remove_file(to);
            return Err(io::Error::other("the copy came out a different size"));
        }
        return Ok(());
    }
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("prism-move-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn renames_a_file_into_the_target() {
        let tmp = TempDir::new("file");
        let (from, to) = (tmp.0.join("clip.mp4"), tmp.0.join("done"));
        std::fs::create_dir_all(&to).unwrap();
        std::fs::write(&from, b"data").unwrap();

        relocate(&from, &to.join("clip.mp4")).unwrap();
        assert!(!from.exists());
        assert_eq!(std::fs::read(to.join("clip.mp4")).unwrap(), b"data");
    }

    #[test]
    fn copies_a_whole_folder_and_leaves_nothing_behind() {
        let tmp = TempDir::new("folder");
        let from = tmp.0.join("Season 1");
        std::fs::create_dir_all(from.join("extras")).unwrap();
        std::fs::write(from.join("ep1.mkv"), b"one").unwrap();
        std::fs::write(from.join("extras/notes.txt"), b"two").unwrap();
        let to = tmp.0.join("done/Season 1");
        std::fs::create_dir_all(to.parent().unwrap()).unwrap();

        copy_tree(&from, &to).unwrap();
        std::fs::remove_dir_all(&from).unwrap();
        assert_eq!(std::fs::read(to.join("ep1.mkv")).unwrap(), b"one");
        assert_eq!(std::fs::read(to.join("extras/notes.txt")).unwrap(), b"two");
        assert!(!from.exists());
    }

    #[test]
    fn never_overwrites_what_is_already_there() {
        let tmp = TempDir::new("clash");
        let wanted = tmp.0.join("movie.mkv");
        assert_eq!(unique(&wanted), wanted);
        std::fs::write(&wanted, b"first").unwrap();
        assert_eq!(unique(&wanted), tmp.0.join("movie (1).mkv"));
        std::fs::write(tmp.0.join("movie (1).mkv"), b"second").unwrap();
        assert_eq!(unique(&wanted), tmp.0.join("movie (2).mkv"));
    }

    // Windows test run 2026-09-26 (E2 with Move on): template folders were
    // flattened away at the target and left behind, empty, at the source.
    #[test]
    fn empty_folders_go_up_to_the_root_and_no_further() {
        let tmp = TempDir::new("parents");
        let root = tmp.0.join("Downloads");
        let deep = root.join("a/b/c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("a/keep.txt"), b"x").unwrap();
        remove_empty_parents(&deep, &root);
        assert!(!root.join("a/b").exists(), "c and b were empty");
        assert!(root.join("a").exists(), "a still holds a file");
        remove_empty_parents(&root, &root);
        assert!(root.exists(), "the download folder itself is never removed");
    }

    #[test]
    fn an_empty_tree_goes_but_anything_holding_a_file_stays() {
        let tmp = TempDir::new("tree");
        let own = tmp.0.join("Pack [01234567]");
        std::fs::create_dir_all(own.join("sub/deeper")).unwrap();
        std::fs::create_dir_all(own.join("kept")).unwrap();
        std::fs::write(own.join("kept/file.bin"), b"x").unwrap();
        remove_empty_tree(&own);
        assert!(!own.join("sub").exists());
        assert!(own.join("kept/file.bin").exists(), "files are never removed");
        std::fs::remove_file(own.join("kept/file.bin")).unwrap();
        remove_empty_tree(&own);
        assert!(!own.exists());
    }

    #[test]
    fn removing_files_tolerates_ones_already_gone() {
        let tmp = TempDir::new("remove");
        let there = tmp.0.join("clip.f137.mp4.part");
        std::fs::write(&there, b"x").unwrap();
        remove_files(&[there.clone(), tmp.0.join("never-existed.part")]);
        assert!(!there.exists());
    }

    #[test]
    fn a_symlink_is_skipped_not_followed() {
        let tmp = TempDir::new("symlink");
        let secret = tmp.0.join("secret.txt");
        std::fs::write(&secret, b"private").unwrap();
        let from = tmp.0.join("folder");
        std::fs::create_dir_all(&from).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, from.join("link.txt")).unwrap();
        std::fs::write(from.join("real.txt"), b"copied").unwrap();

        let to = tmp.0.join("done");
        copy_tree(&from, &to).unwrap();
        assert_eq!(std::fs::read(to.join("real.txt")).unwrap(), b"copied");
        assert!(!to.join("link.txt").exists(), "a planted symlink must not be copied");
    }
}
