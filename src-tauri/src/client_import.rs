//! Bring torrents over from qBittorrent or Transmission.
//!
//! Both keep each torrent as a `.torrent` file next to a bencoded resume file
//! that records where its data lives:
//!
//! - qBittorrent: `BT_backup/<infohash>.torrent` + `<infohash>.fastresume`
//!   (`save_path`, or `qBt-savePath` in older versions);
//! - Transmission: `torrents/<stem>.torrent` + `resume/<stem>.resume`
//!   (`destination`), where the stem is the info hash in 4.x and
//!   `<name>.<hash16>` before.
//!
//! Prism lays torrents out the same way both clients do by default (a
//! multi-file torrent in `<save folder>/<name>`, a single file directly in the
//! save folder), so a torrent imported with its old save folder finds its data
//! and librqbit re-checks it rather than downloading it again.
//!
//! The folder is picked in a dialog here in Rust, as with `pick_download_dir`:
//! the page never names a folder to read.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

/// Most torrents one import reads.
const MAX_TORRENTS: usize = 2000;
/// Resume files are small; anything bigger isn't one.
const MAX_RESUME_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Client {
    Qbittorrent,
    Transmission,
}

/// A torrent found in the other client's folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Found {
    pub torrent: PathBuf,
    pub save_path: Option<String>,
}

/// The resume-file fields Prism uses. Everything else is ignored.
#[derive(Debug, Default, Deserialize)]
struct ResumeFields {
    save_path: Option<String>,
    #[serde(rename = "qBt-savePath")]
    qbt_save_path: Option<String>,
    destination: Option<String>,
}

fn read_resume(path: &Path) -> Option<ResumeFields> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > MAX_RESUME_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    librqbit_bencode::from_bytes::<ResumeFields>(&bytes).ok()
}

fn save_path_of(fields: ResumeFields) -> Option<String> {
    [fields.save_path, fields.qbt_save_path, fields.destination]
        .into_iter()
        .flatten()
        .map(|p| p.trim().to_string())
        .find(|p| !p.is_empty())
}

/// `.torrent` files in `dir`, sorted so an import is repeatable.
fn torrents_in(dir: &Path) -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("torrent")))
        .collect();
    found.sort();
    found.truncate(MAX_TORRENTS);
    found
}

/// What a qBittorrent `BT_backup` folder holds. Accepts the folder itself or
/// qBittorrent's data folder that contains it.
pub(crate) fn scan_qbittorrent(dir: &Path) -> Vec<Found> {
    let backup = if dir.join("BT_backup").is_dir() { dir.join("BT_backup") } else { dir.to_path_buf() };
    torrents_in(&backup)
        .into_iter()
        .map(|torrent| {
            let save_path = read_resume(&torrent.with_extension("fastresume")).and_then(save_path_of);
            Found { torrent, save_path }
        })
        .collect()
}

/// What a Transmission config folder holds (the one with `torrents/` and
/// `resume/` in it).
pub(crate) fn scan_transmission(dir: &Path) -> Vec<Found> {
    let resume_dir = dir.join("resume");
    torrents_in(&dir.join("torrents"))
        .into_iter()
        .map(|torrent| {
            let save_path = torrent
                .file_stem()
                // Append, not with_extension: a pre-4.0 stem is
                // `<name>.<hash16>`, and with_extension would replace the hash.
                .map(|stem| resume_dir.join(format!("{}.resume", stem.to_string_lossy())))
                .and_then(|p| read_resume(&p))
                .and_then(save_path_of);
            Found { torrent, save_path }
        })
        .collect()
}

/// One torrent, ready for the queue.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedTorrent {
    magnet: String,
    /// Where its data already is, when that folder is one Prism may use.
    save_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientImport {
    torrents: Vec<ImportedTorrent>,
    /// Files that weren't usable torrents.
    skipped: usize,
}

/// Pick the other client's folder and read its torrents.
#[tauri::command]
pub async fn import_torrent_client(app: AppHandle, client: Client) -> Result<Option<ClientImport>, String> {
    use tauri_plugin_dialog::DialogExt;

    let title = match client {
        Client::Qbittorrent => "Choose qBittorrent's BT_backup folder",
        Client::Transmission => "Choose Transmission's folder (the one with torrents and resume in it)",
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().set_title(title).pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(picked) = rx.await.map_err(|_| "Folder picker was closed".to_string())? else {
        return Ok(None);
    };
    let dir = picked.into_path().map_err(|e| format!("Invalid folder: {e}"))?;

    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let found = match client {
            Client::Qbittorrent => scan_qbittorrent(&dir),
            Client::Transmission => scan_transmission(&dir),
        };
        let allowed = crate::picked_dirs(&app2);
        let mut torrents = Vec::new();
        let mut skipped = 0;
        for f in found {
            let name = f.torrent.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            // Size first: a stray multi-GB file named `.torrent` in the picked
            // folder must not be read into memory to find out (L9).
            let magnet = std::fs::metadata(&f.torrent)
                .map_err(|e| e.to_string())
                .and_then(|m| {
                    if m.len() > crate::MAX_TORRENT_FILE_BYTES {
                        Err(format!("{name} is too large to be a .torrent"))
                    } else {
                        std::fs::read(&f.torrent).map_err(|e| e.to_string())
                    }
                })
                .and_then(|bytes| crate::store_torrent_bytes(&app2, &name, &bytes));
            match magnet {
                Ok(magnet) => torrents.push(ImportedTorrent {
                    magnet,
                    // A folder Prism may not write to (a system folder, or a
                    // drive not picked here yet) falls back to the default.
                    save_path: f
                        .save_path
                        .filter(|p| crate::validate_download_path(p, &allowed).is_ok()),
                }),
                Err(e) => {
                    log::warn!("client import: skipped {name}: {e}");
                    skipped += 1;
                }
            }
        }
        ClientImport { torrents, skipped }
    })
    .await
    .map_err(|e| format!("Import failed: {e}"))?;
    log::info!("client import: {} torrent(s), {} skipped", result.torrents.len(), result.skipped);
    Ok(Some(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("prism-import-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn bstr(s: &str) -> String {
        format!("{}:{}", s.len(), s)
    }

    #[test]
    fn reads_qbittorrent_save_paths() {
        let tmp = TempDir::new("qbt");
        let backup = tmp.0.join("BT_backup");
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("aaaa.torrent"), b"t").unwrap();
        std::fs::write(
            backup.join("aaaa.fastresume"),
            format!("d{}{}{}i1ee", bstr("save_path"), bstr("/Users/me/Movies"), bstr("paused")),
        )
        .unwrap();
        // Older qBittorrent: the path lives in qBt-savePath.
        std::fs::write(backup.join("bbbb.torrent"), b"t").unwrap();
        std::fs::write(backup.join("bbbb.fastresume"), format!("d{}{}e", bstr("qBt-savePath"), bstr("/Users/me/TV"))).unwrap();
        // No resume file at all.
        std::fs::write(backup.join("cccc.torrent"), b"t").unwrap();

        // The data folder containing BT_backup works as well as BT_backup itself.
        for dir in [&tmp.0, &backup] {
            let found = scan_qbittorrent(dir);
            let paths: Vec<_> = found.iter().map(|f| f.save_path.as_deref()).collect();
            assert_eq!(paths, vec![Some("/Users/me/Movies"), Some("/Users/me/TV"), None]);
        }
    }

    #[test]
    fn reads_transmission_destinations_for_both_file_layouts() {
        let tmp = TempDir::new("tr");
        std::fs::create_dir_all(tmp.0.join("torrents")).unwrap();
        std::fs::create_dir_all(tmp.0.join("resume")).unwrap();
        // 4.x: named by info hash.
        std::fs::write(tmp.0.join("torrents/0123abcd.torrent"), b"t").unwrap();
        std::fs::write(tmp.0.join("resume/0123abcd.resume"), format!("d{}{}e", bstr("destination"), bstr("/Users/me/Downloads"))).unwrap();
        // Before 4.0: <name>.<hash16>, and the name may contain dots.
        std::fs::write(tmp.0.join("torrents/Some.Show.S01.0123456789abcdef.torrent"), b"t").unwrap();
        std::fs::write(
            tmp.0.join("resume/Some.Show.S01.0123456789abcdef.resume"),
            format!("d{}{}e", bstr("destination"), bstr("/Volumes/Media")),
        )
        .unwrap();

        let found = scan_transmission(&tmp.0);
        let paths: Vec<_> = found.iter().map(|f| f.save_path.as_deref()).collect();
        assert_eq!(paths, vec![Some("/Users/me/Downloads"), Some("/Volumes/Media")]);
    }

    #[test]
    fn a_damaged_resume_file_still_imports_the_torrent_without_a_folder() {
        let tmp = TempDir::new("bad");
        std::fs::write(tmp.0.join("dddd.torrent"), b"t").unwrap();
        std::fs::write(tmp.0.join("dddd.fastresume"), b"not bencode").unwrap();
        assert_eq!(scan_qbittorrent(&tmp.0), vec![Found { torrent: tmp.0.join("dddd.torrent"), save_path: None }]);
    }

    // A real fastresume holds far more than the save path: binary piece maps
    // and peer lists (not UTF-8), nested tracker lists, integers. Skipping
    // those must not fail the whole file.
    #[test]
    fn reads_the_save_path_out_of_a_realistic_fastresume() {
        let tmp = TempDir::new("real");
        let mut resume: Vec<u8> = Vec::new();
        resume.extend(b"d");
        resume.extend(format!("{}i1e", bstr("active_time")).as_bytes());
        resume.extend(format!("{}l1:ae", bstr("banned_peers6")).as_bytes());
        resume.extend(bstr("file-format").as_bytes());
        resume.extend(bstr("libtorrent resume file").as_bytes());
        resume.extend(bstr("peers").as_bytes());
        resume.extend(b"6:");
        resume.extend([0xff, 0x00, 0xc3, 0x28, 0x80, 0x01]);
        resume.extend(bstr("pieces").as_bytes());
        resume.extend(b"4:");
        resume.extend([0x01, 0x01, 0x00, 0xfe]);
        resume.extend(format!("{}d{}{}e", bstr("qBt-tags"), bstr("k"), bstr("v")).as_bytes());
        resume.extend(format!("{}{}", bstr("save_path"), bstr("/Volumes/Media/Films")).as_bytes());
        resume.extend(format!("{}ll{}el{}ee", bstr("trackers"), bstr("udp://a:1"), bstr("udp://b:2")).as_bytes());
        resume.extend(b"e");
        std::fs::write(tmp.0.join("eeee.torrent"), b"t").unwrap();
        std::fs::write(tmp.0.join("eeee.fastresume"), &resume).unwrap();
        assert_eq!(scan_qbittorrent(&tmp.0)[0].save_path.as_deref(), Some("/Volumes/Media/Films"));
    }
}
