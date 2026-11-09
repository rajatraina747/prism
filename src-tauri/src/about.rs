//! Prism's own About window, in place of the standard one (see app_menu.rs).
//!
//! It loads `/about-window`, which renders only this panel: no app providers,
//! so a second window never starts a second download orchestrator. Its
//! capability (`capabilities/about.json`) is limited to what the panel shows.

use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub(crate) const ABOUT_LABEL: &str = "about";

const WIDTH: f64 = 340.0;
const HEIGHT: f64 = 440.0;

/// Open the window, or bring it forward if it's already open.
pub(crate) fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(ABOUT_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    // Off the menu's event handler: building a window from inside one can
    // deadlock on Windows.
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = build(&app) {
            log::warn!("about window: not opened: {e}");
        }
    });
}

fn build(app: &AppHandle) -> tauri::Result<()> {
    let builder = WebviewWindowBuilder::new(app, ABOUT_LABEL, WebviewUrl::App("about-window".into()))
        .title("About Prism")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .minimizable(false)
        .maximizable(false)
        .center()
        // Shown once the page has painted its theme, so a dark-theme user
        // doesn't get a white flash.
        .visible(false)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = window.show();
                let _ = window.set_focus();
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    builder.build()?;
    Ok(())
}

/// The main-window route behind each thing the panel can link to. A fixed
/// list, so this window can't send the main window anywhere else.
fn route_for(destination: &str) -> Option<&'static str> {
    match destination {
        "updates" => Some("/settings?section=updates"),
        "licenses" => Some("/licenses"),
        _ => None,
    }
}

/// Take the user to a page in the main window, and close the panel.
#[tauri::command]
pub async fn about_show_in_main(
    app: AppHandle,
    window: tauri::Window,
    destination: String,
) -> Result<(), String> {
    let route = route_for(&destination).ok_or("Unknown destination")?;
    crate::show_main_window(&app);
    app.emit_to("main", crate::app_menu::EVENT, format!("nav:{route}"))
        .map_err(|e| e.to_string())?;
    window.close().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::route_for;

    #[test]
    fn only_listed_destinations_have_a_route() {
        assert_eq!(route_for("updates"), Some("/settings?section=updates"));
        assert_eq!(route_for("licenses"), Some("/licenses"));
        for other in ["", "/settings", "nav:/", "https://example.com"] {
            assert_eq!(route_for(other), None, "{other}");
        }
    }
}
