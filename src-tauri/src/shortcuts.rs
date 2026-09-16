//! Optional system-wide hotkeys.
//!
//! Off unless the user assigns one. A global shortcut is taken away from every
//! other application on the machine for as long as Prism runs, so claiming one
//! nobody asked for isn't ours to do — every accelerator here defaults empty.
//!
//! Registration lives in Rust rather than the webview on purpose: the plugin's
//! own commands are never exposed over IPC, so `capabilities/default.json` —
//! which a test guards — never has to grant the page the ability to bind
//! arbitrary keys. The page asks for a set; this decides what happens.

use crate::errors::{ErrorCode, PrismError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Action names. These cross to the frontend as the event payload and must
/// match `ShortcutAction` in src/types/models.ts.
const ADD_FROM_CLIPBOARD: &str = "addFromClipboard";
const SHOW_PRISM: &str = "showPrism";
const PAUSE_ALL: &str = "pauseAll";

/// Mirrors `GlobalShortcuts` in src/types/models.ts. Empty means unassigned.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalShortcuts {
    pub add_from_clipboard: String,
    pub show_prism: String,
    pub pause_all: String,
}

impl GlobalShortcuts {
    /// The ones actually set, in a stable order.
    fn assigned(&self) -> Vec<(&'static str, &str)> {
        [
            (ADD_FROM_CLIPBOARD, self.add_from_clipboard.trim()),
            (SHOW_PRISM, self.show_prism.trim()),
            (PAUSE_ALL, self.pause_all.trim()),
        ]
        .into_iter()
        .filter(|(_, accelerator)| !accelerator.is_empty())
        .collect()
    }
}

/// Which action each registered hotkey id belongs to.
///
/// A static rather than managed state because the plugin is built before the
/// app is, and the handler only ever gets an `AppHandle` — there is no point
/// in the builder chain where managed state would already exist.
fn registered() -> &'static Mutex<HashMap<u32, &'static str>> {
    static MAP: OnceLock<Mutex<HashMap<u32, &'static str>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Validate a set of accelerators without touching the OS.
///
/// Split out so the rules — what parses, and what collides — are testable
/// without registering anything system-wide from a test run.
///
/// Collisions are caught on the parsed hotkey's id rather than the text, so
/// "Cmd+P" and "CommandOrControl+P" are recognised as the same key instead of
/// being handed to the OS as two bindings where the second quietly loses.
pub(crate) fn parse_bindings(
    shortcuts: &GlobalShortcuts,
) -> Result<Vec<(&'static str, Shortcut)>, String> {
    let mut out: Vec<(&'static str, Shortcut)> = Vec::new();
    for (action, accelerator) in shortcuts.assigned() {
        let shortcut = Shortcut::from_str(accelerator).map_err(|_| {
            format!(
                "\"{accelerator}\" isn't a shortcut Prism understands — try something like CmdOrCtrl+Shift+V"
            )
        })?;
        if let Some((taken, _)) = out.iter().find(|(_, other)| other.id() == shortcut.id()) {
            return Err(format!(
                "\"{accelerator}\" is already assigned to another Prism shortcut ({taken})"
            ));
        }
        out.push((action, shortcut));
    }
    Ok(out)
}

/// Replace every registered hotkey with this set.
///
/// The set is small and this is its only writer, so it is replaced wholesale
/// rather than diffed. If the OS refuses one, everything is unregistered again
/// — a half-applied set would leave the user with some shortcuts working and
/// no way to tell which.
pub(crate) fn apply<R: Runtime>(
    app: &AppHandle<R>,
    shortcuts: &GlobalShortcuts,
) -> Result<(), PrismError> {
    let bindings =
        parse_bindings(shortcuts).map_err(|m| PrismError::new(ErrorCode::InvalidInput, m))?;

    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    if let Ok(mut map) = registered().lock() {
        map.clear();
    }

    for (action, shortcut) in bindings {
        if let Err(e) = manager.register(shortcut) {
            let _ = manager.unregister_all();
            if let Ok(mut map) = registered().lock() {
                map.clear();
            }
            return Err(PrismError::new(
                ErrorCode::Busy,
                format!(
                    "Couldn't take that shortcut for \"{action}\" — another application is probably using it ({e})"
                ),
            ));
        }
        if let Ok(mut map) = registered().lock() {
            map.insert(shortcut.id(), action);
        }
    }
    Ok(())
}

/// Re-register whatever the user had set, at launch. Best effort: a shortcut
/// another app has taken since last time is worth a log line, not a failure
/// that stops Prism starting.
pub(crate) fn apply_saved(app: &AppHandle) {
    let Some(value) = crate::read_setting(app, "shortcuts") else {
        return;
    };
    match serde_json::from_value::<GlobalShortcuts>(value) {
        Ok(shortcuts) => {
            if let Err(e) = apply(app, &shortcuts) {
                log::warn!("shortcuts: not registered at startup: {e:?}");
            }
        }
        Err(e) => log::warn!("shortcuts: unreadable in settings.json: {e}"),
    }
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            // The handler is called for the press *and* the release. Acting on
            // both would run every action twice.
            if event.state != ShortcutState::Pressed {
                return;
            }
            let action = registered()
                .lock()
                .ok()
                .and_then(|map| map.get(&shortcut.id()).copied());
            let Some(action) = action else { return };

            // Raising the window is Rust's job and never crosses to the page:
            // the whole point of this shortcut is that it works when Prism is
            // hidden or minimised, and a webview in that state can't show
            // itself. The other actions are the page's to carry out.
            if action == SHOW_PRISM {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return;
            }
            let _ = app.emit("shortcut-action", action);
        })
        .build()
}

#[tauri::command]
pub async fn set_shortcuts(app: AppHandle, shortcuts: GlobalShortcuts) -> Result<(), PrismError> {
    apply(&app, &shortcuts)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(add: &str, show: &str, pause: &str) -> GlobalShortcuts {
        GlobalShortcuts {
            add_from_clipboard: add.into(),
            show_prism: show.into(),
            pause_all: pause.into(),
        }
    }

    #[test]
    fn nothing_assigned_binds_nothing() {
        // The default. Prism must not claim a system-wide key on its own.
        assert!(parse_bindings(&GlobalShortcuts::default()).unwrap().is_empty());
        // Whitespace is not an assignment either.
        assert!(parse_bindings(&set("   ", "", "")).unwrap().is_empty());
    }

    #[test]
    fn assigned_accelerators_are_parsed() {
        let bindings = parse_bindings(&set("CmdOrCtrl+Shift+V", "", "CmdOrCtrl+Shift+P")).unwrap();
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].0, ADD_FROM_CLIPBOARD);
        assert_eq!(bindings[1].0, PAUSE_ALL);
    }

    #[test]
    fn nonsense_is_refused_with_something_readable() {
        let err = parse_bindings(&set("Ctrl+", "", "")).unwrap_err();
        assert!(err.contains("isn't a shortcut Prism understands"), "{err}");
    }

    #[test]
    fn the_same_key_cannot_be_assigned_twice() {
        let err = parse_bindings(&set("CmdOrCtrl+Shift+V", "CmdOrCtrl+Shift+V", "")).unwrap_err();
        assert!(err.contains("already assigned"), "{err}");
    }

    #[test]
    fn a_collision_is_caught_even_when_spelled_differently() {
        // Two spellings of one key. Caught here rather than handed to the OS,
        // where the second registration would simply lose.
        let err = parse_bindings(&set("CmdOrCtrl+Shift+V", "CommandOrControl+Shift+V", ""));
        assert!(err.is_err(), "expected a collision, got {err:?}");
    }
}
