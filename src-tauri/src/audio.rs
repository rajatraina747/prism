//! Audio-only downloads: which quality, and what the source offers.
//!
//! The choice is a fixed list (`AudioQuality`), parsed from the item or the
//! setting and turned into yt-dlp arguments here, so nothing the page sends
//! reaches the command line except through this whitelist.
//!
//! "Original" keeps the site's own stream: yt-dlp extracts it into an audio
//! file without re-encoding (Opus stays .opus, AAC becomes .m4a). The others
//! re-encode, which can't add quality: a 320 kbps MP3 of a 128 kbps source is
//! only a bigger file. That's why the dialog shows the source next to them.

use serde::Serialize;

use crate::formats::YtDlpFormat;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AudioQuality {
    /// The best stream as the site serves it, no re-encode.
    Original,
    /// MP3, VBR V0 (~245 kbps average): Prism's default before 2.7.
    Mp3V0,
    /// MP3 at a fixed bitrate (kbps).
    Mp3(u32),
    M4a,
    Opus,
}

const MP3_RATES: [u32; 4] = [128, 192, 256, 320];

impl AudioQuality {
    /// `original`, `mp3-v0`, `mp3-320` … `mp3-128`, `m4a`, `opus`.
    pub(crate) fn parse(s: &str) -> Option<Self> {
        match s {
            "original" => Some(Self::Original),
            "mp3-v0" => Some(Self::Mp3V0),
            "m4a" => Some(Self::M4a),
            "opus" => Some(Self::Opus),
            _ => {
                let rate: u32 = s.strip_prefix("mp3-")?.parse().ok()?;
                MP3_RATES.contains(&rate).then_some(Self::Mp3(rate))
            }
        }
    }

    /// The setting before 2.7 was a format alone (`mp3`, `m4a`, `opus`), each
    /// at the best quality.
    pub(crate) fn from_legacy_format(format: &str) -> Self {
        match format {
            "m4a" => Self::M4a,
            "opus" => Self::Opus,
            _ => Self::Mp3V0,
        }
    }

    /// yt-dlp's arguments after `-f` (when a dub was chosen). `-x` alone uses
    /// `--audio-format best`, which only remuxes.
    pub(crate) fn args(self) -> Vec<String> {
        let mut args = vec!["--extract-audio".to_string()];
        let (format, quality) = match self {
            Self::Original => return args,
            Self::Mp3V0 => ("mp3", "0".to_string()),
            Self::Mp3(kbps) => ("mp3", format!("{kbps}K")),
            Self::M4a => ("m4a", "0".to_string()),
            Self::Opus => ("opus", "0".to_string()),
        };
        args.extend(["--audio-format".into(), format.into(), "--audio-quality".into(), quality]);
        args
    }
}

/// The audio stream yt-dlp's `bestaudio` would most likely pick, for the
/// details dialog: "Source: Opus 160 kbps".
#[derive(Debug, Clone, PartialEq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioSource {
    pub codec: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kbps: Option<u32>,
}

/// A codec name people know, from yt-dlp's `acodec` (`opus`, `mp4a.40.2`).
fn codec_name(acodec: &str) -> String {
    let a = acodec.to_ascii_lowercase();
    let name = if a.starts_with("opus") {
        "Opus"
    } else if a.starts_with("mp4a") || a.starts_with("aac") {
        "AAC"
    } else if a.starts_with("vorbis") {
        "Vorbis"
    } else if a.starts_with("mp3") {
        "MP3"
    } else if a.starts_with("flac") {
        "FLAC"
    } else if a.starts_with("ec-3") || a.starts_with("eac3") {
        "E-AC-3"
    } else if a.starts_with("ac-3") || a.starts_with("ac3") {
        "AC-3"
    } else {
        return acodec.split('.').next().unwrap_or(acodec).to_string();
    };
    name.to_string()
}

fn is_audio_only(f: &YtDlpFormat) -> bool {
    f.vcodec.as_deref() == Some("none") && f.acodec.as_deref().is_some_and(|a| a != "none")
}

/// yt-dlp's own ranking of audio codecs (`--format-sort`'s acodec order),
/// for when it didn't say which stream it would take.
fn codec_rank(acodec: &str) -> u8 {
    const ORDER: [&str; 9] = ["flac", "alac", "opus", "vorbis", "aac", "mp4a", "mp3", "ec-3", "ac-3"];
    let a = acodec.to_ascii_lowercase();
    ORDER.iter().position(|c| a.starts_with(c)).map_or(0, |i| (ORDER.len() - i) as u8)
}

/// The stream an audio-only download starts from. yt-dlp's lookup says which
/// it would take (`requested_formats`, whose audio half is `bestaudio`); when
/// it doesn't, rank the audio-only streams as it would: the original
/// language, then codec, then bitrate. A higher-bitrate AAC loses to Opus
/// there (YouTube's 130k AAC vs 106k Opus). None when the site serves audio
/// only inside the video.
pub(crate) fn best_source(formats: &[YtDlpFormat], requested: &[YtDlpFormat]) -> Option<AudioSource> {
    let pick = requested.iter().find(|f| is_audio_only(f)).or_else(|| {
        let audio: Vec<&YtDlpFormat> = formats.iter().filter(|f| is_audio_only(f)).collect();
        let top_pref = audio.iter().filter_map(|f| f.language_preference).max();
        audio
            .into_iter()
            .filter(|f| top_pref.is_none() || f.language_preference == top_pref)
            .max_by(|a, b| {
                codec_rank(a.acodec.as_deref().unwrap_or(""))
                    .cmp(&codec_rank(b.acodec.as_deref().unwrap_or("")))
                    .then(a.abr.unwrap_or(0.0).total_cmp(&b.abr.unwrap_or(0.0)))
            })
    })?;
    Some(AudioSource {
        codec: codec_name(pick.acodec.as_deref().unwrap_or("")),
        kbps: pick.abr.filter(|r| *r > 0.0).map(|r| r.round() as u32),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_the_whitelist() {
        assert_eq!(AudioQuality::parse("original"), Some(AudioQuality::Original));
        assert_eq!(AudioQuality::parse("mp3-v0"), Some(AudioQuality::Mp3V0));
        assert_eq!(AudioQuality::parse("mp3-320"), Some(AudioQuality::Mp3(320)));
        assert_eq!(AudioQuality::parse("mp3-128"), Some(AudioQuality::Mp3(128)));
        assert_eq!(AudioQuality::parse("opus"), Some(AudioQuality::Opus));
        for bad in ["mp3-999", "mp3-", "mp3", "flac", "wav", "mp3-320 --exec x", "", "ORIGINAL"] {
            assert_eq!(AudioQuality::parse(bad), None, "{bad}");
        }
    }

    #[test]
    fn arguments_for_each_choice() {
        assert_eq!(AudioQuality::Original.args(), vec!["--extract-audio"]);
        assert_eq!(
            AudioQuality::Mp3V0.args(),
            vec!["--extract-audio", "--audio-format", "mp3", "--audio-quality", "0"]
        );
        assert_eq!(
            AudioQuality::Mp3(192).args(),
            vec!["--extract-audio", "--audio-format", "mp3", "--audio-quality", "192K"]
        );
        assert_eq!(
            AudioQuality::M4a.args(),
            vec!["--extract-audio", "--audio-format", "m4a", "--audio-quality", "0"]
        );
        assert_eq!(
            AudioQuality::Opus.args(),
            vec!["--extract-audio", "--audio-format", "opus", "--audio-quality", "0"]
        );
    }

    #[test]
    fn legacy_formats_keep_their_meaning() {
        assert_eq!(AudioQuality::from_legacy_format("mp3"), AudioQuality::Mp3V0);
        assert_eq!(AudioQuality::from_legacy_format("m4a"), AudioQuality::M4a);
        assert_eq!(AudioQuality::from_legacy_format("opus"), AudioQuality::Opus);
        assert_eq!(AudioQuality::from_legacy_format("junk"), AudioQuality::Mp3V0);
    }

    fn fmt(acodec: &str, abr: f64, pref: Option<i64>) -> YtDlpFormat {
        YtDlpFormat {
            vcodec: Some("none".into()),
            acodec: Some(acodec.into()),
            abr: Some(abr),
            language_preference: pref,
            ..Default::default()
        }
    }

    #[test]
    fn best_source_is_what_yt_dlp_said_it_would_take() {
        let formats = vec![fmt("mp4a.40.2", 129.5, Some(10)), fmt("opus", 106.0, Some(10))];
        let video = YtDlpFormat { vcodec: Some("av01".into()), acodec: Some("none".into()), ..Default::default() };
        let requested = vec![video, fmt("mp4a.40.2", 129.5, Some(10))];
        assert_eq!(best_source(&formats, &requested), Some(AudioSource { codec: "AAC".into(), kbps: Some(130) }));
    }

    #[test]
    fn best_source_ranks_like_yt_dlp_when_it_did_not_say() {
        // YouTube's real pair: Opus wins over a higher-bitrate AAC.
        let formats = vec![
            fmt("mp4a.40.2", 129.5, Some(10)),
            fmt("opus", 106.2, Some(10)),
            fmt("opus", 47.0, Some(10)),
            fmt("opus", 160.0, Some(-1)), // a dub
            YtDlpFormat { vcodec: Some("avc1".into()), acodec: Some("mp4a.40.2".into()), abr: Some(192.0), ..Default::default() },
        ];
        assert_eq!(best_source(&formats, &[]), Some(AudioSource { codec: "Opus".into(), kbps: Some(106) }));
    }

    #[test]
    fn best_source_without_languages_or_audio_streams() {
        assert_eq!(
            best_source(&[fmt("mp4a.40.5", 48.0, None), fmt("mp4a.40.2", 128.0, None)], &[]),
            Some(AudioSource { codec: "AAC".into(), kbps: Some(128) })
        );
        let muxed = YtDlpFormat { vcodec: Some("avc1".into()), acodec: Some("mp4a.40.2".into()), ..Default::default() };
        assert_eq!(best_source(&[muxed], &[]), None);
    }
}
