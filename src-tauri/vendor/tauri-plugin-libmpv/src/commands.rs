use tauri::{command, AppHandle, Runtime};

use crate::MpvConfig;
use crate::MpvExt;
use crate::Result;
use crate::VideoMarginRatio;

// PRISM VENDOR PATCH: every FFI call runs on the blocking pool — never on the
// main thread. (1.7.2 moved them all onto the main thread, which deadlocks on
// macOS: mpv's video output dispatches synchronously to the main thread while
// it starts, so an mpv call made *from* main waits on a startup that is itself
// waiting on main.) Prism grants none of these commands to a webview — it
// drives mpv through its own allowlisted player_* commands on a dedicated
// thread (src/mpv_worker.rs) — but they must not reintroduce the pattern.
async fn blocking<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(AppHandle<R>) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || f(app))
        .await
        .map_err(|e| crate::Error::FFI(format!("mpv task failed: {e}")))?
}

#[command]
pub(crate) async fn init<R: Runtime>(
    app: AppHandle<R>,
    mpv_config: MpvConfig,
    window_label: String,
) -> Result<String> {
    blocking(app, move |app| app.mpv().init(mpv_config, &window_label)).await
}

#[command]
pub(crate) async fn destroy<R: Runtime>(app: AppHandle<R>, window_label: String) -> Result<()> {
    blocking(app, move |app| app.mpv().destroy(&window_label)).await
}

#[command]
pub(crate) async fn command<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    args: Vec<serde_json::Value>,
    window_label: String,
) -> Result<()> {
    blocking(app, move |app| app.mpv().command(&name, &args, &window_label)).await
}

#[command]
pub(crate) async fn set_property<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    value: serde_json::Value,
    window_label: String,
) -> Result<()> {
    blocking(app, move |app| app.mpv().set_property(&name, &value, &window_label)).await
}

#[command]
pub(crate) async fn get_property<R: Runtime>(
    app: AppHandle<R>,
    name: String,
    format: String,
    window_label: String,
) -> Result<serde_json::Value> {
    blocking(app, move |app| app.mpv().get_property(name, format, &window_label)).await
}

#[command]
pub(crate) async fn set_video_margin_ratio<R: Runtime>(
    app: AppHandle<R>,
    ratio: VideoMarginRatio,
    window_label: String,
) -> Result<()> {
    blocking(app, move |app| app.mpv().set_video_margin_ratio(ratio, &window_label)).await
}
