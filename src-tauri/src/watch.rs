//! Watch folders: drop a `.torrent` or a list of links into a folder and
//! Prism adds it.
//!
//! A folder the user configured is checked every few seconds. A `.torrent`
//! becomes a magnet through the same cache a drop uses; a text file is read
//! for http(s) and magnet links. Whatever is found is emitted as
//! `watch-folder-links`, which the frontend feeds into the ordinary add flow —
//! as an in-app add, not an external one: the user configured this folder, so
//! there is nothing to confirm.
//!
//! Polling rather than filesystem events: network shares and external drives
//! report changes unreliably (or not at all), and a few seconds' delay costs
//! nothing here. Files are never deleted — a handled file is renamed to
//! `<name>.added`, one Prism couldn't read to `<name>.failed`, which is also
//! what stops it being added twice.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// How often each folder is looked at.
const INTERVAL: Duration = Duration::from_secs(5);
/// Largest list of links read into memory (real ones are a few KB).
const MAX_LIST_BYTES: u64 = 1024 * 1024;
/// Text files scanned for links.
const LIST_EXTENSIONS: &[&str] = &["txt", "text", "csv", "list", "urls"];

const EVENT: &str = "watch-folder-links";

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

fn sweep(app: &AppHandle, configured: &[WatchFolder]) -> Vec<String> {
    let allowed = crate::picked_dirs(app);
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
fn scan(dir: &Path, to_magnet: &mut dyn FnMut(&str, &[u8]) -> Option<String>) -> Vec<String> {
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
        let size = entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX);

        let found = if extension == "torrent" {
            std::fs::read(&path).ok().and_then(|bytes| to_magnet(&name, &bytes)).map(|magnet| vec![magnet])
        } else if LIST_EXTENSIONS.contains(&extension.as_str()) && size <= MAX_LIST_BYTES {
            std::fs::read_to_string(&path).ok().map(|text| extract_links(&text))
        } else {
            continue; // not ours: left alone
        };

        match found {
            Some(mut found) if !found.is_empty() => {
                links.append(&mut found);
                mark(&path, "added");
            }
            // Read, but nothing usable in it: don't look at it again.
            _ => mark(&path, "failed"),
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

        let mut found = scan(&tmp.0, &mut stub_magnet);
        found.sort();
        assert_eq!(found, vec!["https://example.com/clip.mp4".to_string(), "magnet:?xt=urn:btih:abc&dn=x".to_string()]);
        assert!(tmp.0.join("show.torrent.added").exists());
        assert!(tmp.0.join("links.txt.added").exists());
        // Files Prism doesn't handle are untouched.
        assert!(tmp.0.join("notes.md").exists());
        // A second pass finds nothing: handled files were renamed.
        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
    }

    #[test]
    fn a_file_it_cannot_read_is_marked_failed_not_retried_forever() {
        let tmp = TempDir::new("bad");
        std::fs::write(tmp.0.join("broken.torrent"), b"not a torrent").unwrap();
        std::fs::write(tmp.0.join("empty.txt"), "no links in here").unwrap();

        assert!(scan(&tmp.0, &mut stub_magnet).is_empty());
        assert!(tmp.0.join("broken.torrent.failed").exists());
        assert!(tmp.0.join("empty.txt.failed").exists());
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
