//! What a link is: one video, or a list of them.
//!
//! The Dashboard used to guess from the URL (`/playlist`, `list=`) and then
//! ask yt-dlp one of two different questions. A guess that missed — a
//! channel (`/@name`), a SoundCloud set, a batch that skipped the guess
//! entirely — went to the single-video lookup, which on a list extracts every
//! entry in full and then fails to parse the result (REVIEW 2026-09-26).
//!
//! `inspect_url` asks once, with `-J --flat-playlist`: yt-dlp answers with a
//! single JSON document whose `_type` says which it is. A video comes back
//! with its formats, as before; a list comes back flat (titles and URLs, no
//! per-entry extraction), which is all the list dialog needs.

use serde::Serialize;
use tauri::AppHandle;

use crate::errors::{classify_output, ErrorCode, PrismError};
use crate::{MediaMetadata, PlaylistEntry, PlaylistInfo, YtDlpInfo, YtDlpPlaylistEntry};

/// A list can be long (a channel's whole catalogue, fetched page by page);
/// a single video answers in seconds.
const INSPECT_TIMEOUT_SECS: u64 = 300;

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Inspected {
    Video { metadata: MediaMetadata },
    Playlist { playlist: PlaylistInfo },
}

/// The URL to download one flat entry from. Recent yt-dlp gives a full URL;
/// otherwise the entry's page, or — for YouTube, which has always accepted it
/// — the watch URL rebuilt from the id. Never a YouTube URL for another
/// site's id: that used to turn every such entry into a broken link.
pub(crate) fn entry_url(entry: &YtDlpPlaylistEntry) -> Option<String> {
    let http = |u: &Option<String>| {
        u.as_deref()
            .map(str::trim)
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
            .map(str::to_string)
    };
    if let Some(url) = http(&entry.url).or_else(|| http(&entry.webpage_url)) {
        return Some(url);
    }
    let youtube = entry.ie_key.as_deref().is_some_and(|k| k.eq_ignore_ascii_case("youtube"));
    let id = entry.id.as_deref().or(entry.url.as_deref()).map(str::trim).filter(|id| !id.is_empty())?;
    (youtube && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .then(|| format!("https://www.youtube.com/watch?v={id}"))
}

/// One flat entry as the list dialog shows it; None when it has no URL.
pub(crate) fn playlist_entry(entry: YtDlpPlaylistEntry) -> Option<PlaylistEntry> {
    let url = entry_url(&entry)?;
    let thumbnail = entry
        .thumbnails
        .and_then(|ts| ts.into_iter().rev().find_map(|t| t.url))
        .unwrap_or_default();
    Some(PlaylistEntry {
        url,
        title: entry.title.unwrap_or_else(|| "Unknown".into()),
        duration: entry.duration.unwrap_or(0.0),
        thumbnail,
    })
}

/// Read yt-dlp's `-J --flat-playlist` document.
pub(crate) fn inspected_from_json(doc: serde_json::Value, url: &str, keep_container: bool) -> Result<Inspected, String> {
    let is_list = doc.get("_type").and_then(|t| t.as_str()) == Some("playlist") || doc.get("entries").is_some();
    if !is_list {
        let info: YtDlpInfo = serde_json::from_value(doc).map_err(|e| format!("Failed to parse yt-dlp output: {e}"))?;
        return Ok(Inspected::Video { metadata: crate::metadata_from_info(info, url, keep_container) });
    }
    let title = doc.get("title").and_then(|t| t.as_str()).map(str::to_string);
    let raw: Vec<serde_json::Value> = doc
        .get("entries")
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    // A channel's front page lists its tabs (Videos, Live, Shorts), each a
    // nested list with its own entries. The Videos tab is what someone
    // pasting a channel means; failing that, the first tab with anything in it.
    let nested: Vec<&serde_json::Value> = raw
        .iter()
        .filter(|e| e.get("_type").and_then(|t| t.as_str()) == Some("playlist") && e.get("entries").is_some())
        .collect();
    let entries: Vec<serde_json::Value> = if !nested.is_empty() && nested.len() == raw.len() {
        let has_entries = |e: &&serde_json::Value| e["entries"].as_array().is_some_and(|a| !a.is_empty());
        let tab = nested
            .iter()
            .copied()
            .find(|e| has_entries(e) && e["title"].as_str().is_some_and(|t| t.ends_with(" - Videos")))
            .or_else(|| nested.iter().copied().find(has_entries));
        tab.and_then(|t| t["entries"].as_array().cloned()).unwrap_or_default()
    } else {
        raw
    };

    let entries: Vec<PlaylistEntry> = entries
        .into_iter()
        .filter_map(|e| serde_json::from_value::<YtDlpPlaylistEntry>(e).ok())
        .filter_map(playlist_entry)
        .collect();
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| format!("Playlist ({} videos)", entries.len()));
    Ok(Inspected::Playlist { playlist: PlaylistInfo { title, entries } })
}

#[tauri::command]
pub async fn inspect_url(app: AppHandle, url: String) -> Result<Inspected, PrismError> {
    let mut args: Vec<String> = vec!["-J".into(), "--flat-playlist".into(), "--no-warnings".into()];
    args.extend(crate::lookup_network_args(&app));
    // Options terminator + URL last (arg-injection defense; see parse_url).
    args.push("--".into());
    args.push(url.clone());

    let cmd = crate::engine::ytdlp_command(&app).map_err(|e| PrismError::new(ErrorCode::EngineMissing, e))?;
    let (code, stdout, stderr) = crate::run_ytdlp_capture(cmd.args(&args), INSPECT_TIMEOUT_SECS).await?;
    if code != Some(0) {
        let stderr = String::from_utf8_lossy(&stderr);
        log::warn!("link lookup failed: {}", stderr.trim().lines().last().unwrap_or("no output"));
        return Err(classify_output(&stderr));
    }
    let doc: serde_json::Value = serde_json::from_slice(&stdout)
        .map_err(|e| PrismError::new(ErrorCode::Unknown, format!("Failed to parse yt-dlp output: {e}")))?;
    inspected_from_json(doc, &url, crate::keep_original_container(&app)).map_err(|e| PrismError::new(ErrorCode::Unknown, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(v: serde_json::Value) -> YtDlpPlaylistEntry {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn entry_urls_keep_their_own_site() {
        assert_eq!(
            entry_url(&entry(json!({"url": "https://vimeo.com/123", "ie_key": "Vimeo"}))).as_deref(),
            Some("https://vimeo.com/123")
        );
        assert_eq!(
            entry_url(&entry(json!({"url": "dQw4w9WgXcQ", "ie_key": "Youtube", "id": "dQw4w9WgXcQ"}))).as_deref(),
            Some("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
        );
        // Another site's bare id is not a YouTube video.
        assert_eq!(entry_url(&entry(json!({"url": "12345", "ie_key": "Dailymotion"}))), None);
        assert_eq!(
            entry_url(&entry(json!({"url": "12345", "ie_key": "Dailymotion", "webpage_url": "https://www.dailymotion.com/video/12345"}))).as_deref(),
            Some("https://www.dailymotion.com/video/12345")
        );
    }

    #[test]
    fn a_video_document_is_a_video() {
        let doc = json!({"title": "Clip", "id": "abc", "extractor_key": "Vimeo", "formats": [], "webpage_url": "https://vimeo.com/1"});
        match inspected_from_json(doc, "https://vimeo.com/1", false).unwrap() {
            Inspected::Video { metadata } => assert_eq!(metadata.title, "Clip"),
            other => panic!("expected a video, got {other:?}"),
        }
    }

    #[test]
    fn a_list_keeps_its_real_title() {
        let doc = json!({"_type": "playlist", "title": "Road trip songs", "entries": [
            {"_type": "url", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=a1", "title": "One", "duration": 60},
            {"_type": "url", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=b2", "title": "Two"}
        ]});
        match inspected_from_json(doc, "u", false).unwrap() {
            Inspected::Playlist { playlist } => {
                assert_eq!(playlist.title, "Road trip songs");
                assert_eq!(playlist.entries.len(), 2);
                assert_eq!(playlist.entries[0].duration, 60.0);
            }
            other => panic!("expected a playlist, got {other:?}"),
        }
    }

    // As yt-dlp 2026.08.19 answers for youtube.com/@YouTube.
    #[test]
    fn a_channel_front_page_means_its_videos_tab() {
        let doc = json!({"_type": "playlist", "title": "YouTube", "entries": [
            {"_type": "playlist", "title": "YouTube - Live", "entries": [
                {"_type": "url", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=live1", "title": "Live"}
            ]},
            {"_type": "playlist", "title": "YouTube - Videos", "entries": [
                {"_type": "url", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=v1", "title": "V1"},
                {"_type": "url", "ie_key": "Youtube", "url": "https://www.youtube.com/watch?v=v2", "title": "V2"}
            ]}
        ]});
        match inspected_from_json(doc, "u", false).unwrap() {
            Inspected::Playlist { playlist } => {
                assert_eq!(playlist.title, "YouTube");
                assert_eq!(playlist.entries.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(), ["V1", "V2"]);
            }
            other => panic!("expected a playlist, got {other:?}"),
        }
    }
}
