//! The choice of qualities offered for one video, told honestly.
//!
//! Every option used to read "<height> MP4" with codec "h264/aac", whatever
//! the site actually had. On YouTube anything above 1080p is VP9 or AV1 (and
//! HDR only exists there), so picking "2160p MP4" delivered a VP9 file inside
//! an .mp4 that QuickTime and Photos can't play, under a label promising
//! H.264 (REVIEW 2026-09-26). Options are now grouped by resolution, frame
//! rate and dynamic range, and name the codec that will really arrive.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::FormatOption;

/// The fields of one yt-dlp format that the choice is built from.
#[derive(Debug, Default, Deserialize)]
#[allow(dead_code)]
pub(crate) struct YtDlpFormat {
    pub format_id: Option<String>,
    pub format_note: Option<String>,
    pub ext: Option<String>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub height: Option<u32>,
    pub width: Option<u32>,
    pub filesize: Option<u64>,
    pub filesize_approx: Option<u64>,
    pub fps: Option<f64>,
    /// `SDR`, `HDR10`, `HLG`, … (absent on many sites: treated as SDR).
    pub dynamic_range: Option<String>,
    /// Audio: the track's language (`es`, `en-US`) and yt-dlp's preference
    /// for it (the original track ranks highest).
    pub language: Option<String>,
    pub language_preference: Option<i64>,
}

/// One audio track of a video with several (YouTube's dubs).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioTrack {
    pub code: String,
    pub name: String,
    pub original: bool,
}

/// The audio tracks on offer, the original first. Empty when there's only
/// one: nothing to choose.
pub(crate) fn audio_tracks(formats: &[YtDlpFormat]) -> Vec<AudioTrack> {
    let mut tracks: Vec<AudioTrack> = Vec::new();
    for f in formats {
        let audio_only = f.vcodec.as_deref() == Some("none") && f.acodec.as_deref().is_some_and(|a| a != "none");
        let Some(code) = f.language.as_deref().map(str::trim).filter(|c| !c.is_empty()) else { continue };
        if !audio_only || tracks.iter().any(|t| t.code == code) {
            continue;
        }
        // "English (US) original (default), low" → "English (US)"
        let note = f.format_note.as_deref().unwrap_or("");
        let name = note.split(',').next().unwrap_or("").replace("original", "").replace("(default)", "");
        let name = name.trim();
        tracks.push(AudioTrack {
            code: code.to_string(),
            name: if name.is_empty() { code.to_string() } else { name.to_string() },
            original: f.language_preference.is_some_and(|p| p > 0) || note.contains("original"),
        });
    }
    if tracks.len() < 2 {
        return Vec::new();
    }
    tracks.sort_by(|a, b| b.original.cmp(&a.original).then_with(|| a.name.cmp(&b.name)));
    tracks
}

/// A language code safe to put in a yt-dlp format filter or `--sub-langs`.
pub(crate) fn valid_language(code: &str) -> bool {
    !code.is_empty() && code.len() <= 20 && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `chain` asking for the `lang` audio track first, then as it was: a video
/// that turns out not to have that dub still downloads.
pub(crate) fn with_audio_language(chain: &str, lang: &str) -> String {
    let preferred = chain.replace("bestaudio", &format!("bestaudio[language={lang}]"));
    format!("{preferred}/{chain}")
}

/// A codec as people know it, from yt-dlp's codec string.
fn codec_name(vcodec: &str) -> &'static str {
    let v = vcodec.to_ascii_lowercase();
    if v.starts_with("avc") || v.starts_with("h264") {
        "H.264"
    } else if v.starts_with("av01") || v == "av1" {
        "AV1"
    } else if v.starts_with("vp09") || v.starts_with("vp9") {
        "VP9"
    } else if v.starts_with("hev") || v.starts_with("hvc") || v.starts_with("h265") {
        "HEVC"
    } else if v.starts_with("vp8") {
        "VP8"
    } else {
        "Video"
    }
}

/// Which codec yt-dlp will hand over for a group. H.264 whenever there is one
/// (Prism's chain asks for it first). Past that it depends on the sort:
/// downloads normally pass `-S vcodec:h264`, under which yt-dlp takes the
/// codec *closest* to H.264 (checked against YouTube's list: VP9 over AV1);
/// with "keep original container" there's no sort and its own order applies,
/// AV1 first.
fn delivered_codec(codecs: &[&str], keep_container: bool) -> &'static str {
    let order: [&'static str; 6] = if keep_container {
        ["H.264", "AV1", "VP9", "HEVC", "VP8", "Video"]
    } else {
        ["H.264", "HEVC", "VP9", "AV1", "VP8", "Video"]
    };
    order.into_iter().find(|c| codecs.contains(c)).unwrap_or("Video")
}

/// Plays in QuickTime, Photos and iOS as well as everywhere else.
pub(crate) fn plays_everywhere(codec: &str) -> bool {
    matches!(codec, "H.264" | "HEVC")
}

#[derive(Default)]
struct Group {
    label_height: u32,
    height: u32,
    codecs: Vec<&'static str>,
    size: u64,
}

/// One option per resolution × frame rate (up to 30 / above 30) × SDR or
/// HDR, best first: highest resolution, then SDR before HDR (HDR looks
/// washed out on most screens and players), then the higher frame rate.
pub(crate) fn options(formats: &[YtDlpFormat], keep_container: bool) -> Vec<FormatOption> {
    // (label height, high fps, hdr) → group
    let mut groups: BTreeMap<(u32, bool, bool), Group> = BTreeMap::new();
    for f in formats {
        let height = f.height.unwrap_or(0);
        let vcodec = f.vcodec.as_deref().unwrap_or("none");
        if height < 144 || vcodec == "none" || f.ext.as_deref() == Some("mhtml") {
            continue;
        }
        // The site's own name for the height when it has one ("1080p" for a
        // 1920×1036 film), else the pixel height.
        let note = f.format_note.as_deref().unwrap_or("");
        let label_height = note
            .strip_suffix('p')
            .and_then(|n| n.parse::<u32>().ok())
            .or_else(|| note.split('p').next().and_then(|n| n.parse::<u32>().ok()))
            .filter(|h| *h >= 144)
            .unwrap_or(height);
        let high_fps = f.fps.is_some_and(|fps| fps > 30.5);
        // HDR only where someone would want it: below 1080p it only doubled
        // the list (YouTube offers "144p60 HDR").
        let hdr = label_height >= 1080 && f.dynamic_range.as_deref().is_some_and(|d| !d.eq_ignore_ascii_case("SDR"));
        if f.dynamic_range.as_deref().is_some_and(|d| !d.eq_ignore_ascii_case("SDR")) && !hdr {
            continue;
        }
        let group = groups.entry((label_height, high_fps, hdr)).or_default();
        group.label_height = label_height;
        group.height = group.height.max(height);
        let codec = codec_name(vcodec);
        if !group.codecs.contains(&codec) {
            group.codecs.push(codec);
        }
        group.size = group.size.max(f.filesize.or(f.filesize_approx).unwrap_or(0));
    }

    let mut keyed: Vec<((u32, bool, bool), Group)> = groups.into_iter().collect();
    keyed.sort_by(|((ha, fa, da), _), ((hb, fb, db), _)| hb.cmp(ha).then(da.cmp(db)).then(fb.cmp(fa)));
    keyed
        .into_iter()
        .map(|((label_height, high_fps, hdr), g)| option_for(label_height, g.height, high_fps, hdr, &g.codecs, g.size, keep_container))
        .collect()
}

fn option_for(
    label_height: u32,
    height: u32,
    high_fps: bool,
    hdr: bool,
    codecs: &[&'static str],
    size: u64,
    keep_container: bool,
) -> FormatOption {
    let offered: Vec<&str> = codecs.iter().copied().filter(|c| !hdr || *c != "H.264").collect();
    let codec = delivered_codec(&offered, keep_container);
    // `=?`/`<=?`: sites that don't report fps or dynamic range still match.
    let fps = if high_fps { "[fps>30]" } else { "[fps<=?30]" };
    let range = if hdr { "[dynamic_range!=SDR]" } else { "[dynamic_range=?SDR]" };
    let h = height;
    // The chosen resolution wins over codec compatibility: yt-dlp takes the
    // first alternative it can satisfy, and a "<=H avc1" branch would be
    // satisfiable at a lower height. H.264 first at the exact height (never
    // for HDR, which has none), then any codec there, then the nearest below.
    let mut chain = Vec::new();
    if !hdr {
        chain.push(format!("bestvideo[height={h}]{fps}{range}[vcodec^=avc1]+bestaudio[acodec^=mp4a]"));
    }
    chain.push(format!("bestvideo[height={h}]{fps}{range}+bestaudio"));
    chain.push(format!("bestvideo[height<={h}]{fps}{range}+bestaudio"));
    chain.push(format!("bestvideo[height<={h}]+bestaudio"));
    chain.push(format!("best[height<={h}]"));
    chain.push("best".into());

    let resolution = format!("{label_height}p");
    let mut label = resolution.clone();
    if high_fps {
        label.push_str("60");
    }
    if hdr {
        label.push_str(" HDR");
    }
    label.push_str(&format!(" · {codec}"));
    let container = if keep_container && codec != "H.264" { "webm" } else { "mp4" };
    let quality = match label_height {
        h if h >= 2160 => "best",
        h if h >= 1080 => "high",
        h if h >= 720 => "medium",
        _ => "low",
    };
    FormatOption {
        id: chain.join("/"),
        label,
        resolution,
        container: container.into(),
        codec: codec.into(),
        file_size: size,
        quality: quality.into(),
        fps: Some(if high_fps { 60 } else { 30 }),
        hdr,
        plays_everywhere: plays_everywhere(codec),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(height: u32, vcodec: &str, fps: f64, range: &str) -> YtDlpFormat {
        YtDlpFormat {
            height: Some(height),
            vcodec: Some(vcodec.into()),
            fps: Some(fps),
            dynamic_range: Some(range.into()),
            ext: Some("mp4".into()),
            format_note: Some(format!("{height}p")),
            ..Default::default()
        }
    }

    // Shaped like YouTube's list for a 4K/60 HDR upload.
    fn youtube_4k() -> Vec<YtDlpFormat> {
        vec![
            f(2160, "vp09.00.51.08", 60.0, "SDR"),
            f(2160, "av01.0.13M.08", 60.0, "SDR"),
            f(2160, "vp09.02.51.10", 60.0, "HDR10"),
            f(1080, "avc1.64002a", 60.0, "SDR"),
            f(1080, "vp09.00.41.08", 60.0, "SDR"),
            f(1080, "avc1.640028", 30.0, "SDR"),
            f(720, "avc1.4d401f", 30.0, "SDR"),
            YtDlpFormat { vcodec: Some("none".into()), acodec: Some("mp4a.40.2".into()), ..Default::default() },
        ]
    }

    #[test]
    fn labels_say_what_arrives() {
        let labels: Vec<String> = options(&youtube_4k(), false).into_iter().map(|o| o.label).collect();
        assert_eq!(labels, ["2160p60 · VP9", "2160p60 HDR · VP9", "1080p60 · H.264", "1080p · H.264", "720p · H.264"]);
        // Without Prism's H.264 sort, yt-dlp's own order puts AV1 first.
        assert_eq!(options(&youtube_4k(), true)[0].label, "2160p60 · AV1");
    }

    #[test]
    fn only_h264_and_hevc_count_as_playing_everywhere() {
        let opts = options(&youtube_4k(), false);
        assert!(!opts[0].plays_everywhere, "VP9 doesn't play in QuickTime");
        assert!(opts[2].plays_everywhere);
    }

    #[test]
    fn the_exact_height_wins_and_hdr_never_asks_for_h264() {
        let opts = options(&youtube_4k(), false);
        assert!(opts[0].id.starts_with("bestvideo[height=2160][fps>30][dynamic_range=?SDR][vcodec^=avc1]"));
        assert!(opts[1].id.starts_with("bestvideo[height=2160][fps>30][dynamic_range!=SDR]+bestaudio"));
        assert!(!opts[1].id.contains("avc1"));
        assert!(opts[3].id.contains("[fps<=?30]"));
    }

    #[test]
    fn keeping_the_original_container_says_so() {
        let opts = options(&youtube_4k(), true);
        assert_eq!(opts[0].container, "webm");
        assert_eq!(opts[2].container, "mp4");
    }

    fn audio(code: &str, note: &str, pref: i64) -> YtDlpFormat {
        YtDlpFormat {
            vcodec: Some("none".into()),
            acodec: Some("mp4a.40.2".into()),
            language: Some(code.into()),
            format_note: Some(note.into()),
            language_preference: Some(pref),
            ..Default::default()
        }
    }

    // As YouTube lists a dubbed upload (yt-dlp 2026.08.19).
    #[test]
    fn dubbed_tracks_are_listed_original_first() {
        let formats = vec![
            audio("es", "Spanish, low", -1),
            audio("en-US", "English (US) original (default), low", 10),
            audio("es", "Spanish, medium", -1),
            audio("de", "German, medium", -1),
            f(1080, "avc1", 30.0, "SDR"),
        ];
        let tracks = audio_tracks(&formats);
        assert_eq!(
            tracks,
            [
                AudioTrack { code: "en-US".into(), name: "English (US)".into(), original: true },
                AudioTrack { code: "de".into(), name: "German".into(), original: false },
                AudioTrack { code: "es".into(), name: "Spanish".into(), original: false },
            ]
        );
        assert!(audio_tracks(&[audio("en", "English", 10)]).is_empty(), "one track is no choice");
    }

    #[test]
    fn a_chosen_dub_is_asked_for_first_then_anything() {
        assert_eq!(
            with_audio_language("bestvideo+bestaudio[acodec^=mp4a]/best", "es"),
            "bestvideo+bestaudio[language=es][acodec^=mp4a]/best/bestvideo+bestaudio[acodec^=mp4a]/best"
        );
        assert!(valid_language("zh-Hans"));
        assert!(!valid_language("es]+bestvideo"));
        assert!(!valid_language(""));
    }

    #[test]
    fn hdr_is_offered_from_1080p_up_only() {
        let formats = vec![f(1080, "vp09.02.41.10", 60.0, "HDR10"), f(720, "vp09.02.40.10", 60.0, "HDR10"), f(720, "avc1", 60.0, "SDR")];
        let labels: Vec<String> = options(&formats, false).into_iter().map(|o| o.label).collect();
        assert_eq!(labels, ["1080p60 HDR · VP9", "720p60 · H.264"]);
    }

    #[test]
    fn sites_without_fps_or_range_get_one_option_per_height() {
        let plain = vec![
            YtDlpFormat { height: Some(720), vcodec: Some("avc1".into()), ..Default::default() },
            YtDlpFormat { height: Some(480), vcodec: Some("avc1".into()), ..Default::default() },
        ];
        let labels: Vec<String> = options(&plain, false).into_iter().map(|o| o.label).collect();
        assert_eq!(labels, ["720p · H.264", "480p · H.264"]);
    }
}

#[cfg(test)]
mod fixture {
    /// Labels for a real `-J` dump: `PRISM_FORMATS_FIXTURE=path cargo test
    /// formats_from_fixture -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn formats_from_fixture() {
        let path = std::env::var("PRISM_FORMATS_FIXTURE").expect("PRISM_FORMATS_FIXTURE");
        let doc: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let formats: Vec<super::YtDlpFormat> = serde_json::from_value(doc["formats"].clone()).unwrap();
        for o in super::options(&formats, false) {
            println!("{:<22} {:>10} everywhere={}", o.label, o.file_size, o.plays_everywhere);
        }
    }
}
