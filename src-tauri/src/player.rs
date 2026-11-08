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
        "audio-delay": "double",
        "playlist-pos": "int64",
        "playlist-count": "int64",
        "ab-loop-a": "string",
        "ab-loop-b": "string",
        "video-aspect-override": "string",
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
    let validated = crate::validate_open_path(&path, false, &crate::picked_dirs(&app));
    // A path from the page must be something Prism downloaded (ledger.rs),
    // or one the user chose in a dialog Rust showed or dropped on the player
    // (`UserPicked`). Those aren't held to the download roots either: the
    // choice is the permission, and mpv only ever plays the file.
    if let Some(picked) = user_picked_media(&app, &path) {
        return load_validated(&app, picked).await;
    }
    let validated = validated?;
    if !crate::is_openable_media(&validated) {
        return Err("The player only opens media files".into());
    }
    crate::ledger::require_recorded(&app, &validated)?;
    load_validated(&app, validated).await
}

/// Audio and video the player opens from anywhere when the user picks it.
/// Narrower than `is_openable_media`: no images, subtitles or documents.
pub const PLAYABLE_EXTENSIONS: &[&str] = &[
    "mp4", "m4v", "mkv", "webm", "mov", "avi", "flv", "wmv", "mpg", "mpeg", "ts", "mts", "m2ts",
    "3gp", "ogv", "vob", "mp3", "m4a", "aac", "opus", "ogg", "oga", "wav", "flac", "aiff", "aif",
    "wma", "alac",
];

pub fn is_playable(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| PLAYABLE_EXTENSIONS.contains(&e.as_str()))
}

/// Files the user chose this session in a dialog Rust showed, or dropped on
/// the player window (a native event, not something the page can fake).
/// Canonical paths. Session-only: nothing is persisted, so a page can't grow
/// this list, and the next launch starts empty.
#[derive(Default)]
pub struct UserPicked(std::sync::Mutex<std::collections::HashSet<String>>);

/// Check a file the user chose and remember it. Returns its canonical path.
/// Deliberately not held to the download roots, so a film on an external
/// drive or a NAS plays; still has to be a real file of a media type.
pub fn accept_user_pick(app: &AppHandle, path: &std::path::Path) -> Result<String, String> {
    use tauri::Manager;
    let resolved = path.canonicalize().map_err(|_| "File not found".to_string())?;
    if !resolved.is_file() {
        return Err("That isn't a file".into());
    }
    if !is_playable(&resolved) {
        return Err("The player only opens audio and video files".into());
    }
    let canonical = crate::canonical_string(&resolved);
    if let Some(state) = app.try_state::<UserPicked>() {
        if let Ok(mut set) = state.0.lock() {
            set.insert(canonical.clone());
        }
    }
    Ok(canonical)
}

/// `path`, canonical, if the user picked it this session.
fn user_picked_media(app: &AppHandle, path: &str) -> Option<String> {
    use tauri::Manager;
    let canonical = crate::canonical_string(&std::path::Path::new(path).canonicalize().ok()?);
    let state = app.try_state::<UserPicked>()?;
    let picked = state.0.lock().ok()?.contains(&canonical);
    // A file played before (Recent files) was chosen by the user then; the
    // list is Rust's own file, so the page can't add to it.
    (picked || (is_playable(std::path::Path::new(&canonical)) && crate::player_queue::is_recent(app, &canonical)))
        .then_some(canonical)
}

/// Show the "play a file" dialog on `window` and return what was chosen.
/// Every picker here names its window: without one, the dialog library
/// attaches a sheet to whichever window AppKit calls main at that moment,
/// which can leave it on screen but dead while clicks reach the video.
async fn pick_playable(app: &AppHandle, window: &tauri::Window) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(window)
        .set_title("Play a file")
        .add_filter("Audio and video", PLAYABLE_EXTENSIONS)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "File picker was closed".to_string())? else {
        return Ok(None);
    };
    picked.into_path().map(Some).map_err(|e| format!("Invalid file: {e}"))
}

/// A file the main window wants played, picked in a Rust dialog.
#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PickedMedia {
    pub path: String,
    pub title: String,
}

/// "Play a file…" from the main window (Library, ⌘O). Rust shows the dialog
/// and remembers the choice, so the `player_load` that follows accepts it.
/// None if the user cancelled.
#[tauri::command]
pub async fn pick_media_file(app: AppHandle, window: tauri::Window) -> Result<Option<PickedMedia>, String> {
    let Some(path) = pick_playable(&app, &window).await? else { return Ok(None) };
    let path = accept_user_pick(&app, &path)?;
    let title = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(Some(PickedMedia { path, title }))
}

/// Files the OS asked Prism to open ("Open With → Prism", a double-click
/// once Prism is the chosen app), waiting for the main window to play them.
/// Held here because a cold start delivers them before the page listens.
#[derive(Default)]
pub struct OpenedMedia(std::sync::Mutex<OpenedState>);

#[derive(Default)]
struct OpenedState {
    waiting: Vec<PickedMedia>,
    /// Canonical paths of files opened together, kept for the load of the
    /// first one so they become its playlist instead of its folder.
    together: Vec<String>,
}

impl OpenedState {
    /// The file to play from everything waiting, in reading order (Finder's
    /// selection order is arbitrary). With nothing waiting, changes nothing:
    /// the page asks at startup and on every event, so it can ask twice.
    fn next(&mut self) -> Option<PickedMedia> {
        let mut files = std::mem::take(&mut self.waiting);
        files.sort_by(|a, b| crate::player_queue::natural_cmp(&a.title, &b.title));
        files.dedup_by(|a, b| a.path == b.path);
        files.truncate(crate::player_queue::MAX_PLAYLIST);
        if !files.is_empty() {
            self.together = if files.len() > 1 { files.iter().map(|f| f.path.clone()).collect() } else { Vec::new() };
        }
        files.into_iter().next()
    }

    /// The playlist for `current` if it was opened with others. Good for one
    /// load: any later load is an ordinary one.
    fn playlist_for(&mut self, current: &str) -> Option<(Vec<std::path::PathBuf>, usize)> {
        let together = std::mem::take(&mut self.together);
        let at = together.iter().position(|p| p == current)?;
        Some((together.into_iter().map(std::path::PathBuf::from).collect(), at))
    }
}

/// Accept the playable files among `paths` as the user's choice and queue
/// them for the main window, which `take_opened_media` hands them to. Tells
/// the main window when something was queued.
pub fn queue_opened(app: &AppHandle, paths: impl IntoIterator<Item = std::path::PathBuf>) {
    use tauri::{Emitter, Manager};
    let accepted: Vec<PickedMedia> = paths
        .into_iter()
        .filter(|p| is_playable(p))
        .filter_map(|p| accept_user_pick(app, &p).ok())
        .map(|path| {
            let title = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            PickedMedia { path, title }
        })
        .collect();
    if accepted.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<OpenedMedia>() {
        if let Ok(mut opened) = state.0.lock() {
            opened.waiting.extend(accepted);
        }
    }
    let _ = app.emit_to("main", "open-media-file", ());
}

/// The file to play from what the OS opened since the last call (main
/// window). Anything opened with it queues behind it when it loads.
#[tauri::command]
pub fn take_opened_media(app: AppHandle) -> Option<PickedMedia> {
    use tauri::Manager;
    app.try_state::<OpenedMedia>()
        .and_then(|s| s.0.lock().ok().and_then(|mut opened| opened.next()))
}

/// A file dropped on the player window. The paths come from the OS drop
/// event in Rust, so the page can't make one up. The first playable one is
/// remembered and handed to the player as an ordinary load.
pub fn on_player_drop(app: &AppHandle, paths: &[std::path::PathBuf]) {
    use tauri::Emitter;
    let Some(path) = paths.iter().find(|p| is_playable(p)) else {
        let _ = app.emit_to(PLAYER_LABEL, "player-load-error", "The player only opens audio and video files");
        return;
    };
    match accept_user_pick(app, path) {
        Ok(path) => {
            let title = std::path::Path::new(&path).file_name().map(|n| n.to_string_lossy().into_owned());
            let _ = app.emit_to(PLAYER_LABEL, "player-load", serde_json::json!({ "path": path, "title": title }));
        }
        Err(e) => {
            let _ = app.emit_to(PLAYER_LABEL, "player-load-error", e);
        }
    }
}

/// "Open file…" in the player: Rust shows the dialog, so the user's pick is
/// the permission, and loads the file — from any folder or drive. Returns
/// its name, or None if the user cancelled.
#[tauri::command]
pub async fn player_open_file(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    ensure_player_window(&window)?;
    let Some(path) = pick_playable(&app, &window).await? else { return Ok(None) };
    let validated = accept_user_pick(&app, &path)?;
    let name = std::path::Path::new(&validated).file_name().map(|n| n.to_string_lossy().into_owned());
    load_validated(&app, validated).await?;
    Ok(name)
}

async fn load_validated(app: &AppHandle, validated: String) -> Result<(), String> {
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
    // The rest of its folder, in reading order, so Next/Previous work and a
    // season plays through. Built from the validated file's own folder, off
    // the async workers (a big folder is a directory walk).
    let current = std::path::PathBuf::from(&validated);
    let opened_together = {
        use tauri::Manager;
        app.try_state::<OpenedMedia>()
            .and_then(|s| s.0.lock().ok().and_then(|mut opened| opened.playlist_for(&validated)))
    };
    let plays_through = opened_together.is_some();
    let queue = match opened_together {
        Some(list) => Some(list),
        None => {
            let current = current.clone();
            tauri::async_runtime::spawn_blocking(move || crate::player_queue::folder_playlist(&current))
                .await
                .ok()
                .flatten()
        }
    };
    let episode = plays_through
        || current
            .file_name()
            .and_then(|n| n.to_str())
            .is_some_and(crate::player_queue::looks_like_episode);
    {
        let (app, path) = (app.clone(), validated.clone());
        tauri::async_runtime::spawn_blocking(move || crate::player_queue::record(&app, &path));
    }
    mpv_worker(app)
        .run("loadfile", LOAD_TIMEOUT, move |mpv| {
            mpv.command("loadfile", vec![serde_json::json!(validated)], PLAYER_LABEL)?;
            // Episodes, and files opened together, go on to the next one by themselves; anything else
            // waits for Next ("always": never advance at the end of a file).
            mpv.set_property("keep-open", &serde_json::json!(if episode { "yes" } else { "always" }), PLAYER_LABEL)?;
            if let Some((list, at)) = queue {
                for p in list.iter().filter(|p| **p != current) {
                    mpv.command("loadfile", vec![serde_json::json!(p.to_string_lossy()), serde_json::json!("append")], PLAYER_LABEL)?;
                }
                // The current file went in first; move it to its place in the
                // sorted list (mpv inserts before the target entry).
                if at > 0 {
                    mpv.command("playlist-move", vec![serde_json::json!(0), serde_json::json!(at + 1)], PLAYER_LABEL)?;
                }
            }
            mpv.set_property("pause", &serde_json::json!("no"), PLAYER_LABEL)
        })
        .await
}

/// Next or previous in the folder playlist.
#[tauri::command]
pub async fn player_playlist_step(app: AppHandle, window: tauri::Window, forward: bool) -> Result<(), String> {
    ensure_player_window(&window)?;
    mpv_worker(&app)
        .run("playlist step", CALL_TIMEOUT, move |mpv| {
            mpv.command(if forward { "playlist-next" } else { "playlist-prev" }, vec![], PLAYER_LABEL)
        })
        .await
}

/// The playlist moved on (Next, Previous, or the end of an episode): point
/// Prism's idea of what's playing at the file mpv is actually playing, so
/// resume positions, subtitles beside it and Recent files follow. The path
/// comes from mpv, and only a playable file in the same folder as the one
/// Prism loaded is accepted. Returns its name for the window title, or None
/// when nothing changed.
#[tauri::command]
pub async fn player_now_playing(app: AppHandle, window: tauri::Window) -> Result<Option<String>, String> {
    use tauri::Manager;
    ensure_player_window(&window)?;
    let Some(current) = app.state::<crate::player_state::PlayerState>().current() else { return Ok(None) };
    let Some(loaded) = current.path else { return Ok(None) };
    let value = mpv_worker(&app)
        .run("get path", CALL_TIMEOUT, |mpv| mpv.get_property("path", "string", PLAYER_LABEL))
        .await?;
    let Some(now) = value.as_str().map(str::to_string) else { return Ok(None) };
    let (now_p, loaded_p) = (std::path::Path::new(&now), std::path::Path::new(&loaded));
    let same_folder = now_p.parent().and_then(|d| d.canonicalize().ok()) == loaded_p.parent().and_then(|d| d.canonicalize().ok());
    // Nothing to follow: still the file Prism loaded, or not one it queued.
    if now == loaded || !same_folder || !now_p.is_file() || !is_playable(now_p) {
        return Ok(None);
    }
    let canonical = now_p.canonicalize().map(|p| crate::canonical_string(&p)).unwrap_or(now.clone());
    let title = now_p.file_name().map(|n| n.to_string_lossy().into_owned());
    app.state::<crate::player_state::PlayerState>().set_current(
        crate::player_state::key_for_path(&canonical),
        title.clone(),
        Some(canonical.clone()),
    );
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || crate::player_queue::record(&app2, &canonical));
    Ok(title)
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

/// The few mpv actions the player's keys and buttons need beyond seeking,
/// each named here rather than passed through: frame step, the A-B loop.
#[tauri::command]
pub async fn player_action(app: AppHandle, window: tauri::Window, action: String) -> Result<(), String> {
    ensure_player_window(&window)?;
    let command = match action.as_str() {
        "frame-step" => "frame-step",
        "frame-back-step" => "frame-back-step",
        "ab-loop" => "ab-loop",
        _ => return Err(format!("Unknown player action '{action}'")),
    };
    mpv_worker(&app)
        .run("player action", CALL_TIMEOUT, move |mpv| mpv.command(command, vec![], PLAYER_LABEL))
        .await
}

/// A screenshot of the current frame, saved to Pictures/Prism. The folder and
/// name are Rust's (the video's name and the time), never the page's.
/// Returns where it went.
#[tauri::command]
pub async fn player_screenshot(app: AppHandle, window: tauri::Window) -> Result<String, String> {
    use tauri::Manager;
    ensure_player_window(&window)?;
    let dir = dirs::picture_dir()
        .or_else(|| dirs::home_dir().map(|h| h.join("Pictures")))
        .ok_or("No Pictures folder")?
        .join("Prism");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    let base = app
        .state::<crate::player_state::PlayerState>()
        .current()
        .and_then(|c| c.title)
        .map(|t| std::path::Path::new(&t).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or(t))
        .unwrap_or_else(|| "Prism".into());
    let safe: String = base
        .chars()
        .map(|c| if c.is_alphanumeric() || " ._-()".contains(c) { c } else { '_' })
        .take(80)
        .collect();
    let stamp = chrono::Local::now().format("%Y-%m-%d at %H.%M.%S");
    let file = dir.join(format!("{} {}.png", safe.trim(), stamp));
    let target = file.to_string_lossy().into_owned();
    let arg = target.clone();
    mpv_worker(&app)
        .run("screenshot", LOAD_TIMEOUT, move |mpv| {
            mpv.command("screenshot-to-file", vec![serde_json::json!(arg), serde_json::json!("video")], PLAYER_LABEL)
        })
        .await?;
    Ok(target)
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
    // Beside the file that is playing is fine wherever that is (those are
    // what `player_sibling_subtitles` offers); otherwise the usual roots.
    let validated = match beside_current_media(&app, &path) {
        Some(p) => p,
        None => crate::validate_open_path(&path, false, &crate::picked_dirs(&app))?,
    };
    add_subtitle(&app, validated).await
}

/// "Add subtitle…": Rust shows the dialog, so a subtitle anywhere works.
/// Returns false if the user cancelled.
#[tauri::command]
pub async fn player_pick_subtitle(app: AppHandle, window: tauri::Window) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    ensure_player_window(&window)?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_parent(&window)
        .set_title("Add subtitles")
        .add_filter("Subtitles", SUBTITLE_EXTENSIONS)
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    let Some(picked) = rx.await.map_err(|_| "File picker was closed".to_string())? else {
        return Ok(false);
    };
    let path = picked.into_path().map_err(|e| format!("Invalid file: {e}"))?;
    let resolved = path.canonicalize().map_err(|_| "File not found".to_string())?;
    if !resolved.is_file() {
        return Err("File not found".into());
    }
    add_subtitle(&app, crate::canonical_string(&resolved)).await?;
    Ok(true)
}

/// `path`, canonical, when it's a file in the same folder as what's playing.
fn beside_current_media(app: &AppHandle, path: &str) -> Option<String> {
    use tauri::Manager;
    let current = app.state::<crate::player_state::PlayerState>().current()?.path?;
    let dir = std::path::Path::new(&current).parent()?.canonicalize().ok()?;
    let resolved = std::path::Path::new(path).canonicalize().ok()?;
    (resolved.is_file() && resolved.parent() == Some(dir.as_path())).then(|| crate::canonical_string(&resolved))
}

async fn add_subtitle(app: &AppHandle, validated: String) -> Result<(), String> {
    if !is_subtitle(&validated) {
        return Err("That isn't a subtitle file".into());
    }
    mpv_worker(app)
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
        // Picture shape: mpv's own values only.
        "video-aspect-override" => match value.as_str() {
            Some("-1" | "16:9" | "4:3" | "21:9" | "2.39:1" | "1:1") => Ok(value.clone()),
            _ => Err(bad()),
        },
        // Audio timing nudge, for a file whose sound runs early or late.
        "audio-delay" => value
            .as_f64()
            .filter(|v| (-10.0..=10.0).contains(v))
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
    fn picked(path: &str) -> super::PickedMedia {
        super::PickedMedia { path: path.into(), title: path.rsplit('/').next().unwrap().into() }
    }

    #[test]
    fn files_opened_together_play_in_reading_order() {
        let mut opened = super::OpenedState { waiting: vec![picked("/a/Ep 10.mkv"), picked("/a/Ep 2.mkv"), picked("/a/Ep 2.mkv")], ..Default::default() };
        assert_eq!(opened.next(), Some(picked("/a/Ep 2.mkv")));
        // The page asks again on the event that follows; that must not lose them.
        assert_eq!(opened.next(), None);
        let (list, at) = opened.playlist_for("/a/Ep 2.mkv").unwrap();
        assert_eq!(list, [std::path::PathBuf::from("/a/Ep 2.mkv"), "/a/Ep 10.mkv".into()]);
        assert_eq!(at, 0);
        assert!(opened.playlist_for("/a/Ep 2.mkv").is_none(), "good for one load");
    }

    #[test]
    fn one_opened_file_keeps_its_folder_playlist() {
        let mut opened = super::OpenedState { waiting: vec![picked("/a/b.mp4")], ..Default::default() };
        assert_eq!(opened.next(), Some(picked("/a/b.mp4")));
        assert!(opened.playlist_for("/a/b.mp4").is_none());
    }

    #[test]
    fn an_unrelated_load_drops_a_stale_opened_list() {
        let mut opened = super::OpenedState { waiting: vec![picked("/a/1.mp4"), picked("/a/2.mp4")], ..Default::default() };
        opened.next();
        assert!(opened.playlist_for("/other.mp4").is_none());
        assert!(opened.playlist_for("/a/1.mp4").is_none());
    }

    // Tauri's Windows installer ignores `rank` and makes itself the handler
    // for every listed type, so media types belong in the macOS config only.
    #[test]
    fn only_macos_declares_media_file_types() {
        let exts = |json: &str| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(json).unwrap();
            v["bundle"]["fileAssociations"]
                .as_array()
                .map(|a| a.iter().flat_map(|f| f["ext"].as_array().unwrap().iter().map(|e| e.as_str().unwrap().to_string())).collect())
                .unwrap_or_default()
        };
        assert_eq!(exts(include_str!("../tauri.conf.json")), ["torrent"]);
        assert!(exts(include_str!("../tauri.windows.conf.json")).is_empty());
        assert!(exts(include_str!("../tauri.linux.conf.json")).is_empty());
        let mut mac = exts(include_str!("../tauri.macos.conf.json"));
        mac.retain(|e| e != "torrent");
        let mut playable: Vec<String> = super::PLAYABLE_EXTENSIONS.iter().map(|e| e.to_string()).collect();
        mac.sort();
        playable.sort();
        assert_eq!(mac, playable);
    }

    // Picked files skip the download roots, so the type check is what keeps
    // "Play a File…" to media: no scripts, apps, images or documents.
    #[test]
    fn only_audio_and_video_can_be_picked_to_play() {
        use std::path::Path;
        for ok in ["/Volumes/NAS/Film.MKV", "D:/films/a.mp4", "/x/song.flac", "/x/a.m2ts"] {
            assert!(super::is_playable(Path::new(ok)), "{ok}");
        }
        for bad in ["/x/run.command", "/x/a.app", "/x/a.exe", "/x/a.pdf", "/x/a.srt", "/x/a.jpg", "/x/noext", "/x/a.mp4.sh"] {
            assert!(!super::is_playable(Path::new(bad)), "{bad}");
        }
        // Everything playable is also something Prism would open at all.
        for ext in super::PLAYABLE_EXTENSIONS {
            assert!(crate::is_openable_media(&format!("/x/a.{ext}")), "{ext}");
        }
    }

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

/// Keep Prism's own Dock icon while the player runs.
///
/// mpv's macOS video output replaces the app's Dock icon with mpv's own when
/// a video starts, and it stayed until Prism quit. mpv skips that when
/// `MPVBUNDLE=true`, which mpv.app sets for itself. Measured with
/// `examples/mpv_thread_repro` (icon fingerprint unchanged with it, replaced
/// without; playback the same). Called with the Vulkan setup, before any
/// thread exists, because it sets an environment variable.
#[cfg(target_os = "macos")]
pub fn keep_prism_dock_icon() {
    if std::env::var_os("MPVBUNDLE").is_none() {
        std::env::set_var("MPVBUNDLE", "true");
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
