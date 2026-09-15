//! One-time move of Prism's data to the new bundle identifier.
//!
//! 2.0 renamed the app from `com.prism.app` to `com.rainacorp.prism`. Tauri
//! derives the app-data directory from the identifier, so without this every
//! upgrading user would open 2.0 to an empty queue, history, settings and
//! torrent session. The copy runs at the very top of `run()`, before the Tauri
//! builder: Tauri creates windows and plugins open their files before `setup`,
//! so the data has to already be in place by then.
//!
//! Rules: copy, never move, and never delete the old directory; it stays as a
//! fallback (a `MOVED_TO_…` note says where the data went). The copy lands in a
//! private staging directory and is renamed into place only once complete, so a
//! crash mid-copy leaves nothing half-migrated. A lock file keeps two launches
//! from migrating at the same time. A marker in the new directory makes every
//! later launch a no-op.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

pub const OLD_ID: &str = "com.prism.app";
pub const NEW_ID: &str = "com.rainacorp.prism";

const MARKER: &str = ".migrated";
/// A lock older than this belongs to a launch that died mid-copy.
const STALE_LOCK: Duration = Duration::from_secs(600);
/// Regenerated on the next playback; can be large.
const SKIP_FILES: &[&str] = &["mpv.log"];

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum Outcome {
    AlreadyDone,
    NothingToMigrate,
    InProgressElsewhere,
    Migrated { files: u64 },
    Failed { error: String },
}

static LAST_OUTCOME: std::sync::OnceLock<Outcome> = std::sync::OnceLock::new();

/// Migrate the platform data directory (and, on macOS, the logs directory).
pub fn run_once() -> Outcome {
    let Some(base) = dirs::data_dir() else {
        return remember(Outcome::Failed { error: "no platform data directory".into() });
    };
    let outcome = migrate_dir(&base.join(OLD_ID), &base.join(NEW_ID), env!("CARGO_PKG_VERSION"));

    // Logs are history, not state: best effort, never a reason to fail.
    #[cfg(target_os = "macos")]
    if matches!(outcome, Outcome::Migrated { .. }) {
        if let Some(logs) = dirs::home_dir().map(|h| h.join("Library/Logs")) {
            let (old, new) = (logs.join(OLD_ID), logs.join(NEW_ID));
            if old.is_dir() && !new.exists() {
                let _ = copy_tree(&old, &new);
            }
        }
    }
    remember(outcome)
}

fn remember(outcome: Outcome) -> Outcome {
    let _ = LAST_OUTCOME.set(outcome.clone());
    outcome
}

/// Log what the launch-time migration did. Called from `setup`, once logging
/// exists (migration runs before the logger is installed).
pub fn log_outcome() {
    match LAST_OUTCOME.get() {
        Some(Outcome::Migrated { files }) => {
            log::info!("migrated {files} files from {OLD_ID} to {NEW_ID}")
        }
        Some(Outcome::Failed { error }) => {
            log::error!("could not migrate data from {OLD_ID}: {error}; it is untouched and will be retried next launch")
        }
        Some(Outcome::InProgressElsewhere) => {
            log::warn!("another Prism launch was migrating data from {OLD_ID}")
        }
        _ => {}
    }
}

pub(crate) fn migrate_dir(old: &Path, new: &Path, app_version: &str) -> Outcome {
    if new.join(MARKER).exists() {
        return Outcome::AlreadyDone;
    }
    if !old.is_dir() {
        return Outcome::NothingToMigrate;
    }
    let (Some(parent), Some(name)) = (new.parent(), new.file_name().and_then(|n| n.to_str())) else {
        return Outcome::Failed { error: format!("unusable target {}", new.display()) };
    };
    if let Err(e) = fs::create_dir_all(parent) {
        return Outcome::Failed { error: format!("create {}: {e}", parent.display()) };
    }

    let lock = parent.join(format!("{name}.migrating.lock"));
    match acquire_lock(&lock) {
        Ok(true) => {}
        Ok(false) => return Outcome::InProgressElsewhere,
        Err(e) => return Outcome::Failed { error: format!("lock {}: {e}", lock.display()) },
    }
    let outcome = migrate_locked(old, new, parent, name, app_version);
    let _ = fs::remove_file(&lock);
    outcome
}

fn migrate_locked(old: &Path, new: &Path, parent: &Path, name: &str, app_version: &str) -> Outcome {
    // Re-check under the lock: another launch may have finished meanwhile.
    if new.join(MARKER).exists() {
        return Outcome::AlreadyDone;
    }

    // Staging left by a launch that crashed mid-copy is ours to discard.
    let partial_prefix = format!("{name}.partial-");
    if let Ok(entries) = fs::read_dir(parent) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&partial_prefix) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }

    let staging = parent.join(format!("{partial_prefix}{}", std::process::id()));
    let files = match copy_tree(old, &staging) {
        Ok(n) => n,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Outcome::Failed { error: format!("copy: {e}") };
        }
    };

    // A new directory without the marker came from a launch whose migration
    // failed and then ran with empty data. Keep it, out of the way.
    if new.exists() {
        let aside = parent.join(format!("{name}.pre-migration-{}", std::process::id()));
        if let Err(e) = fs::rename(new, &aside) {
            let _ = fs::remove_dir_all(&staging);
            return Outcome::Failed { error: format!("set aside {}: {e}", new.display()) };
        }
    }
    if let Err(e) = fs::rename(&staging, new) {
        let _ = fs::remove_dir_all(&staging);
        return Outcome::Failed { error: format!("rename into place: {e}") };
    }

    let marker = serde_json::json!({
        "from": OLD_ID,
        "appVersion": app_version,
        "at": chrono::Utc::now().to_rfc3339(),
        "files": files,
    });
    let _ = fs::write(new.join(MARKER), marker.to_string());
    let _ = fs::write(
        old.join(format!("MOVED_TO_{NEW_ID}.txt")),
        format!(
            "Prism {app_version} copied this folder to {}.\n\
             This copy is no longer used and was left in place as a backup.\n",
            new.display()
        ),
    );
    Outcome::Migrated { files }
}

/// Take the lock file; `Ok(false)` if a live launch holds it.
fn acquire_lock(lock: &Path) -> io::Result<bool> {
    for _ in 0..2 {
        match fs::OpenOptions::new().write(true).create_new(true).open(lock) {
            Ok(_) => return Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                let age = fs::metadata(lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .unwrap_or_default();
                if age < STALE_LOCK {
                    return Ok(false);
                }
                let _ = fs::remove_file(lock);
            }
            Err(e) => return Err(e),
        }
    }
    Ok(false)
}

/// Recursive copy that never follows symlinks (a planted link must not pull
/// files from elsewhere into app data) and keeps permissions — the managed
/// yt-dlp needs its exec bit, and its recorded SHA-256 must still match.
fn copy_tree(from: &Path, to: &Path) -> io::Result<u64> {
    fs::create_dir_all(to)?;
    let mut files = 0;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let name = entry.file_name();
        let target: PathBuf = to.join(&name);
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            files += copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            if SKIP_FILES.iter().any(|s| name == *s) {
                continue;
            }
            fs::copy(entry.path(), &target)?;
            files += 1;
        }
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh directory under the system temp dir, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let nanos = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos();
            let dir = std::env::temp_dir().join(format!("prism-migrate-{tag}-{}-{nanos}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed_old(base: &Path) -> PathBuf {
        let old = base.join(OLD_ID);
        fs::create_dir_all(old.join("torrent-session")).unwrap();
        fs::create_dir_all(old.join("engine")).unwrap();
        fs::write(old.join("settings.json"), r#"{"audioFormat":"opus"}"#).unwrap();
        fs::write(old.join("history.json"), "[]").unwrap();
        fs::write(old.join("torrent-session/session.json"), "{}").unwrap();
        fs::write(old.join("engine/yt-dlp"), b"#!/bin/sh\n").unwrap();
        fs::write(old.join("mpv.log"), "noise").unwrap();
        old
    }

    #[test]
    fn copies_everything_but_logs_and_marks_both_sides() {
        let tmp = TempDir::new("fresh");
        let old = seed_old(&tmp.0);
        let new = tmp.0.join(NEW_ID);

        assert_eq!(migrate_dir(&old, &new, "2.0.0"), Outcome::Migrated { files: 4 });
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), r#"{"audioFormat":"opus"}"#);
        assert!(new.join("torrent-session/session.json").exists());
        assert!(!new.join("mpv.log").exists());
        assert!(new.join(MARKER).exists());
        // The old directory is a backup, never removed.
        assert!(old.join("settings.json").exists());
        assert!(old.join(format!("MOVED_TO_{NEW_ID}.txt")).exists());
        // No staging or lock left behind.
        let leftovers: Vec<_> = fs::read_dir(&tmp.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".partial-") || n.ends_with(".lock"))
            .collect();
        assert!(leftovers.is_empty(), "leftovers: {leftovers:?}");
    }

    #[test]
    fn second_launch_is_a_no_op() {
        let tmp = TempDir::new("again");
        let old = seed_old(&tmp.0);
        let new = tmp.0.join(NEW_ID);
        migrate_dir(&old, &new, "2.0.0");
        fs::write(new.join("settings.json"), r#"{"audioFormat":"mp3"}"#).unwrap();

        assert_eq!(migrate_dir(&old, &new, "2.0.0"), Outcome::AlreadyDone);
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), r#"{"audioFormat":"mp3"}"#);
    }

    #[test]
    fn nothing_to_do_without_old_data() {
        let tmp = TempDir::new("none");
        let new = tmp.0.join(NEW_ID);
        assert_eq!(migrate_dir(&tmp.0.join(OLD_ID), &new, "2.0.0"), Outcome::NothingToMigrate);
        assert!(!new.exists());
    }

    #[test]
    fn crashed_staging_is_discarded_and_redone() {
        let tmp = TempDir::new("crashed");
        let old = seed_old(&tmp.0);
        let stale = tmp.0.join(format!("{NEW_ID}.partial-99999"));
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("settings.json"), "half").unwrap();
        let new = tmp.0.join(NEW_ID);

        assert_eq!(migrate_dir(&old, &new, "2.0.0"), Outcome::Migrated { files: 4 });
        assert!(!stale.exists());
        assert_eq!(fs::read_to_string(new.join("settings.json")).unwrap(), r#"{"audioFormat":"opus"}"#);
    }

    #[test]
    fn unmarked_new_directory_is_set_aside_not_deleted() {
        let tmp = TempDir::new("aside");
        let old = seed_old(&tmp.0);
        let new = tmp.0.join(NEW_ID);
        fs::create_dir_all(&new).unwrap();
        fs::write(new.join("settings.json"), "fresh-after-failure").unwrap();

        assert_eq!(migrate_dir(&old, &new, "2.0.0"), Outcome::Migrated { files: 4 });
        let aside = fs::read_dir(&tmp.0)
            .unwrap()
            .flatten()
            .find(|e| e.file_name().to_string_lossy().starts_with(&format!("{NEW_ID}.pre-migration-")))
            .expect("previous directory kept");
        assert_eq!(fs::read_to_string(aside.path().join("settings.json")).unwrap(), "fresh-after-failure");
    }

    #[test]
    fn live_lock_defers_to_the_other_launch() {
        let tmp = TempDir::new("locked");
        let old = seed_old(&tmp.0);
        fs::write(tmp.0.join(format!("{NEW_ID}.migrating.lock")), "").unwrap();
        assert_eq!(migrate_dir(&old, &tmp.0.join(NEW_ID), "2.0.0"), Outcome::InProgressElsewhere);
    }

    #[cfg(unix)]
    #[test]
    fn keeps_exec_bit_and_skips_symlinks() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = TempDir::new("perms");
        let old = seed_old(&tmp.0);
        fs::set_permissions(old.join("engine/yt-dlp"), fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("/etc/hosts", old.join("planted")).unwrap();
        let new = tmp.0.join(NEW_ID);

        migrate_dir(&old, &new, "2.0.0");
        let mode = fs::metadata(new.join("engine/yt-dlp")).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111);
        assert!(!new.join("planted").exists());
    }
}
