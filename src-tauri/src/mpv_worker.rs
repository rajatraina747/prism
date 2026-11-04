//! The one thread Prism calls mpv from.
//!
//! mpv's client API is thread-safe, but on macOS its video output starts up by
//! dispatching work *synchronously onto the main thread* (gpu-next → MoltenVK
//! → `MacCommon.init` → `DispatchQueue.main.sync`). An mpv call made from the
//! main thread while that is in flight waits on mpv's core, the core waits on
//! the video output, and the video output waits on the main thread: the whole
//! app beach-balls and never recovers. 1.7.2–1.9.0 ran every call on the main
//! thread and did exactly that (the July 2026 audit, 1.9.1 addendum; in git history).
//!
//! So every mpv call runs here, on one dedicated thread, in the order it was
//! made, and the caller awaits it with a timeout. The main thread never runs or
//! waits on an mpv call; AppKit-only work (window adoption in player.rs) is the
//! one thing that still goes to main. `examples/mpv_thread_repro.rs` reproduces
//! the deadlock and exercises this arrangement against the bundled libmpv.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tauri_plugin_libmpv::{MpvConfig, MpvExt};

pub const INIT_TIMEOUT: Duration = Duration::from_secs(20);
pub const LOAD_TIMEOUT: Duration = Duration::from_secs(10);
pub const CALL_TIMEOUT: Duration = Duration::from_secs(5);

const STOPPED_RESPONDING: &str =
    "The player stopped responding. Close the player window and open it again; if it still won't play, restart Prism.";

type Job<C> = Box<dyn FnOnce(&C) + Send>;

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

    pub fn get_property(&self, name: &str, format: &str, label: &str) -> Result<serde_json::Value, String> {
        self.app.mpv().get_property(name.to_string(), format.to_string(), label).map_err(|e| e.to_string())
    }
}

/// The worker Prism manages: one thread, handed the plugin's mpv calls.
pub type MpvWorker = Worker<MpvCalls>;

/// A single thread that runs jobs in order, each given `C`. Generic so the
/// timeout and recovery rules can be tested without an mpv.
pub struct Worker<C> {
    jobs: mpsc::Sender<Job<C>>,
    /// Set when a call outlives its timeout. The thread is still stuck inside
    /// mpv, so anything queued behind it would wait too — fail fast instead.
    /// Cleared again by the thread when that call does return: a call that
    /// was only slow (a first start, while macOS checks freshly installed
    /// libraries, took 16 s) mustn't leave the player dead until a restart.
    wedged: Arc<AtomicBool>,
}

impl Worker<MpvCalls> {
    pub fn spawn(app: AppHandle) -> std::io::Result<Self> {
        Self::spawn_with(MpvCalls { app })
    }
}

impl<C: Send + 'static> Worker<C> {
    pub fn spawn_with(calls: C) -> std::io::Result<Self> {
        let (jobs, queue) = mpsc::channel::<Job<C>>();
        let wedged = Arc::new(AtomicBool::new(false));
        let thread_wedged = wedged.clone();
        std::thread::Builder::new().name("prism-mpv".into()).spawn(move || {
            for job in queue {
                job(&calls);
                // Whatever overran has returned: the thread is free again.
                if thread_wedged.swap(false, Ordering::Relaxed) {
                    log::info!("mpv thread is responding again");
                }
            }
        })?;
        Ok(Self { jobs, wedged })
    }

    /// Run `f` on the mpv thread and wait for it, for at most `timeout` once it
    /// has started. Time spent queued behind another call doesn't count: a
    /// slow `init` used to make the calls behind it time out and mark a
    /// player that was about to work as dead. While queued, it gives up only
    /// if the call ahead of it is declared stuck.
    pub async fn run<T: Send + 'static>(
        &self,
        what: &'static str,
        timeout: Duration,
        f: impl FnOnce(&C) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        if self.wedged.load(Ordering::Relaxed) {
            return Err(STOPPED_RESPONDING.into());
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (started_tx, mut started_rx) = tokio::sync::oneshot::channel::<()>();
        self.jobs
            .send(Box::new(move |calls| {
                let _ = started_tx.send(());
                // A panic must not take the thread (and every later call) down.
                let result = catch_unwind(AssertUnwindSafe(|| f(calls)))
                    .unwrap_or_else(|_| Err("The player engine failed handling a request".into()));
                let _ = tx.send(result);
            }))
            .map_err(|_| "The player engine thread has stopped".to_string())?;
        loop {
            match tokio::time::timeout(Duration::from_millis(250), &mut started_rx).await {
                Ok(Ok(())) => break,
                Ok(Err(_)) => return Err("The player engine thread has stopped".into()),
                Err(_) if self.wedged.load(Ordering::Relaxed) => return Err(STOPPED_RESPONDING.into()),
                Err(_) => {}
            }
        }
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
    use super::*;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    // Regression (play-any-file testing, 2026-11-05): the first player start
    // took 16 s; four calls queued behind it hit their 5 s timeouts and
    // marked the player dead, though init then succeeded.
    #[test]
    fn time_spent_queued_behind_a_slow_call_does_not_count() {
        let w = Worker::spawn_with(()).unwrap();
        let rt = rt();
        rt.block_on(async {
            let slow = w.run("init", Duration::from_secs(5), |_| {
                std::thread::sleep(Duration::from_millis(600));
                Ok(1)
            });
            let queued = w.run("set_property", Duration::from_millis(200), |_| Ok(2));
            let (a, b) = tokio::join!(slow, queued);
            assert_eq!((a.unwrap(), b.unwrap()), (1, 2));
        });
    }

    #[test]
    fn a_call_that_overruns_marks_it_stuck_until_it_returns() {
        let w = Worker::spawn_with(()).unwrap();
        let rt = rt();
        rt.block_on(async {
            let stuck = w.run("loadfile", Duration::from_millis(100), |_| {
                std::thread::sleep(Duration::from_millis(500));
                Ok(())
            });
            assert!(stuck.await.is_err(), "an overrun is reported");
            // While it's still inside the call, others fail fast.
            assert!(w.run("seek", Duration::from_secs(5), |_| Ok(())).await.is_err());
            // Once it returns, the player works again without a restart.
            tokio::time::sleep(Duration::from_millis(600)).await;
            assert_eq!(w.run("seek", Duration::from_secs(5), |_| Ok(7)).await.unwrap(), 7);
        });
    }

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
