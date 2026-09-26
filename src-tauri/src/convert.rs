//! Converting a finished file to another format.
//!
//! This module is the part that decides *what* to run and *what ffmpeg said* —
//! both pure, so the arguments and the progress arithmetic can be tested
//! without spawning anything. Running it goes through `spawn.rs` like every
//! other child process, so a conversion is killed with its process group on
//! unix and its Job Object on Windows rather than being left behind.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::download_manager::{DownloadComplete, DownloadProgress};
use crate::errors::{ErrorCode, PrismError};
use crate::spawn::{Child, CommandSpec, Event};

/// Conversions currently running, so one can be stopped.
///
/// Without this, cancelling a conversion would signal the three download
/// engines — none of which owns it — and ffmpeg would keep going with nothing
/// left in the UI pointing at it. `Child::kill` takes the process group on
/// unix and the Job Object on Windows, so nothing is left behind.
fn running() -> &'static Mutex<HashMap<String, Child>> {
    static RUNNING: OnceLock<Mutex<HashMap<String, Child>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Stop a running conversion. A no-op for an id this doesn't own, so the
/// frontend can signal every engine without knowing which one has the job.
#[tauri::command]
pub async fn cancel_convert(id: String) -> Result<(), String> {
    crate::jobs::cancel(&id);
    let child = running().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(child) = child {
        child.kill();
    }
    Ok(())
}

/// Stop every running conversion. Called on app exit: a conversion runs in its
/// own process group, so quitting Prism didn't take ffmpeg with it (REVIEW
/// 2026-09-23 B-6).
pub fn kill_all() {
    let children: Vec<Child> = running()
        .lock()
        .map(|mut map| map.drain().map(|(_, child)| child).collect())
        .unwrap_or_default();
    crate::spawn::stop_all(&children.iter().collect::<Vec<_>>());
}

/// The conversions offered. Deliberately a short list of destinations people
/// actually want, rather than a codec matrix: every extra option here is one
/// more way to produce a file that won't play.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Preset {
    /// H.264 + AAC in MP4. The safe default: plays everywhere.
    Mp4H264,
    /// HEVC + AAC in MP4. Smaller, but fussier about players.
    Mp4Hevc,
    /// Re-wrap only — no re-encode — when the streams are already fine.
    Mp4Remux,
    Mp3,
    M4a,
    Opus,
}

impl Preset {
    /// The extension the result should carry.
    pub fn extension(self) -> &'static str {
        match self {
            Preset::Mp4H264 | Preset::Mp4Hevc | Preset::Mp4Remux => "mp4",
            Preset::Mp3 => "mp3",
            Preset::M4a => "m4a",
            Preset::Opus => "opus",
        }
    }

}

/// The full argument list for a conversion.
///
/// `-nostdin` because a child reading the terminal would hang on a stray
/// keypress; `-progress pipe:1` with `-nostats` because the machine-readable
/// stream is what this parses, and the human one would only interleave with
/// it. The output path is last, and is expected to be one that doesn't exist —
/// there is no `-y`, so ffmpeg refuses rather than overwriting someone's file.
pub fn preset_args(preset: Preset, input: &str, output: &str) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-nostdin".into(),
        "-loglevel".into(),
        "error".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
        // The input is a download, so its contents are a stranger's: a
        // torrent's `movie.mkv` can really be an HLS or concat playlist, and
        // ffmpeg would follow its entries to any URL or local file. Local
        // files only, and nothing they reference elsewhere (REVIEW
        // 2026-09-26 M4). Must precede `-i` to apply to it.
        "-protocol_whitelist".into(),
        "file,pipe".into(),
        "-i".into(),
        input.into(),
    ];

    match preset {
        Preset::Mp4H264 => args.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "medium".into(),
            "-crf".into(), "20".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "192k".into(),
            // Lets a player start before the whole file has arrived.
            "-movflags".into(), "+faststart".into(),
        ]),
        Preset::Mp4Hevc => args.extend([
            "-c:v".into(), "libx265".into(),
            "-preset".into(), "medium".into(),
            "-crf".into(), "24".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "192k".into(),
            // Without this tag QuickTime won't open an HEVC mp4 at all.
            "-tag:v".into(), "hvc1".into(),
            "-movflags".into(), "+faststart".into(),
        ]),
        Preset::Mp4Remux => args.extend([
            "-c".into(), "copy".into(),
            "-movflags".into(), "+faststart".into(),
        ]),
        Preset::Mp3 => args.extend([
            "-vn".into(),
            "-c:a".into(), "libmp3lame".into(),
            "-q:a".into(), "2".into(),
        ]),
        Preset::M4a => args.extend([
            "-vn".into(),
            "-c:a".into(), "aac".into(),
            "-b:a".into(), "256k".into(),
        ]),
        Preset::Opus => args.extend([
            "-vn".into(),
            "-c:a".into(), "libopus".into(),
            "-b:a".into(), "160k".into(),
        ]),
    }

    // The output is a file `reserve_output` just created, empty, for this run
    // alone — so overwriting it is the point, not a risk.
    args.push("-y".into());
    args.push(output.into());
    args
}

/// What the last `-progress` block said.
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct ConvertProgress {
    /// Position in the output, in microseconds.
    pub out_time_us: u64,
    /// Bytes written so far.
    pub total_size: u64,
    /// Multiple of real time, e.g. 2.5 means 2.5 seconds encoded per second.
    pub speed: f64,
    /// ffmpeg reported `progress=end`.
    pub done: bool,
}

/// Fold one line of ffmpeg's `-progress` stream into `state`.
///
/// Returns true when the line closed a block (`progress=continue` or
/// `progress=end`), which is the point at which the values are consistent and
/// worth reporting. Anything unrecognised is ignored rather than treated as an
/// error: ffmpeg adds keys between versions, and a new one shouldn't break a
/// conversion.
pub fn apply_progress_line(line: &str, state: &mut ConvertProgress) -> bool {
    let Some((key, value)) = line.trim().split_once('=') else {
        return false;
    };
    let value = value.trim();

    match key.trim() {
        "out_time_us" | "out_time_ms" => {
            // Despite the name, ffmpeg reports out_time_ms in microseconds too.
            if let Ok(v) = value.parse::<u64>() {
                state.out_time_us = v;
            }
        }
        "total_size" => {
            if let Ok(v) = value.parse::<u64>() {
                state.total_size = v;
            }
        }
        "speed" => {
            // "1.23x", or "N/A" before the first frame is written.
            if let Ok(v) = value.trim_end_matches('x').trim().parse::<f64>() {
                state.speed = v;
            }
        }
        "progress" => {
            state.done = value == "end";
            return true;
        }
        _ => {}
    }
    false
}

/// How far along, 0–100, or None when it can't honestly be said.
///
/// ffmpeg's progress stream carries a position but no total, so the duration
/// has to come from the item being converted. When that is unknown — a stream
/// with no duration, or metadata that never arrived — the answer is None and
/// the UI shows activity rather than a number invented from nothing.
pub fn percent(progress: &ConvertProgress, duration_secs: f64) -> Option<f64> {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return None;
    }
    let elapsed = progress.out_time_us as f64 / 1_000_000.0;
    Some((elapsed / duration_secs * 100.0).clamp(0.0, 100.0))
}

/// Where a converted file should land: beside the original, with the preset's
/// extension, and never on top of something that already exists.
pub fn output_path(input: &Path, preset: Preset) -> PathBuf {
    let stem = input.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let wanted = input
        .parent()
        .unwrap_or(Path::new(""))
        .join(format!("{stem}.{}", preset.extension()));
    // Converting an mp4 to mp4 would otherwise want the input's own name.
    let wanted = if wanted == input {
        input
            .parent()
            .unwrap_or(Path::new(""))
            .join(format!("{stem} (converted).{}", preset.extension()))
    } else {
        wanted
    };
    crate::http_engine::free_destination(&wanted)
}

/// Claim the output file for one conversion by creating it, empty, before
/// ffmpeg runs.
///
/// Choosing a free name isn't enough on its own: two conversions of the same
/// file (a double-click) chose the same name, the second ffmpeg refused to
/// overwrite, and its failure cleanup deleted the first one's output (REVIEW
/// 2026-09-26 M5). Creating the file with `create_new` makes the name this
/// run's alone; a name taken meanwhile just moves on to the next free one.
pub fn reserve_output(input: &Path, preset: Preset) -> std::io::Result<PathBuf> {
    for _ in 0..32 {
        let candidate = output_path(input, preset);
        match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
            Ok(_) => return Ok(candidate),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other("no free name for the converted file"))
}

/// Convert a finished file, reporting through the same events a download uses.
///
/// The UI already understands `download-progress-{id}` and
/// `download-complete-{id}`, so a conversion appears as another running item
/// rather than needing a second channel and a second set of states.
///
/// `duration_secs` comes from the item being converted, because ffmpeg's
/// progress stream reports a position but never a total. Zero means the
/// percentage is left out rather than invented.
#[tauri::command]
pub async fn convert_file(
    app: AppHandle,
    id: String,
    input: String,
    preset: Preset,
    duration_secs: f64,
) -> Result<(), String> {
    // Taken before the first await, so a stop that arrives meanwhile is seen.
    let ticket = crate::jobs::begin(&id);
    // Checked like every other path the webview names: inside the allowed
    // roots, and really there. Without this the command would run ffmpeg on
    // anything and write its output alongside, which is not a power the page
    // is given anywhere else.
    let input = crate::validate_open_path(&input, false, &crate::picked_dirs(&app))?;
    crate::ledger::require_recorded(&app, &input)?;
    let source = PathBuf::from(&input);
    if !source.is_file() {
        return Err("That file isn't there any more".into());
    }
    let ffmpeg = crate::find_ffmpeg_blocking(&app)
        .await
        .ok_or_else(|| "Converting needs ffmpeg, which isn't installed".to_string())?;

    if ticket.cancelled() {
        log::info!("convert {id}: stopped before it started");
        return Ok(());
    }
    // From here the destination is this run's own file, so removing it on
    // failure can only ever remove what this run made.
    let destination = reserve_output(&source, preset).map_err(|e| format!("Couldn't create the converted file: {e}"))?;
    let args = preset_args(preset, &input, &destination.to_string_lossy());

    let (mut events, child) = match CommandSpec::new(&ffmpeg).args(&args).spawn() {
        Ok(pair) => pair,
        Err(e) => {
            let _ = std::fs::remove_file(&destination);
            return Err(format!("Couldn't start ffmpeg: {e}"));
        }
    };

    if let Ok(mut map) = running().lock() {
        map.insert(id.clone(), child);
    }

    tauri::async_runtime::spawn(async move {
        let mut state = ConvertProgress::default();
        let mut stderr_tail = String::new();
        let mut line = String::new();
        let mut code: Option<i32> = None;

        while let Some(event) = events.recv().await {
            match event {
                Event::Stdout(chunk) => {
                    line.push_str(&String::from_utf8_lossy(&chunk));
                    // ffmpeg writes one key=value per line; a chunk may hold
                    // several, or half of one.
                    while let Some(at) = line.find('\n') {
                        let complete: String = line.drain(..=at).collect();
                        if apply_progress_line(&complete, &mut state) {
                            let progress = percent(&state, duration_secs).unwrap_or(0.0);
                            let _ = app.emit(
                                &format!("download-progress-{id}"),
                                DownloadProgress {
                                    id: id.clone(),
                                    downloaded_bytes: state.total_size,
                                    total_bytes: 0,
                                    progress,
                                    speed: 0.0,
                                    eta: 0.0,
                                    stage: Some("processing"),
                                },
                            );
                        }
                    }
                }
                Event::Stderr(chunk) => {
                    // Only the tail matters: ffmpeg puts the reason last.
                    stderr_tail.push_str(&String::from_utf8_lossy(&chunk));
                    if stderr_tail.len() > 4096 {
                        let cut = stderr_tail.len() - 4096;
                        stderr_tail.drain(..cut);
                    }
                }
                Event::Terminated(status) => {
                    code = status;
                    break;
                }
            }
        }
        // Whether it finished or was killed, it is no longer running.
        let was_cancelled = running()
            .lock()
            .map(|mut map| map.remove(&id).is_none())
            .unwrap_or(false);

        // A killed ffmpeg exits non-zero, which is not a failure worth
        // reporting as one — the user asked for it to stop.
        let ok = !was_cancelled && code == Some(0) && destination.is_file();
        if ok {
            crate::ledger::record(&app, &destination.to_string_lossy());
        }
        let size = destination.metadata().ok().map(|m| m.len());
        let error = (!ok && !was_cancelled).then(|| {
            let detail = stderr_tail.trim().to_string();
            let message = if detail.is_empty() {
                "ffmpeg couldn't convert that file".to_string()
            } else {
                detail
            };
            PrismError::new(ErrorCode::Unknown, message)
        });
        // A run that failed part-way leaves a partial file behind; it is not a
        // result anyone asked for.
        if !ok {
            let _ = std::fs::remove_file(&destination);
        }

        crate::finished::emit(
            &app,
            DownloadComplete {
                id: id.clone(),
                success: ok,
                error,
                file_path: ok.then(|| destination.to_string_lossy().into_owned()),
                file_size: if ok { size } else { None },
                actual_height: None,
                output_folder: None,
            },
        );
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fold(lines: &[&str]) -> (ConvertProgress, usize) {
        let mut state = ConvertProgress::default();
        let mut blocks = 0;
        for line in lines {
            if apply_progress_line(line, &mut state) {
                blocks += 1;
            }
        }
        (state, blocks)
    }

    #[test]
    fn the_output_is_the_last_argument() {
        let args = preset_args(Preset::Mp4H264, "/in.mkv", "/out.mp4");
        assert_eq!(args.last().unwrap(), "/out.mp4");
        // It overwrites only the empty file `reserve_output` created for it.
        assert_eq!(args[args.len() - 2], "-y");
        // The input is named, not concatenated into anything.
        let i = args.iter().position(|a| a == "-i").unwrap();
        assert_eq!(args[i + 1], "/in.mkv");
    }

    // Regression (REVIEW 2026-09-26 M5): two conversions of one file each get
    // their own output, and something already there is never taken.
    #[test]
    fn each_conversion_reserves_its_own_output() {
        let dir = std::env::temp_dir().join(format!("prism-convert-reserve-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("clip.mkv");
        std::fs::write(&input, b"source").unwrap();
        std::fs::write(dir.join("clip.mp3"), b"someone else's").unwrap();

        let first = reserve_output(&input, Preset::Mp3).unwrap();
        let second = reserve_output(&input, Preset::Mp3).unwrap();
        assert_ne!(first, second, "a second conversion must not share the first one's file");
        assert_ne!(first, dir.join("clip.mp3"), "an existing file is never the output");
        assert!(first.exists() && second.exists(), "both names are claimed on disk");
        assert_eq!(std::fs::read(dir.join("clip.mp3")).unwrap(), b"someone else's");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Regression (REVIEW 2026-09-26 M4): a download disguised as a playlist
    // must not send ffmpeg to the network or to other local files.
    #[test]
    fn the_input_is_read_with_local_protocols_only() {
        for preset in [Preset::Mp4H264, Preset::Mp4Hevc, Preset::Mp4Remux, Preset::Mp3, Preset::M4a, Preset::Opus] {
            let args = preset_args(preset, "/in.mkv", "/out.mp4");
            let whitelist = args.iter().position(|a| a == "-protocol_whitelist").expect("whitelist set");
            assert_eq!(args[whitelist + 1], "file,pipe", "{preset:?}");
            let input = args.iter().position(|a| a == "-i").unwrap();
            assert!(whitelist < input, "{preset:?}: the whitelist must come before -i to apply to it");
        }
    }

    #[test]
    fn every_preset_asks_for_the_machine_readable_progress_stream() {
        for preset in [Preset::Mp4H264, Preset::Mp4Hevc, Preset::Mp4Remux, Preset::Mp3, Preset::M4a, Preset::Opus] {
            let args = preset_args(preset, "in", "out");
            assert!(args.windows(2).any(|w| w[0] == "-progress" && w[1] == "pipe:1"), "{preset:?}");
            assert!(args.iter().any(|a| a == "-nostats"), "{preset:?}");
        }
    }

    #[test]
    fn audio_presets_drop_the_video_stream() {
        for preset in [Preset::Mp3, Preset::M4a, Preset::Opus] {
            assert!(preset_args(preset, "in", "out").iter().any(|a| a == "-vn"), "{preset:?}");
        }
    }

    #[test]
    fn hevc_carries_the_tag_quicktime_needs() {
        let args = preset_args(Preset::Mp4Hevc, "in", "out");
        assert!(args.windows(2).any(|w| w[0] == "-tag:v" && w[1] == "hvc1"));
    }

    #[test]
    fn a_remux_re_encodes_nothing() {
        let args = preset_args(Preset::Mp4Remux, "in", "out");
        assert!(args.windows(2).any(|w| w[0] == "-c" && w[1] == "copy"));
    }

    #[test]
    fn a_block_is_only_reported_when_it_closes() {
        let (state, blocks) = fold(&[
            "out_time_us=5000000",
            "total_size=1048576",
            "speed=2.5x",
            "progress=continue",
        ]);
        assert_eq!(blocks, 1, "only the progress= line closes a block");
        assert_eq!(state.out_time_us, 5_000_000);
        assert_eq!(state.total_size, 1_048_576);
        assert_eq!(state.speed, 2.5);
        assert!(!state.done);
    }

    #[test]
    fn the_end_of_the_stream_is_recognised() {
        let (state, _) = fold(&["out_time_us=9000000", "progress=end"]);
        assert!(state.done);
    }

    #[test]
    fn nonsense_and_unknown_keys_are_ignored() {
        // ffmpeg gains keys between versions, and "N/A" appears before the
        // first frame. Neither should stop a conversion.
        let (state, blocks) = fold(&["speed=N/A", "bitrate=N/A", "something_new=1", "no equals sign", ""]);
        assert_eq!(blocks, 0);
        assert_eq!(state, ConvertProgress::default());
    }

    #[test]
    fn out_time_ms_is_microseconds_too_despite_its_name() {
        let (state, _) = fold(&["out_time_ms=2500000", "progress=continue"]);
        assert_eq!(state.out_time_us, 2_500_000);
    }

    #[test]
    fn percent_needs_a_duration_to_be_honest_about() {
        let p = ConvertProgress { out_time_us: 30_000_000, ..Default::default() };
        assert_eq!(percent(&p, 60.0), Some(50.0));
        assert_eq!(percent(&p, 0.0), None, "no duration means no percentage");
        assert_eq!(percent(&p, f64::NAN), None);
    }

    #[test]
    fn percent_never_runs_past_the_end() {
        // ffmpeg can report a position slightly past the source duration.
        let p = ConvertProgress { out_time_us: 61_000_000, ..Default::default() };
        assert_eq!(percent(&p, 60.0), Some(100.0));
    }
}
