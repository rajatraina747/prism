//! Filename templates: how a finished download is named and where it lands
//! under its destination.
//!
//! A template is plain text with `{token}` placeholders, for example
//! `{uploader}/{date:YYYY-MM-DD} {title}`. A `/` in the template makes a
//! subfolder. Every value comes from a website or a server, so values can never
//! create folders (a `/` inside a title becomes `-`), and each rendered path
//! component is cleaned on its own: no reserved characters, no `.` or `..`,
//! no leading dots, no Windows device names, no trailing dots or spaces, and a
//! bounded length. The result is always a relative path that stays inside the
//! destination; callers still validate the joined path.

use std::path::{Path, PathBuf};

use serde::Deserialize;

pub const DEFAULT_TEMPLATE: &str = "{title}";

/// Longest single file or folder name produced (bytes vary; this is chars).
const MAX_COMPONENT: usize = 200;
/// Deepest subfolder nesting a template may create.
const MAX_DEPTH: usize = 8;

const TOKENS: &[&str] = &["title", "uploader", "site", "id", "date", "resolution", "filename", "name", "category"];

/// The values one download offers. Missing values render as nothing, and a
/// path component that ends up empty is dropped.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateVars {
    pub title: Option<String>,
    pub uploader: Option<String>,
    /// The site's host, e.g. `youtube.com`.
    pub site: Option<String>,
    /// The site's id for the item.
    pub id: Option<String>,
    /// `YYYYMMDD` (yt-dlp's `upload_date`) or an RFC 3339 timestamp.
    pub date: Option<String>,
    /// e.g. `1080p`.
    pub resolution: Option<String>,
    /// The server's file name for direct links, extension included.
    pub filename: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TemplateError {
    UnknownToken(String),
    Unclosed,
    Empty,
}

impl std::fmt::Display for TemplateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TemplateError::UnknownToken(name) => write!(f, "Unknown placeholder {{{name}}}"),
            TemplateError::Unclosed => f.write_str("A { has no matching }"),
            TemplateError::Empty => f.write_str("The template is empty"),
        }
    }
}

enum Piece<'a> {
    Text(&'a str),
    Token(&'a str, Option<&'a str>),
}

fn parse(template: &str) -> Result<Vec<Piece<'_>>, TemplateError> {
    let mut pieces = Vec::new();
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        if open > 0 {
            pieces.push(Piece::Text(&rest[..open]));
        }
        let after = &rest[open + 1..];
        let close = after.find('}').ok_or(TemplateError::Unclosed)?;
        let inner = &after[..close];
        let (name, format) = match inner.split_once(':') {
            Some((name, format)) => (name, Some(format)),
            None => (inner, None),
        };
        if !TOKENS.contains(&name) {
            return Err(TemplateError::UnknownToken(name.to_string()));
        }
        pieces.push(Piece::Token(name, format));
        rest = &after[close + 1..];
    }
    if rest.contains('}') {
        return Err(TemplateError::Unclosed);
    }
    if !rest.is_empty() {
        pieces.push(Piece::Text(rest));
    }
    if pieces.iter().all(|p| matches!(p, Piece::Text(t) if t.trim().is_empty())) {
        return Err(TemplateError::Empty);
    }
    Ok(pieces)
}

/// Check a template without rendering it (Settings validates as you type).
pub fn validate(template: &str) -> Result<(), TemplateError> {
    parse(template).map(|_| ())
}

/// Render `template` into a relative path. When everything renders empty,
/// falls back to the title, then to `download`.
pub fn render(template: &str, vars: &TemplateVars) -> Result<PathBuf, TemplateError> {
    let mut text = String::new();
    for piece in parse(template)? {
        match piece {
            Piece::Text(literal) => text.push_str(literal),
            Piece::Token(name, format) => text.push_str(&value(name, format, vars)),
        }
    }
    let mut path = PathBuf::new();
    for component in text.split(['/', '\\']).map(clean_component).filter(|c| !c.is_empty()).take(MAX_DEPTH) {
        path.push(component);
    }
    if path.as_os_str().is_empty() {
        let fallback = clean_component(vars.title.as_deref().unwrap_or_default());
        path.push(if fallback.is_empty() { "download".to_string() } else { fallback });
    }
    Ok(path)
}

/// Settings → Storage: check a template and show the path it produces for
/// sample values. An empty template means the default.
#[tauri::command]
pub fn preview_filename_template(template: String, vars: TemplateVars) -> Result<String, String> {
    let template = if template.trim().is_empty() { DEFAULT_TEMPLATE } else { template.as_str() };
    validate(template).map_err(|e| e.to_string())?;
    render(template, &vars)
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .map_err(|e| e.to_string())
}

/// A token's value, with path separators neutralised: values never make folders.
fn value(name: &str, format: Option<&str>, vars: &TemplateVars) -> String {
    let raw = match name {
        "title" => vars.title.clone(),
        "uploader" => vars.uploader.clone(),
        "site" => vars.site.clone(),
        "id" => vars.id.clone(),
        "resolution" => vars.resolution.clone(),
        "filename" => vars.filename.clone(),
        "name" => vars
            .filename
            .as_deref()
            .and_then(|f| Path::new(f).file_stem())
            .map(|s| s.to_string_lossy().into_owned()),
        "category" => vars.category.clone(),
        "date" => vars.date.as_deref().and_then(|d| format_date(d, format.unwrap_or("YYYY-MM-DD"))),
        _ => None,
    };
    raw.unwrap_or_default().replace(['/', '\\'], "-")
}

/// `20260915` or `2026-09-15T…` rendered with `YYYY`, `MM` and `DD` in `format`.
fn format_date(date: &str, format: &str) -> Option<String> {
    let digits: String = date.chars().filter(char::is_ascii_digit).take(8).collect();
    if digits.len() < 8 {
        return None;
    }
    let (year, month, day) = (&digits[0..4], &digits[4..6], &digits[6..8]);
    Some(format.replace("YYYY", year).replace("MM", month).replace("DD", day))
}

fn clean_component(raw: &str) -> String {
    const RESERVED: &[char] = &['<', '>', ':', '"', '|', '?', '*'];
    let cleaned: String = raw
        .chars()
        .map(|c| if RESERVED.contains(&c) || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.').trim_end_matches(['.', ' ']).trim();
    let mut out: String = trimmed.chars().take(MAX_COMPONENT).collect();
    out = out.trim_end_matches(['.', ' ']).to_string();
    if is_windows_device_name(&out) {
        out.insert(0, '_');
    }
    out
}

/// `CON`, `nul.txt`, `COM1`, `lpt9.log`… are unusable file names on Windows.
fn is_windows_device_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or_default().trim_end().to_ascii_uppercase();
    match stem.as_str() {
        "CON" | "PRN" | "AUX" | "NUL" => true,
        s if s.len() == 4 && (s.starts_with("COM") || s.starts_with("LPT")) => {
            matches!(s.as_bytes()[3], b'1'..=b'9')
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Component;

    fn vars() -> TemplateVars {
        TemplateVars {
            title: Some("Never Gonna Give You Up".into()),
            uploader: Some("Rick Astley".into()),
            site: Some("youtube.com".into()),
            id: Some("dQw4w9WgXcQ".into()),
            date: Some("20091025".into()),
            resolution: Some("1080p".into()),
            filename: None,
            category: Some("Music".into()),
        }
    }

    fn rendered(template: &str, v: &TemplateVars) -> String {
        render(template, v).unwrap().to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn renders_tokens_and_subfolders() {
        assert_eq!(rendered(DEFAULT_TEMPLATE, &vars()), "Never Gonna Give You Up");
        assert_eq!(
            rendered("{category}/{uploader}/{date:YYYY-MM-DD} {title} [{resolution}]", &vars()),
            "Music/Rick Astley/2009-10-25 Never Gonna Give You Up [1080p]"
        );
        assert_eq!(rendered("{date:YYYY}/{id}", &vars()), "2009/dQw4w9WgXcQ");
    }

    #[test]
    fn values_never_create_folders() {
        let v = TemplateVars { title: Some("AC/DC \\ Back in Black".into()), ..vars() };
        assert_eq!(rendered("{title}", &v), "AC-DC - Back in Black");
    }

    #[test]
    fn missing_values_drop_their_folder() {
        let v = TemplateVars { uploader: None, ..vars() };
        assert_eq!(rendered("{uploader}/{title}", &v), "Never Gonna Give You Up");
        let empty = TemplateVars::default();
        assert_eq!(rendered("{uploader}", &empty), "download");
    }

    #[test]
    fn stays_inside_the_destination() {
        let v = TemplateVars { title: Some("../../etc/passwd".into()), uploader: Some("..".into()), ..vars() };
        for template in ["{title}", "../{title}", "{uploader}/{title}", "/abs/{title}", "..\\..\\{title}"] {
            let path = render(template, &v).unwrap();
            assert!(path.is_relative(), "{template} → {path:?}");
            assert!(
                path.components().all(|c| matches!(c, Component::Normal(_))),
                "{template} → {path:?}"
            );
        }
    }

    #[test]
    fn cleans_names_every_platform_can_store() {
        let v = TemplateVars { title: Some("what? \"quoted\" <tags> *star*: done...  ".into()), ..vars() };
        assert_eq!(rendered("{title}", &v), "what_ _quoted_ _tags_ _star__ done");
        let device = TemplateVars { title: Some("CON".into()), ..vars() };
        assert_eq!(rendered("{title}", &device), "_CON");
        let port = TemplateVars { title: Some("com1.txt".into()), ..vars() };
        assert_eq!(rendered("{title}", &port), "_com1.txt");
        let hidden = TemplateVars { title: Some(".bashrc".into()), ..vars() };
        assert_eq!(rendered("{title}", &hidden), "bashrc");
        let long = TemplateVars { title: Some("x".repeat(500)), ..vars() };
        assert_eq!(rendered("{title}", &long).chars().count(), MAX_COMPONENT);
    }

    #[test]
    fn name_is_the_filename_without_its_extension() {
        let v = TemplateVars { filename: Some("debian-13.5.0-amd64-netinst.iso".into()), ..TemplateVars::default() };
        assert_eq!(rendered("{name}", &v), "debian-13.5.0-amd64-netinst");
        assert_eq!(rendered("isos/{filename}", &v), "isos/debian-13.5.0-amd64-netinst.iso");
    }

    #[test]
    fn dates_accept_rfc3339_and_reject_garbage() {
        let v = TemplateVars { date: Some("2026-09-15T10:00:00Z".into()), ..vars() };
        assert_eq!(rendered("{date:DD.MM.YYYY}", &v), "15.09.2026");
        let bad = TemplateVars { date: Some("soon".into()), ..vars() };
        assert_eq!(rendered("{date}/{title}", &bad), "Never Gonna Give You Up");
    }

    #[test]
    fn reports_template_mistakes() {
        assert_eq!(validate("{titel}"), Err(TemplateError::UnknownToken("titel".into())));
        assert_eq!(validate("{title"), Err(TemplateError::Unclosed));
        assert_eq!(validate("title}"), Err(TemplateError::Unclosed));
        assert_eq!(validate("   "), Err(TemplateError::Empty));
        assert!(validate("{uploader}/{title}").is_ok());
    }

    #[test]
    fn caps_folder_depth() {
        let template = (0..20).map(|i| format!("d{i}")).collect::<Vec<_>>().join("/") + "/{title}";
        assert_eq!(render(&template, &vars()).unwrap().components().count(), MAX_DEPTH);
    }
}
