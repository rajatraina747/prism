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

/// Whether the embedded player can run: the libmpv wrapper must sit next to
/// the executable (dev builds stage it there — see build.rs). Bundled releases
/// don't ship it yet (ROADMAP → In-app player → Distribution), so the UI uses
/// this to hide "Play in Prism" instead of offering a player that can't start.
#[tauri::command]
pub fn player_available() -> bool {
    #[cfg(target_os = "windows")]
    let name = "libmpv-wrapper.dll";
    #[cfg(target_os = "macos")]
    let name = "libmpv-wrapper.dylib";
    #[cfg(all(unix, not(target_os = "macos")))]
    let name = "libmpv-wrapper.so";

    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
        .map(|dir| dir.join(name).exists() || dir.join("lib").join(name).exists())
        .unwrap_or(false)
}
