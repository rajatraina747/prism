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
#[allow(clippy::disallowed_methods)] // AppKit calls only — never mpv (see mpv_worker.rs)
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
        let (tx, rx) = tokio::sync::oneshot::channel();
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
        // Await, never block: a tokio worker parked in a blocking recv stays
        // parked for as long as the main thread is busy.
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .map_err(|_| "video-window adoption timed out waiting for the main thread".to_string())?
            .map_err(|_| "video-window adoption was dropped".to_string())?;
        match outcome {
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
#[allow(clippy::disallowed_methods)] // AppKit calls only — never mpv (see mpv_worker.rs)
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

use crate::mpv_worker::{MpvWorker, CALL_TIMEOUT, INIT_TIMEOUT, LOAD_TIMEOUT};
use tauri::AppHandle;
use tauri_plugin_libmpv::MpvConfig;

const PLAYER_LABEL: &str = "player";

fn ensure_player_window(window: &tauri::Window) -> Result<(), String> {
    if window.label() != PLAYER_LABEL {
        return Err("Player commands are only available to the player window".into());
    }
    Ok(())
}

/// Every mpv call goes through the dedicated mpv thread, never the main
/// thread — see mpv_worker.rs for the deadlock that prevents.
fn mpv_worker(app: &AppHandle) -> tauri::State<'_, MpvWorker> {
    use tauri::Manager;
    app.state::<MpvWorker>()
}

/// Options mpv starts with. Fixed here, not in the webview.
/// The options every player starts with.
///
/// The on-screen controller and the youtube-dl hook are Lua scripts, and their
/// options exist only in a libmpv built with Lua. The macOS build Prism ships
/// since 2.0 has none, and setting an option mpv doesn't have fails the whole
/// init: the player never started in 2.0.0 to 2.0.2 (2.0.2 still set `osc` from
/// this list). Without Lua neither script exists, so the lockdown holds either
/// way. Pure so a test pins exactly what each kind of build is sent.
pub(crate) fn fixed_options(has_lua: bool) -> Vec<(&'static str, &'static str)> {
    let mut options = vec![
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
        // Lockdown: no user config, no Lua/JS scripts, no youtube-dl hook.
        // Playback is identical on every machine and nothing outside this
        // binary can add behaviour to the player.
        ("config", "no"),
        ("load-scripts", "no"),
        // Never follow references inside a file: a torrent's `movie.mkv`
        // that is really an `#EXTM3U` playlist made mpv fetch its entries
        // from anywhere (REVIEW 2026-09-23 S-7). mpv parses such playlists
        // itself, so ffmpeg's protocol_whitelist doesn't reach them; this
        // does. Play now is unaffected: its http://127.0.0.1 URL is the file
        // itself, not a reference.
        ("access-references", "no"),
    ];
    if has_lua {
        options.push(("osc", "no"));
        options.push(("ytdl", "no"));
    }
    options
}

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
    for (k, v) in fixed_options(libmpv_has_lua(app)) {
        initial.insert(k.into(), serde_json::json!(v));
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
        "chapter-list": "node",
        "chapter": "int64",
        "sub-delay": "double",
        "sub-visibility": "flag",
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
        log::warn!("player init refused: libmpv-wrapper is not bundled");
        return Err("The built-in player isn't included in this build of Prism".into());
    }
    #[cfg(target_os = "macos")]
    log::info!(
        "player Vulkan driver: {}",
        std::env::var("VK_DRIVER_FILES").unwrap_or_else(|_| "none bundled; system search".into())
    );
    let cfg = player_mpv_config(&app)?;
    mpv_worker(&app)
        .run("init", INIT_TIMEOUT, move |mpv| {
            mpv.init(cfg, PLAYER_LABEL)
                .inspect_err(|e| log::warn!("player init failed: {e}"))
        })
        .await
}

#[tauri::command]
pub async fn player_destroy(app: AppHandle, window: tauri::Window) -> Result<(), String> {
    ensure_player_window(&window)?;
    mpv_worker(&app)
        .run("destroy", LOAD_TIMEOUT, |mpv| mpv.destroy(PLAYER_LABEL))
        .await
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
    {
        use tauri::Manager;
        let title = std::path::Path::new(&validated)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned());
        app.state::<crate::player_state::PlayerState>().set_current(
            crate::player_state::key_for_path(&validated),
            title,
            Some(validated.clone()),
        );
    }
    mpv_worker(&app)
        .run("loadfile", LOAD_TIMEOUT, move |mpv| {
            mpv.command("loadfile", vec![serde_json::json!(validated)], PLAYER_LABEL)?;
            mpv.set_property("pause", &serde_json::json!("no"), PLAYER_LABEL)
        })
        .await
}

/// Play a file of a torrent that is still downloading. Unlike `player_load`
/// this never opens the half-written file on disk: it is served over loopback
/// by `stream_server`, which is also what makes librqbit fetch the pieces the
/// player is about to want.
///
/// The file has to be one the torrent is already downloading. Selecting it
/// here would mean calling librqbit's all-or-nothing `update_only_files` and
/// silently dropping every other file the user chose, which is worse than the
/// button not being offered — so the UI only offers it for selected files.
#[tauri::command]
pub async fn player_load_stream(
    app: AppHandle,
    window: tauri::Window,
    torrent_id: String,
    file_idx: usize,
) -> Result<(), String> {
    use tauri::Manager;
    ensure_player_window(&window)?;
    let (_, name, _) = app
        .state::<crate::torrent::TorrentManager>()
        .stream_target(&torrent_id, file_idx)
        .await?;
    if !crate::stream_server::is_media_file(&name) {
        return Err("The player only opens media files".into());
    }
    let url = app
        .state::<crate::stream_server::StreamServer>()
        .url_for(&app, &torrent_id, file_idx)
        .await?;
    app.state::<crate::player_state::PlayerState>().set_current(
        crate::player_state::key_for_stream(&torrent_id, file_idx),
        Some(name),
        None,
    );
    mpv_worker(&app)
        .run("loadfile", LOAD_TIMEOUT, move |mpv| {
            // A swarm that stalls mid-file should make the player wait, not
            // give up on the stream.
            mpv.set_property("network-timeout", &serde_json::json!("60"), PLAYER_LABEL)?;
            mpv.command("loadfile", vec![serde_json::json!(url)], PLAYER_LABEL)?;
            mpv.set_property("pause", &serde_json::json!("no"), PLAYER_LABEL)
        })
        .await
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
    mpv_worker(&app)
        .run("seek", CALL_TIMEOUT, move |mpv| {
            mpv.command(
                "seek",
                vec![serde_json::json!(seconds), serde_json::json!(mode)],
                PLAYER_LABEL,
            )
        })
        .await
}

/// Remember where the player is in whatever it currently has open. The window
/// reports only the number: which item it belongs to is Rust's to know, from
/// the last `player_load`/`player_load_stream`.
#[tauri::command]
pub async fn player_save_position(
    app: AppHandle,
    window: tauri::Window,
    position: f64,
    duration: f64,
) -> Result<(), String> {
    ensure_player_window(&window)?;
    crate::player_state::save_current(&app, position, duration)
}

/// Where to pick up whatever is open, if it was left partway through.
#[tauri::command]
pub async fn player_resume_position(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Option<f64>, String> {
    ensure_player_window(&window)?;
    Ok(crate::player_state::resume_current(&app))
}

/// Subtitle files the player will take, whether picked by hand or found
/// sitting next to the media.
const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "vtt", "ass", "ssa", "sub", "lrc"];

fn is_subtitle(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| SUBTITLE_EXTENSIONS.contains(&e.as_str()))
}

/// Load a subtitle file and switch to it. Validated like any other path the
/// UI hands to the player: inside the allowed roots, and a subtitle at that.
#[tauri::command]
pub async fn player_add_subtitle(
    app: AppHandle,
    window: tauri::Window,
    path: String,
) -> Result<(), String> {
    ensure_player_window(&window)?;
    let validated = crate::validate_open_path(&path, false, &crate::picked_dirs(&app))?;
    if !is_subtitle(&validated) {
        return Err("That isn't a subtitle file".into());
    }
    mpv_worker(&app)
        .run("sub-add", CALL_TIMEOUT, move |mpv| {
            mpv.command(
                "sub-add",
                vec![serde_json::json!(validated), serde_json::json!("select")],
                PLAYER_LABEL,
            )
        })
        .await
}

/// Subtitles sitting beside the file being played, so the common case needs
/// no file picker. Only ones whose name starts with the media's — a season
/// folder shouldn't offer every episode's subtitles — and empty for a stream,
/// which has no folder to look in.
#[tauri::command]
pub async fn player_sibling_subtitles(
    app: AppHandle,
    window: tauri::Window,
) -> Result<Vec<String>, String> {
    use tauri::Manager;
    ensure_player_window(&window)?;
    let Some(current) = app.state::<crate::player_state::PlayerState>().current() else {
        return Ok(Vec::new());
    };
    let Some(path) = current.path else {
        return Ok(Vec::new());
    };
    let media = std::path::Path::new(&path);
    let (Some(dir), Some(stem)) = (media.parent(), media.file_stem().and_then(|s| s.to_str()))
    else {
        return Ok(Vec::new());
    };
    let mut found: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let p = entry.ok()?.path();
            let name = p.file_name()?.to_str()?.to_string();
            let full = p.to_str()?.to_string();
            (is_subtitle(&full) && name.starts_with(stem)).then_some(full)
        })
        .collect();
    found.sort();
    Ok(found)
}

/// Mini player: a small always-on-top window, or back to the size it opens at.
/// Done here rather than from the window itself so the player window's ACL
/// stays as narrow as it is.
#[tauri::command]
pub async fn player_set_mini(window: tauri::Window, on: bool) -> Result<(), String> {
    ensure_player_window(&window)?;
    let (w, h) = if on { (400.0, 225.0) } else { (1024.0, 640.0) };
    window.set_always_on_top(on).map_err(|e| e.to_string())?;
    window
        .set_size(tauri::LogicalSize::new(w, h))
        .map_err(|e| e.to_string())
}

/// The only properties the UI may set, each with its value shape checked.
pub(crate) fn validate_player_property(
    name: &str,
    value: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let bad = || format!("Invalid value for player property '{}'", name);
    match name {
        "pause" | "mute" | "sub-visibility" => match value {
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
        // Chapter index, from mpv's own chapter-list.
        "chapter" => match value {
            Value::Number(n) if n.as_i64().is_some_and(|i| i >= 0) => Ok(value.clone()),
            _ => Err(bad()),
        },
        // Subtitle timing nudge, in seconds either way.
        "sub-delay" => value
            .as_f64()
            .filter(|v| (-60.0..=60.0).contains(v))
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
    mpv_worker(&app)
        .run("set_property", CALL_TIMEOUT, move |mpv| {
            mpv.set_property(&name, &value, PLAYER_LABEL)
        })
        .await
}

/// Debug builds only: `PRISM_VERIFY_PLAYER=<media file>` opens the player at
/// launch and logs `player-verify: ok` once playback passes 1 s. That checks
/// the whole path (window, mpv init, load, video output) end to end with
/// nobody clicking. `PRISM_VERIFY_EXIT=1` quits afterwards.
/// See scripts/verify-player-macos.sh.
#[cfg(debug_assertions)]
pub fn verify_player_from_env(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{Listener, WebviewUrl, WebviewWindowBuilder};

    let Ok(clip) = std::env::var("PRISM_VERIFY_PLAYER") else {
        return Ok(());
    };
    let quit = std::env::var("PRISM_VERIFY_EXIT").is_ok_and(|v| v == "1");
    log::info!("player-verify: opening {clip}");

    let handle = app.clone();
    let reported = AtomicBool::new(false);
    app.listen_any(format!("mpv-event-{PLAYER_LABEL}"), move |event| {
        let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) else {
            return;
        };
        let playing = payload["event"] == "property-change"
            && payload["name"] == "time-pos"
            && payload["data"].as_f64().is_some_and(|t| t > 1.0);
        if playing && !reported.swap(true, Ordering::Relaxed) {
            log::info!("player-verify: ok");
            if quit {
                handle.exit(0);
            }
        }
    });

    let mut query = tauri::Url::parse("http://localhost/").map_err(|e| e.to_string())?;
    query.query_pairs_mut().append_pair("src", &clip).append_pair("title", "Prism verify");
    let url = format!("player?{}", query.query().unwrap_or_default());
    // Same window options as openInPlayer (src/lib/player-window.ts).
    WebviewWindowBuilder::new(app, PLAYER_LABEL, WebviewUrl::App(url.into()))
        .title("Prism Player")
        .inner_size(1024.0, 640.0)
        .min_inner_size(480.0, 320.0)
        .transparent(true)
        .center()
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    // Regression (2.0.2): the macOS libmpv shipped since 2.0 is built without
    // Lua, so `osc`/`ytdl` don't exist and setting them failed player init.
    // Regression (2.0.3): 2.0.2 still set `osc` from the fixed list, so a
    // Lua-less libmpv refused the whole init. Only a Lua build gets the two
    // Lua-script options; every build gets the lockdown.
    #[test]
    fn lua_only_options_go_only_to_a_lua_build() {
        let keys = |has_lua| super::fixed_options(has_lua).into_iter().map(|(k, _)| k).collect::<Vec<_>>();
        let without = keys(false);
        assert!(!without.contains(&"osc") && !without.contains(&"ytdl"), "{without:?}");
        let with = keys(true);
        assert!(with.contains(&"osc") && with.contains(&"ytdl"));
        for build in [&without, &with] {
            for required in ["config", "load-scripts", "access-references", "input-default-bindings"] {
                assert!(build.contains(&required), "{required} missing");
            }
            let mut unique = build.to_vec();
            unique.sort();
            unique.dedup();
            assert_eq!(unique.len(), build.len(), "an option is set twice");
        }
    }

    #[test]
    fn reads_whether_libmpv_was_built_with_lua() {
        let config = |line: &str| format!("\0mpv\0Configuration: {line}\0").into_bytes();
        assert!(super::lua_disabled(&config("-Dgpl=false -Dlibmpv=true -Dlua=disabled -Dvulkan=enabled")));
        assert!(!super::lua_disabled(&config("-Dlibmpv=true -Dlua=enabled")));
        assert!(!super::lua_disabled(&config("-Dlua=luajit")));
        assert!(!super::lua_disabled(b"no configuration here"), "unknown means Lua is assumed");
    }

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

/// Point the Vulkan loader at the MoltenVK driver bundled beside libmpv.
///
/// macOS provides no Vulkan driver, and mpv's video output (gpu-next) runs on
/// Vulkan. Releases up to 1.9.1 shipped the loader but not the driver, so the
/// player only showed video on Macs that happened to have Homebrew's
/// molten-vk. Called at the top of `run()`, before any thread exists, because
/// it sets environment variables. A developer's own setting wins.
#[cfg(target_os = "macos")]
pub fn use_bundled_vulkan_driver() {
    if std::env::var_os("VK_DRIVER_FILES").is_some() || std::env::var_os("VK_ICD_FILENAMES").is_some() {
        return;
    }
    if let Some(manifest) = bundled_vulkan_manifest() {
        std::env::set_var("VK_DRIVER_FILES", &manifest);
        // The name loaders before 1.3.207 read.
        std::env::set_var("VK_ICD_FILENAMES", &manifest);
    }
}

/// `Contents/Resources/lib/vulkan/icd.d/MoltenVK_icd.json` in the app bundle;
/// `<exe dir>/lib/…` in development.
#[cfg(target_os = "macos")]
fn bundled_vulkan_manifest() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let relative = "lib/vulkan/icd.d/MoltenVK_icd.json";
    [exe_dir.join("../Resources").join(relative), exe_dir.join(relative)]
        .into_iter()
        .find(|path| path.is_file())
        .and_then(|path| path.canonicalize().ok())
}

/// Whether the embedded player can run: the libmpv wrapper must be reachable —
/// next to the executable (dev builds stage it there, see build.rs) or in the
/// bundled resources (releases ship it under resources/lib; the vendored
/// plugin searches there too). The UI uses this to hide "Play in Prism"
/// instead of offering a player that can't start (e.g. Linux, where window
/// embedding isn't supported yet).
#[tauri::command]
pub fn player_available(app: tauri::AppHandle) -> bool {
    #[cfg(target_os = "windows")]
    let name = "libmpv-wrapper.dll";
    #[cfg(target_os = "macos")]
    let name = "libmpv-wrapper.dylib";
    #[cfg(all(unix, not(target_os = "macos")))]
    let name = "libmpv-wrapper.so";

    library_dirs(&app).iter().any(|d| d.join(name).exists())
}

/// Where the player's libraries may be: next to the executable (dev builds
/// stage them there, see build.rs) or in the bundled resources.
fn library_dirs(app: &AppHandle) -> Vec<std::path::PathBuf> {
    use tauri::Manager;
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
    dirs
}

/// Whether mpv's build configuration, as embedded in libmpv, disabled Lua.
/// mpv stores its configure line (`… -Dlua=disabled …`) in the library.
pub(crate) fn lua_disabled(library: &[u8]) -> bool {
    const MARKER: &[u8] = b"-Dlua=disabled";
    library.windows(MARKER.len()).any(|w| w == MARKER)
}

/// Whether the bundled libmpv has Lua (and so the `osc` and `ytdl` options).
/// Read once. When the library can't be found or read, assume it does: the
/// options then stay set, which is the locked-down choice.
fn libmpv_has_lua(app: &AppHandle) -> bool {
    static HAS_LUA: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *HAS_LUA.get_or_init(|| {
        #[cfg(target_os = "windows")]
        let names: &[&str] = &["libmpv-2.dll", "mpv-2.dll"];
        #[cfg(target_os = "macos")]
        let names: &[&str] = &["libmpv.dylib", "libmpv.2.dylib"];
        #[cfg(all(unix, not(target_os = "macos")))]
        let names: &[&str] = &["libmpv.so.2", "libmpv.so"];
        let found = library_dirs(app)
            .iter()
            .flat_map(|d| names.iter().map(move |n| d.join(n)))
            .find(|p| p.is_file());
        let has_lua = match found.as_deref().map(std::fs::read) {
            Some(Ok(bytes)) => !lua_disabled(&bytes),
            _ => true,
        };
        log::info!("player: libmpv {:?} has Lua: {has_lua}", found);
        has_lua
    })
}
