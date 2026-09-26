//! Running yt-dlp: one process group per run, streamed output, whole-run kill.
//!
//! yt-dlp ships as a PyInstaller one-file bundle: the process Prism starts
//! unpacks itself and forks the real downloader. Killing only the launcher
//! leaves that worker running (see `proc`). On unix every run now gets its own
//! process group, so one `killpg` reaches the worker and anything it forked —
//! including a child that was reparented after its parent exited, which a walk
//! of the process table (`proc::kill_tree`) can't find.
//!
//! Windows has no process groups, so a run is put in a job object instead:
//! killing the job reaches everything in it, and because the job is set to end
//! when its last handle closes, a run cannot outlive Prism however Prism ends.
//! `taskkill /T` stays as the fallback for the sliver of time between starting
//! a process and assigning it. The tests below are unix-only — the Windows
//! path is compiled by CI's cross-check job and exercised by hand.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};
use tokio::sync::mpsc;

/// What a run reports, in order: output lines as they arrive (each with its
/// terminator), then exactly one `Terminated`, which is always the last event.
#[derive(Debug)]
pub enum Event {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Terminated(Option<i32>),
}

#[derive(Debug, Clone)]
pub struct CommandSpec {
    program: PathBuf,
    args: Vec<OsString>,
    envs: Vec<(OsString, OsString)>,
}

impl CommandSpec {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        CommandSpec { program: program.into(), args: Vec::new(), envs: Vec::new() }
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.envs.push((key.as_ref().to_os_string(), value.as_ref().to_os_string()));
        self
    }

    pub fn spawn(self) -> std::io::Result<(mpsc::UnboundedReceiver<Event>, Child)> {
        let mut cmd = tokio::process::Command::new(&self.program);
        cmd.args(&self.args)
            .envs(self.envs.iter().map(|(k, v)| (k, v)))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        // Made before the spawn so the gap before the process is assigned is
        // as short as it can be; anything forked inside that gap is still
        // covered by the `taskkill` fallback in `kill`.
        #[cfg(windows)]
        let job = job::create();

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
        #[cfg(windows)]
        if let Some(job) = job {
            job::assign(job, pid);
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let stdout = child.stdout.take().map(|s| forward(s, tx.clone(), Event::Stdout));
        let stderr = child.stderr.take().map(|s| forward(s, tx.clone(), Event::Stderr));
        let exited = Arc::new(AtomicBool::new(false));
        let exited_flag = exited.clone();
        tauri::async_runtime::spawn(async move {
            // Drain output first so Terminated is always the last event.
            if let Some(reader) = stdout {
                let _ = reader.await;
            }
            if let Some(reader) = stderr {
                let _ = reader.await;
            }
            let code = child.wait().await.ok().and_then(|status| status.code());
            exited_flag.store(true, Ordering::SeqCst);
            // Letting go of the last handle ends the job, which also takes
            // down anything the run forked and walked away from.
            #[cfg(windows)]
            if let Some(job) = job {
                job::close(job);
            }
            let _ = tx.send(Event::Terminated(code));
        });
        Ok((
            rx,
            Child {
                pid,
                exited,
                #[cfg(windows)]
                job,
            },
        ))
    }
}

/// The longest piece `forward` sends. A longer line arrives in pieces this
/// size, so a caller's byte cap trips on the first ones instead of after the
/// whole line has been buffered. `--dump-json` prints one line, however big
/// (REVIEW 2026-09-23 S-6).
const MAX_LINE: u64 = 1024 * 1024;

/// Forward a pipe line by line (or in `MAX_LINE` pieces). Keeps reading after
/// the receiver is gone, so the process never blocks on a full pipe.
fn forward<R>(
    stream: R,
    tx: mpsc::UnboundedSender<Event>,
    wrap: fn(Vec<u8>) -> Event,
) -> tauri::async_runtime::JoinHandle<()>
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stream);
        loop {
            let mut line = Vec::new();
            match (&mut reader).take(MAX_LINE).read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = tx.send(wrap(line));
                }
            }
        }
    })
}

/// Everything Prism needs to reach one run's processes on Windows: a job
/// object they are all in, held as a `usize` so `Child` stays `Send`.
#[cfg(windows)]
mod job {
    use std::ffi::c_void;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    /// An unnamed job whose processes are killed when its last handle closes.
    /// `None` if Windows refused, in which case the caller falls back to
    /// killing the tree by pid.
    pub fn create() -> Option<usize> {
        // SAFETY: null attributes and a null name are the documented way to
        // ask for an unnamed job; the handle is checked before it is used.
        let handle: HANDLE = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return None;
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is a correctly sized, fully initialised struct of
        // the class named, and outlives the call.
        let set = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(limits) as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set == 0 {
            // A job without the kill-on-close limit would let downloads
            // outlive Prism, which is the whole point of having one.
            let _ = unsafe { CloseHandle(handle) };
            return None;
        }
        Some(handle as usize)
    }

    /// Put a process in the job. Best effort: a process that has already
    /// exited can't be assigned, and doesn't need to be.
    pub fn assign(job: usize, pid: u32) -> bool {
        // SAFETY: the rights asked for are the ones assignment needs; the
        // returned handle is checked and always closed again below.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            return false;
        }
        let assigned = unsafe { AssignProcessToJobObject(job as HANDLE, process) };
        let _ = unsafe { CloseHandle(process) };
        assigned != 0
    }

    pub fn terminate(job: usize) {
        // SAFETY: `job` came from `create` and is closed only by `close`.
        let _ = unsafe { TerminateJobObject(job as HANDLE, 1) };
    }

    pub fn close(job: usize) {
        // SAFETY: as above; called once, from the run's own task.
        let _ = unsafe { CloseHandle(job as HANDLE) };
    }
}

/// A running command. Dropping it does not kill the process; `kill` does.
pub struct Child {
    pid: u32,
    exited: Arc<AtomicBool>,
    /// Windows only: the job object holding this run (see `job`).
    #[cfg(windows)]
    job: Option<usize>,
}

/// How long a run has to exit after SIGTERM before it is killed outright.
///
/// SIGKILL straight away gave yt-dlp no chance to clean up: its PyInstaller
/// launcher unpacks ~70 MB into a `_MEI*` temp folder per run and removes it
/// only when it exits normally, so every pause and cancel left one behind
/// (115 folders, 8 GB, on one Mac: REVIEW 2026-09-26). SIGTERM lets the
/// launcher forward the signal, wait for the worker and tidy up; a `.part`
/// file is resumable either way.
pub const KILL_GRACE: std::time::Duration = std::time::Duration::from_secs(3);

impl Child {
    /// Stop the whole run: its process group on unix (forked workers
    /// included), its job object on Windows. On unix it is asked to stop
    /// first and killed outright after `KILL_GRACE` if it hasn't. A no-op once
    /// it has exited, when its pid may already belong to another process.
    pub fn kill(&self) {
        if self.gone() {
            return;
        }
        #[cfg(unix)]
        {
            // SAFETY: a plain signal to this run's own process group; `gone`
            // ruled out pid 0/1 (which would mean Prism's group or init).
            unsafe {
                libc::killpg(self.pid as libc::pid_t, libc::SIGTERM);
            }
            let (pid, exited) = (self.pid, self.exited.clone());
            let _ = std::thread::Builder::new().name("prism-kill-grace".into()).spawn(move || {
                if !wait_for(&exited, KILL_GRACE) {
                    hard_kill(pid, &exited);
                }
            });
        }
        #[cfg(windows)]
        self.force_kill();
    }

    /// Kill the run outright, now.
    pub fn force_kill(&self) {
        if self.gone() {
            return;
        }
        #[cfg(unix)]
        hard_kill(self.pid, &self.exited);
        #[cfg(windows)]
        {
            if let Some(job) = self.job {
                job::terminate(job);
            }
            // Anything that forked before the job assignment landed.
            crate::proc::kill_tree(self.pid);
        }
    }

    /// Wait (blocking) up to `timeout` for the run to exit; true if it did.
    pub fn wait_exited(&self, timeout: std::time::Duration) -> bool {
        wait_for(&self.exited, timeout)
    }

    fn gone(&self) -> bool {
        // pid 0 would make killpg signal Prism's own group.
        self.pid <= 1 || self.exited.load(Ordering::SeqCst)
    }
}

/// Stop several runs, giving them `KILL_GRACE` between them to exit before
/// the stragglers are killed outright. For quitting: blocks until done.
pub fn stop_all(children: &[&Child]) {
    for child in children {
        child.kill();
    }
    let deadline = std::time::Instant::now() + KILL_GRACE;
    for child in children {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if !child.wait_exited(left) {
            child.force_kill();
        }
    }
}

/// How old an unpack folder must be before the launch sweep removes it. A
/// day, not an hour: a long download (or someone's own yt-dlp in a terminal)
/// keeps its folder for as long as it runs, and removing it mid-run would
/// crash that run.
const STALE_UNPACK_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// Whether `dir` is a PyInstaller unpack folder yt-dlp left behind: named
/// `_MEI…`, holding yt-dlp's own files, and older than `STALE_UNPACK_AGE`.
fn is_stale_ytdlp_unpack(dir: &std::path::Path, now: std::time::SystemTime) -> bool {
    let named = dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("_MEI"));
    let ours = dir.join("yt_dlp_ejs").is_dir() || dir.join("yt_dlp").is_dir();
    let old = std::fs::metadata(dir)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| now.duration_since(t).ok())
        .is_some_and(|age| age >= STALE_UNPACK_AGE);
    named && ours && old
}

/// Remove the temp folders earlier yt-dlp runs couldn't clean up (killed
/// outright before 2.3, or cut off by a crash). Returns how many went.
pub fn sweep_stale_unpack_dirs(temp: &std::path::Path) -> usize {
    let now = std::time::SystemTime::now();
    let Ok(entries) = std::fs::read_dir(temp) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        // Not following links: a `_MEI` symlink to somewhere else is not ours.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) || !is_stale_ytdlp_unpack(&path, now) {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => removed += 1,
            Err(e) => log::warn!("could not remove {}: {e}", path.display()),
        }
    }
    removed
}

fn wait_for(exited: &AtomicBool, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while !exited.load(Ordering::SeqCst) {
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    true
}

#[cfg(unix)]
fn hard_kill(pid: u32, exited: &AtomicBool) {
    if pid <= 1 || exited.load(Ordering::SeqCst) {
        return;
    }
    // SAFETY: as in `kill`.
    unsafe {
        libc::killpg(pid as libc::pid_t, libc::SIGKILL);
    }
    // Anything that left the group.
    crate::proc::kill_tree(pid);
}

#[cfg(all(unix, test))]
mod tests {
    // Regression (REVIEW 2026-09-23 S-6): one long line was buffered whole
    // before any cap could see it.
    #[test]
    fn a_long_line_arrives_in_bounded_pieces() {
        tauri::async_runtime::block_on(async {
            let mut text = vec![b'x'; 3 * super::MAX_LINE as usize + 5];
            text.extend(b"\nshort\n");
            let (tx, mut rx) = super::mpsc::unbounded_channel();
            super::forward(std::io::Cursor::new(text.clone()), tx, super::Event::Stdout).await.unwrap();
            let mut pieces = Vec::new();
            while let Ok(super::Event::Stdout(p)) = rx.try_recv() {
                pieces.push(p);
            }
            assert!(pieces.iter().all(|p| p.len() as u64 <= super::MAX_LINE));
            assert_eq!(pieces.concat(), text, "nothing lost or reordered");
            assert_eq!(pieces.last().unwrap(), b"short\n");
        });
    }

    use super::*;
    use std::time::Duration;

    fn is_alive(pid: i32) -> bool {
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn until_terminated(rx: &mut mpsc::UnboundedReceiver<Event>) -> Option<i32> {
        while let Some(event) = rx.recv().await {
            if let Event::Terminated(code) = event {
                return code;
            }
        }
        panic!("channel closed without Terminated");
    }

    #[test]
    fn streams_stdout_and_stderr_then_terminates_last() {
        tauri::async_runtime::block_on(async {
            let (mut rx, _child) = CommandSpec::new("/bin/sh")
                .args(["-c", "echo out; echo err 1>&2; echo \"$PRISM_TEST\"; exit 3"])
                .env("PRISM_TEST", "env-ok")
                .spawn()
                .unwrap();
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let code = loop {
                match rx.recv().await.expect("event") {
                    Event::Stdout(line) => out.extend(line),
                    Event::Stderr(line) => err.extend(line),
                    Event::Terminated(code) => break code,
                }
            };
            assert_eq!(String::from_utf8(out).unwrap(), "out\nenv-ok\n");
            assert_eq!(String::from_utf8(err).unwrap(), "err\n");
            assert_eq!(code, Some(3));
            assert!(rx.recv().await.is_none(), "Terminated must be the last event");
        });
    }

    /// The case a process-table walk misses: a worker whose parent already
    /// exited, so it was reparented away from the launcher — but it is still
    /// in the run's process group.
    #[test]
    fn kill_reaches_an_orphaned_worker_through_the_group() {
        tauri::async_runtime::block_on(async {
            let (mut rx, child) = CommandSpec::new("/bin/sh")
                .args(["-c", "(sleep 30 & echo $!); sleep 30"])
                .spawn()
                .unwrap();
            let orphan: i32 = match rx.recv().await {
                Some(Event::Stdout(line)) => String::from_utf8_lossy(&line).trim().parse().unwrap(),
                other => panic!("expected the orphan's pid, got {other:?}"),
            };
            assert!(is_alive(orphan), "orphan should be running before the kill");

            child.kill();
            tokio::time::timeout(Duration::from_secs(10), until_terminated(&mut rx))
                .await
                .expect("run should terminate after kill");
            let mut gone = false;
            for _ in 0..100 {
                if !is_alive(orphan) {
                    gone = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(gone, "orphaned worker {orphan} survived the kill");
        });
    }

    /// SIGTERM first: a run gets to clean up after itself (yt-dlp's launcher
    /// removes its `_MEI*` temp folder), which SIGKILL never allowed.
    #[test]
    fn kill_lets_the_run_clean_up() {
        tauri::async_runtime::block_on(async {
            let marker = std::env::temp_dir().join(format!("prism-kill-clean-{}", std::process::id()));
            let _ = std::fs::remove_file(&marker);
            let script = format!("trap 'echo done > \"{}\"; exit 0' TERM; echo ready; sleep 30 & wait", marker.display());
            let (mut rx, child) = CommandSpec::new("/bin/sh").args(["-c", &script]).spawn().unwrap();
            assert!(matches!(rx.recv().await, Some(Event::Stdout(_))), "script should start");
            child.kill();
            tokio::time::timeout(Duration::from_secs(10), until_terminated(&mut rx))
                .await
                .expect("run should terminate after kill");
            assert!(marker.exists(), "the run's TERM handler never ran");
            let _ = std::fs::remove_file(&marker);
        });
    }

    /// A run that ignores SIGTERM is still gone after the grace period.
    #[test]
    fn kill_escalates_when_terminate_is_ignored() {
        tauri::async_runtime::block_on(async {
            let (mut rx, child) = CommandSpec::new("/bin/sh")
                .args(["-c", "trap '' TERM; echo ready; while :; do sleep 1; done"])
                .spawn()
                .unwrap();
            assert!(matches!(rx.recv().await, Some(Event::Stdout(_))), "script should start");
            let started = std::time::Instant::now();
            child.kill();
            tokio::time::timeout(KILL_GRACE + Duration::from_secs(10), until_terminated(&mut rx))
                .await
                .expect("run should be killed after the grace period");
            assert!(started.elapsed() >= KILL_GRACE - Duration::from_millis(200), "killed before the grace period");
        });
    }

    #[test]
    fn only_old_ytdlp_unpack_folders_are_swept() {
        let temp = std::env::temp_dir().join(format!("prism-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        for (name, marker) in [("_MEIold", "yt_dlp_ejs"), ("_MEIfresh", "yt_dlp_ejs"), ("_MEIother", "numpy"), ("keep", "yt_dlp_ejs")] {
            std::fs::create_dir_all(temp.join(name).join(marker)).unwrap();
        }
        let later = std::time::SystemTime::now() + STALE_UNPACK_AGE + Duration::from_secs(60);
        assert!(is_stale_ytdlp_unpack(&temp.join("_MEIold"), later));
        assert!(!is_stale_ytdlp_unpack(&temp.join("_MEIfresh"), std::time::SystemTime::now()), "a running download's folder");
        assert!(!is_stale_ytdlp_unpack(&temp.join("_MEIother"), later), "another PyInstaller app's folder");
        assert!(!is_stale_ytdlp_unpack(&temp.join("keep"), later), "not an unpack folder");
        // Everything here is new, so a real sweep removes nothing.
        assert_eq!(sweep_stale_unpack_dirs(&temp), 0);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn kill_after_exit_is_a_no_op() {
        tauri::async_runtime::block_on(async {
            let (mut rx, child) = CommandSpec::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
            assert_eq!(until_terminated(&mut rx).await, Some(0));
            child.kill();
        });
    }
}
