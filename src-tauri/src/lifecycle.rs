//! Closing the window, and quitting.
//!
//! Downloads run in this process, so ending it ends them: yt-dlp is killed,
//! torrents stop seeding, direct downloads stop mid-file. Closing the window
//! used to do exactly that, with no warning, while the tray icon suggested
//! Prism would carry on in the background. Now:
//!
//! - closing the main window hides it (the `closeToTray` setting, on by
//!   default) and the work carries on; the tray, the Dock, a second launch or
//!   the "show Prism" hotkey bring it back;
//! - every deliberate Quit — the tray, the menu (⌘Q included), closing the
//!   window with `closeToTray` off — asks first while anything is running.
//!
//! ⌘Q is only catchable because the menu's Quit is Prism's own item
//! (`app_menu.rs`): the predefined one calls `-[NSApp terminate:]`, which
//! reaches Rust as `RunEvent::Exit`, too late to ask anything.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};

/// Whether the tray icon was created. Without it a hidden window can only be
/// reached again through the Dock (macOS) or a second launch.
static TRAY_AVAILABLE: AtomicBool = AtomicBool::new(false);

pub(crate) fn set_tray_available(available: bool) {
    TRAY_AVAILABLE.store(available, Ordering::SeqCst);
}

/// Whether closing the main window hides it rather than quitting: the
/// setting, and somewhere to bring it back from.
pub(crate) fn close_to_tray(app: &AppHandle) -> bool {
    let reachable = cfg!(target_os = "macos") || TRAY_AVAILABLE.load(Ordering::SeqCst);
    reachable && crate::setting_bool(app, "closeToTray", true)
}

/// Downloads, direct downloads and torrents (seeding included) running now.
pub(crate) async fn active_work(app: &AppHandle) -> usize {
    let videos = app.state::<crate::DownloadManager>().active_count().await;
    let direct = app.state::<crate::http_engine::HttpEngine>().active_count().await;
    let torrents = app.state::<crate::torrent::TorrentManager>().active_count().await;
    videos + direct + torrents
}

/// The question asked before quitting with `active` transfers running.
pub(crate) fn quit_prompt(active: usize) -> String {
    match active {
        1 => "1 transfer is still running. Quitting stops it; it resumes the next time Prism starts.".into(),
        n => format!("{n} transfers are still running. Quitting stops them; they resume the next time Prism starts."),
    }
}

/// Set while the quit question is on screen, so a second Quit (a double ⌘Q)
/// doesn't stack another dialog on the first.
static ASKING: AtomicBool = AtomicBool::new(false);

/// Quit, asking first if anything is running.
pub(crate) fn request_quit(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let active = active_work(&app).await;
        if active == 0 {
            app.exit(0);
            return;
        }
        if ASKING.swap(true, Ordering::SeqCst) {
            return;
        }
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
        crate::show_main_window(&app);
        let quit_app = app.clone();
        app.dialog()
            .message(quit_prompt(active))
            .title("Quit Prism?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Keep running".into()))
            .show(move |quit| {
                ASKING.store(false, Ordering::SeqCst);
                if quit {
                    log::info!("quit confirmed with {active} transfer(s) running");
                    quit_app.exit(0);
                }
            });
    });
}

/// Shown once per launch, the first time the window is hidden on a platform
/// where a hidden window leaves nothing on screen to say Prism is still
/// there (Windows, Linux — macOS keeps the Dock icon).
static TOLD_ABOUT_TRAY: AtomicBool = AtomicBool::new(false);

/// The main window's close button: hide, or quit (asking first).
pub(crate) fn on_main_close_requested(window: &tauri::Window, api: &tauri::CloseRequestApi) {
    let app = window.app_handle();
    api.prevent_close();
    if close_to_tray(app) {
        let _ = window.hide();
        if cfg!(not(target_os = "macos")) && !TOLD_ABOUT_TRAY.swap(true, Ordering::SeqCst) {
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title("Prism is still running")
                .body("Downloads carry on in the background. Open Prism from the tray icon.")
                .show();
        }
    } else {
        request_quit(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_prompt_counts_what_would_stop() {
        assert!(quit_prompt(1).starts_with("1 transfer is"));
        assert!(quit_prompt(3).starts_with("3 transfers are"));
    }
}
