//! Watch folders: drop a `.torrent` into a folder and Prism adds it.
//!
//! A folder the user configured is checked every few seconds. A `.torrent`
//! becomes a magnet through the same cache a drop uses, and is emitted as
//! `watch-folder-links`, which the frontend feeds into the ordinary add flow
//! through the same confirmation card as a link from a browser: the natural
//! folder to watch is Downloads, and a web page can put a `.torrent` there
//! without asking (REVIEW 2026-09-26 H2).
//!
//! Only `.torrent` files, as other clients do. Text files of links were read
//! too, and renamed once handled — so any note in a watched Downloads that
//! happened to hold a URL was renamed `.added` and its links offered for
//! download (REVIEW 2026-09-26). Lists of links still go in through the Add
//! sheet or a drop.
//!
//! Polling rather than filesystem events: network shares and external drives
//! report changes unreliably (or not at all), and a few seconds' delay costs
//! nothing here. Files are never deleted — a handled file is renamed to
//! `<name>.added`, one Prism couldn't read to `<name>.failed`, which is also
//! what stops it being added twice.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// How often each folder is looked at.
/// Ten seconds, not five: each pass lists the folder, and the natural one
/// to watch is a large Downloads (REVIEW 2026-09-26 L4).
const INTERVAL: Duration = Duration::from_secs(10);

const EVENT: &str = "watch-folder-links";

/// A link found in a watch folder, and whether the user must confirm it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLink {
    pub url: String,
    /// Anything can put a file in the folder, a web page included.
    pub confirm: bool,
}

/// One configured folder, as stored in settings.json.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WatchFolder {
    path: String,
    #[serde(default = "enabled_by_default")]
    enabled: bool,
}

fn enabled_by_default() -> bool {
    true
}

fn folders(app: &AppHandle) -> Vec<WatchFolder> {
    crate::read_setting(app, "watchFolders")
        .and_then(|value| serde_json::from_value::<Vec<WatchFolder>>(value).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|folder| folder.enabled && !folder.path.trim().is_empty())
        .collect()
}

/// Start watching in the background. Cheap when nothing is configured: a
/// settings read (cached) every few seconds.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(INTERVAL).await;
            let configured = folders(&app);
            if configured.is_empty() {
                continue;
            }
            let found = tauri::async_runtime::spawn_blocking({
                let app = app.clone();
                move || sweep(&app, &configured)
            })
            .await
            .unwrap_or_default();
            if !found.is_empty() {
                log::info!("watch folders: adding {} link(s)", found.len());
                let _ = app.emit(EVENT, found);
            }
        }
    });
}

fn sweep(app: &AppHandle, configured: &[WatchFolder]) -> Vec<WatchLink> {
    let allowed = crate::picked_dirs(app);
    let destinations: Vec<PathBuf> = crate::download_destinations(app)
        .into_iter()
        .map(|d| d.canonicalize().unwrap_or(d))
        .collect();
    let mut links = Vec::new();
    for folder in configured {
        // Same rules as opening a file: no system folders, no dotfiles.
        let dir = match crate::validate_open_path(&folder.path, true, &allowed) {
            Ok(dir) => PathBuf::from(dir),
            Err(e) => {
                log::warn!("watch folder {}: {e}", folder.path);
                continue;
            }
        };
        // Prism's own downloads land in a destination; watching one would
        // re-add every .torrent or link list it downloads.
        if destinations.iter().any(|d| d == &dir) {
            log::warn!("watch folder {}: it is also a download destination; not watched", dir.display());
            continue;
        }
        links.extend(scan(&dir, &mut |name, bytes| {
            crate::store_torrent_bytes(app, name, bytes)
                .inspect_err(|e| log::warn!("watch folder: {e}"))
                .ok()
        }));
    }
    links
}

/// One pass over a folder. `to_magnet` caches a `.torrent`'s bytes and
/// returns its magnet (separated out so the sweep is testable on its own).
fn scan(dir: &Path, to_magnet: &mut dyn FnMut(&str, &[u8]) -> Option<String>) -> Vec<WatchLink> {
    let mut links = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            log::warn!("watch folder {}: {e}", dir.display());
            return links;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        let is_torrent = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("torrent"));
        if !kind.is_file() || !is_torrent {
            // Anything else is not ours: left alone.
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // Size first: a page can drop a huge file named `.torrent` into a
        // watched Downloads, and reading it whole to find out it isn't one
        // would hold all of it in memory (L9).
        let small = entry.metadata().is_ok_and(|m| m.len() <= crate::MAX_TORRENT_FILE_BYTES);
        let bytes = if small { std::fs::read(&path).ok() } else { None };
        match bytes.and_then(|bytes| to_magnet(&name, &bytes)) {
            Some(magnet) => {
                links.push(WatchLink { url: magnet, confirm: true });
                mark(&path, "added");
            }
            // A .torrent is Prism's kind of file: mark it so it isn't retried forever.
            None => mark(&path, "failed"),
        }
    }
    links
}

/// Rename a handled file out of the way; it is never deleted.
fn mark(path: &Path, outcome: &str) {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{outcome}"));
    let target = PathBuf::from(name);
    if let Err(e) = std::fs::rename(path, &target) {
        log::warn!("watch folder: could not rename {} : {e}", path.display());
    }
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
            let dir = std::env::temp_dir().join(format!("prism-watch-{tag}-{}-{nanos}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn stub_magnet(_name: &str, bytes: &[u8]) -> Option<String> {
        (bytes == b"valid").then(|| "magnet:?xt=urn:btih:abc&dn=x".to_string())
    }

    #[test]
    fn picks_up_torrents_then_marks_them_handled() {
        let tmp = TempDir::new("sweep");
        std::fs::write(tmp.0.join("show.torrent"), b"valid").unwrap();
        std::fs::write(tmp.0.join("notes.md"), "left alone").unwrap();

        // Regression (REVIEW 2026-09-26 H2): a .torrent needs the
        // confirmation card — a browser can drop one into Downloads unasked.
        assert_eq!(
            scan(&tmp.0, &mut stub_magnet),
            vec![WatchLink { url: "magnet:?xt=urn:btih:abc&dn=x".into(), confirm: true }]
        );
        assert!(tmp.0.join("show.torrent.added").exists());
        assert!(tmp.0.join("notes.md").exists(), "files Prism doesn't handle are untouched");
        // A second pass finds nothing: handled files were renamed.
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
    }

    // Regression (REVIEW 2026-09-26): someone's notes in a watched Downloads
    // were renamed `.added` and their links offered for download.
    #[test]
    fn text_files_with_links_are_left_alone() {
        let tmp = TempDir::new("text");
        std::fs::write(tmp.0.join("links.txt"), "https://example.com/clip.mp4\n").unwrap();
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
        assert!(tmp.0.join("links.txt").exists());
        assert!(!tmp.0.join("links.txt.added").exists());
    }

    #[test]
    fn a_torrent_it_cannot_read_is_marked_failed_not_retried_forever() {
        let tmp = TempDir::new("bad");
        std::fs::write(tmp.0.join("broken.TORRENT"), b"not a torrent").unwrap();
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
        assert!(tmp.0.join("broken.TORRENT.failed").exists());
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
    }

    #[test]
    fn folders_and_subfolders_are_not_descended_into() {
        let tmp = TempDir::new("nested");
        std::fs::create_dir_all(tmp.0.join("inner")).unwrap();
        std::fs::write(tmp.0.join("inner/deep.torrent"), b"valid").unwrap();
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
        assert!(tmp.0.join("inner/deep.torrent").exists());
    }
}
