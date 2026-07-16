fn main() {
    // Dev wiring for the embedded player: tauri-plugin-libmpv loads
    // libmpv-wrapper.dylib from <exe_dir>/lib, and the wrapper in turn loads
    // libmpv from its own directory. Stage both into target/<profile>/lib so
    // `tauri dev` just works. Best-effort — a missing libmpv only disables
    // the in-app player, never the build. Bundled-app packaging is a separate
    // step (ROADMAP → In-app player → Distribution).
    #[cfg(target_os = "macos")]
    stage_player_libs();

    tauri_build::build()
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
    let libmpv_dst = lib_dir.join("libmpv.dylib");
    if !libmpv_dst.exists() {
        for candidate in ["/opt/homebrew/lib/libmpv.dylib", "/usr/local/lib/libmpv.dylib"] {
            if std::path::Path::new(candidate).exists() {
                let _ = std::os::unix::fs::symlink(candidate, &libmpv_dst);
                break;
            }
        }
    }

    println!("cargo:rerun-if-changed=lib/libmpv-wrapper.dylib");
}
