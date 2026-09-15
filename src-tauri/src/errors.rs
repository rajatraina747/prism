//! Structured errors for everything Prism reports to the UI.
//!
//! Engines fail with free text: yt-dlp's stderr, librqbit's messages. The UI
//! used to receive that text verbatim and pattern-match English phrases in
//! TypeScript to decide what to suggest. That leaked local paths into the
//! webview (S-12: `--cookies-from-browser` failures name the browser's cookie
//! database under the user's home) and scattered classification across layers.
//!
//! Now every failure crossing into the webview is a `PrismError`:
//! - a machine-readable `code`, which drives retry and the fix offered;
//! - a one-line `summary` safe to show;
//! - an optional `detail` (the engine's output, redacted and capped) for the
//!   tooltip and bug reports.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Network,
    Timeout,
    Auth,
    Geo,
    Unavailable,
    RateLimited,
    Forbidden,
    DiskFull,
    Permission,
    NotFound,
    Unsupported,
    Format,
    Checksum,
    EngineMissing,
    InvalidInput,
    Busy,
    Cancelled,
    Unknown,
}

impl ErrorCode {
    /// Whether retrying the same request unchanged can succeed.
    pub fn retryable(self) -> bool {
        matches!(
            self,
            ErrorCode::Network
                | ErrorCode::Timeout
                | ErrorCode::RateLimited
                | ErrorCode::Forbidden
                | ErrorCode::DiskFull
                | ErrorCode::Format
                | ErrorCode::Checksum
                | ErrorCode::Busy
                | ErrorCode::Unknown
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrismError {
    pub code: ErrorCode,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub retryable: bool,
}

impl PrismError {
    pub fn new(code: ErrorCode, summary: impl Into<String>) -> Self {
        PrismError { code, summary: redact(&summary.into()), detail: None, retryable: code.retryable() }
    }

    pub fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        let detail = cap_tail(&redact(detail.as_ref()), MAX_DETAIL);
        self.detail = (!detail.trim().is_empty()).then_some(detail);
        self
    }
}

impl std::fmt::Display for PrismError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.summary)
    }
}

impl From<String> for PrismError {
    fn from(message: String) -> Self {
        PrismError::new(ErrorCode::Unknown, message)
    }
}

impl From<&str> for PrismError {
    fn from(message: &str) -> Self {
        PrismError::new(ErrorCode::Unknown, message)
    }
}

/// Longest detail kept (the end of the output is where the cause is).
const MAX_DETAIL: usize = 4 * 1024;
/// Longest one-line summary.
const MAX_SUMMARY: usize = 200;

/// Classify a failed yt-dlp run from its output (stderr tail, or the last
/// `ERROR:` line). Pattern order matters: the first match wins.
pub fn classify_output(raw: &str) -> PrismError {
    let lower = raw.to_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| lower.contains(n));

    let code = if has(&[
        "sign in to confirm",
        "not a bot",
        "login required",
        "private video",
        "members-only",
        "age-restricted",
        "age restricted",
        "confirm your age",
        "cookies",
    ]) {
        ErrorCode::Auth
    } else if has(&["video unavailable", "has been removed", "account terminated", "no longer available", "http error 404"]) {
        ErrorCode::Unavailable
    } else if has(&["available in your country", "geo restrict", "georestrict"]) {
        ErrorCode::Geo
    } else if has(&["http error 429", "too many requests", "rate limit"]) {
        ErrorCode::RateLimited
    } else if has(&["http error 403", "forbidden"]) {
        ErrorCode::Forbidden
    } else if has(&["no space left", "disk full", "not enough space", "errno 28"]) {
        ErrorCode::DiskFull
    } else if has(&["permission denied", "access denied", "errno 13", "operation not permitted"]) {
        ErrorCode::Permission
    } else if has(&["requested format is not available", "codec", "merge", "remux", "postprocessing"]) {
        ErrorCode::Format
    } else if has(&["timed out", "timeout"]) {
        ErrorCode::Timeout
    } else if has(&["unable to download", "connection", "network", "name resolution", "dns", "ssl", "certificate"]) {
        ErrorCode::Network
    } else if has(&["unsupported url", "unable to extract", "no video formats found"]) {
        ErrorCode::Unsupported
    } else if has(&["not found"]) {
        ErrorCode::NotFound
    } else {
        ErrorCode::Unknown
    };

    let summary = concise_line(raw);
    let summary = if summary.is_empty() { "yt-dlp failed without an error message".to_string() } else { summary };
    PrismError::new(code, summary).with_detail(raw)
}

/// The one line of engine output worth showing: the last `ERROR:` line (else
/// the last line), minus the `yt-dlp error:`/`ERROR:` and `[extractor] id:`
/// prefixes, capped. Mirrors `conciseError` in src/services/errors.ts.
pub fn concise_line(raw: &str) -> String {
    static PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[[^\]]+\]\s*(?:[\w-]+:\s+)?").unwrap());
    let body = raw.trim();
    let lines: Vec<&str> = body.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let pick = lines
        .iter()
        .rev()
        .find(|l| l.to_ascii_uppercase().starts_with("ERROR:"))
        .or(lines.last())
        .copied()
        .unwrap_or(body);
    let pick = strip_prefix_ci(pick, "yt-dlp error:");
    let pick = strip_prefix_ci(pick, "ERROR:");
    let line = PREFIX.replace(pick.trim(), "").trim().to_string();
    cap_head(&redact(&line), MAX_SUMMARY)
}

fn strip_prefix_ci<'a>(s: &'a str, prefix: &str) -> &'a str {
    match s.get(..prefix.len()) {
        Some(head) if head.eq_ignore_ascii_case(prefix) => s[prefix.len()..].trim_start(),
        _ => s,
    }
}

/// Remove what must not leave Rust: the user's home path, browser profile
/// and cookie-store locations, and URL query strings (tokens, signatures).
pub fn redact(text: &str) -> String {
    static BROWSER_STORE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?i)[^\s'"]*(?:cookies(?:\.sqlite|\.binarycookies)?|login data|local state|key4\.db)[^\s'"]*"#).unwrap()
    });
    static QUERY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(https?://[^\s?#'"]+)\?[^\s'"]*"#).unwrap());

    let mut out = text.to_string();
    if let Some(home) = dirs::home_dir().map(|h| h.to_string_lossy().into_owned()) {
        if home.len() > 1 {
            out = out.replace(&home, "~");
        }
    }
    let out = BROWSER_STORE.replace_all(&out, "[browser profile]");
    QUERY.replace_all(&out, "$1?…").into_owned()
}

fn cap_head(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

fn cap_tail(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut start = s.len() - max_bytes;
    while !s.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &s[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(raw: &str) -> ErrorCode {
        classify_output(raw).code
    }

    #[test]
    fn classifies_the_common_yt_dlp_failures() {
        let cases: &[(&str, ErrorCode)] = &[
            ("ERROR: [youtube] abc: Sign in to confirm you're not a bot", ErrorCode::Auth),
            ("ERROR: [youtube] abc: Private video. Sign in if you've been granted access", ErrorCode::Auth),
            ("ERROR: [youtube] abc: Video unavailable. This video has been removed", ErrorCode::Unavailable),
            ("ERROR: The uploader has not made this video available in your country", ErrorCode::Geo),
            ("ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests", ErrorCode::RateLimited),
            ("ERROR: unable to download video data: HTTP Error 403: Forbidden", ErrorCode::Forbidden),
            ("ERROR: [Errno 28] No space left on device", ErrorCode::DiskFull),
            ("ERROR: unable to open for writing: [Errno 13] Permission denied", ErrorCode::Permission),
            ("ERROR: [youtube] abc: Requested format is not available", ErrorCode::Format),
            ("ERROR: Unable to download webpage: The read operation timed out", ErrorCode::Timeout),
            ("ERROR: Unable to download webpage: <urlopen error [Errno 8] nodename nor servname provided>", ErrorCode::Network),
            ("ERROR: Unsupported URL: https://example.com/page", ErrorCode::Unsupported),
            ("something odd happened", ErrorCode::Unknown),
        ];
        for (raw, want) in cases {
            assert_eq!(code_of(raw), *want, "{raw}");
        }
    }

    #[test]
    fn unknown_is_retryable_but_auth_is_not() {
        assert!(classify_output("weird").retryable);
        assert!(!classify_output("ERROR: Private video").retryable);
    }

    #[test]
    fn summary_is_the_last_error_line_without_prefixes() {
        let raw = "[youtube] abc: Downloading webpage\nWARNING: slow\nERROR: [youtube] abc: Video unavailable\n";
        assert_eq!(classify_output(raw).summary, "Video unavailable");
        assert_eq!(concise_line("yt-dlp error: ERROR: [generic] Unsupported URL: x"), "Unsupported URL: x");
    }

    #[test]
    fn cookie_stores_and_query_strings_never_leave_rust() {
        let raw = "ERROR: could not find chrome cookies database in \"/tmp/Profile 1/Cookies\"\n\
                   fetching https://cdn.example.com/v.mp4?sig=SECRET&expire=1";
        let err = classify_output(raw);
        let all = format!("{} {}", err.summary, err.detail.clone().unwrap_or_default());
        assert!(!all.contains("SECRET"), "{all}");
        assert!(!all.contains("/Cookies"), "{all}");
        assert!(all.contains("[browser profile]"), "{all}");
        assert!(all.contains("https://cdn.example.com/v.mp4?…"), "{all}");
    }

    #[test]
    fn home_directory_becomes_tilde() {
        if let Some(home) = dirs::home_dir() {
            let raw = format!("ERROR: unable to open {}/Movies/x.mp4", home.display());
            assert!(classify_output(&raw).summary.contains("~/Movies/x.mp4"));
        }
    }

    #[test]
    fn detail_keeps_the_tail_within_the_cap() {
        let raw = format!("{}ERROR: the end", "x".repeat(10_000));
        let detail = classify_output(&raw).detail.unwrap();
        assert!(detail.len() <= MAX_DETAIL + "…".len());
        assert!(detail.ends_with("ERROR: the end"));
    }

    #[test]
    fn serializes_for_the_webview() {
        let json = serde_json::to_value(PrismError::new(ErrorCode::RateLimited, "slow down")).unwrap();
        assert_eq!(json, serde_json::json!({"code": "rate_limited", "summary": "slow down", "retryable": true}));
    }
}
