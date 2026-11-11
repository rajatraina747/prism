//! Text that Rust shows itself: the app and tray menus, window titles, the
//! quit dialog and system notifications. It comes from the same catalog as
//! the interface (`src/locales/en/native.json`, keys `native.*` there), built
//! into the binary, with i18next's rules: `{{name}}` placeholders, and a
//! `count` picking `key_one` or `key_other`.
//!
//! English only for now, like the interface. A missing key returns the key
//! itself, which the tests below rule out for every key Rust uses.

use std::collections::HashMap;
use std::sync::LazyLock;

use serde_json::Value;

static EN: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/locales/en/native.json"))
        .expect("src/locales/en/native.json is valid JSON")
});

/// Keys are written as the interface writes them (`native.menu.quit`); the
/// file is the `native` area, so its top level starts one step down.
fn lookup(key: &str) -> Option<&'static str> {
    key.strip_prefix("native.")?
        .split('.')
        .try_fold(&*EN, |node, part| node.get(part))?
        .as_str()
}

fn interpolate(template: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let name = after[..end].trim();
                match vars.get(name) {
                    Some(v) => out.push_str(v),
                    None => out.push_str(&rest[start..start + 2 + end + 2]),
                }
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[start..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// A string with no placeholders.
pub(crate) fn t(key: &str) -> String {
    lookup(key).map(str::to_string).unwrap_or_else(|| key.to_string())
}

/// A string with placeholders. A `count` var selects the plural form.
pub(crate) fn t_with(key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    let vars: HashMap<&str, String> = vars.iter().map(|(k, v)| (*k, v.to_string())).collect();
    let template = vars
        .get("count")
        .and_then(|c| {
            let form = if c == "1" { "one" } else { "other" };
            lookup(&format!("{key}_{form}"))
        })
        .or_else(|| lookup(key));
    match template {
        Some(tpl) => interpolate(tpl, &vars),
        None => key.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every `"native.…"` key in the Rust source exists, so
    /// a typo fails here instead of showing "native.menu.qiut" in a menu.
    #[test]
    fn every_used_key_exists() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut used = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "rs") && !path.ends_with("i18n.rs") {
                let text = std::fs::read_to_string(&path).unwrap();
                // Every "native.…" literal: the t() calls and NAV_ITEMS' keys.
                for (i, _) in text.match_indices("\"native.") {
                    let key: String = text[i + 1..].chars().take_while(|c| *c != '"').collect();
                    used.push(key);
                }
            }
        }
        assert!(used.len() >= 20, "the scan found {} keys; it should find every menu item", used.len());
        let missing: Vec<_> = used
            .iter()
            .filter(|k| lookup(k).is_none() && lookup(&format!("{k}_other")).is_none())
            .collect();
        assert!(missing.is_empty(), "missing from native.json: {missing:?}");
    }

    #[test]
    fn placeholders_and_plurals() {
        assert_eq!(
            t_with("native.quit.prompt", &[("count", &1)]),
            "1 transfer is still running. Quitting stops it; it resumes the next time Prism starts."
        );
        assert_eq!(
            t_with("native.quit.prompt", &[("count", &3)]),
            "3 transfers are still running. Quitting stops them; they resume the next time Prism starts."
        );
        assert_eq!(interpolate("a {{x}} b {{missing}}", &HashMap::from([("x", "1".to_string())])), "a 1 b {{missing}}");
        assert_eq!(t("native.no.such.key"), "native.no.such.key");
    }
}
