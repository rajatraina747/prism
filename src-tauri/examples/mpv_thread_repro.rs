// Standalone repro/verification harness — NOT part of the app. Confirms the
// commands.rs main-thread patch: creates a real NSApplication + run loop
// (mimicking a packaged .app), then calls mpv_wrapper_create with real
// window-creating options from a background thread (the old, broken path)
// and via a main-thread dispatch (the patched path), against the exact
// bundled dylibs Prism ships.
use objc2::rc::Retained;
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
use objc2_foundation::MainThreadMarker;
use std::ffi::{c_char, c_void, CString};
use std::os::raw::c_void as CVoid;
use std::sync::mpsc;

type Create = unsafe extern "C" fn(*const c_char, *const c_char, Option<unsafe extern "C" fn(*const c_char, *mut c_void)>, *mut c_void) -> *mut CVoid;
type Destroy = unsafe extern "C" fn(*mut CVoid);

unsafe extern "C" fn on_event(_e: *const c_char, _u: *mut c_void) {}

fn call_create(create: Create, opts: &str) -> *mut CVoid {
    let c_opts = CString::new(opts).unwrap();
    let c_props = CString::new("{}").unwrap();
    unsafe { create(c_opts.as_ptr(), c_props.as_ptr(), Some(on_event), std::ptr::null_mut()) }
}

fn main() {
    let lib_path = std::env::args().nth(1).expect("usage: mpv_thread_repro <path-to-libmpv-wrapper.dylib>");
    let lib = unsafe { libloading::Library::new(&lib_path) }.expect("load wrapper");
    let create: libloading::Symbol<Create> = unsafe { lib.get(b"mpv_wrapper_create") }.expect("sym create");
    let destroy: libloading::Symbol<Destroy> = unsafe { lib.get(b"mpv_wrapper_destroy") }.expect("sym destroy");
    let create = *create;
    let destroy = *destroy;

    let mtm = MainThreadMarker::new().expect("must run on main thread");
    let app: Retained<NSApplication> = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Accessory);

    let opts = r#"{"vo":"gpu-next","hwdec":"auto-safe","keep-open":"yes","force-window":"yes","auto-window-resize":"no","target-colorspace-hint":"yes","input-default-bindings":"no","osc":"no"}"#;

    // OLD (broken) path: call from a background std::thread while a real
    // NSApp run loop is alive on main — mirrors upstream's un-patched
    // spawn_blocking/inline-async behavior.
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let h = call_create(create, opts);
        tx.send(h as usize).ok();
    });
    // Give the run loop a moment to actually start spinning before the
    // background thread's call lands, like a real app's timing.
    std::thread::sleep(std::time::Duration::from_millis(200));

    // Pump the run loop briefly so main-queue dispatches (if mpv issues any)
    // can actually execute while we wait for the background result.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let bg_result = loop {
        if let Ok(h) = rx.try_recv() { break Some(h); }
        if std::time::Instant::now() > deadline { break None; }
        unsafe {
            use objc2_foundation::{NSDate, NSRunLoop, NSDefaultRunLoopMode};
            let rl = NSRunLoop::currentRunLoop();
            let until = NSDate::dateWithTimeIntervalSinceNow(0.02);
            let _ = rl.runMode_beforeDate(NSDefaultRunLoopMode, &until);
        }
    };
    match bg_result {
        Some(h) if h != 0 => {
            println!("OLD PATH (background thread): SUCCESS (unexpected!)");
            unsafe { destroy(h as *mut CVoid) };
        }
        Some(_) => println!("OLD PATH (background thread): NULL (bug reproduced)"),
        None => println!("OLD PATH (background thread): TIMED OUT (bug reproduced — hung)"),
    }

    // NEW (patched) path: call directly on the main thread, as commands.rs
    // now does via run_on_main_thread.
    let h2 = call_create(create, opts);
    if h2.is_null() {
        println!("NEW PATH (main thread): NULL (fix did NOT work)");
    } else {
        println!("NEW PATH (main thread): SUCCESS (fix works)");
        unsafe { destroy(h2) };
    }
}
