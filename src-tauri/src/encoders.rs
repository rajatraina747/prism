//! Choosing an H.264 / HEVC encoder the bundled ffmpeg really has.
//!
//! Prism ships LGPL ffmpeg builds, so x264 and x265 (both GPL) are never in
//! them. Asking for `libx264` failed every MP4 conversion in the bundled app.
//! What each platform has instead:
//!
//! - macOS: VideoToolbox (Apple's hardware encoder, on every Mac).
//! - Windows / Linux (BtbN LGPL builds): NVENC, Quick Sync and AMF when the
//!   GPU is there, Media Foundation on Windows, and OpenH264 / Kvazaar as
//!   software fallbacks that always work.
//!
//! A hardware encoder appears in `ffmpeg -encoders` whether or not the machine
//! has that GPU, so being listed proves nothing. Each candidate is tried on a
//! fraction of a second of generated video, with the same options a real run
//! would use, and the first that succeeds is kept for the rest of the session.
//! A system ffmpeg that does have x264/x265 still gets them first.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::spawn::{CommandSpec, Event};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Codec {
    H264,
    Hevc,
}

impl Codec {
    /// Candidates, best first: software x26x where present (best quality per
    /// byte), then hardware, then the software encoders LGPL builds carry.
    pub fn candidates(self) -> &'static [&'static str] {
        match self {
            Codec::H264 => &[
                "libx264",
                "h264_videotoolbox",
                "h264_nvenc",
                "h264_qsv",
                "h264_amf",
                "h264_mf",
                "libopenh264",
            ],
            Codec::Hevc => &[
                "libx265",
                "hevc_videotoolbox",
                "hevc_nvenc",
                "hevc_qsv",
                "hevc_amf",
                "hevc_mf",
                "libkvazaar",
            ],
        }
    }

    fn label(self) -> &'static str {
        match self {
            Codec::H264 => "H.264",
            Codec::Hevc => "HEVC",
        }
    }
}

/// A target bitrate for the encoders that take only a bitrate, scaled by the
/// picture height, since one number can't suit 480p and 4K alike. `None`
/// (height unknown) assumes 1080p.
pub fn bitrate_for(codec: Codec, height: Option<u32>) -> &'static str {
    let h = height.unwrap_or(1080);
    match (codec, h) {
        (Codec::H264, 0..=480) => "2500k",
        (Codec::H264, 481..=720) => "5M",
        (Codec::H264, 721..=1080) => "8M",
        (Codec::H264, 1081..=1440) => "16M",
        (Codec::H264, _) => "35M",
        (Codec::Hevc, 0..=480) => "1500k",
        (Codec::Hevc, 481..=720) => "3M",
        (Codec::Hevc, 721..=1080) => "5M",
        (Codec::Hevc, 1081..=1440) => "10M",
        (Codec::Hevc, _) => "20M",
    }
}

/// The `-c:v` value and its quality options, including the pixel format.
/// `stream` is the output stream specifier suffix (`""` for `-c:v`, `":0"`
/// for `-c:v:0`).
pub fn encoder_args(encoder: &str, codec: Codec, height: Option<u32>, stream: &str) -> Vec<String> {
    let hevc = codec == Codec::Hevc;
    let mut a: Vec<String> = vec![format!("-c:v{stream}"), encoder.into()];
    let mut push = |xs: &[&str]| a.extend(xs.iter().map(|s| s.to_string()));
    match encoder {
        "libx264" => push(&["-preset", "medium", "-crf", "20"]),
        "libx265" => push(&["-preset", "medium", "-crf", "24"]),
        e if e.ends_with("_videotoolbox") => push(&["-q:v", if hevc { "60" } else { "65" }]),
        e if e.ends_with("_nvenc") => push(&[
            "-preset",
            "p5",
            "-rc",
            "vbr",
            "-cq",
            if hevc { "26" } else { "23" },
            "-b:v",
            "0",
        ]),
        e if e.ends_with("_qsv") => push(&["-global_quality", if hevc { "26" } else { "23" }]),
        e if e.ends_with("_amf") => {
            let qp = if hevc { "26" } else { "22" };
            push(&["-rc", "cqp", "-qp_i", qp, "-qp_p", qp]);
        }
        "libkvazaar" => push(&["-kvazaar-params", "preset=fast,qp=26"]),
        // Media Foundation and OpenH264 take a bitrate, not a quality level.
        _ => push(&["-b:v", bitrate_for(codec, height)]),
    }
    // Apple players and most TVs want 8-bit 4:2:0; Quick Sync wants it as NV12.
    let pix = if encoder.ends_with("_qsv") {
        "nv12"
    } else {
        "yuv420p"
    };
    push(&["-pix_fmt", pix]);
    a
}

/// (ffmpeg path, codec) → the encoder chosen for it, `None` if none works.
type Cache = Mutex<HashMap<(String, Codec), Option<&'static str>>>;

fn cache() -> &'static Cache {
    static CACHE: OnceLock<Cache> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn run(ffmpeg: &str, args: &[String]) -> Option<(String, Option<i32>)> {
    let (mut events, _child) = CommandSpec::new(ffmpeg).args(args).spawn().ok()?;
    let mut out = Vec::new();
    while let Some(ev) = events.recv().await {
        match ev {
            Event::Stdout(b) => out.extend(b),
            Event::Stderr(_) => {}
            Event::Terminated(code) => {
                return Some((String::from_utf8_lossy(&out).into_owned(), code))
            }
        }
    }
    None
}

/// The arguments for the trial encode: a few frames of generated video, so it
/// opens the real encoder (and its GPU) without touching any file.
pub fn trial_args(encoder: &str, codec: Codec) -> Vec<String> {
    let mut a: Vec<String> = [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=320x240:r=30:d=0.5",
        "-frames:v",
        "5",
    ]
    .map(String::from)
    .into();
    a.extend(encoder_args(encoder, codec, Some(240), ""));
    a.extend(["-f", "null", "-"].map(String::from));
    a
}

/// The best working encoder for `codec` in this ffmpeg, or `None` when it has
/// none. Tried once per ffmpeg per session.
pub async fn pick(ffmpeg: &str, codec: Codec) -> Option<&'static str> {
    let key = (ffmpeg.to_string(), codec);
    if let Some(hit) = cache().lock().ok().and_then(|m| m.get(&key).copied()) {
        return hit;
    }
    let listed = run(ffmpeg, &["-hide_banner".into(), "-encoders".into()])
        .await
        .map(|(t, _)| t)
        .unwrap_or_default();
    let mut chosen = None;
    for &enc in codec.candidates() {
        // `-encoders` lines read " V....D h264_videotoolbox   VideoToolbox…".
        if !listed.split_whitespace().any(|w| w == enc) {
            continue;
        }
        match run(ffmpeg, &trial_args(enc, codec)).await {
            Some((_, Some(0))) => {
                chosen = Some(enc);
                break;
            }
            _ => log::info!(
                "{} encoder {enc} is listed but didn't work here",
                codec.label()
            ),
        }
    }
    log::info!("{} encoder: {}", codec.label(), chosen.unwrap_or("none"));
    if let Ok(mut m) = cache().lock() {
        m.insert(key, chosen);
    }
    chosen
}

/// The error to show when there is no encoder at all.
pub fn missing(codec: Codec) -> String {
    format!(
        "This copy of ffmpeg has no {} encoder that works on this computer",
        codec.label()
    )
}

/// ffprobe beside `ffmpeg` (the bundled pair always travel together).
pub fn sibling_ffprobe(ffmpeg: &str) -> PathBuf {
    let p = Path::new(ffmpeg);
    let name = if cfg!(windows) {
        "ffprobe.exe"
    } else {
        "ffprobe"
    };
    p.parent()
        .map(|d| d.join(name))
        .unwrap_or_else(|| PathBuf::from(name))
}

/// The height of the first video stream, for sizing a bitrate. Local
/// protocols only: the file is a download, and a playlist in disguise must
/// not send ffprobe anywhere (REVIEW 2026-09-26 M4).
pub async fn probe_height(ffmpeg: &str, input: &str) -> Option<u32> {
    let probe = sibling_ffprobe(ffmpeg);
    let args: Vec<String> = [
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=height",
        "-of",
        "csv=p=0",
        input,
    ]
    .map(String::from)
    .into();
    let (mut events, _child) = CommandSpec::new(&probe).args(&args).spawn().ok()?;
    let mut out = Vec::new();
    while let Some(ev) = events.recv().await {
        match ev {
            Event::Stdout(b) => out.extend(b),
            Event::Stderr(_) => {}
            Event::Terminated(Some(0)) => break,
            Event::Terminated(_) => return None,
        }
    }
    String::from_utf8_lossy(&out)
        .lines()
        .next()?
        .trim()
        .parse()
        .ok()
        .filter(|&h| h > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_gpl_encoder_is_ever_the_only_choice() {
        for codec in [Codec::H264, Codec::Hevc] {
            let c = codec.candidates();
            assert!(c.len() > 2, "{codec:?}: needs fallbacks beyond x26x");
            assert!(
                c.iter().any(|e| e.ends_with("_videotoolbox")),
                "{codec:?}: macOS bundled build"
            );
            assert!(
                c.iter().any(|e| *e == "libopenh264" || *e == "libkvazaar"),
                "{codec:?}: LGPL software fallback"
            );
        }
    }

    #[test]
    fn every_candidate_sets_an_encoder_and_a_pixel_format() {
        for codec in [Codec::H264, Codec::Hevc] {
            for enc in codec.candidates() {
                let a = encoder_args(enc, codec, Some(1080), ":0");
                assert_eq!(a[..2], [String::from("-c:v:0"), enc.to_string()], "{enc}");
                assert!(a.windows(2).any(|w| w[0] == "-pix_fmt"), "{enc}");
            }
        }
    }

    #[test]
    fn bitrate_only_encoders_scale_with_the_picture() {
        let at = |h| encoder_args("libopenh264", Codec::H264, Some(h), "");
        assert!(at(480).windows(2).any(|w| w == ["-b:v", "2500k"]));
        assert!(at(2160).windows(2).any(|w| w == ["-b:v", "35M"]));
        assert!(encoder_args("h264_mf", Codec::H264, None, "")
            .windows(2)
            .any(|w| w == ["-b:v", "8M"]));
    }

    #[test]
    fn the_trial_reads_no_file_and_writes_nothing() {
        let a = trial_args("h264_videotoolbox", Codec::H264);
        assert!(a.windows(2).any(|w| w == ["-f", "lavfi"]));
        assert_eq!(a[a.len() - 3..], ["-f", "null", "-"].map(String::from));
    }

    // Runs the real bundled/system ffmpeg when one is on hand, so CI on each
    // platform shows which encoder that build would pick.
    #[test]
    fn a_real_ffmpeg_yields_an_encoder_when_present() {
        let Ok(ffmpeg) = std::env::var("PRISM_TEST_FFMPEG") else {
            return;
        };
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        for codec in [Codec::H264, Codec::Hevc] {
            let got = rt.block_on(pick(&ffmpeg, codec));
            eprintln!("{codec:?} -> {got:?}");
            assert!(got.is_some(), "{codec:?}: no working encoder in {ffmpeg}");
        }
    }
}
