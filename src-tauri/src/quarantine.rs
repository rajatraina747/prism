//! Mark finished downloads as "came from the internet" so the OS applies its
//! normal checks when the user opens them outside Prism.
//!
//! Browsers set this automatically; a file written by yt-dlp or the torrent
//! engine carries no such flag, so a torrent-delivered executable would open
//! with no Gatekeeper/SmartScreen involvement at all. Media files are
//! unaffected by the flag in practice (players open them without a prompt).
//! Best-effort: a failure here never fails the download.

use std::path::Path;

/// Flag `path` (a file, or every file under a directory) as downloaded.
pub fn mark_downloaded(path: &str) {
    let p = Path::new(path);
    if !p.exists() {
        return;
    }
    #[cfg(target_os = "macos")]
    macos(p);
    #[cfg(target_os = "windows")]
    windows(p);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let _ = p;
}

/// `com.apple.quarantine` = `flags;timestamp-hex;agent;uuid`. 0x0083 is the
/// combination browsers write (download + user-initiated + Gatekeeper check
/// pending); `xattr -r` covers directories.
#[cfg(target_os = "macos")]
fn macos(p: &Path) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let value = format!("0083;{:x};Prism;", ts);
    let _ = std::process::Command::new("xattr")
        .args(["-r", "-w", "com.apple.quarantine", &value])
        .arg(p)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// Mark-of-the-Web: a `Zone.Identifier` alternate data stream with ZoneId=3
/// (Internet). SmartScreen and Explorer honour it on open.
#[cfg(target_os = "windows")]
fn windows(p: &Path) {
    fn mark_file(f: &Path) {
        let ads = format!("{}:Zone.Identifier", f.display());
        let _ = std::fs::write(ads, "[ZoneTransfer]\r\nZoneId=3\r\n");
    }
    fn walk(dir: &Path, depth: usize) {
        if depth > 16 {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let path = e.path();
                if path.is_dir() {
                    walk(&path, depth + 1);
                } else {
                    mark_file(&path);
                }
            }
        }
    }
    if p.is_dir() {
        walk(p, 0);
    } else {
        mark_file(p);
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn marks_a_file_with_quarantine_xattr() {
        let dir = std::env::temp_dir().join(format!("prism-quarantine-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("clip.mp4");
        std::fs::write(&f, b"x").unwrap();
        mark_downloaded(&f.to_string_lossy());
        let out = std::process::Command::new("xattr")
            .args(["-p", "com.apple.quarantine"])
            .arg(&f)
            .output()
            .unwrap();
        let v = String::from_utf8_lossy(&out.stdout);
        assert!(v.starts_with("0083;"), "unexpected xattr value: {v}");
        assert!(v.contains(";Prism;"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
