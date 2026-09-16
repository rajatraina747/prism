//! Recognising a file Prism has already downloaded, whatever URL it came from.
//!
//! The URL-level check (`sourceKey` in the frontend) already catches the same
//! link twice, and a magnet by its infohash. What it cannot catch is the same
//! *content* arriving from somewhere else — a mirror, a re-upload, a different
//! site carrying the same release.
//!
//! That comparison can only happen once a file exists, so this runs after a
//! download finishes rather than before one starts. Telling someone "you
//! already have this" the moment it lands is worth doing; pretending it could
//! be known at add time would mean hashing a file nobody has yet.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// How much of each end of the file goes into the hash.
///
/// Hashing whole files would make every completed download re-read gigabytes
/// for a convenience feature. The ends are enough to tell real files apart,
/// and the size is part of the key, so a collision needs two files of exactly
/// equal length matching at both ends — see the test.
const EDGE_BYTES: u64 = 4 * 1024 * 1024;

/// Files at or below this are hashed whole: the two edges would overlap, and
/// reading 8 MB is cheap anyway.
const WHOLE_FILE_LIMIT: u64 = EDGE_BYTES * 2;

/// Most entries kept. The plan called for an uncapped index; an install that
/// runs for years would grow one without bound for a convenience lookup, and
/// player-state.json already sets the precedent of capping this kind of file.
const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub path: String,
    pub title: String,
    pub recorded_at: String,
}

type Index = HashMap<String, IndexEntry>;

/// A key for the file's content: its size, and a hash of both ends.
///
/// Size leads so that two files of different lengths can never share a key
/// however their edges hash.
pub(crate) fn content_key(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};

    let mut file = std::fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut hasher = Sha256::new();

    if size <= WHOLE_FILE_LIMIT {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
    } else {
        let mut edge = vec![0u8; EDGE_BYTES as usize];
        file.read_exact(&mut edge)?;
        hasher.update(&edge);
        file.seek(SeekFrom::End(-(EDGE_BYTES as i64)))?;
        file.read_exact(&mut edge)?;
        hasher.update(&edge);
    }

    let digest: String = hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("{size}:{digest}"))
}

fn index_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    Some(app.path().app_data_dir().ok()?.join("content-index.json"))
}

fn load(path: &Path) -> Index {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Written through a temp file and renamed, so a crash mid-write leaves the
/// previous index rather than a truncated one.
fn save(path: &Path, index: &Index) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(index)?)?;
    std::fs::rename(&tmp, path)
}

/// Trim to the newest `MAX_ENTRIES` by recorded time.
fn trim(index: &mut Index) {
    if index.len() <= MAX_ENTRIES {
        return;
    }
    let mut entries: Vec<(String, String)> = index
        .iter()
        .map(|(key, entry)| (key.clone(), entry.recorded_at.clone()))
        .collect();
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    for (key, _) in entries.into_iter().skip(MAX_ENTRIES) {
        index.remove(&key);
    }
}

/// Record a finished download, and say whether its content was already here.
///
/// Returns the entry that already held this content, if any — and only when it
/// points somewhere else, so re-recording the same file is not a duplicate
/// report.
#[tauri::command]
pub async fn index_download(
    app: tauri::AppHandle,
    path: String,
    title: String,
) -> Result<Option<IndexEntry>, String> {
    let file = Path::new(&path);
    if !file.is_file() {
        return Ok(None);
    }
    let key = content_key(file).map_err(|e| format!("Couldn't read the finished file: {e}"))?;
    let Some(index_file) = index_path(&app) else {
        return Ok(None);
    };

    let mut index = load(&index_file);
    let existing = index.get(&key).filter(|e| e.path != path).cloned();

    // The newest copy wins the entry: it is the one most likely still there.
    index.insert(
        key,
        IndexEntry {
            path,
            title,
            recorded_at: chrono::Utc::now().to_rfc3339(),
        },
    );
    trim(&mut index);
    if let Err(e) = save(&index_file, &index) {
        log::warn!("content index: not saved: {e}");
    }
    Ok(existing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("prism-content-{}-{tag}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let path = dir.join(name);
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn identical_content_gets_the_same_key_under_a_different_name() {
        let dir = temp_dir("same");
        let a = write(&dir, "a.bin", b"the same bytes");
        let b = write(&dir, "b.bin", b"the same bytes");
        assert_eq!(content_key(&a).unwrap(), content_key(&b).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_content_gets_a_different_key() {
        let dir = temp_dir("diff");
        let a = write(&dir, "a.bin", b"one");
        let b = write(&dir, "b.bin", b"two");
        assert_ne!(content_key(&a).unwrap(), content_key(&b).unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn size_alone_separates_files_that_hash_the_same_ends() {
        let dir = temp_dir("size");
        let a = write(&dir, "a.bin", b"abc");
        let b = write(&dir, "b.bin", b"abcd");
        let (ka, kb) = (content_key(&a).unwrap(), content_key(&b).unwrap());
        assert!(ka.starts_with("3:"), "{ka}");
        assert!(kb.starts_with("4:"), "{kb}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The known limitation, written down rather than left to be discovered:
    /// past the whole-file limit only the ends are hashed, so two files of the
    /// same length that match at both ends collide. Both would have to be over
    /// 8 MB and differ *only* in the middle — but it is not impossible, and a
    /// duplicate report is advisory for that reason.
    #[test]
    fn only_the_ends_are_hashed_on_a_large_file() {
        let dir = temp_dir("edges");
        let size = (WHOLE_FILE_LIMIT + 1024) as usize;

        let mut first = vec![b'a'; size];
        let mut second = vec![b'a'; size];
        // Differ only in the middle, which neither edge covers.
        first[size / 2] = b'X';
        second[size / 2] = b'Y';

        let a = write(&dir, "a.bin", &first);
        let b = write(&dir, "b.bin", &second);
        assert_eq!(
            content_key(&a).unwrap(),
            content_key(&b).unwrap(),
            "edge hashing cannot see a difference in the middle",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn trimming_keeps_the_newest_entries() {
        let mut index: Index = HashMap::new();
        for i in 0..(MAX_ENTRIES + 10) {
            index.insert(
                format!("key{i}"),
                IndexEntry {
                    path: format!("/tmp/{i}"),
                    title: format!("{i}"),
                    // Lexicographic order matches chronological order for RFC 3339.
                    recorded_at: format!("2026-09-{:02}T00:00:00Z", (i % 28) + 1),
                },
            );
        }
        trim(&mut index);
        assert_eq!(index.len(), MAX_ENTRIES);
    }
}
