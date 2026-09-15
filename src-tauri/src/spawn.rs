//! Running yt-dlp: one process group per run, streamed output, whole-run kill.
//!
//! yt-dlp ships as a PyInstaller one-file bundle: the process Prism starts
//! unpacks itself and forks the real downloader. Killing only the launcher
//! leaves that worker running (see `proc`). On unix every run now gets its own
//! process group, so one `killpg` reaches the worker and anything it forked —
//! including a child that was reparented after its parent exited, which a walk
//! of the process table (`proc::kill_tree`) can't find. On Windows the tree is
//! killed with `taskkill /T`, as before.

use std::ffi::{OsStr, OsString};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
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

        let mut child = cmd.spawn()?;
        let pid = child.id().unwrap_or(0);
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
            let _ = tx.send(Event::Terminated(code));
        });
        Ok((rx, Child { pid, exited }))
    }
}

/// Forward a pipe line by line. Keeps reading after the receiver is gone, so
/// the process never blocks on a full pipe.
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
            match reader.read_until(b'\n', &mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let _ = tx.send(wrap(line));
                }
            }
        }
    })
}

/// A running command. Dropping it does not kill the process; `kill` does.
pub struct Child {
    pid: u32,
    exited: Arc<AtomicBool>,
}

impl Child {
    /// Kill the whole run: its process group on unix (forked workers
    /// included), its process tree on Windows. A no-op once it has exited,
    /// when its pid may already belong to another process.
    pub fn kill(&self) {
        // pid 0 would make killpg signal Prism's own group.
        if self.pid <= 1 || self.exited.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pid as libc::pid_t, libc::SIGKILL);
        }
        // Unix: anything that left the group. Windows: the tree kill itself.
        crate::proc::kill_tree(self.pid);
    }
}

#[cfg(all(unix, test))]
mod tests {
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

    #[test]
    fn kill_after_exit_is_a_no_op() {
        tauri::async_runtime::block_on(async {
            let (mut rx, child) = CommandSpec::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
            assert_eq!(until_terminated(&mut rx).await, Some(0));
            child.kill();
        });
    }
}
