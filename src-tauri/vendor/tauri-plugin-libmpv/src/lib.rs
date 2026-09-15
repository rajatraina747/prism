use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, RunEvent, Runtime, WindowEvent,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;
#[cfg(desktop)]
mod wrapper;

mod commands;
mod error;
mod models;
mod utils;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Mpv;
#[cfg(mobile)]
use mobile::Mpv;

pub trait MpvExt<R: Runtime> {
    fn mpv(&self) -> &Mpv<R>;
}

impl<R: Runtime, T: Manager<R>> crate::MpvExt<R> for T {
    fn mpv(&self) -> &Mpv<R> {
        self.state::<Mpv<R>>().inner()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("libmpv")
        .invoke_handler(tauri::generate_handler![
            commands::init,
            commands::destroy,
            commands::command,
            commands::set_property,
            commands::get_property,
            commands::set_video_margin_ratio,
        ])
        .setup(|app, api| {
            unsafe {
                let locale = std::ffi::CString::new("C").unwrap();
                libc::setlocale(libc::LC_NUMERIC, locale.as_ptr());
            }

            #[cfg(mobile)]
            let mpv = mobile::init(app, api)?;
            #[cfg(desktop)]
            let mpv = desktop::init(app, api)?;
            app.manage(mpv);
            Ok(())
        })
        .on_event(|app_handle, run_event| {
            if let RunEvent::WindowEvent {
                label,
                event: WindowEvent::CloseRequested { api, .. },
                ..
            } = run_event
            {
                let mpv_state = app_handle.state::<Mpv<R>>();

                // PRISM VENDOR PATCH: never wait for this lock here — this runs
                // on the main thread. `with_instance` holds it for a whole FFI
                // call, and on macOS that call can itself be waiting for the
                // main thread (mpv's video output dispatches to main while it
                // starts), so a blocking lock deadlocks the app when the player
                // is closed mid-startup. Busy means an instance is in use.
                let instance_exists = match mpv_state.instances.try_lock() {
                    Ok(guard) => guard.contains_key(label),
                    Err(std::sync::TryLockError::Poisoned(poisoned)) => {
                        log::warn!("Mutex for mpv instances was poisoned. Recovering.");
                        poisoned.into_inner().contains_key(label)
                    }
                    Err(std::sync::TryLockError::WouldBlock) => true,
                };

                if instance_exists {
                    api.prevent_close();

                    let app_handle_clone = app_handle.clone();
                    let window_label = label.to_string();

                    // Blocking pool, not an async task: destroy waits for the
                    // instance lock and for mpv to terminate.
                    tauri::async_runtime::spawn_blocking(move || {
                        log::info!(
                            "Close requested for '{}', destroying mpv instance first...",
                            &window_label
                        );

                        if let Err(e) = app_handle_clone.mpv().destroy(&window_label) {
                            log::error!(
                                "Failed to destroy mpv for '{}': {}. Still closing.",
                                &window_label,
                                e
                            );
                        }

                        if let Some(window) = app_handle_clone.get_webview_window(&window_label) {
                            if let Err(e) = window.close() {
                                log::error!("Failed to close window '{}': {}", &window_label, e);
                            }
                        }
                    });
                }
            }
        })
        .build()
}
