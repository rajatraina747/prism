//! yt-dlp engine management.
//!
//! The bundled sidecar goes stale as sites change extraction; this module lets
//! the app fetch the latest official yt-dlp release into app-data and prefer it
//! over the bundled copy, decoupling "site broke" from "wait for a Prism release".
//! It also checks, at most daily, whether a newer release exists, so the UI can
//! nudge before a site breaks rather than after.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::augmented_path;
use crate::spawn::CommandSpec;

#[cfg(target_os = "windows")]
const YTDLP_NAME: &str = "yt-dlp.exe";
#[cfg(not(target_os = "windows"))]
const YTDLP_NAME: &str = "yt-dlp";

/// The release asset for this platform.
#[cfg(target_os = "macos")]
const RELEASE_ASSET: &str = "yt-dlp_macos";
#[cfg(target_os = "windows")]
const RELEASE_ASSET: &str = "yt-dlp.exe";
#[cfg(target_os = "linux")]
const RELEASE_ASSET: &str = "yt-dlp";

/// Redirects to `/releases/tag/<latest>`; the redirect itself names the tag,
/// so no API call (and no API rate limit) is needed.
const LATEST_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest";

/// The yt-dlp version scripts/sidecars.lock pins, i.e. the bundled sidecar.
const BUNDLED_VERSION: &str = env!("PRISM_BUNDLED_YTDLP_VERSION");

/// yt-dlp's one-file builds are ~35 MB; anything past this is not a yt-dlp
/// release and must not be buffered into memory.
const MAX_BINARY_BYTES: u64 = 200 * 1024 * 1024;
/// The checksum manifest is a few KB.
const MAX_SUMS_BYTES: u64 = 1024 * 1024;
/// Time to first byte, and total time for one request (body included).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// The latest-release lookup is one redirect; it never needs long.
const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a latest-release lookup is reused before asking GitHub again.
const FRESHNESS_TTL: Duration = Duration::from_secs(24 * 60 * 60);
/// `--version` on a healthy binary returns in well under a second; a hang
/// here used to leave the Settings page's engine row stuck forever.
const VERSION_TIMEOUT_SECS: u64 = 20;

/// Look up the expected SHA-256 for `asset` in the release's SHA2-256SUMS
/// manifest (lines of `<hex>  <filename>`).
fn expected_sha256(sums: &str, asset: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        (name == asset).then(|| hash.to_ascii_lowercase())
    })
}

fn managed_ytdlp_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    Some(dir.join("engine").join(YTDLP_NAME))
}

/// Beside the managed binary: the SHA-256 it had when `update_ytdlp` verified
/// it against the release manifest.
fn recorded_sha_path(binary: &Path) -> PathBuf {
    binary.with_extension("sha256")
}

/// Beside the managed binary: the version `update_ytdlp` installed (2.0+).
fn recorded_version_path(binary: &Path) -> PathBuf {
    binary.with_extension("version")
}

fn managed_version(binary: &Path) -> Option<String> {
    std::fs::read_to_string(recorded_version_path(binary))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| version_key(v).is_some())
}

pub(crate) fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect())
}

/// Whether the managed binary is byte-for-byte what `update_ytdlp` installed
/// (S-2). Hashing ~35 MB per spawn is wasteful, so the verdict is cached
/// against the file's size and mtime and recomputed only when either changes.
/// No record (an engine installed before 1.9) counts as unverified.
fn managed_binary_verified(binary: &Path) -> bool {
    type Verdict = (PathBuf, u64, Option<std::time::SystemTime>, bool);
    static CACHE: std::sync::Mutex<Option<Verdict>> = std::sync::Mutex::new(None);

    let Ok(meta) = std::fs::metadata(binary) else { return false };
    let (len, mtime) = (meta.len(), meta.modified().ok());
    if let Ok(guard) = CACHE.lock() {
        if let Some((p, l, m, ok)) = guard.as_ref() {
            if p == binary && *l == len && *m == mtime {
                return *ok;
            }
        }
    }
    let ok = std::fs::read_to_string(recorded_sha_path(binary))
        .ok()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.len() == 64)
        .is_some_and(|expected| sha256_file(binary).is_ok_and(|actual| actual == expected));
    if !ok {
        log::warn!("self-updated yt-dlp failed its integrity check; using the bundled engine");
    }
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((binary.to_path_buf(), len, mtime, ok));
    }
    ok
}

/// yt-dlp versions are dates, sometimes with a build number:
/// `2026.08.19`, `2026.08.19.1`. Compared field by field.
fn version_key(version: &str) -> Option<Vec<u64>> {
    let fields: Option<Vec<u64>> = version.trim().split('.').map(|f| f.parse().ok()).collect();
    fields.filter(|f| f.len() >= 3)
}

fn is_newer(candidate: &str, than: &str) -> bool {
    matches!((version_key(candidate), version_key(than)), (Some(a), Some(b)) if a > b)
}

/// Use the self-updated engine only while it is intact and not older than the
/// bundled one — an app update can ship a newer sidecar than an engine the
/// user updated months ago. A managed engine from before 2.0 has no recorded
/// version and keeps its old precedence.
fn prefer_managed(managed: &Path, bundled_version: &str) -> bool {
    managed.exists()
        && managed_binary_verified(managed)
        && managed_version(managed).map_or(true, |v| !is_newer(bundled_version, &v))
}

/// Flags every invocation gets, ahead of anything else: ignore the user's and
/// system's yt-dlp config files (`~/yt-dlp.conf`, `%APPDATA%\yt-dlp\config`, a
/// portable `yt-dlp.conf` beside the binary, …) and clear the plugin search
/// path. Without them a stray config line such as `--exec` silently overrides
/// the argv Prism builds — including the `--` terminator it relies on.
const LOCKDOWN_ARGS: [&str; 2] = ["--ignore-config", "--no-plugin-dirs"];

/// Resolve the yt-dlp command: a self-updated copy in app-data wins over the
/// bundled sidecar while it is intact and not older (see `prefer_managed`).
/// PATH is pre-augmented so deno/node are visible either way.
pub fn ytdlp_command(app: &AppHandle) -> Result<CommandSpec, String> {
    let program = match managed_ytdlp_path(app) {
        Some(managed) if prefer_managed(&managed, BUNDLED_VERSION) => managed,
        _ => bundled_ytdlp_path()?,
    };
    // UTF-8 output everywhere: Prism reads it as UTF-8, and on Windows yt-dlp
    // would otherwise print paths in the console code page (B-7).
    Ok(CommandSpec::new(program)
        .args(LOCKDOWN_ARGS)
        .env("PATH", augmented_path())
        .env("PYTHONIOENCODING", "utf-8"))
}

/// The sidecar Tauri places beside the app binary (`externalBin`, target
/// triple stripped): `Contents/MacOS/yt-dlp` in the macOS bundle, next to the
/// exe on Windows and Linux, `target/<profile>/yt-dlp` in development.
fn bundled_ytdlp_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("Failed to find yt-dlp sidecar: {e}"))?;
    let path = exe
        .parent()
        .map(|dir| dir.join(YTDLP_NAME))
        .ok_or("Failed to find yt-dlp sidecar")?;
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("Failed to find yt-dlp sidecar at {}", path.display()))
    }
}

#[tauri::command]
pub async fn get_ytdlp_version(app: AppHandle) -> Result<String, String> {
    let cmd = ytdlp_command(&app)?.args(["--version"]);
    let (code, stdout, _stderr) =
        crate::run_ytdlp_capture(cmd, VERSION_TIMEOUT_SECS).await.map_err(|e| e.summary)?;
    if code != Some(0) {
        return Err("yt-dlp --version failed".into());
    }
    Ok(String::from_utf8_lossy(&stdout).trim().to_string())
}

// ── Freshness ───────────────────────────────────────────────────────────

/// What the Updates page and the sidebar nudge show.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    /// "managed" (self-updated) or "bundled".
    pub active: &'static str,
    /// None for a pre-2.0 managed engine, whose version was never recorded.
    pub active_version: Option<String>,
    pub bundled_version: String,
    pub managed_version: Option<String>,
    /// The newest yt-dlp release, when a check has run.
    pub latest: Option<String>,
    pub checked_at: Option<String>,
    pub update_available: bool,
}

/// The last latest-release lookup, cached beside the managed engine (out of
/// the webview's reach).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Freshness {
    latest: String,
    checked_at: String,
}

impl Freshness {
    fn now(latest: String) -> Self {
        Freshness { latest, checked_at: chrono::Utc::now().to_rfc3339() }
    }

    /// Unparseable timestamps count as stale.
    fn age(&self) -> Duration {
        chrono::DateTime::parse_from_rfc3339(&self.checked_at)
            .ok()
            .and_then(|t| (chrono::Utc::now() - t.with_timezone(&chrono::Utc)).to_std().ok())
            .unwrap_or(Duration::MAX)
    }
}

fn freshness_path(app: &AppHandle) -> Option<PathBuf> {
    managed_ytdlp_path(app)?.parent().map(|dir| dir.join("freshness.json"))
}

fn read_freshness(app: &AppHandle) -> Option<Freshness> {
    let text = std::fs::read_to_string(freshness_path(app)?).ok()?;
    serde_json::from_str::<Freshness>(&text).ok().filter(|f| version_key(&f.latest).is_some())
}

fn write_freshness(app: &AppHandle, freshness: &Freshness) {
    let Some(path) = freshness_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(freshness) {
        let _ = std::fs::write(path, text);
    }
}

fn engine_info(app: &AppHandle, freshness: Option<&Freshness>) -> EngineInfo {
    let managed = managed_ytdlp_path(app);
    let using_managed = managed.as_deref().is_some_and(|m| prefer_managed(m, BUNDLED_VERSION));
    let managed_version = managed.as_deref().filter(|m| m.exists()).and_then(managed_version);
    build_info(using_managed, managed_version, BUNDLED_VERSION, freshness)
}

fn build_info(
    using_managed: bool,
    managed_version: Option<String>,
    bundled_version: &str,
    freshness: Option<&Freshness>,
) -> EngineInfo {
    let active_version = if using_managed {
        managed_version.clone()
    } else {
        Some(bundled_version.to_string())
    };
    let latest = freshness.map(|f| f.latest.clone());
    let update_available = matches!((&latest, &active_version), (Some(l), Some(a)) if is_newer(l, a));
    EngineInfo {
        active: if using_managed { "managed" } else { "bundled" },
        active_version,
        bundled_version: bundled_version.to_string(),
        managed_version,
        latest,
        checked_at: freshness.map(|f| f.checked_at.clone()),
        update_available,
    }
}

/// The tag GitHub's `/releases/latest` redirect points at.
fn tag_from_location(location: &str) -> Option<String> {
    let (_, rest) = location.rsplit_once("/releases/tag/")?;
    let tag = rest.split(['?', '#', '/']).next()?;
    version_key(tag).map(|_| tag.to_string())
}

async fn latest_release_tag() -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("Prism/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(CHECK_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;
    let resp = client
        .get(LATEST_URL)
        .send()
        .await
        .map_err(|e| format!("Could not check for a newer engine: {e}"))?;
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("Could not check for a newer engine: GitHub answered HTTP {}", resp.status()))?;
    tag_from_location(location).ok_or_else(|| "Could not check for a newer engine: unexpected answer from GitHub".into())
}

#[tauri::command]
pub async fn get_engine_info(app: AppHandle) -> Result<EngineInfo, String> {
    Ok(engine_info(&app, read_freshness(&app).as_ref()))
}

/// Compare against the newest yt-dlp release. Reuses a lookup younger than a
/// day unless `force`.
#[tauri::command]
pub async fn check_engine_update(app: AppHandle, force: bool) -> Result<EngineInfo, String> {
    let freshness = match read_freshness(&app) {
        Some(cached) if !force && cached.age() < FRESHNESS_TTL => cached,
        _ => {
            let fresh = Freshness::now(latest_release_tag().await?);
            write_freshness(&app, &fresh);
            fresh
        }
    };
    Ok(engine_info(&app, Some(&freshness)))
}

// ── Update ──────────────────────────────────────────────────────────────

/// HTTP client for release downloads: bounded connect + total time so a
/// stalled GitHub fetch fails with a message instead of hanging the Settings
/// action forever, and a UA so the request is attributable.
fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Prism/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))
}

/// GET `url` into memory, refusing bodies larger than `cap` (checked against
/// Content-Length up front and again while streaming, since the header can
/// be absent or wrong).
async fn fetch_capped(
    client: &reqwest::Client,
    url: &str,
    cap: u64,
    what: &str,
) -> Result<Vec<u8>, String> {
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download {}: {}", what, e))?;
    if !resp.status().is_success() {
        return Err(format!("Failed to download {}: HTTP {}", what, resp.status()));
    }
    let too_big = || {
        format!(
            "Refusing to download {}: larger than the {} MB limit",
            what,
            cap / 1_048_576
        )
    };
    if resp.content_length().is_some_and(|len| len > cap) {
        return Err(too_big());
    }
    let mut buf = Vec::with_capacity(resp.content_length().unwrap_or(0).min(cap) as usize);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("Failed to download {}: {}", what, e))?
    {
        if (buf.len() as u64).saturating_add(chunk.len() as u64) > cap {
            return Err(too_big());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

/// One update at a time: two would race on the same staging and record files.
static UPDATING: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

/// Install the newest official yt-dlp release into app-data: resolve the tag
/// once, download the binary and checksum manifest from that same tag, verify
/// the SHA-256 and that the binary runs, then atomically swap it in. Returns
/// the version now in use (unchanged when already current).
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let _updating = UPDATING
        .try_lock()
        .map_err(|_| "The engine is already updating".to_string())?;
    let target = managed_ytdlp_path(&app).ok_or("Could not resolve app data directory")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create engine directory: {}", e))?;
    }

    let tag = latest_release_tag().await?;
    write_freshness(&app, &Freshness::now(tag.clone()));
    if let Some(active) = engine_info(&app, None).active_version {
        if !is_newer(&tag, &active) {
            log::info!("yt-dlp engine already current ({active})");
            return Ok(active);
        }
    }

    // Both files from the same tag: fetching "latest" twice could straddle a
    // release and pair a binary with the wrong manifest.
    let base = format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}");
    let client = http_client()?;
    let bytes = fetch_capped(&client, &format!("{base}/{RELEASE_ASSET}"), MAX_BINARY_BYTES, "yt-dlp").await?;
    let sums_bytes =
        fetch_capped(&client, &format!("{base}/SHA2-256SUMS"), MAX_SUMS_BYTES, "yt-dlp checksums").await?;
    let sums = String::from_utf8_lossy(&sums_bytes);
    let expected = expected_sha256(&sums, RELEASE_ASSET)
        .ok_or_else(|| format!("No checksum entry for {} in SHA2-256SUMS", RELEASE_ASSET))?;
    let actual = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };
    if actual != expected {
        log::warn!("yt-dlp update rejected: checksum mismatch for {RELEASE_ASSET} {tag}");
        return Err("Downloaded yt-dlp failed checksum verification — keeping current engine. Please try again.".into());
    }

    // Unique staging name so a crashed earlier attempt can't collide.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let staging = target.with_extension(format!("download-{unique}"));
    std::fs::write(&staging, &bytes).map_err(|e| format!("Failed to write yt-dlp: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("Failed to mark yt-dlp executable: {}", e))?;
    }

    // Verify the download actually runs before swapping it in. Bounded and
    // async: a binary that hangs must not park a runtime thread or leave the
    // Settings action spinning.
    let mut version_check = tokio::process::Command::new(&staging);
    version_check.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        version_check.creation_flags(CREATE_NO_WINDOW);
    }
    let check = tokio::time::timeout(Duration::from_secs(VERSION_TIMEOUT_SECS), version_check.output()).await;
    let version = match check {
        Ok(Ok(out)) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => {
            let _ = std::fs::remove_file(&staging);
            return Err("Downloaded yt-dlp failed verification — keeping current engine".into());
        }
    };

    std::fs::rename(&staging, &target).map_err(|e| format!("Failed to install yt-dlp: {}", e))?;
    // Recorded after the swap: a failure in between leaves a stale record,
    // which only means the bundled engine is used until the next update.
    std::fs::write(recorded_sha_path(&target), &actual)
        .map_err(|e| format!("Failed to record yt-dlp checksum: {}", e))?;
    let _ = std::fs::write(recorded_version_path(&target), &version);
    log::info!("yt-dlp engine updated to {version}");
    Ok(version)
}

/// Remove the self-updated engine, falling back to the bundled sidecar.
#[tauri::command]
pub async fn reset_ytdlp(app: AppHandle) -> Result<(), String> {
    if let Some(managed) = managed_ytdlp_path(&app) {
        if managed.exists() {
            std::fs::remove_file(&managed)
                .map_err(|e| format!("Failed to remove managed yt-dlp: {}", e))?;
        }
        let _ = std::fs::remove_file(recorded_sha_path(&managed));
        let _ = std::fs::remove_file(recorded_version_path(&managed));
        log::info!("yt-dlp engine reset to the bundled copy");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_checksum_for_asset() {
        let sums = "\
aaaa1111  yt-dlp
BBBB2222  yt-dlp_macos
cccc3333  yt-dlp.exe";
        assert_eq!(expected_sha256(sums, "yt-dlp_macos"), Some("bbbb2222".into()));
        assert_eq!(expected_sha256(sums, "yt-dlp.exe"), Some("cccc3333".into()));
        assert_eq!(expected_sha256(sums, "yt-dlp_linux_armv7l"), None);
    }

    #[test]
    fn managed_binary_must_match_its_recorded_hash() {
        let dir = std::env::temp_dir().join(format!("prism-engine-sha-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join(YTDLP_NAME);
        std::fs::write(&bin, b"genuine").unwrap();
        // No record yet (pre-1.9 install): not trusted.
        assert!(!managed_binary_verified(&bin));
        std::fs::write(recorded_sha_path(&bin), sha256_file(&bin).unwrap()).unwrap();
        std::fs::write(&bin, b"genuine!").unwrap(); // size changes → cache miss
        assert!(!managed_binary_verified(&bin), "tampered binary accepted");
        std::fs::write(&bin, b"genuine").unwrap();
        std::fs::write(recorded_sha_path(&bin), sha256_file(&bin).unwrap()).unwrap();
        std::fs::write(&bin, b"genuine").unwrap();
        assert!(managed_binary_verified(&bin));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn http_client_builds_with_timeouts() {
        assert!(http_client().is_ok());
    }

    #[test]
    fn bundled_version_comes_from_the_sidecars_lock() {
        let lock = include_str!("../../scripts/sidecars.lock");
        assert!(lock.contains(&format!("YTDLP_VERSION={BUNDLED_VERSION}\n")), "{BUNDLED_VERSION}");
        assert!(version_key(BUNDLED_VERSION).is_some());
    }

    #[test]
    fn compares_date_versions_with_build_numbers() {
        assert!(is_newer("2026.09.01", "2026.08.19"));
        assert!(is_newer("2026.08.19.1", "2026.08.19"));
        assert!(is_newer("2027.01.02", "2026.12.31"));
        assert!(!is_newer("2026.08.19", "2026.08.19"));
        assert!(!is_newer("2026.08.01", "2026.08.19"));
        assert!(!is_newer("nightly", "2026.08.19"));
    }

    #[test]
    fn reads_the_tag_from_the_latest_redirect() {
        assert_eq!(
            tag_from_location("https://github.com/yt-dlp/yt-dlp/releases/tag/2026.09.01").as_deref(),
            Some("2026.09.01")
        );
        assert_eq!(tag_from_location("/yt-dlp/yt-dlp/releases/tag/2026.09.01.2?x=1").as_deref(), Some("2026.09.01.2"));
        assert_eq!(tag_from_location("https://github.com/yt-dlp/yt-dlp/releases"), None);
        assert_eq!(tag_from_location("https://github.com/yt-dlp/yt-dlp/releases/tag/nightly"), None);
    }

    #[test]
    fn an_older_self_updated_engine_yields_to_a_newer_bundled_one() {
        let dir = std::env::temp_dir().join(format!("prism-engine-prefer-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join(YTDLP_NAME);
        std::fs::write(&bin, b"managed engine").unwrap();
        std::fs::write(recorded_sha_path(&bin), sha256_file(&bin).unwrap()).unwrap();

        // Before 2.0 no version was recorded: keeps its old precedence.
        assert!(prefer_managed(&bin, "2026.08.19"));
        std::fs::write(recorded_version_path(&bin), "2026.09.01").unwrap();
        assert!(prefer_managed(&bin, "2026.08.19"));
        std::fs::write(recorded_version_path(&bin), "2026.07.01").unwrap();
        assert!(!prefer_managed(&bin, "2026.08.19"), "stale managed engine shadowed a newer bundled one");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn update_is_available_only_when_latest_is_newer_than_what_runs() {
        let fresh = Freshness::now("2026.09.01".into());
        let bundled = build_info(false, None, "2026.08.19", Some(&fresh));
        assert!(bundled.update_available);
        assert_eq!(bundled.active, "bundled");

        let managed = build_info(true, Some("2026.09.01".into()), "2026.08.19", Some(&fresh));
        assert!(!managed.update_available);
        assert_eq!(managed.active_version.as_deref(), Some("2026.09.01"));

        // Unknown version (pre-2.0 managed engine): no nudge rather than a wrong one.
        assert!(!build_info(true, None, "2026.08.19", Some(&fresh)).update_available);
        assert!(!build_info(false, None, "2026.08.19", None).update_available);
    }

    #[test]
    fn freshness_ages_and_treats_garbage_as_stale() {
        assert!(Freshness::now("2026.09.01".into()).age() < FRESHNESS_TTL);
        let garbage = Freshness { latest: "2026.09.01".into(), checked_at: "yesterday-ish".into() };
        assert_eq!(garbage.age(), Duration::MAX);
    }
}
