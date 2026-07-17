use tauri::{command, AppHandle, Runtime};

use crate::MpvConfig;
use crate::MpvExt;
use crate::Result;
use crate::VideoMarginRatio;

// PRISM VENDOR PATCH: every command here previously ran on a tokio worker
// thread (`init` inline in the async fn, the rest via `spawn_blocking`) —
// never the main thread. On macOS, AppKit/Cocoa window creation is
// main-thread-only; calling `mpv_wrapper_create` with `force-window`/`wid`
// off the main thread returns NULL — intermittently in a dev build,
// reliably in a release build ("Failed to create mpv instance" on every
// attempt). `run_on_main` serializes every FFI call onto the main thread via
// `AppHandle::run_on_main_thread`, the same pattern already used in Prism's
// own `player.rs` for the window-adoption fixup.
fn run_on_main<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })?;
    rx.recv()
        .map_err(|_| crate::Error::FFI("main-thread task was dropped before completing".into()))
}

#[command]
pub(crate) async fn init<R: Runtime>(
    app: AppHandle<R>,
    mpv_config: MpvConfig,
    window_label: String,
) -> Result<String> {
    let app2 = app.clone();
    run_on_main(&app, move || app2.mpv().init(mpv_config, &window_label))?
}

#[command]
pub(crate) async fn destroy<R: Runtime>(app: AppHandle<R>, window_label: String) -> Result<()> {
    let app2 = app.clone();
    run_on_main(&app, move || app2.mpv().destroy(&window_label))?
}

#[command]
pub(crate) async fn command<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    args: Vec<serde_json::Value>,
    window_label: String,
) -> Result<()> {
    let app2 = app.clone();
    run_on_main(&app, move || app2.mpv().command(&name, &args, &window_label))?
}

#[command]
pub(crate) async fn set_property<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    value: serde_json::Value,
    window_label: String,
) -> Result<()> {
    let app2 = app.clone();
    run_on_main(&app, move || {
        app2.mpv().set_property(&name, &value, &window_label)
    })?
}

#[command]
pub(crate) async fn get_property<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    format: String,
    window_label: String,
) -> Result<serde_json::Value> {
    let app2 = app.clone();
    run_on_main(&app, move || {
        app2.mpv().get_property(name, format, &window_label)
    })?
}

#[command]
pub(crate) async fn set_video_margin_ratio<R: Runtime>(
    app: AppHandle<R>,
    ratio: VideoMarginRatio,
    window_label: String,
) -> Result<()> {
    let app2 = app.clone();
    run_on_main(&app, move || {
        app2.mpv().set_video_margin_ratio(ratio, &window_label)
    })?
}
