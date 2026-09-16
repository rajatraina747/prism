//! A loopback HTTP server that hands the embedded player a torrent's file
//! while that file is still downloading ("Play now").
//!
//! mpv can seek in an HTTP source but not in a half-written file, and
//! librqbit's `FileStream` moves piece priorities to follow the read head — so
//! playing through this server is also what tells the swarm which pieces to
//! fetch next. Nothing else in Prism needs an HTTP server; this one exists for
//! that single job.
//!
//! The exposure is deliberately narrow, because a media server on loopback is
//! reachable by anything else running as this user:
//!   * it binds 127.0.0.1 on a port the OS picks, never a public interface;
//!   * every request must carry a token minted fresh for this launch, compared
//!     in constant time, so a guessed or stale URL is refused;
//!   * the `Host` header must be the loopback address it bound, which stops a
//!     DNS-rebound page from reaching it; and
//!   * no CORS header is ever sent, so a page in the webview cannot read a
//!     response even if it guessed the URL.
//!
//! It serves exactly one shape of thing: a byte range of a file of a torrent
//! that is currently active.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::OnceCell;
use tokio_util::io::ReaderStream;

use crate::torrent::TorrentManager;

/// Where the server is listening and the token it was started with. Both are
/// fixed for the life of the launch.
struct Endpoint {
    port: u16,
    token: String,
}

/// Managed state: the server is started the first time something asks for a
/// URL, so a session that never streams never opens a socket.
#[derive(Default)]
pub struct StreamServer {
    endpoint: OnceCell<Endpoint>,
}

struct ServerState {
    app: AppHandle,
    token: String,
    port: u16,
}

impl StreamServer {
    pub fn new() -> Self {
        Self::default()
    }

    /// The URL the player should open for one file of one torrent, starting
    /// the server if this is the first stream of the launch.
    pub async fn url_for(&self, app: &AppHandle, id: &str, file_idx: usize) -> Result<String, String> {
        let endpoint = self
            .endpoint
            .get_or_try_init(|| start(app.clone()))
            .await?;
        Ok(format!(
            "http://127.0.0.1:{}/s/{}/{}/{}",
            endpoint.port, endpoint.token, id, file_idx
        ))
    }
}

/// Bind loopback on an OS-chosen port and serve until the process exits.
async fn start(app: AppHandle) -> Result<Endpoint, String> {
    let token = mint_token()?;
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .map_err(|e| format!("Couldn't start the streaming server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Couldn't start the streaming server: {e}"))?
        .port();

    let state = Arc::new(ServerState { app, token: token.clone(), port });
    let router = Router::new()
        .route("/s/{token}/{id}/{idx}", get(serve))
        .with_state(state);

    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            log::warn!("streaming server stopped: {e}");
        }
    });

    log::info!("streaming server listening on 127.0.0.1:{port}");
    Ok(Endpoint { port, token })
}

/// 32 bytes from the OS, hex-encoded. Not derived from anything guessable:
/// the URL is the only thing standing between another local process and the
/// contents of an active torrent.
fn mint_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("Couldn't start the streaming server: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

async fn serve(
    State(state): State<Arc<ServerState>>,
    Path((token, id, idx)): Path<(String, String, usize)>,
    headers: HeaderMap,
) -> Response {
    if !constant_time_eq(&token, &state.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    // A request that didn't address us by the loopback address we bound isn't
    // ours to answer, whatever the DNS said.
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    if host != format!("127.0.0.1:{}", state.port) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let torrents = state.app.state::<TorrentManager>();
    let (tid, name, len) = match torrents.stream_target(&id, idx).await {
        Ok(target) => target,
        Err(e) => return (StatusCode::NOT_FOUND, e).into_response(),
    };
    let Some(api) = torrents.api().await else {
        return (StatusCode::SERVICE_UNAVAILABLE, "The torrent engine is not running").into_response();
    };

    let range = headers.get(header::RANGE).and_then(|h| h.to_str().ok());
    let (start, end) = match parse_range(range, len) {
        Some(r) => r,
        None => {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{len}"))],
            )
                .into_response()
        }
    };

    let mut stream = match api.api_stream(tid, idx).await {
        Ok(s) => s,
        Err(e) => return (StatusCode::NOT_FOUND, e.to_string()).into_response(),
    };
    if start > 0 {
        if let Err(e) = stream.seek(std::io::SeekFrom::Start(start)).await {
            return (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response();
        }
    }

    let count = end - start + 1;
    let body = Body::from_stream(ReaderStream::new(stream.take(count)));
    let mut response = Response::builder()
        .status(if range.is_some() { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK })
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, content_type(&name))
        .header(header::CONTENT_LENGTH, count.to_string());
    if range.is_some() {
        response = response.header(header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}"));
    }
    match response.body(body) {
        Ok(r) => r,
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// Compare without leaking where two tokens first differ.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The one byte range to send, inclusive. `None` means the request asked for
/// something outside the file. A missing or unparseable Range header is the
/// whole file, which is what a player asks for first.
///
/// Only a single range is honoured: multipart ranges buy nothing for playback
/// and every player Prism can open asks for one at a time.
fn parse_range(header: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let last = len.saturating_sub(1);
    let Some(spec) = header.and_then(|h| h.strip_prefix("bytes=")) else {
        return Some((0, last));
    };
    let spec = spec.split(',').next()?.trim();
    let (from, to) = spec.split_once('-')?;
    let (start, end) = match (from.trim(), to.trim()) {
        // "bytes=-500": the final 500 bytes.
        ("", suffix) => {
            let n: u64 = suffix.parse().ok()?;
            if n == 0 {
                return None;
            }
            (len.saturating_sub(n), last)
        }
        (from, "") => (from.parse().ok()?, last),
        (from, to) => (from.parse().ok()?, to.parse::<u64>().ok()?.min(last)),
    };
    if len == 0 || start > last || start > end {
        return None;
    }
    Some((start, end))
}

/// Extensions the embedded player will be offered a stream for. Deliberately
/// short: "Play now" on a .rar is a worse experience than no button at all.
const MEDIA_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "webm", "avi", "mov", "m4v", "mpg", "mpeg", "ts", "m2ts", "wmv", "flv", "ogv",
    "mp3", "m4a", "flac", "opus", "ogg", "wav", "aac",
];

pub fn is_media_file(name: &str) -> bool {
    extension(name).is_some_and(|ext| MEDIA_EXTENSIONS.contains(&ext.as_str()))
}

fn extension(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let (_, ext) = base.rsplit_once('.')?;
    if ext.is_empty() {
        return None;
    }
    Some(ext.to_ascii_lowercase())
}

/// Enough of a guess for a player to pick a demuxer; mpv sniffs the content
/// anyway, so an unknown extension is served as a generic stream.
fn content_type(name: &str) -> &'static str {
    match extension(name).as_deref() {
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("webm") => "video/webm",
        Some("avi") => "video/x-msvideo",
        Some("mov") => "video/quicktime",
        Some("ts") | Some("m2ts") | Some("mpg") | Some("mpeg") => "video/mp2t",
        Some("mp3") => "audio/mpeg",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("flac") => "audio/flac",
        Some("opus") | Some("ogg") | Some("ogv") => "audio/ogg",
        Some("wav") => "audio/wav",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_match_only_when_equal() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("", "a"));
    }

    #[test]
    fn a_minted_token_is_32_random_bytes_in_hex() {
        let a = mint_token().unwrap();
        let b = mint_token().unwrap();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two launches must not share a token");
    }

    #[test]
    fn no_range_header_is_the_whole_file() {
        assert_eq!(parse_range(None, 1000), Some((0, 999)));
        assert_eq!(parse_range(Some("bogus"), 1000), Some((0, 999)));
    }

    #[test]
    fn ranges_are_inclusive_and_clamped() {
        assert_eq!(parse_range(Some("bytes=0-99"), 1000), Some((0, 99)));
        assert_eq!(parse_range(Some("bytes=500-"), 1000), Some((500, 999)));
        // Players routinely ask past the end; clamp rather than refuse.
        assert_eq!(parse_range(Some("bytes=900-5000"), 1000), Some((900, 999)));
        assert_eq!(parse_range(Some("bytes=-200"), 1000), Some((800, 999)));
        // Only the first range of a multipart request is served.
        assert_eq!(parse_range(Some("bytes=0-99,200-299"), 1000), Some((0, 99)));
    }

    #[test]
    fn ranges_outside_the_file_are_refused() {
        assert_eq!(parse_range(Some("bytes=1000-"), 1000), None);
        assert_eq!(parse_range(Some("bytes=900-800"), 1000), None);
        assert_eq!(parse_range(Some("bytes=-0"), 1000), None);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), None);
    }

    #[test]
    fn only_media_files_are_offered_a_stream() {
        assert!(is_media_file("A Movie.mkv"));
        assert!(is_media_file("folder/track.FLAC"));
        assert!(!is_media_file("readme.txt"));
        assert!(!is_media_file("archive.rar"));
        assert!(!is_media_file("no-extension"));
    }

    #[test]
    fn content_types_cover_what_the_player_opens() {
        assert_eq!(content_type("a.mp4"), "video/mp4");
        assert_eq!(content_type("a.MKV"), "video/x-matroska");
        assert_eq!(content_type("a.bin"), "application/octet-stream");
    }
}
