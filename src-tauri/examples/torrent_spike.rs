//! Standalone runner for the BitTorrent spike — proves librqbit actually downloads a
//! magnet via DHT without launching the whole Tauri app.
//!
//!   cargo run --example torrent_spike -- "<magnet-uri>" [output_dir]
//!
//! Default output dir is /tmp/prism-torrent-spike. Use a legal test magnet
//! (e.g. a current Debian/Ubuntu ISO) to validate.

fn main() -> anyhow::Result<()> {
    let magnet = std::env::args()
        .nth(1)
        .expect("usage: torrent_spike <magnet-uri> [output_dir]");
    let out = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "/tmp/prism-torrent-spike".to_string());

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        app_lib::torrent::download_magnet(&magnet, out.into(), |downloaded, total| {
            let pct = if total > 0 {
                downloaded as f64 / total as f64 * 100.0
            } else {
                0.0
            };
            eprintln!("{:.1}% ({} / {} bytes)", pct, downloaded, total);
        })
        .await?;
        eprintln!("DONE");
        anyhow::Ok(())
    })
}
