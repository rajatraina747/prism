//! Watch folders: drop a `.torrent` or a list of links into a folder and
//! Prism adds it.
//!
//! A folder the user configured is checked every few seconds. A `.torrent`
//! becomes a magnet through the same cache a drop uses; a text file is read
//! for http(s) and magnet links. Whatever is found is emitted as
//! `watch-folder-links`, which the frontend feeds into the ordinary add flow.
//!
//! A `.torrent` is added directly: the user configured this folder for them.
//! Links from a text file go through the same confirmation card as a link
//! from a browser. The natural folder to watch is Downloads, and a web page
//! can put a `.txt` there without asking; its links would otherwise join a
//! swarm or run yt-dlp with the browser's cookies, unconfirmed (REVIEW
//! 2026-09-23 S-1).
//!
//! Polling rather than filesystem events: network shares and external drives
//! report changes unreliably (or not at all), and a few seconds' delay costs
//! nothing here. Files are never deleted — a handled file is renamed to
//! `<name>.added`, a `.torrent` Prism couldn't read to `<name>.failed`, which
//! is also what stops it being added twice. A text file with no links in it
//! is someone's own file and is left exactly as it is.

use std::path::{Path, PathBuf};
use std::time::Duration;

use std::collections::HashSet;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// How often each folder is looked at.
const INTERVAL: Duration = Duration::from_secs(5);
/// Largest list of links read into memory (real ones are a few KB).
const MAX_LIST_BYTES: u64 = 1024 * 1024;
/// Text files scanned for links.
const LIST_EXTENSIONS: &[&str] = &["txt", "text", "csv", "list", "urls"];

const EVENT: &str = "watch-folder-links";

/// A link found in a watch folder, and whether the user must confirm it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchLink {
    pub url: String,
    /// From a text file, which anything can put in the folder.
    pub confirm: bool,
}

/// Text files already read and found to hold no links, by path, size and
/// modification time, so they are not re-read every pass and are read
/// again only if they change.
type Seen = HashSet<(PathBuf, u64, Option<SystemTime>)>;

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
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Seen::new()));
        loop {
            tokio::time::sleep(INTERVAL).await;
            let configured = folders(&app);
            if configured.is_empty() {
                continue;
            }
            let found = tauri::async_runtime::spawn_blocking({
                let (app, seen) = (app.clone(), seen.clone());
                move || {
                    let mut seen = seen.lock().unwrap_or_else(|p| p.into_inner());
                    sweep(&app, &configured, &mut seen)
                }
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

fn sweep(app: &AppHandle, configured: &[WatchFolder], seen: &mut Seen) -> Vec<WatchLink> {
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
        links.extend(scan(&dir, seen, &mut |name, bytes| {
            crate::store_torrent_bytes(app, name, bytes)
                .inspect_err(|e| log::warn!("watch folder: {e}"))
                .ok()
        }));
    }
    links
}

/// One pass over a folder. `to_magnet` caches a `.torrent`'s bytes and
/// returns its magnet (separated out so the sweep is testable on its own).
fn scan(dir: &Path, seen: &mut Seen, to_magnet: &mut dyn FnMut(&str, &[u8]) -> Option<String>) -> Vec<WatchLink> {
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
        if !kind.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let extension = path
            .extension()
            .map(|e| e.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        let metadata = entry.metadata().ok();
        let size = metadata.as_ref().map(|m| m.len()).unwrap_or(u64::MAX);

        if extension == "torrent" {
            match std::fs::read(&path).ok().and_then(|bytes| to_magnet(&name, &bytes)) {
                Some(magnet) => {
                    links.push(WatchLink { url: magnet, confirm: false });
                    mark(&path, "added");
                }
                // A .torrent is Prism's kind of file: mark it so it isn't retried forever.
                None => mark(&path, "failed"),
            }
        } else if LIST_EXTENSIONS.contains(&extension.as_str()) && size <= MAX_LIST_BYTES {
            let key = (path.clone(), size, metadata.and_then(|m| m.modified().ok()));
            if seen.contains(&key) {
                continue;
            }
            let found = std::fs::read_to_string(&path).map(|text| extract_links(&text)).unwrap_or_default();
            if found.is_empty() {
                // Someone's own notes, not a list for Prism: leave it alone.
                seen.insert(key);
                continue;
            }
            links.extend(found.into_iter().map(|url| WatchLink { url, confirm: true }));
            mark(&path, "added");
        }
        // Anything else is not ours: left alone.
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

/// http(s) and magnet links in a text file, in order, without duplicates.
fn extract_links(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    text.split_whitespace()
        .map(str::trim)
        .filter(|token| {
            let lower = token.to_ascii_lowercase();
            lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("magnet:?")
        })
        .filter(|token| seen.insert(token.to_string()))
        .map(str::to_string)
        .collect()
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
    fn reads_links_out_of_a_text_file() {
        let text = "https://example.com/a.mp4\n# a comment\nmagnet:?xt=urn:btih:abc\nnot-a-link\nhttps://example.com/a.mp4";
        assert_eq!(
            extract_links(text),
            vec!["https://example.com/a.mp4".to_string(), "magnet:?xt=urn:btih:abc".to_string()]
        );
        assert!(extract_links("nothing here").is_empty());
    }

    #[test]
    fn picks_up_torrents_and_lists_then_marks_them_handled() {
        let tmp = TempDir::new("sweep");
        std::fs::write(tmp.0.join("show.torrent"), b"valid").unwrap();
        std::fs::write(tmp.0.join("links.txt"), "https://example.com/clip.mp4\n").unwrap();
        std::fs::write(tmp.0.join("notes.md"), "left alone").unwrap();

        let mut seen = Seen::new();
        let mut found = scan(&tmp.0, &mut seen, &mut stub_magnet);
        found.sort_by(|a, b| a.url.cmp(&b.url));
        // Regression (REVIEW 2026-09-23 S-1): a text file's links need the
        // confirmation card; a .torrent the user dropped in does not.
        assert_eq!(
            found,
            vec![
                WatchLink { url: "https://example.com/clip.mp4".into(), confirm: true },
                WatchLink { url: "magnet:?xt=urn:btih:abc&dn=x".into(), confirm: false },
            ]
        );
        assert!(tmp.0.join("show.torrent.added").exists());
        assert!(tmp.0.join("links.txt.added").exists());
        // Files Prism doesn't handle are untouched.
        assert!(tmp.0.join("notes.md").exists());
        // A second pass finds nothing: handled files were renamed.
        assert!(scan(&tmp.0, &mut seen, &mut stub_magnet).is_empty());
    }

    #[test]
    fn a_file_it_cannot_read_is_marked_failed_not_retried_forever() {
        let tmp = TempDir::new("bad");
        std::fs::write(tmp.0.join("broken.torrent"), b"not a torrent").unwrap();
        std::fs::write(tmp.0.join("empty.txt"), "no links in here").unwrap();

        let mut seen = Seen::new();
        assert!(scan(&tmp.0, &mut seen, &mut stub_magnet).is_empty());
        assert!(tmp.0.join("broken.torrent.failed").exists());
        // Regression (REVIEW 2026-09-23 S-1): a text file with no links is
        // someone's own file, left exactly as it was.
        assert!(tmp.0.join("empty.txt").exists());
        assert!(!tmp.0.join("empty.txt.failed").exists());
        assert!(scan(&tmp.0, &mut seen, &mut stub_magnet).is_empty());
        assert!(seen.len() == 1, "remembered, so it isn't re-read every pass");

        // Read again once it changes.
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(tmp.0.join("empty.txt"), "now https://example.com/v.mp4 is in here").unwrap();
        assert_eq!(scan(&tmp.0, &mut seen, &mut stub_magnet).len(), 1);
    }

    #[test]
    fn folders_and_subfolders_are_not_descended_into() {
        let tmp = TempDir::new("nested");
        std::fs::create_dir_all(tmp.0.join("inner")).unwrap();
        std::fs::write(tmp.0.join("inner/deep.torrent"), b"valid").unwrap();
        assert!(scan(&tmp.0, &mut Seen::new(), &mut stub_magnet).is_empty());
        assert!(tmp.0.join("inner/deep.torrent").exists());
    }
}
