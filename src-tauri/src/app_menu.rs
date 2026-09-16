//! The application menu bar.
//!
//! Built by *extending* Tauri's default menu rather than replacing it. On
//! macOS the menu is where the webview gets ⌘C, ⌘V, ⌘Z and the standard Window
//! commands from — assembling one from scratch is an easy way to take those
//! away from every text field in the app without noticing until someone tries
//! to paste a URL.
//!
//! A menu item names an intent and hands it to the frontend, the same way the
//! tray hands over `quick-add-url`. Navigation then goes through the one bus
//! that already owns it (`src/lib/nav-bus.ts`) instead of a second path that
//! could drift from it.

use tauri::menu::{IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// Carries the chosen item's id to the frontend.
const EVENT: &str = "menu-action";

/// Opens the Add sheet.
const ADD_ID: &str = "add";

/// Where each "Go" entry leads: menu id, label, accelerator. The id after
/// `nav:` is the route, so the shell needs no table of its own.
const NAV_ITEMS: [(&str, &str, &str); 6] = [
    ("nav:/", "Dashboard", "CmdOrCtrl+1"),
    ("nav:/queue", "Transfers", "CmdOrCtrl+2"),
    ("nav:/subscriptions", "Subscriptions", "CmdOrCtrl+3"),
    ("nav:/library", "Library", "CmdOrCtrl+4"),
    ("nav:/statistics", "Statistics", "CmdOrCtrl+5"),
    ("nav:/settings", "Settings", "CmdOrCtrl+,"),
];

/// Whether an id is one this menu emitted, rather than a predefined item
/// (Copy, Minimise…) that the OS handles on its own.
fn is_ours(id: &str) -> bool {
    id == ADD_ID || id.starts_with("nav:")
}

pub(crate) fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // The standard menu first: everything below is added to it.
    let menu = Menu::default(app)?;

    let add = MenuItem::with_id(app, ADD_ID, "Add Link…", true, Some("CmdOrCtrl+N"))?;
    let separator = PredefinedMenuItem::separator(app)?;
    let nav: Vec<MenuItem<R>> = NAV_ITEMS
        .iter()
        .map(|(id, label, accelerator)| {
            MenuItem::with_id(app, *id, *label, true, Some(*accelerator))
        })
        .collect::<tauri::Result<_>>()?;

    let mut items: Vec<&dyn IsMenuItem<R>> = vec![&add, &separator];
    items.extend(nav.iter().map(|item| item as &dyn IsMenuItem<R>));

    // A submenu, not loose items: a root menu's children have to be submenus.
    let go = Submenu::with_items(app, "Go", true, &items)?;
    menu.append(&go)?;
    app.set_menu(menu)?;

    app.on_menu_event(|app, event| {
        let id = event.id.as_ref();
        if is_ours(id) {
            let _ = app.emit(EVENT, id.to_string());
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn every_entry_is_distinct() {
        // Two items quietly sharing an accelerator is the sort of thing nobody
        // notices until one of them stops working.
        let ids: HashSet<&str> = NAV_ITEMS.iter().map(|(id, _, _)| *id).collect();
        assert_eq!(ids.len(), NAV_ITEMS.len(), "duplicate menu id");

        let mut accelerators: HashSet<&str> =
            NAV_ITEMS.iter().map(|(_, _, accel)| *accel).collect();
        assert_eq!(accelerators.len(), NAV_ITEMS.len(), "duplicate accelerator");

        // The Add item shares the same keyboard space as the Go entries.
        assert!(accelerators.insert("CmdOrCtrl+N"), "Add collides with a Go entry");
    }

    #[test]
    fn nav_ids_carry_a_usable_route() {
        for (id, label, _) in NAV_ITEMS {
            let route = id.strip_prefix("nav:").unwrap_or_else(|| panic!("{id} is not a nav id"));
            assert!(route.starts_with('/'), "{label}: {route} is not a route");
        }
    }

    #[test]
    fn predefined_items_are_left_to_the_os() {
        // Copy, Minimise and friends must not be forwarded to the frontend —
        // the OS already performed them.
        assert!(is_ours(ADD_ID));
        assert!(is_ours("nav:/library"));
        assert!(!is_ours("copy"));
        assert!(!is_ours("minimize"));
        assert!(!is_ours(""));
    }
}
