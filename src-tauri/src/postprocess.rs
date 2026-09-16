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
