//! BitTorrent engine spike (go/no-go). Wraps librqbit to download a magnet/torrent
//! URL to disk while reporting progress. Deliberately UI-less: this exists to prove
//! the library integrates against our toolchain and Tauri dep tree, and that a real
//! magnet resolves via DHT and completes, before we commit to the second-engine arc.
//! See ROADMAP.md → "Second engine: BitTorrent".

use std::path::PathBuf;
use std::time::Duration;

use librqbit::{AddTorrent, Session};

/// Download a magnet or `.torrent` URL into `output_dir`, calling `on_progress`
/// with (downloaded_bytes, total_bytes) roughly once a second until complete.
/// Returns the output directory on success.
pub async fn download_magnet<F: Fn(u64, u64)>(
    magnet: &str,
    output_dir: PathBuf,
    on_progress: F,
) -> anyhow::Result<PathBuf> {
    let session = Session::new(output_dir.clone()).await?;
    let handle = session
        .add_torrent(AddTorrent::from_url(magnet), None)
        .await?
        .into_handle()
        .ok_or_else(|| anyhow::anyhow!("torrent was added in list-only mode"))?;

    loop {
        let stats = handle.stats();
        on_progress(stats.progress_bytes, stats.total_bytes);
        if stats.finished {
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }

    Ok(output_dir)
}

/// Spike command: download a magnet, logging progress to the app log. Wired into the
/// Tauri handler list purely to validate the command path; no frontend consumes it yet.
#[tauri::command]
pub async fn torrent_spike(magnet: String, output_dir: String) -> Result<String, String> {
    let out = PathBuf::from(output_dir);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    download_magnet(&magnet, out, |downloaded, total| {
        let pct = if total > 0 {
            downloaded as f64 / total as f64 * 100.0
        } else {
            0.0
        };
        log::info!(
            "torrent spike: {:.1}% ({} / {} bytes)",
            pct,
            downloaded,
            total
        );
    })
    .await
    .map(|p| p.display().to_string())
    .map_err(|e| e.to_string())
}
