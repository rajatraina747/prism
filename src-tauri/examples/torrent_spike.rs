//! Standalone runner that proves librqbit downloads a magnet via DHT without
//! launching the Tauri app.
//!
//!   cargo run --example torrent_spike -- "<magnet-uri>" [output_dir]
//!
//! Default output dir is /tmp/prism-torrent-spike. Use a legal test magnet
//! (e.g. a current Debian/Ubuntu ISO) to validate.

use std::time::Duration;

use librqbit::{AddTorrent, Session};

fn main() -> anyhow::Result<()> {
    let magnet = std::env::args()
        .nth(1)
        .expect("usage: torrent_spike <magnet-uri> [output_dir]");
    let out = std::env::args()
        .nth(2)
        .unwrap_or_else(|| "/tmp/prism-torrent-spike".to_string());

    let rt = tokio::runtime::Runtime::new()?;
    rt.block_on(async move {
        std::fs::create_dir_all(&out)?;
        let session = Session::new(out.into()).await?;
        let handle = session
            .add_torrent(AddTorrent::from_url(&magnet), None)
            .await?
            .into_handle()
            .ok_or_else(|| anyhow::anyhow!("torrent was added in list-only mode"))?;

        loop {
            let stats = handle.stats();
            let pct = if stats.total_bytes > 0 {
                stats.progress_bytes as f64 / stats.total_bytes as f64 * 100.0
            } else {
                0.0
            };
            eprintln!("{:.1}% ({} / {} bytes)", pct, stats.progress_bytes, stats.total_bytes);
            if stats.finished {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
        eprintln!("DONE");
        anyhow::Ok(())
    })
}
