//! macOS integration for the embedded player.
//!
//! mpv's `--wid` support on macOS is minimal and, with current libmpv (0.41),
//! it ends up creating its **own borderless NSWindow** for the video instead
//! of embedding a subview into the NSView it was handed. mpv's docs recommend
//! the render API on macOS for this reason; until tauri-plugin-libmpv grows a
//! render-API mode, we "fake-embed" the classic way:
//!
//!   1. find mpv's video window among the app's windows,
//!   2. adopt it as a *child window* of the player window, ordered BELOW it —
//!      child windows track their parent's moves, and sitting underneath the
//!      transparent player window means the webview's controls stay visible
//!      and receive all clicks,
//!   3. pin its frame to the player's content rect, and re-pin on every
//!      resize (see the `on_window_event` hook in lib.rs).

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    use objc2_core_foundation::CGRect;

    /// NSWindowOrderingMode: NSWindowBelow
    const NS_WINDOW_BELOW: isize = -1;

    /// Window classes that must never be adopted (tray/status, menus, panels).
    fn is_system_window(class_name: &str) -> bool {
        ["StatusBar", "Menu", "Panel", "Popover", "Sheet"]
            .iter()
            .any(|s| class_name.contains(s))
    }

    /// Pin `child`'s frame to `parent`'s content rect, and re-assert that it
    /// draws BELOW the parent. Simple fullscreen raises the parent's window
    /// level without touching the child's, which flips the video above the
    /// webview and hides the controls — matching the level and re-ordering on
    /// every refit keeps controls on top in all modes.
    ///
    /// Safety: main thread only.
    unsafe fn refit(child: *mut AnyObject, parent: *mut AnyObject) {
        let frame: CGRect = msg_send![parent, frame];
        let content: CGRect = msg_send![parent, contentRectForFrameRect: frame];
        let _: () = msg_send![child, setFrame: content, display: true];

        let level: isize = msg_send![parent, level];
        let _: () = msg_send![child, setLevel: level];
        let parent_num: isize = msg_send![parent, windowNumber];
        let _: () = msg_send![child, orderWindow: NS_WINDOW_BELOW, relativeTo: parent_num];
    }

    /// Re-pin all adopted children (called on player window resizes).
    ///
    /// Safety: main thread only.
    pub unsafe fn refit_children(player_ns: *mut AnyObject) {
        let children: *mut AnyObject = msg_send![player_ns, childWindows];
        if children.is_null() {
            return;
        }
        let count: usize = msg_send![children, count];
        for i in 0..count {
            let child: *mut AnyObject = msg_send![children, objectAtIndex: i];
            refit(child, player_ns);
        }
    }

    pub struct AdoptOutcome {
        /// A video window is parented to the player (found now or previously).
        pub adopted: bool,
        /// Class names of the windows considered (diagnostics).
        pub windows: Vec<String>,
    }

    /// One adoption pass over the app's windows.
    ///
    /// Safety: main thread only.
    pub unsafe fn adopt_video_window(
        player_ns: *mut AnyObject,
        other_tauri: &[*mut AnyObject],
    ) -> AdoptOutcome {
        let nsapp: *mut AnyObject =
            msg_send![objc2::class!(NSApplication), sharedApplication];
        let windows: *mut AnyObject = msg_send![nsapp, windows];
        let count: usize = msg_send![windows, count];

        let mut names = Vec::with_capacity(count);
        let mut adopted = false;

        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            if w == player_ns || other_tauri.contains(&w) {
                continue;
            }
            let name = (*w).class().name().to_string_lossy().into_owned();
            if is_system_window(&name) {
                names.push(name);
                continue;
            }
            let visible: bool = msg_send![w, isVisible];
            let parent: *mut AnyObject = msg_send![w, parentWindow];
            if parent == player_ns {
                // Already ours (e.g. a later retry) — just re-pin.
                refit(w, player_ns);
                adopted = true;
            } else if visible && parent.is_null() {
                let _: () =
                    msg_send![player_ns, addChildWindow: w, ordered: NS_WINDOW_BELOW];
                // The webview above handles ALL input; the video window must
                // never take clicks or key focus (a focused video window eats
                // the keyboard shortcuts).
                let _: () = msg_send![w, setIgnoresMouseEvents: true];
                // The green traffic light must not native-fullscreen the
                // player into its own Space — the adopted child can't follow,
                // leaving a black stranded desktop. Strip fullscreen from the
                // parent's collection behavior (our ⤢ uses simple fullscreen,
                // which doesn't involve Spaces). FullScreenPrimary = 1<<7,
                // FullScreenAuxiliary = 1<<8, FullScreenNone = 1<<9.
                let cb: usize = msg_send![player_ns, collectionBehavior];
                let cb = (cb & !((1usize << 7) | (1usize << 8))) | (1usize << 9);
                let _: () = msg_send![player_ns, setCollectionBehavior: cb];
                refit(w, player_ns);
                adopted = true;
            }
            names.push(name);
        }

        AdoptOutcome { adopted, windows: names }
    }
}

/// Adopt mpv's standalone video window under the "player" window (see module
/// docs). Retries briefly: mpv creates its window asynchronously after init.
/// Returns the class names of the windows considered, for diagnostics.
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn fixup_player_video(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    use tauri::Manager;

    let player = app
        .get_webview_window("player")
        .ok_or("player window not found")?;
    // Tauri windows must never be adopted; collect their handles for exclusion.
    let other: Vec<usize> = app
        .webview_windows()
        .values()
        .filter(|w| w.label() != "player")
        .filter_map(|w| w.ns_window().ok().map(|p| p as usize))
        .collect();

    let mut last: Vec<String> = Vec::new();
    for _ in 0..25 {
        let (tx, rx) = std::sync::mpsc::channel();
        let p = player.clone();
        let other = other.clone();
        player
            .run_on_main_thread(move || {
                let result = (|| -> Result<macos::AdoptOutcome, String> {
                    let ns = p.ns_window().map_err(|e| e.to_string())?
                        as *mut objc2::runtime::AnyObject;
                    let other_ptrs: Vec<*mut objc2::runtime::AnyObject> =
                        other.iter().map(|&u| u as *mut _).collect();
                    Ok(unsafe { macos::adopt_video_window(ns, &other_ptrs) })
                })();
                let _ = tx.send(result);
            })
            .map_err(|e| e.to_string())?;
        match rx.recv().map_err(|e| e.to_string())? {
            Ok(outcome) => {
                if outcome.adopted {
                    return Ok(outcome.windows);
                }
                last = outcome.windows;
            }
            Err(e) => return Err(e),
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
    Ok(last)
}

/// Keep the adopted video window pinned to the player's content rect. Wired
/// to the player window's Resized event in lib.rs (moves need no handling —
/// child windows track their parent).
#[cfg(target_os = "macos")]
pub fn refit_player_children(window: &tauri::Window) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(ns) = w.ns_window() {
            unsafe { macos::refit_children(ns as *mut objc2::runtime::AnyObject) };
        }
    });
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn fixup_player_video(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    // Windows parents the HWND properly; nothing to patch.
    Ok(Vec::new())
}

// ── Player commands ──────────────────────────────────────────────────
//
// The vendored plugin exposes a raw mpv passthrough (`command`, `set_property`,
// `init` with arbitrary options). mpv's `run`/`subprocess` commands execute
// programs, `loadfile ytdl://` shells out, `load-script` runs Lua — so a
// script injection in the player window would have been code execution.
// The player capability therefore grants NONE of the plugin's commands; the
// webview only gets these, which allowlist every verb, property and value,
// validate media paths like `open_file`, and start mpv with config files,
// scripts and the ytdl hook disabled.

use tauri::AppHandle;
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

const PLAYER_LABEL: &str = "player";

fn ensure_player_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != PLAYER_LABEL {
        return Err("Player commands are only available to the player window".into());
    }
    Ok(())
}

/// Every mpv FFI call must run on the main thread on macOS (see the vendor
/// patch in commands.rs); this mirrors that without blocking a worker.
async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.await
        .map_err(|_| "main-thread task was dropped before completing".to_string())
}

/// Options mpv starts with. Fixed here, not in the webview.
fn player_mpv_config(app: &AppHandle) -> Result<MpvConfig, String> {
    use tauri::Manager;
    let mut initial = serde_json::Map::new();
    // mpv's own log — the only record of why a video output failed to come
    // up. Lands beside the app's data so a user can send it.
    if let Ok(dir) = app.path().app_data_dir() {
        initial.insert(
            "log-file".into(),
            serde_json::json!(dir.join("mpv.log").to_string_lossy()),
        );
    }
    let fixed: &[(&str, &str)] = &[
        ("vo", "gpu-next"),
        ("hwdec", "auto-safe"),
        // Survive EOF so the user can replay instead of the window dying.
        ("keep-open", "yes"),
        ("force-window", "yes"),
        // mpv resizes its (adopted — see above) window to each video's native
        // size on load, breaking the frame pinning.
        ("auto-window-resize", "no"),
        // HDR: hint the source's colorspace to the display. On macOS this
        // drives EDR, so HDR content renders as true HDR on capable panels.
        ("target-colorspace-hint", "yes"),
        // The webview owns all input and chrome.
        ("input-default-bindings", "no"),
        ("osc", "no"),
        // Lockdown: no user config, no Lua/JS scripts, no youtube-dl hook.
        // Playback is identical on every machine and nothing outside this
        // binary can add behaviour to the player.
        ("config", "no"),
        ("load-scripts", "no"),
        ("ytdl", "no"),
    ];
    for (k, v) in fixed {
        initial.insert((*k).into(), serde_json::json!(v));
    }
    let observed = serde_json::json!({
        "pause": "flag",
        "time-pos": "double",
        "duration": "double",
        "volume": "double",
        "mute": "flag",
        "speed": "double",
        "track-list": "node",
        "media-title": "string",
        "video-params": "node",
        "eof-reached": "flag",
    });
    serde_json::from_value(serde_json::json!({
        "initialOptions": initial,
        "observedProperties": observed,
    }))
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn player_init(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    ensure_player_window(&window)?;
    // Fail with a clear message before touching the plugin's library loader.
    if !player_available(app.clone()) {
        return Err("The built-in player isn't included in this build of Prism".into());
    }
    let cfg = player_mpv_config(&app)?;
    let app2 = app.clone();
    on_main(&app, move || {
        app2.mpv()
            .init(cfg, PLAYER_LABEL)
            .map(|_| ())
            .map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
pub async fn player_destroy(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    ensure_player_window(&window)?;
    let app2 = app.clone();
    on_main(&app, move || app2.mpv().destroy(PLAYER_LABEL).map_err(|e| e.to_string())).await?
}

/// Load a local media file and start playback. Same path rules as `open_file`:
/// inside the allowed roots, not a system location, a media/subtitle type.
#[tauri::command]
pub async fn player_load(app: AppHandle, window: tauri::Window, path: String) -> Result<(), String> {
    ensure_player_window(&window)?;
    let validated = crate::validate_open_path(&path, false, &crate::picked_dirs(&app))?;
    if !crate::is_openable_media(&validated) {
        return Err("The player only opens media files".into());
    }
    let app2 = app.clone();
    on_main(&app, move || {
        let mpv = app2.mpv();
        mpv.command("loadfile", &vec![serde_json::json!(validated)], PLAYER_LABEL)
            .map_err(|e| e.to_string())?;
        mpv.set_property("pause", &serde_json::json!("no"), PLAYER_LABEL)
            .map_err(|e| e.to_string())
    })
    .await?
}

#[tauri::command]
pub async fn player_seek(
    app: AppHandle,
    window: tauri::Window,
    seconds: f64,
    relative: bool,
) -> Result<(), String> {
    ensure_player_window(&window)?;
    if !seconds.is_finite() {
        return Err("Invalid seek position".into());
    }
    let mode = if relative { "relative" } else { "absolute" };
    let app2 = app.clone();
    on_main(&app, move || {
        app2.mpv()
            .command(
                "seek",
                &vec![serde_json::json!(seconds), serde_json::json!(mode)],
                PLAYER_LABEL,
            )
            .map_err(|e| e.to_string())
    })
    .await?
}

/// The only properties the UI may set, each with its value shape checked.
pub(crate) fn validate_player_property(
    name: &str,
    value: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let bad = || format!("Invalid value for player property '{}'", name);
    match name {
        "pause" | "mute" => match value {
            Value::Bool(b) => Ok(Value::String(if *b { "yes" } else { "no" }.into())),
            Value::String(s) if s == "yes" || s == "no" => Ok(value.clone()),
            _ => Err(bad()),
        },
        "volume" => value
            .as_f64()
            .filter(|v| (0.0..=100.0).contains(v))
            .map(|v| serde_json::json!(v))
            .ok_or_else(bad),
        "speed" => value
            .as_f64()
            .filter(|v| (0.1..=4.0).contains(v))
            .map(|v| serde_json::json!(v))
            .ok_or_else(bad),
        // Track ids come from mpv's own track-list.
        "aid" | "sid" => match value {
            Value::String(s) if s == "no" || s == "auto" || s.parse::<u32>().is_ok() => {
                Ok(value.clone())
            }
            Value::Number(n) if n.as_u64().is_some() => Ok(Value::String(n.to_string())),
            _ => Err(bad()),
        },
        _ => Err(format!("Property '{}' is not settable from the player UI", name)),
    }
}

#[tauri::command]
pub async fn player_set(
    app: AppHandle,
    window: tauri::Window,
    name: String,
    value: serde_json::Value,
) -> Result<(), String> {
    ensure_player_window(&window)?;
    let value = validate_player_property(&name, &value)?;
    let app2 = app.clone();
    on_main(&app, move || {
        app2.mpv()
            .set_property(&name, &value, PLAYER_LABEL)
            .map_err(|e| e.to_string())
    })
    .await?
}

#[cfg(test)]
mod tests {
    use super::validate_player_property;
    use serde_json::json;

    #[test]
    fn player_properties_are_allowlisted_and_shape_checked() {
        assert_eq!(validate_player_property("pause", &json!(true)).unwrap(), json!("yes"));
        assert_eq!(validate_player_property("mute", &json!("no")).unwrap(), json!("no"));
        assert!(validate_player_property("pause", &json!("maybe")).is_err());
        assert_eq!(validate_player_property("volume", &json!(50)).unwrap(), json!(50.0));
        assert!(validate_player_property("volume", &json!(150)).is_err());
        assert!(validate_player_property("speed", &json!(0.0)).is_err());
        assert_eq!(validate_player_property("aid", &json!(2)).unwrap(), json!("2"));
        assert!(validate_player_property("aid", &json!("../x")).is_err());
        // The dangerous ones never pass, whatever the value.
        for p in ["input-ipc-server", "ytdl", "script", "load-scripts", "config", "wid"] {
            assert!(validate_player_property(p, &json!("x")).is_err(), "{p} must be rejected");
        }
    }
}

/// Whether the embedded player can run: the libmpv wrapper must be reachable —
/// next to the executable (dev builds stage it there, see build.rs) or in the
/// bundled resources (releases ship it under resources/lib; the vendored
/// plugin searches there too). The UI uses this to hide "Play in Prism"
/// instead of offering a player that can't start (e.g. Linux, where window
/// embedding isn't supported yet).
#[tauri::command]
pub fn player_available(app: tauri::AppHandle) -> bool {
    use tauri::Manager;

    #[cfg(target_os = "windows")]
    let name = "libmpv-wrapper.dll";
    #[cfg(target_os = "macos")]
    let name = "libmpv-wrapper.dylib";
    #[cfg(all(unix, not(target_os = "macos")))]
    let name = "libmpv-wrapper.so";

    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.to_path_buf());
            dirs.push(d.join("lib"));
        }
    }
    if let Ok(res) = app.path().resource_dir() {
        dirs.push(res.join("lib"));
        dirs.push(res);
    }
    dirs.iter().any(|d| d.join(name).exists())
}
