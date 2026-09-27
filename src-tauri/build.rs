fn main() {
    // Dev wiring for the embedded player: tauri-plugin-libmpv loads
    // libmpv-wrapper.dylib from <exe_dir>/lib, and the wrapper in turn loads
    // libmpv from its own directory. Stage both into target/<profile>/lib so
    // `tauri dev` just works. Best-effort — a missing libmpv only disables
    // the in-app player, never the build. Bundled-app packaging is a separate
    // step (ROADMAP → In-app player → Distribution).
    #[cfg(target_os = "macos")]
    stage_player_libs();
    export_bundled_ytdlp_version();
    link_manifest();

    // Prism's own commands go through the ACL like the plugins' do: each
    // window may call only what its capability grants (capabilities/*.json).
    // Without an app manifest every command was callable from every window,
    // the player's included (REVIEW 2026-09-23 S-2). Keep this in step with
    // `generate_handler!` in src/lib.rs; a test there checks it.
    // No Windows app manifest from tauri-build: `link_manifest` puts the same
    // one into every binary, tests included.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS))
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("failed to run tauri-build")
}

/// Every Windows binary needs Common Controls v6, the `cargo test` ones too:
/// rfd (the dialog plugin) imports `TaskDialogIndirect`, which only comctl32 v6
/// has. tauri-build's manifest reached the app alone, so test exes loaded v5
/// and died before `main` with STATUS_ENTRYPOINT_NOT_FOUND — the Rust tests had
/// never run on Windows. The linker now writes the manifest (the same single
/// dependency tauri-build's had) into every binary; the lib's unit-test
/// harness isn't a "tests" target, so this can't be scoped to tests.
fn link_manifest() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_os == "windows" && target_env == "msvc" {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' \
             version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}

/// Every command registered in `generate_handler!`.
const COMMANDS: &[&str] = &[
    "parse_url",
    "parse_playlist",
    "inspect_url",
    "cache_thumbnail",
    "missing_files",
    "log_store_problem",
    "restart_torrent_engine",
    "store_load",
    "store_save_queue",
    "store_update_history",
    "store_save_doc",
    "queue_snapshot",
    "queue_add",
    "queue_remove",
    "queue_pause",
    "queue_resume",
    "queue_cancel",
    "queue_retry",
    "queue_pause_all",
    "queue_resume_all",
    "queue_clear_completed",
    "queue_reorder",
    "queue_set_settings",
    "queue_update_torrent_files",
    "queue_remove_with_data",
    "queue_restart_torrent_engine",
    "when_done_cancel",
    "start_download",
    "cancel_download",
    "probe_direct_link",
    "start_http_download",
    "cancel_http_download",
    "set_http_rate_limit",
    "preview_filename_template",
    "start_torrent",
    "cancel_torrent",
    "pause_torrent",
    "resume_torrent",
    "update_torrent_files",
    "parse_torrent",
    "set_torrent_rate_limit",
    "reannounce_torrent",
    "recheck_torrent",
    "torrent_peers",
    "torrent_details",
    "open_file",
    "open_external",
    "show_in_folder",
    "get_default_download_path",
    "get_launch_torrent_files",
    "import_torrent_file",
    "pick_download_dir",
    "open_backup_file",
    "import_torrent_client",
    "get_app_version",
    "ffmpeg_available",
    "get_ytdlp_version",
    "update_ytdlp",
    "reset_ytdlp",
    "get_engine_info",
    "check_engine_update",
    "check_app_update",
    "install_app_update",
    "fixup_player_video",
    "player_available",
    "player_init",
    "player_destroy",
    "player_load",
    "player_load_stream",
    "player_open_file",
    "player_save_position",
    "player_resume_position",
    "player_add_subtitle",
    "player_sibling_subtitles",
    "player_set_mini",
    "player_seek",
    "player_set",
    "when_done",
    "storage_summary",
    "move_to_trash",
    "rss_fetch",
    "set_shortcuts",
    "set_progress",
    "index_download",
    "convert_file",
    "cancel_convert",
];

/// The yt-dlp version scripts/sidecars.lock pins, so the app can tell whether
/// a self-updated engine is newer than the one it ships with (engine.rs).
fn export_bundled_ytdlp_version() {
    let lock = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/sidecars.lock");
    println!("cargo:rerun-if-changed={}", lock.display());
    let version = std::fs::read_to_string(&lock)
        .ok()
        .and_then(|text| {
            text.lines()
                .find_map(|line| line.trim().strip_prefix("YTDLP_VERSION=").map(|v| v.trim().to_string()))
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=PRISM_BUNDLED_YTDLP_VERSION={version}");
}

#[cfg(target_os = "macos")]
fn stage_player_libs() {
    use std::path::PathBuf;

    let out_dir = match std::env::var("OUT_DIR") {
        Ok(d) => PathBuf::from(d),
        Err(_) => return,
    };
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out → profile dir is 3 up.
    let profile_dir = match out_dir.ancestors().nth(3) {
        Some(d) => d.to_path_buf(),
        None => return,
    };
    let lib_dir = profile_dir.join("lib");
    let _ = std::fs::create_dir_all(&lib_dir);

    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let wrapper_src = manifest.join("lib/libmpv-wrapper.dylib");
    if wrapper_src.exists() {
        let _ = std::fs::copy(&wrapper_src, lib_dir.join("libmpv-wrapper.dylib"));
    }

    // The wrapper resolves libmpv relative to itself first; link the system
    // (Homebrew) libmpv next to it. Symlink, not copy — tracks brew upgrades.
    //
    // When scripts/bundle-libmpv-macos.sh has produced a real self-contained
    // libmpv in src-tauri/lib, the resource staging copies it here itself —
    // and copying *over a symlink* would try to write into Homebrew
    // (EACCES). Drop any stale symlink and skip ours in that case.
    let libmpv_dst = lib_dir.join("libmpv.dylib");
    let have_bundled = manifest.join("lib/libmpv.dylib").exists();
    if libmpv_dst.symlink_metadata().map(|m| m.is_symlink()).unwrap_or(false) && have_bundled {
        let _ = std::fs::remove_file(&libmpv_dst);
    }
    if !have_bundled && !libmpv_dst.exists() {
        for candidate in ["/opt/homebrew/lib/libmpv.dylib", "/usr/local/lib/libmpv.dylib"] {
            if std::path::Path::new(candidate).exists() {
                let _ = std::os::unix::fs::symlink(candidate, &libmpv_dst);
                break;
            }
        }
    }

    println!("cargo:rerun-if-changed=lib/libmpv-wrapper.dylib");
}
