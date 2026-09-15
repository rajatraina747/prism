//! The one thread Prism calls mpv from.
//!
//! mpv's client API is thread-safe, but on macOS its video output starts up by
//! dispatching work *synchronously onto the main thread* (gpu-next → MoltenVK
//! → `MacCommon.init` → `DispatchQueue.main.sync`). An mpv call made from the
//! main thread while that is in flight waits on mpv's core, the core waits on
//! the video output, and the video output waits on the main thread: the whole
//! app beach-balls and never recovers. 1.7.2–1.9.0 ran every call on the main
//! thread and did exactly that (docs/AUDIT-2026-07.md, 1.9.1 addendum).
//!
//! So every mpv call runs here, on one dedicated thread, in the order it was
//! made, and the caller awaits it with a timeout. The main thread never runs or
//! waits on an mpv call; AppKit-only work (window adoption in player.rs) is the
//! one thing that still goes to main. `examples/mpv_thread_repro.rs` reproduces
//! the deadlock and exercises this arrangement against the bundled libmpv.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

pub const INIT_TIMEOUT: Duration = Duration::from_secs(20);
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5);

const STOPPED_RESPONDING: &str =
    "The player stopped responding. Close the player window and restart Prism to play again.";

type Job = Box<dyn FnOnce(&MpvCalls) + Send>;

/// The mpv operations Prism uses. Only handed out on the worker thread.
pub struct MpvCalls {
    app: AppHandle,
}

impl MpvCalls {
    pub fn init(&self, config: MpvConfig, label: &str) -> Result<(), String> {
        self.app.mpv().init(config, label).map(|_| ()).map_err(|e| e.to_string())
    }

    pub fn destroy(&self, label: &str) -> Result<(), String> {
        self.app.mpv().destroy(label).map_err(|e| e.to_string())
    }

    pub fn command(&self, name: &str, args: Vec<serde_json::Value>, label: &str) -> Result<(), String> {
        self.app.mpv().command(name, &args, label).map_err(|e| e.to_string())
    }

    pub fn set_property(&self, name: &str, value: &serde_json::Value, label: &str) -> Result<(), String> {
        self.app.mpv().set_property(name, value, label).map_err(|e| e.to_string())
    }
}

pub struct MpvWorker {
    jobs: mpsc::Sender<Job>,
    /// Set when a call outlives its timeout. The thread is still stuck inside
    /// mpv, so anything queued behind it would wait too — fail fast instead.
    wedged: AtomicBool,
}

impl MpvWorker {
    pub fn spawn(app: AppHandle) -> std::io::Result<Self> {
        let (jobs, queue) = mpsc::channel::<Job>();
        std::thread::Builder::new().name("prism-mpv".into()).spawn(move || {
            let calls = MpvCalls { app };
            for job in queue {
                job(&calls);
            }
        })?;
        Ok(Self { jobs, wedged: AtomicBool::new(false) })
    }

    /// Run `f` on the mpv thread and wait for it, for at most `timeout`.
    pub async fn run<T: Send + 'static>(
        &self,
        what: &'static str,
        timeout: Duration,
        f: impl FnOnce(&MpvCalls) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if self.wedged.load(Ordering::Relaxed) {
            return Err(STOPPED_RESPONDING.into());
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.jobs
            .send(Box::new(move |calls| {
                // A panic must not take the thread (and every later call) down.
                let result = catch_unwind(AssertUnwindSafe(|| f(calls)))
                    .unwrap_or_else(|_| Err("The player engine failed handling a request".into()));
                let _ = tx.send(result);
            }))
            .map_err(|_| "The player engine thread has stopped".to_string())?;
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("The player engine dropped the request".into()),
            Err(_) => {
                self.wedged.store(true, Ordering::Relaxed);
                log::error!("mpv {what} did not return within {timeout:?}; player marked unresponsive");
                Err(STOPPED_RESPONDING.into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    /// The deadlock came back once already by way of a "harmless" helper that
    /// called mpv on the main thread. Nothing outside this module may reach
    /// the plugin's mpv handle.
    #[test]
    fn mpv_is_only_called_through_the_worker() {
        for (file, source) in [("player.rs", include_str!("player.rs")), ("lib.rs", include_str!("lib.rs"))] {
            assert!(!source.contains(".mpv()"), "{file} calls mpv directly; use MpvWorker::run");
            assert!(!source.contains("MpvExt"), "{file} imports MpvExt; use MpvWorker::run");
        }
    }
}
