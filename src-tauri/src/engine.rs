//! yt-dlp engine management.
//!
//! The bundled sidecar goes stale as sites change extraction; this module lets
//! the app fetch the latest official yt-dlp release into app-data and prefer it
//! over the bundled copy, decoupling "site broke" from "wait for a Prism release".

use std::path::PathBuf;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::Command;
use tauri_plugin_shell::ShellExt;

use crate::augmented_path;

#[cfg(target_os = "windows")]
const YTDLP_NAME: &str = "yt-dlp.exe";
#[cfg(not(target_os = "windows"))]
const YTDLP_NAME: &str = "yt-dlp";

#[cfg(target_os = "macos")]
const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
#[cfg(target_os = "windows")]
const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
#[cfg(target_os = "linux")]
const RELEASE_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

const SUMS_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS";

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

/// Resolve the yt-dlp command: a self-updated copy in app-data wins over the
/// bundled sidecar. PATH is pre-augmented so deno/node are visible either way.
pub fn ytdlp_command(app: &AppHandle) -> Result<Command, String> {
    if let Some(managed) = managed_ytdlp_path(app) {
        if managed.exists() {
            return Ok(app
                .shell()
                .command(managed)
                .env("PATH", augmented_path()));
        }
    }
    app.shell()
        .sidecar("yt-dlp")
        .map(|c| c.env("PATH", augmented_path()))
        .map_err(|e| format!("Failed to find yt-dlp sidecar: {}", e))
}

#[tauri::command]
pub async fn get_ytdlp_version(app: AppHandle) -> Result<String, String> {
    let output = ytdlp_command(&app)?
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("Failed to run yt-dlp: {}", e))?;
    if output.status.code() != Some(0) {
        return Err("yt-dlp --version failed".into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Download the latest official yt-dlp release into app-data, verify its
/// SHA-256 against the release manifest and that it runs, then atomically
/// swap it in. Returns the new version string.
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<String, String> {
    let target = managed_ytdlp_path(&app).ok_or("Could not resolve app data directory")?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create engine directory: {}", e))?;
    }

    let resp = reqwest::get(RELEASE_URL)
        .await
        .map_err(|e| format!("Failed to download yt-dlp: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Failed to download yt-dlp: HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed to download yt-dlp: {}", e))?;

    // Verify against the release's published SHA-256 manifest. A mismatch can
    // also mean "latest" advanced between the two fetches — retrying resolves
    // that; a persistent mismatch means a corrupted or tampered download.
    let sums_resp = reqwest::get(SUMS_URL)
        .await
        .map_err(|e| format!("Failed to fetch yt-dlp checksums: {}", e))?;
    if !sums_resp.status().is_success() {
        return Err(format!(
            "Failed to fetch yt-dlp checksums: HTTP {}",
            sums_resp.status()
        ));
    }
    let sums = sums_resp
        .text()
        .await
        .map_err(|e| format!("Failed to fetch yt-dlp checksums: {}", e))?;
    let asset = RELEASE_URL.rsplit('/').next().unwrap_or_default();
    let expected = expected_sha256(&sums, asset)
        .ok_or_else(|| format!("No checksum entry for {} in SHA2-256SUMS", asset))?;
    let actual = {
        use sha2::{Digest, Sha256};
        Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{:02x}", b))
            .collect::<String>()
    };
    if actual != expected {
        return Err("Downloaded yt-dlp failed checksum verification — keeping current engine. Please try again.".into());
    }

    // Unique staging name so two concurrent updates can't clobber each other's
    // partial download before the atomic rename.
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

    // Verify the download actually runs before swapping it in
    let check = std::process::Command::new(&staging).arg("--version").output();
    let version = match check {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
        _ => {
            let _ = std::fs::remove_file(&staging);
            return Err("Downloaded yt-dlp failed verification — keeping current engine".into());
        }
    };

    std::fs::rename(&staging, &target).map_err(|e| format!("Failed to install yt-dlp: {}", e))?;
    Ok(version)
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
}

/// Remove the self-updated engine, falling back to the bundled sidecar.
#[tauri::command]
pub async fn reset_ytdlp(app: AppHandle) -> Result<(), String> {
    if let Some(managed) = managed_ytdlp_path(&app) {
        if managed.exists() {
            std::fs::remove_file(&managed)
                .map_err(|e| format!("Failed to remove managed yt-dlp: {}", e))?;
        }
    }
    Ok(())
}
