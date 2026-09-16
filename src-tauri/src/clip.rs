//! Downloading part of a video rather than all of it.
//!
//! yt-dlp takes a range as `--download-sections "*START-END"`. The timestamps
//! come from the webview, so they are validated into a shape that can only be
//! digits and colons before they are handed over. Arguments are passed as
//! argv rather than through a shell, so this is belt-and-braces — but a range
//! is user text reaching a command line, and the narrow rule is cheap.

use std::sync::OnceLock;

use regex::Regex;

/// Seconds, `MM:SS`, or `HH:MM:SS`, with optional fractional seconds. Nothing
/// else: no signs, no spaces, no letters, no `inf` from the user.
fn timestamp_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\d{1,3}(:[0-5]?\d){0,2}(\.\d{1,3})?$").expect("valid regex"))
}

/// A timestamp in seconds, or None when it isn't one Prism will accept.
fn to_seconds(raw: &str) -> Option<f64> {
    let text = raw.trim();
    if !timestamp_re().is_match(text) {
        return None;
    }
    let mut seconds = 0f64;
    for part in text.split(':') {
        let value: f64 = part.parse().ok()?;
        seconds = seconds * 60.0 + value;
    }
    Some(seconds)
}

/// The `--download-sections` argument for a range, or the reason it isn't one.
///
/// An absent end means "to the end of the video"; an absent start means "from
/// the beginning". Both absent is a mistake rather than a whole-video
/// download, because asking for a clip of everything is more likely a slip
/// than an intention.
pub(crate) fn section_arg(start: Option<&str>, end: Option<&str>) -> Result<String, String> {
    let start_text = start.map(str::trim).filter(|s| !s.is_empty());
    let end_text = end.map(str::trim).filter(|s| !s.is_empty());

    if start_text.is_none() && end_text.is_none() {
        return Err("Give a start time, an end time, or both".into());
    }

    let start_secs = match start_text {
        Some(text) => Some(
            to_seconds(text)
                .ok_or_else(|| format!("\"{text}\" isn't a time — try 1:23 or 0:01:23"))?,
        ),
        None => None,
    };
    let end_secs = match end_text {
        Some(text) => Some(
            to_seconds(text)
                .ok_or_else(|| format!("\"{text}\" isn't a time — try 1:23 or 0:01:23"))?,
        ),
        None => None,
    };

    if let (Some(from), Some(to)) = (start_secs, end_secs) {
        if to <= from {
            return Err("The end time has to come after the start time".into());
        }
    }

    // Written back out from the parsed seconds rather than echoing the input,
    // so whatever reaches yt-dlp is something this module produced.
    let from = start_secs.unwrap_or(0.0);
    Ok(match end_secs {
        Some(to) => format!("*{}-{}", trim_seconds(from), trim_seconds(to)),
        None => format!("*{}-inf", trim_seconds(from)),
    })
}

/// Seconds without a trailing `.0`, so whole seconds read as whole seconds.
fn trim_seconds(value: f64) -> String {
    if (value - value.round()).abs() < f64::EPSILON {
        format!("{}", value.round() as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_forms_a_person_would_type() {
        assert_eq!(section_arg(Some("90"), Some("120")).unwrap(), "*90-120");
        assert_eq!(section_arg(Some("1:30"), Some("2:00")).unwrap(), "*90-120");
        assert_eq!(section_arg(Some("0:01:30"), Some("0:02:00")).unwrap(), "*90-120");
    }

    #[test]
    fn an_open_end_runs_to_the_end_of_the_video() {
        assert_eq!(section_arg(Some("1:00"), None).unwrap(), "*60-inf");
        assert_eq!(section_arg(Some("1:00"), Some("  ")).unwrap(), "*60-inf");
    }

    #[test]
    fn an_open_start_runs_from_the_beginning() {
        assert_eq!(section_arg(None, Some("30")).unwrap(), "*0-30");
    }

    #[test]
    fn asking_for_a_clip_of_nothing_is_a_mistake() {
        assert!(section_arg(None, None).is_err());
        assert!(section_arg(Some(""), Some("")).is_err());
    }

    #[test]
    fn the_end_has_to_come_after_the_start() {
        assert!(section_arg(Some("2:00"), Some("1:00")).is_err());
        assert!(section_arg(Some("60"), Some("60")).is_err(), "an empty clip is not a clip");
    }

    #[test]
    fn refuses_anything_that_is_not_a_timestamp() {
        for bad in ["abc", "-5", "1:2:3:4", "1e3", "inf", "99:99", "1 30", "٣٠"] {
            assert!(section_arg(Some(bad), Some("5:00")).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn nothing_that_looks_like_an_option_or_a_shell_survives() {
        // These reach argv rather than a shell, so this is a second line of
        // defence — but the rule is what keeps it true if that ever changes.
        for bad in ["0-1 --exec rm -rf /", "$(id)", "`id`", "1;2", "--help", "*0-1"] {
            assert!(section_arg(Some(bad), None).is_err(), "accepted {bad}");
        }
    }

    #[test]
    fn fractional_seconds_survive_the_round_trip() {
        assert_eq!(section_arg(Some("1.5"), Some("2.5")).unwrap(), "*1.5-2.5");
    }
}
