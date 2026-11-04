//! What plays next, and what played recently.
//!
//! Playing a file queues the other audio and video in its folder, in the
//! order a person would read them ("Episode 2" before "Episode 10"), so
//! Next and Previous work and a season plays through. Only Rust builds that
//! list, from a file it has already validated, and only from that file's own
//! folder: the page never names what gets queued.
//!
//! Recent files are kept here too, in `player-recent.json` beside the app's
//! other data. Rust writes it; the page can only ask for it or clear it. A
//! path on the list may be played again later, even from outside the
//! download folders, because the user chose it the first time.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// How many files a folder playlist holds at most. A folder of 5,000 clips
/// shouldn't stall the player while mpv queues them.
const MAX_PLAYLIST: usize = 200;
/// How many recent files are remembered.
const MAX_RECENT: usize = 10;

/// Compare names the way people read them: runs of digits as numbers,
/// letters without regard to case.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(&ch) = it.peek() {
                        if !ch.is_ascii_digit() { break; }
                        s.push(ch);
                        it.next();
                    }
                    s
                };
                let (m, n) = (take(&mut x), take(&mut y));
                let (mt, nt) = (m.trim_start_matches('0'), n.trim_start_matches('0'));
                let by_value = mt.len().cmp(&nt.len()).then_with(|| mt.cmp(nt));
                if by_value != Ordering::Equal {
                    return by_value;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// Whether a file name reads like one episode of several, which is when the
/// player goes on to the next one by itself. In a mixed downloads folder it
/// waits for Next instead.
pub fn looks_like_episode(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    // S01E02, s1e2
    for i in 0..bytes.len() {
        if bytes[i] == b's' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() { j += 1; }
            if j + 1 < bytes.len() && bytes[j] == b'e' && bytes[j + 1].is_ascii_digit() {
                let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphabetic();
                if before_ok {
                    return true;
                }
            }
        }
    }
    lower.contains("episode") || lower.contains(" ep ") || lower.contains(".ep.")
}

/// The folder playlist for `current`: every playable file beside it, sorted
/// naturally, and where `current` sits in that list. `None` when it has no
/// playable neighbours (one file is not a playlist).
pub fn folder_playlist(current: &Path) -> Option<(Vec<PathBuf>, usize)> {
    let dir = current.parent()?;
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| crate::player::is_playable(p))
        // A dot file is a macOS resource fork (._Episode 1.mkv), not media.
        .filter(|p| !p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.')))
        .collect();
    if files.len() < 2 {
        return None;
    }
    files.sort_by(|a, b| {
        let name = |p: &PathBuf| p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        natural_cmp(&name(a), &name(b))
    });
    let at = files.iter().position(|p| p == current)?;
    // Keep a window around the current file rather than the first 200.
    if files.len() > MAX_PLAYLIST {
        let start = at.saturating_sub(MAX_PLAYLIST / 2).min(files.len() - MAX_PLAYLIST);
        let window: Vec<PathBuf> = files[start..start + MAX_PLAYLIST].to_vec();
        return Some((window, at - start));
    }
    Some((files, at))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub title: String,
    pub at: String,
}

fn recent_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("player-recent.json"))
}

pub fn read_recent_at(file: &Path) -> Vec<RecentFile> {
    std::fs::read_to_string(file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// The list with `path` moved to the front, deduplicated and capped.
pub fn with_recent(mut list: Vec<RecentFile>, path: &str, title: &str, at: &str) -> Vec<RecentFile> {
    list.retain(|r| r.path != path);
    list.insert(0, RecentFile { path: path.into(), title: title.into(), at: at.into() });
    list.truncate(MAX_RECENT);
    list
}

pub fn recent(app: &AppHandle) -> Vec<RecentFile> {
    recent_file(app).map(|f| read_recent_at(&f)).unwrap_or_default()
}

/// Remember a local file that just started playing.
pub fn record(app: &AppHandle, path: &str) {
    let Some(file) = recent_file(app) else { return };
    let title = Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let list = with_recent(read_recent_at(&file), path, &title, &chrono::Utc::now().to_rfc3339());
    if let Ok(text) = serde_json::to_vec_pretty(&list) {
        let tmp = file.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }
}

/// Whether `canonical` is on the recent list (so it may be played again).
pub fn is_recent(app: &AppHandle, canonical: &str) -> bool {
    recent(app).iter().any(|r| r.path == canonical)
}

/// Recently played files that still exist, newest first. Main window
/// (Library → Play a file).
#[tauri::command]
pub async fn recent_media(app: AppHandle) -> Vec<RecentFile> {
    tauri::async_runtime::spawn_blocking(move || {
        recent(&app).into_iter().filter(|r| Path::new(&r.path).is_file()).collect()
    })
    .await
    .unwrap_or_default()
}

/// Forget the recent files list.
#[tauri::command]
pub async fn clear_recent_media(app: AppHandle) -> Result<(), String> {
    if let Some(file) = recent_file(&app) {
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Couldn't clear recent files: {e}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_sort_the_way_people_read_them() {
        let mut v = vec!["Episode 10.mkv", "episode 2.mkv", "Episode 1.mkv", "Episode 02b.mkv"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["Episode 1.mkv", "episode 2.mkv", "Episode 02b.mkv", "Episode 10.mkv"]);
        assert_eq!(natural_cmp("S01E09", "S01E10"), Ordering::Less);
        assert_eq!(natural_cmp("a", "a"), Ordering::Equal);
    }

    #[test]
    fn episodes_are_recognised_and_ordinary_names_are_not() {
        for yes in ["Tulsa.King.S04E03.1080p.mkv", "show s1e2.mp4", "Episode 3.mkv", "Show - Ep 4 .mkv"] {
            assert!(looks_like_episode(yes), "{yes}");
        }
        for no in ["Video by foyege24.mp4", "Inside Rocket Lab's Neutron Factory.mp4", "season.mp4", "Mise en scene.mkv"] {
            assert!(!looks_like_episode(no), "{no}");
        }
    }

    #[test]
    fn a_folder_becomes_a_sorted_playlist_around_the_current_file() {
        let dir = std::env::temp_dir().join(format!("prism-queue-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("Extras")).unwrap();
        for n in ["Ep 10.mkv", "Ep 2.mkv", "Ep 1.mkv", "notes.txt", "._Ep 1.mkv", "cover.jpg"] {
            std::fs::write(dir.join(n), b"x").unwrap();
        }
        let current = dir.join("Ep 2.mkv");
        let (list, at) = folder_playlist(&current).unwrap();
        let names: Vec<_> = list.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["Ep 1.mkv", "Ep 2.mkv", "Ep 10.mkv"], "media only, no subfolders, no dot files");
        assert_eq!(at, 1);
        std::fs::remove_file(dir.join("Ep 1.mkv")).unwrap();
        std::fs::remove_file(dir.join("Ep 10.mkv")).unwrap();
        assert!(folder_playlist(&current).is_none(), "one file is not a playlist");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recent_files_are_newest_first_without_repeats_and_capped() {
        let mut list = Vec::new();
        for i in 0..12 {
            list = with_recent(list, &format!("/m/{i}.mkv"), &format!("{i}"), "t");
        }
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].path, "/m/11.mkv");
        list = with_recent(list, "/m/5.mkv", "5", "t2");
        assert_eq!(list[0].path, "/m/5.mkv");
        assert_eq!(list.iter().filter(|r| r.path == "/m/5.mkv").count(), 1);
    }
}
