// Standalone threading harness for the embedded player — NOT part of the app.
//
// Drives the exact libmpv-wrapper + libmpv Prism ships, with a real
// NSApplication run loop on the main thread (like a packaged .app), and runs
// every mpv FFI step either on the main thread (via the main dispatch queue)
// or on a dedicated worker thread, depending on the scenario:
//
//   main-all                 every call on main — the 1.9.0 behaviour; expected
//                            to deadlock (loadfile waits on mpv's core while
//                            the macOS VO waits on the main thread)
//   worker-all               every call on the worker
//   main-init-worker-rest    create on main, everything else on the worker
//   worker-destroy-early     worker; destroy right after loadfile, while the VO
//                            is still coming up (closing the player mid-init)
//   main-init-destroy-early  create on main; destroy early on the worker
//
// A step that doesn't return within --timeout-secs is a hang: the harness runs
// `sample` on itself, reports the deadlock frames it finds, and exits 2.
// Exit 0 = every iteration created mpv, played past 0.5 s and destroyed it.
//
//   cargo run --example mpv_thread_repro -- \
//     --wrapper /Applications/Prism.app/Contents/Resources/lib/libmpv-wrapper.dylib \
//     --clip examples/fixtures/clip.mp4 --scenario worker-all --iterations 20
//
// AppKit and libmpv make this macOS-only; its deps are declared under a macOS
// target in Cargo.toml, so everything below is gated to keep `cargo clippy
// --all-targets` (which builds examples) working on Linux CI.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("mpv_thread_repro is macOS-only — it drives AppKit and the bundled libmpv.");
}

#[cfg(target_os = "macos")]
fn main() {
    mac::main();
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::rc::Retained;
    use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
    use objc2_foundation::MainThreadMarker;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};
    use std::sync::mpsc;
    use std::sync::OnceLock;
    use std::time::{Duration, Instant};

    type EventFn = unsafe extern "C" fn(*const c_char, *mut c_void);
    type Create =
        unsafe extern "C" fn(*const c_char, *const c_char, Option<EventFn>, *mut c_void) -> *mut c_void;
    type Destroy = unsafe extern "C" fn(*mut c_void);
    type Call = unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char;
    type Free = unsafe extern "C" fn(*mut c_char);

    #[derive(Clone, Copy)]
    struct Ffi {
        create: Create,
        destroy: Destroy,
        command: Call,
        set_property: Call,
        get_property: Call,
    }

    static FREE: OnceLock<Free> = OnceLock::new();

    unsafe extern "C" fn on_event(event: *const c_char, _userdata: *mut c_void) {
        if let (Some(free), false) = (FREE.get(), event.is_null()) {
            unsafe { free(event as *mut c_char) };
        }
    }

    #[repr(C)]
    struct DispatchQueue {
        _private: [u8; 0],
    }

    extern "C" {
        static _dispatch_main_q: DispatchQueue;
        fn dispatch_async_f(
            queue: *const DispatchQueue,
            context: *mut c_void,
            work: unsafe extern "C" fn(*mut c_void),
        );
        fn setlocale(category: c_int, locale: *const c_char) -> *mut c_char;
    }

    const LC_NUMERIC: c_int = 4;

    type Job = Box<dyn FnOnce() + Send>;

    unsafe extern "C" fn run_job(context: *mut c_void) {
        let job = unsafe { Box::from_raw(context as *mut Job) };
        job();
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Site {
        Main,
        Worker,
    }

    struct Scenario {
        init: Site,
        rest: Site,
        destroy_early: bool,
    }

    fn scenario(name: &str) -> Scenario {
        use Site::*;
        let (init, rest, destroy_early) = match name {
            "main-all" => (Main, Main, false),
            "worker-all" => (Worker, Worker, false),
            "main-init-worker-rest" => (Main, Worker, false),
            "worker-destroy-early" => (Worker, Worker, true),
            "main-init-destroy-early" => (Main, Worker, true),
            other => usage(&format!("unknown scenario '{other}'")),
        };
        Scenario { init, rest, destroy_early }
    }

    struct Runner {
        worker: mpsc::Sender<Job>,
        timeout: Duration,
    }

    impl Runner {
        fn new(timeout: Duration) -> Self {
            let (tx, rx) = mpsc::channel::<Job>();
            std::thread::Builder::new()
                .name("repro-mpv".into())
                .spawn(move || {
                    for job in rx {
                        job();
                    }
                })
                .expect("spawn worker");
            Runner { worker: tx, timeout }
        }

        /// Run `f` on `site` and wait for it; a step that never returns is a hang.
        fn run<T: Send + 'static>(&self, site: Site, step: &str, f: impl FnOnce() -> T + Send + 'static) -> T {
            let (tx, rx) = mpsc::channel();
            let job: Job = Box::new(move || {
                let _ = tx.send(f());
            });
            match site {
                Site::Main => unsafe {
                    let context = Box::into_raw(Box::new(job)) as *mut c_void;
                    dispatch_async_f(std::ptr::addr_of!(_dispatch_main_q), context, run_job);
                },
                Site::Worker => self.worker.send(job).expect("worker alive"),
            }
            match rx.recv_timeout(self.timeout) {
                Ok(value) => value,
                Err(_) => hung(step, site),
            }
        }
    }

    fn hung(step: &str, site: Site) -> ! {
        println!("HUNG: '{step}' on {site:?} did not return; sampling the process…");
        let pid = std::process::id();
        let out = std::env::temp_dir().join(format!("mpv_thread_repro-{pid}.sample.txt"));
        let _ = std::process::Command::new("/usr/bin/sample")
            .args([pid.to_string().as_str(), "3", "-file"])
            .arg(&out)
            .output();
        match std::fs::read_to_string(&out) {
            Ok(text) => {
                for frame in ["mp_dispatch_lock", "mp_rendezvous", "_dispatch_sync_f_slow", "MacCommon"] {
                    let seen = if text.contains(frame) { "present" } else { "absent" };
                    println!("  {frame}: {seen}");
                }
                println!("  full sample: {}", out.display());
            }
            Err(e) => println!("  sample failed: {e}"),
        }
        std::process::exit(2);
    }

    fn usage(problem: &str) -> ! {
        eprintln!("{problem}");
        eprintln!(
            "usage: mpv_thread_repro --wrapper <libmpv-wrapper.dylib> --clip <media> \
             --scenario <main-all|worker-all|main-init-worker-rest|worker-destroy-early|main-init-destroy-early> \
             [--vo gpu-next] [--force-window yes] [--wid no] [--log <mpv.log>] [--iterations 1] [--timeout-secs 15] \
             [--set <property=value, set before loadfile>]"
        );
        std::process::exit(64);
    }

    /// One wrapper call returning its JSON response (`{"data":…}` / `{"error":…}`).
    fn call(f: Call, handle: usize, a: &str, b: &str) -> Result<serde_json::Value, String> {
        let (ca, cb) = (CString::new(a).unwrap(), CString::new(b).unwrap());
        let ptr = unsafe { f(handle as *mut c_void, ca.as_ptr(), cb.as_ptr()) };
        if ptr.is_null() {
            return Err("wrapper returned a null response".into());
        }
        let text = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
        unsafe { (FREE.get().expect("free fn"))(ptr) };
        let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        match value.get("error").and_then(|e| e.as_str()) {
            Some(err) => Err(err.to_string()),
            None => Ok(value),
        }
    }

    struct Args {
        wrapper: String,
        clip: String,
        scenario: String,
        vo: String,
        force_window: String,
        iterations: usize,
        timeout: Duration,
        wid: bool,
        log: Option<String>,
        set: Option<(String, String)>,
    }

    fn parse_args() -> Args {
        let mut raw = std::env::args().skip(1);
        let mut args = Args {
            wrapper: String::new(),
            clip: String::new(),
            scenario: String::new(),
            vo: "gpu-next".into(),
            force_window: "yes".into(),
            iterations: 1,
            timeout: Duration::from_secs(15),
            wid: false,
            log: None,
            set: None,
        };
        while let Some(flag) = raw.next() {
            let value = raw.next().unwrap_or_else(|| usage(&format!("{flag} needs a value")));
            match flag.as_str() {
                "--wrapper" => args.wrapper = value,
                "--clip" => args.clip = value,
                "--scenario" => args.scenario = value,
                "--vo" => args.vo = value,
                "--force-window" => args.force_window = value,
                "--wid" => args.wid = value == "yes",
                "--log" => args.log = Some(value),
                "--set" => {
                    let (k, v) = value.split_once('=').unwrap_or_else(|| usage("--set needs property=value"));
                    args.set = Some((k.to_string(), v.to_string()));
                }
                "--iterations" => args.iterations = value.parse().unwrap_or_else(|_| usage("bad --iterations")),
                "--timeout-secs" => {
                    args.timeout = Duration::from_secs(value.parse().unwrap_or_else(|_| usage("bad --timeout-secs")))
                }
                other => usage(&format!("unknown flag {other}")),
            }
        }
        if args.wrapper.is_empty() || args.clip.is_empty() || args.scenario.is_empty() {
            usage("--wrapper, --clip and --scenario are required");
        }
        args
    }

    /// A fingerprint of the Dock icon (its TIFF size), to see whether mpv
    /// replaced it. Read on the main thread, as AppKit requires.
    fn dock_icon(runner: &Runner) -> usize {
        runner.run(Site::Main, "read dock icon", || {
            let mtm = MainThreadMarker::new().expect("main thread");
            NSApplication::sharedApplication(mtm)
                .applicationIconImage()
                .and_then(|image| image.TIFFRepresentation())
                .map(|data| data.len())
                .unwrap_or(0)
        })
    }

    fn iteration(runner: &Runner, ffi: Ffi, plan: &Scenario, options: &str, clip: &str, set: Option<(String, String)>, i: usize) {
        let icon_before = dock_icon(runner);
        let started = Instant::now();
        let opts = options.to_string();
        let handle = runner.run(plan.init, "create", move || {
            let o = CString::new(opts).unwrap();
            let props = CString::new(std::env::var("REPRO_PROPS").unwrap_or_else(|_| r#"{"time-pos":"double"}"#.into())).unwrap();
            unsafe { (ffi.create)(o.as_ptr(), props.as_ptr(), Some(on_event), std::ptr::null_mut()) as usize }
        });
        if handle == 0 {
            println!("iteration {i}: create returned NULL on {:?}", plan.init);
            std::process::exit(3);
        }
        let created = started.elapsed();

        if let Some((name, value)) = set {
            let value = serde_json::to_string(&value).unwrap();
            let prop = name.clone();
            if let Err(e) = runner.run(plan.rest, "set property", move || call(ffi.set_property, handle, &prop, &value)) {
                println!("iteration {i}: setting {name} failed: {e}");
                std::process::exit(6);
            }
        }
        let load_args = serde_json::to_string(&[clip]).unwrap();
        if let Err(e) = runner.run(plan.rest, "loadfile", move || call(ffi.command, handle, "loadfile", &load_args)) {
            println!("iteration {i}: loadfile failed: {e}");
            std::process::exit(5);
        }
        let loaded = started.elapsed();

        if !plan.destroy_early {
            let _ = runner.run(plan.rest, "unpause", move || call(ffi.set_property, handle, "pause", "\"no\""));
            let deadline = Instant::now() + runner.timeout;
            loop {
                let pos = runner
                    .run(plan.rest, "get time-pos", move || call(ffi.get_property, handle, "time-pos", "double"))
                    .ok()
                    .and_then(|v| v.get("data").and_then(|d| d.as_f64()));
                if pos.is_some_and(|p| p > 0.5) {
                    break;
                }
                if Instant::now() > deadline {
                    println!("iteration {i}: playback never advanced past 0.5 s");
                    std::process::exit(4);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let played = started.elapsed();
        let icon_after = dock_icon(runner);
        println!(
            "iteration {i}: dock icon {} ({icon_before} -> {icon_after} bytes)",
            if icon_before == icon_after { "unchanged" } else { "CHANGED" }
        );

        runner.run(plan.rest, "destroy", move || unsafe { (ffi.destroy)(handle as *mut c_void) });
        println!(
            "iteration {i}: ok (created {created:.2?}, loaded {loaded:.2?}, playing {played:.2?}, destroyed {:.2?})",
            started.elapsed()
        );
    }

    /// A plain titled window, created on the main thread; returns its content
    /// view's pointer for mpv's `wid`.
    fn host_view() -> i64 {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        use objc2_core_foundation::{CGPoint, CGRect, CGSize};
        let frame = CGRect {
            origin: CGPoint { x: 120.0, y: 120.0 },
            size: CGSize { width: 640.0, height: 360.0 },
        };
        unsafe {
            let window: *mut AnyObject = msg_send![class!(NSWindow), alloc];
            // styleMask: titled | closable | miniaturizable | resizable; backing: buffered
            let window: *mut AnyObject =
                msg_send![window, initWithContentRect: frame, styleMask: 15usize, backing: 2usize, defer: false];
            let _: () = msg_send![window, setReleasedWhenClosed: false];
            let _: () = msg_send![window, orderFrontRegardless];
            let view: *mut AnyObject = msg_send![window, contentView];
            view as i64
        }
    }

    pub fn main() {
        let args = parse_args();
        let plan = scenario(&args.scenario);

        // mpv refuses to start unless LC_NUMERIC is "C" (the plugin does the same).
        unsafe { setlocale(LC_NUMERIC, c"C".as_ptr()) };

        let lib: &'static libloading::Library =
            Box::leak(Box::new(unsafe { libloading::Library::new(&args.wrapper) }.expect("load libmpv-wrapper")));
        let ffi = unsafe {
            Ffi {
                create: *lib.get::<Create>(b"mpv_wrapper_create").expect("mpv_wrapper_create"),
                destroy: *lib.get::<Destroy>(b"mpv_wrapper_destroy").expect("mpv_wrapper_destroy"),
                command: *lib.get::<Call>(b"mpv_wrapper_command").expect("mpv_wrapper_command"),
                set_property: *lib.get::<Call>(b"mpv_wrapper_set_property").expect("mpv_wrapper_set_property"),
                get_property: *lib.get::<Call>(b"mpv_wrapper_get_property").expect("mpv_wrapper_get_property"),
            }
        };
        let free = unsafe { *lib.get::<Free>(b"mpv_wrapper_free").expect("mpv_wrapper_free") };
        let _ = FREE.set(free);

        // Same fixed options as player.rs, plus mute so the run is silent.
        let mut options = serde_json::json!({
            "vo": args.vo,
            "hwdec": "auto-safe",
            "keep-open": "yes",
            "force-window": args.force_window,
            "auto-window-resize": "no",
            "target-colorspace-hint": "yes",
            "input-default-bindings": "no",
            "config": "no",
            "load-scripts": "no",
            "access-references": "no",
            "mute": "yes",
        });
        // As player.rs does: `osc`/`ytdl` exist only in a libmpv built with
        // Lua, and setting a missing option fails the whole create.
        let libmpv = std::path::Path::new(&args.wrapper).with_file_name("libmpv.dylib");
        let lua_disabled = std::fs::read(&libmpv)
            .map(|b| b.windows(14).any(|w| w == b"-Dlua=disabled"))
            .unwrap_or(false);
        if !lua_disabled {
            options["osc"] = serde_json::json!("no");
            options["ytdl"] = serde_json::json!("no");
        }
        println!("libmpv {}: Lua {}", libmpv.display(), if lua_disabled { "disabled" } else { "present (or unknown)" });

        let mtm = MainThreadMarker::new().expect("must run on the main thread");
        let app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

        // --wid yes: hand mpv a real window's content view, as the app does
        // with the player window (the plugin passes its NSView as `wid`).
        if args.wid {
            options["wid"] = serde_json::json!(host_view());
        }
        // mpv's own log — shows which video output actually came up.
        if let Some(log) = &args.log {
            options["log-file"] = serde_json::json!(log);
        }
        let options = options.to_string();

        let clip = args.clip.clone();
        let set = args.set.clone();
        let (iterations, timeout, name) = (args.iterations, args.timeout, args.scenario.clone());
        std::thread::spawn(move || {
            let runner = Runner::new(timeout);
            for i in 1..=iterations {
                iteration(&runner, ffi, &plan, &options, &clip, set.clone(), i);
            }
            println!("{name}: {iterations} iteration(s) passed");
            std::process::exit(0);
        });

        // The controller thread exits the process; the run loop never returns.
        #[allow(unused_unsafe)]
        unsafe {
            app.run();
        }
    }
}
