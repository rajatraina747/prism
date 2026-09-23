//! App self-update, driven from Rust instead of the plugin's JS `check()`.
//!
//! The JS API can't configure the HTTP client, and the plugin's own client
//! has no connect timeout. On a network that black-holes one of GitHub's CDN
//! addresses (seen in the wild: the router's DNS always answered with the dead
//! one first) the TCP connect to that address hangs for the OS default (~75 s),
//! the frontend's 30 s overall timeout fires first, and the other addresses are
//! never tried — "Could not reach update server" while curl and browsers work.
//! hyper splits `connect_timeout` evenly across the resolved addresses, so a
//! bounded connect timeout is exactly what makes it fall through to a live one.

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Budget for connecting, shared across every address DNS returns (GitHub's
/// CDN hands out four, so ~3 s each).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
/// A download that stops delivering bytes for this long is dead. Deliberately
/// not an overall request timeout: that would also cap a slow but healthy
/// download of the full installer.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// The whole check (latest.json is a few KB).
const CHECK_TIMEOUT: Duration = Duration::from_secs(45);

/// The update found by the last successful check, installed on request.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    available: bool,
    version: Option<String>,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// An error with its whole `source()` chain. reqwest's top-level message is
/// just "error sending request"; the cause ("operation timed out", "dns
/// error", "certificate…") is what tells a user what is actually wrong.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(s) = cur {
        let msg = s.to_string();
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        cur = s.source();
    }
    out
}

#[tauri::command]
pub async fn check_app_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<UpdateInfo, String> {
    let checked = async {
        let updater = app
            .updater_builder()
            .configure_client(|c| c.connect_timeout(CONNECT_TIMEOUT).read_timeout(READ_TIMEOUT))
            .build()
            .map_err(|e| error_chain(&e))?;
        tokio::time::timeout(CHECK_TIMEOUT, updater.check())
            .await
            .map_err(|_| format!("Update check timed out after {} seconds", CHECK_TIMEOUT.as_secs()))?
            .map_err(|e| error_chain(&e))
    }
    .await;
    let found = match checked {
        Ok(found) => found,
        Err(e) => {
            log::warn!("update check failed: {e}");
            return Err(e);
        }
    };
    match &found {
        Some(u) => log::info!("update check: {} available", u.version),
        None => log::info!("update check: up to date"),
    }
    let info = UpdateInfo {
        available: found.is_some(),
        version: found.as_ref().map(|u| u.version.clone()),
        notes: found.as_ref().and_then(|u| u.body.clone()),
    };
    *pending.0.lock().map_err(|_| "Update state lock poisoned".to_string())? = found;
    Ok(info)
}

/// Download, verify (minisign, inside the plugin) and install the pending
/// update. Progress goes out as `app-update-progress`; the frontend relaunches.
#[tauri::command]
pub async fn install_app_update(
    app: AppHandle,
    pending: State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .map_err(|_| "Update state lock poisoned".to_string())?
        .clone()
        .ok_or("No update available to install — check for updates first")?;
    // One install at a time. A second request used to start a second
    // download of the whole app beside the first, each at half speed.
    static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if INSTALLING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("An update is already downloading".into());
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            INSTALLING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _release = Release;
    log::info!("installing update {}", update.version);
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                let _ = app.emit("app-update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| {
            let msg = error_chain(&e);
            log::warn!("update install failed: {msg}");
            msg
        })
}

#[cfg(test)]
mod tests {
    use super::error_chain;

    #[derive(Debug)]
    struct E(&'static str, Option<Box<E>>);
    impl std::fmt::Display for E {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.0)
        }
    }
    impl std::error::Error for E {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            self.1.as_deref().map(|e| e as _)
        }
    }

    /// The updater fix against the real network: the release-asset host is
    /// resolved to a black-holed address *first* (on the network this was
    /// diagnosed on, GitHub's 185.199.109.133 behaved exactly like this),
    /// then to a live one. hyper splits the connect timeout across the
    /// addresses, so the request falls through and succeeds well inside the
    /// check budget. The plugin's own client — no connect timeout — sat on
    /// the dead address for the OS's ~75 s TCP timeout instead.
    ///
    /// Uses this crate's reqwest 0.12 (the plugin builds on 0.13); both use
    /// hyper-util's connector. Network-dependent, so opt-in:
    /// `cargo test --lib -- --ignored connect_timeout`.
    #[test]
    #[ignore = "needs network"]
    fn connect_timeout_falls_through_a_blackholed_address() {
        use std::net::{SocketAddr, ToSocketAddrs};
        const HOST: &str = "release-assets.githubusercontent.com";
        let dead: SocketAddr = std::env::var("PRISM_DEAD_ADDR")
            .unwrap_or_else(|_| "10.255.255.1:443".into())
            .parse()
            .unwrap();
        let live = (HOST, 443)
            .to_socket_addrs()
            .expect("DNS")
            .find(|a| a.is_ipv4() && a.ip() != dead.ip())
            .expect("a live IPv4 address");
        let client = reqwest::Client::builder()
            .connect_timeout(super::CONNECT_TIMEOUT)
            .resolve_to_addrs(HOST, &[dead, live])
            .build()
            .unwrap();
        let started = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(client.get(format!("https://{HOST}/")).send());
        let took = started.elapsed();
        // Any HTTP status proves TCP + TLS reached the live address.
        assert!(result.is_ok(), "request failed after {took:?}: {result:?}");
        assert!(took < super::CHECK_TIMEOUT, "took {took:?}");
        assert!(took >= super::CONNECT_TIMEOUT / 2 / 2, "dead address was never tried ({took:?})");
    }

    #[test]
    fn error_chain_includes_causes_once() {
        let e = E("error sending request", Some(Box::new(E("operation timed out", None))));
        assert_eq!(error_chain(&e), "error sending request: operation timed out");
        let dup = E("client error (Connect): tcp connect error", Some(Box::new(E("tcp connect error", None))));
        assert_eq!(error_chain(&dup), "client error (Connect): tcp connect error");
    }
}
