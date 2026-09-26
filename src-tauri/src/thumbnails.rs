//! Thumbnails, kept on this machine.
//!
//! The Library showed each thumbnail straight from the site that served it.
//! Signed CDN links (Instagram, TikTok, …) expire within hours, so older rows
//! went blank; nothing showed offline; and with a proxy set nothing showed at
//! all, since the webview would have fetched them around the proxy (REVIEW
//! 2026-09-26 M6). Now each picture is fetched once, through the same client
//! (and proxy) as direct downloads, and kept in `app_data/thumbs/`, which the
//! page reads through Tauri's asset protocol — scoped to that folder alone.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// A thumbnail is tens of KB; anything past this isn't one.
const MAX_BYTES: u64 = 5 * 1024 * 1024;
/// Thumbnails kept; past this the oldest go.
const MAX_FILES: usize = 4000;
const PRUNE_TO: usize = 3000;

fn thumbs_dir(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_data_dir().ok()?.join("thumbs"))
}

/// The file name a thumbnail URL is kept under (without extension).
fn key_for(url: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(url.trim().as_bytes()).iter().take(16).map(|b| format!("{b:02x}")).collect()
}

/// The extension for an image content type; None for anything that isn't a
/// picture the webview shows.
fn extension_for(content_type: &str) -> Option<&'static str> {
    let ct = content_type.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    match ct.as_str() {
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// A thumbnail already kept for `key`, whatever its extension.
fn existing(dir: &Path, key: &str) -> Option<PathBuf> {
    ["jpg", "png", "webp", "gif", "avif"]
        .iter()
        .map(|ext| dir.join(format!("{key}.{ext}")))
        .find(|p| p.is_file())
}

/// Drop the oldest thumbnails once there are too many.
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    if files.len() <= MAX_FILES {
        return;
    }
    files.sort();
    for (_, path) in files.iter().take(files.len() - PRUNE_TO) {
        let _ = std::fs::remove_file(path);
    }
}

/// The local path of the thumbnail at `url`, fetching and keeping it the
/// first time.
#[tauri::command]
pub async fn cache_thumbnail(app: AppHandle, url: String) -> Result<String, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "Not a thumbnail URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Not a thumbnail URL".into());
    }
    let dir = thumbs_dir(&app).ok_or("Could not resolve the app data directory")?;
    let key = key_for(&url);
    if let Some(path) = existing(&dir, &key) {
        return Ok(path.to_string_lossy().into_owned());
    }

    let client = crate::http_engine::client_for(&app).map_err(|e| e.summary)?;
    let mut resp = client.get(parsed.as_str()).send().await.map_err(|e| format!("Thumbnail: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Thumbnail: HTTP {}", resp.status()));
    }
    let ext = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(extension_for)
        .ok_or("Thumbnail: not an image")?;
    if resp.content_length().is_some_and(|len| len > MAX_BYTES) {
        return Err("Thumbnail: too large".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Thumbnail: {e}"))? {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_BYTES {
            return Err("Thumbnail: too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }

    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| format!("Thumbnail: {e}"))?;
        let path = dir.join(format!("{key}.{ext}"));
        let tmp = dir.join(format!("{key}.part"));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("Thumbnail: {e}"))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("Thumbnail: {e}"))?;
        prune(&dir);
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("Thumbnail: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_pictures_are_kept() {
        assert_eq!(extension_for("image/jpeg"), Some("jpg"));
        assert_eq!(extension_for("image/webp; charset=binary"), Some("webp"));
        assert_eq!(extension_for("text/html"), None);
        assert_eq!(extension_for("image/svg+xml"), None, "an SVG can carry script");
    }

    #[test]
    fn a_url_always_maps_to_the_same_name() {
        assert_eq!(key_for("https://i.ytimg.com/vi/x/hq.jpg"), key_for(" https://i.ytimg.com/vi/x/hq.jpg "));
        assert_ne!(key_for("https://a/1.jpg"), key_for("https://a/2.jpg"));
        assert_eq!(key_for("https://a/1.jpg").len(), 32);
    }

    #[test]
    fn pruning_keeps_the_newest() {
        let dir = std::env::temp_dir().join(format!("prism-thumbs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for i in 0..(MAX_FILES + 1) {
            std::fs::write(dir.join(format!("{i}.jpg")), b"x").unwrap();
        }
        prune(&dir);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), PRUNE_TO);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
