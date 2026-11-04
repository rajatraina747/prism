//! Make a finished video play on Apple devices.
//!
//! yt-dlp's `--remux-video mp4` changes the container and nothing else. Many
//! sites (Instagram, Facebook, TikTok, X) serve VP9/AV1 video or Opus audio,
//! and those end up as an `.mp4` that QuickTime refuses to open, that iMessage
//! won't preview and that iOS shows as a plain file after AirDrop. The format
//! chain only *prefers* H.264, so when a site offers nothing else the codec
//! comes through untouched.
//!
//! After a download, probe the streams and re-encode only what Apple's players
//! can't decode (H.264/HEVC video and AAC/MP3/ALAC/AC-3 audio are copied as
//! they are, so ordinary YouTube downloads pass straight through).

use serde_json::Value;

use crate::encoders::Codec;
use crate::spawn::{Child, CommandSpec, Event};

/// What to do with the streams of one file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    /// The main video stream isn't H.264/HEVC: re-encode it to H.264.
    pub encode_video: bool,
    /// HEVC is fine for Apple, but only when tagged `hvc1`.
    pub retag_hevc: bool,
    /// Some audio stream isn't something QuickTime plays: re-encode to AAC.
    pub encode_audio: bool,
}

impl Plan {
    fn is_noop(self) -> bool {
        !self.encode_video && !self.retag_hevc && !self.encode_audio
    }
}

/// Decide from `ffprobe -of json -show_streams`-style output. `None` when the
/// file is already fine (or isn't a video at all, or can't be understood —
/// an unreadable probe never triggers a re-encode).
pub fn plan_from_probe(json: &str) -> Option<Plan> {
    let v: Value = serde_json::from_str(json).ok()?;
    let streams = v.get("streams")?.as_array()?;
    let mut plan = Plan { encode_video: false, retag_hevc: false, encode_audio: false };
    let mut saw_video = false;
    for s in streams {
        let codec = s.get("codec_name").and_then(Value::as_str).unwrap_or("");
        match s.get("codec_type").and_then(Value::as_str) {
            Some("video") => {
                // Cover art is a video stream that isn't the video.
                let cover = s.pointer("/disposition/attached_pic").and_then(Value::as_i64) == Some(1);
                if cover || saw_video {
                    continue;
                }
                saw_video = true;
                match codec {
                    "h264" => {}
                    "hevc" => {
                        let tag = s.get("codec_tag_string").and_then(Value::as_str).unwrap_or("");
                        if tag != "hvc1" {
                            plan.retag_hevc = true;
                        }
                    }
                    _ => plan.encode_video = true,
                }
            }
            Some("audio") if !matches!(codec, "aac" | "mp3" | "alac" | "ac3" | "eac3") => plan.encode_audio = true,
            _ => {}
        }
    }
    (saw_video && !plan.is_noop()).then_some(plan)
}

/// The ffmpeg arguments for a plan. `encoder` is the H.264 encoder
/// `encoders::pick` chose; `height` sizes the bitrate for those that need one.
pub fn ffmpeg_args(plan: Plan, encoder: &str, height: Option<u32>, input: &str, output: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file,pipe", "-i"]
        .map(String::from)
        .into();
    a.push(input.into());
    // Everything is kept; only the streams that need it are re-encoded.
    a.extend(["-map", "0", "-c", "copy"].map(String::from));
    if plan.encode_video {
        a.extend(crate::encoders::encoder_args(encoder, Codec::H264, height, ":0"));
        a.extend(["-tag:v:0", "avc1"].map(String::from));
    } else if plan.retag_hevc {
        a.extend(["-tag:v:0", "hvc1"].map(String::from));
    }
    if plan.encode_audio {
        a.extend(["-c:a", "aac", "-b:a", "160k"].map(String::from));
    }
    a.extend(["-movflags", "+faststart", "-f", "mp4", "-y"].map(String::from));
    a.push(output.into());
    a
}

async fn collect(spec: CommandSpec) -> Option<(String, Option<i32>)> {
    let (mut events, _child) = spec.spawn().ok()?;
    let mut out = Vec::new();
    while let Some(ev) = events.recv().await {
        match ev {
            Event::Stdout(b) => out.extend(b),
            Event::Stderr(_) => {}
            Event::Terminated(code) => return Some((String::from_utf8_lossy(&out).into_owned(), code)),
        }
    }
    None
}

/// Probe `path` and, if Apple players couldn't open it, replace it with a
/// playable MP4 of the same name. Returns the child that is re-encoding so the
/// caller can register it for Cancel, via `on_start`; `Ok(false)` means
/// nothing needed doing. Failure leaves the original file untouched.
pub async fn make_playable(ffmpeg: &str, path: &str, on_start: impl FnOnce(Child)) -> Result<bool, String> {
    if !path.to_ascii_lowercase().ends_with(".mp4") {
        return Ok(false);
    }
    let probe = crate::encoders::sibling_ffprobe(ffmpeg);
    let spec = CommandSpec::new(&probe).args([
        "-v", "error", "-protocol_whitelist", "file,pipe", "-of", "json",
        "-show_entries", "stream=codec_type,codec_name,codec_tag_string:stream_disposition=attached_pic",
        path,
    ]);
    let Some((json, Some(0))) = collect(spec).await else { return Ok(false) };
    let Some(plan) = plan_from_probe(&json) else { return Ok(false) };

    let (encoder, height) = if plan.encode_video {
        let enc = crate::encoders::pick(ffmpeg, Codec::H264)
            .await
            .ok_or_else(|| crate::encoders::missing(Codec::H264))?;
        (enc, crate::encoders::probe_height(ffmpeg, path).await)
    } else {
        ("", None)
    };
    let temp = format!("{path}.prism-fix.mp4");
    let args = ffmpeg_args(plan, encoder, height, path, &temp);
    let (mut events, child) = CommandSpec::new(ffmpeg).args(&args).spawn().map_err(|e| e.to_string())?;
    on_start(child);

    let mut stderr = String::new();
    let mut code = None;
    while let Some(ev) = events.recv().await {
        match ev {
            Event::Stderr(b) => {
                stderr.push_str(&String::from_utf8_lossy(&b));
                if stderr.len() > 4000 {
                    let mut cut = stderr.len() - 2000;
                    while !stderr.is_char_boundary(cut) {
                        cut += 1;
                    }
                    stderr = stderr[cut..].to_string();
                }
            }
            Event::Terminated(c) => {
                code = c;
                break;
            }
            Event::Stdout(_) => {}
        }
    }
    if code != Some(0) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("ffmpeg exited {code:?}: {}", stderr.trim()));
    }
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        e.to_string()
    })?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(video: &str, tag: &str, audio: &str) -> String {
        format!(
            r#"{{"streams":[
              {{"codec_type":"video","codec_name":"{video}","codec_tag_string":"{tag}","disposition":{{"attached_pic":0}}}},
              {{"codec_type":"audio","codec_name":"{audio}"}},
              {{"codec_type":"video","codec_name":"mjpeg","disposition":{{"attached_pic":1}}}}
            ]}}"#
        )
    }

    #[test]
    fn h264_with_aac_is_left_alone() {
        assert_eq!(plan_from_probe(&probe("h264", "avc1", "aac")), None);
    }

    #[test]
    fn vp9_is_re_encoded_even_with_a_cover_image() {
        let p = plan_from_probe(&probe("vp9", "vp09", "aac")).unwrap();
        assert!(p.encode_video && !p.encode_audio);
    }

    #[test]
    fn opus_audio_is_re_encoded_but_video_is_copied() {
        let p = plan_from_probe(&probe("h264", "avc1", "opus")).unwrap();
        assert!(p.encode_audio && !p.encode_video);
    }

    #[test]
    fn hevc_only_needs_the_right_tag() {
        assert_eq!(plan_from_probe(&probe("hevc", "hvc1", "aac")), None);
        let p = plan_from_probe(&probe("hevc", "hev1", "aac")).unwrap();
        assert!(p.retag_hevc && !p.encode_video);
    }

    #[test]
    fn a_cover_image_alone_is_not_a_video_and_junk_is_ignored() {
        assert_eq!(plan_from_probe(r#"{"streams":[{"codec_type":"video","codec_name":"mjpeg","disposition":{"attached_pic":1}}]}"#), None);
        assert_eq!(plan_from_probe("not json"), None);
    }

    #[test]
    fn the_output_is_last_and_only_flagged_streams_are_encoded() {
        let plan = Plan { encode_video: true, retag_hevc: false, encode_audio: false };
        let a = ffmpeg_args(plan, "h264_videotoolbox", None, "in.mp4", "out.mp4");
        assert_eq!(a.last().unwrap(), "out.mp4");
        assert!(a.windows(2).any(|w| w == ["-c:v:0", "h264_videotoolbox"]));
        assert!(!a.iter().any(|x| x == "aac"));
    }
}
