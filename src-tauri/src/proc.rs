//! Process-tree termination.
//!
//! yt-dlp ships as a PyInstaller one-file bundle: the binary we spawn is a
//! launcher that unpacks itself and forks the real downloader as a child.
//! Killing only the process we spawned leaves that child running — reparented
//! to init, still writing the same `.part` file, still using bandwidth — where
//! it goes on to race the next run for the same item. Every kill therefore has
//! to take the whole tree.

/// Kill `pid` and everything descended from it. Best effort: processes that
/// already exited (or that we aren't allowed to signal) are skipped silently.
#[cfg(unix)]
pub fn kill_tree(pid: u32) {
    let mut targets = match std::process::Command::new("ps").args(["-Ao", "pid=,ppid="]).output() {
        Ok(out) => descendants(&String::from_utf8_lossy(&out.stdout), pid),
        // No process table to walk — at least kill the process we know about.
        Err(_) => Vec::new(),
    };
    // Children first, so nothing re-forks between the parent's death and ours.
    targets.push(pid);
    for target in targets {
        // Never signal init or a whole process group.
        if target <= 1 {
            continue;
        }
        unsafe {
            libc::kill(target as libc::pid_t, libc::SIGKILL);
        }
    }
}

#[cfg(windows)]
pub fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = std::process::Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

/// Descendants of `root`, breadth-first, from `ps -Ao pid=,ppid=` output.
#[cfg(unix)]
fn descendants(ps_output: &str, root: u32) -> Vec<u32> {
    let pairs: Vec<(u32, u32)> = ps_output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let ppid = fields.next()?.parse().ok()?;
            Some((pid, ppid))
        })
        .collect();

    let mut found: Vec<u32> = Vec::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for &(pid, ppid) in &pairs {
            // `pid != parent` guards against a self-parented row; `found`
            // against a cycle in a malformed table.
            if ppid == parent && pid != parent && !found.contains(&pid) {
                found.push(pid);
                frontier.push(pid);
            }
        }
    }
    found
}

#[cfg(all(unix, test))]
mod tests {
    use super::{descendants, kill_tree};
    use std::io::Read;
    use std::process::{Child, Command, Stdio};

    const PS: &str = "
    1     0
  100     1
  200   100
  201   200
  300     1
";

    #[test]
    fn collects_children_and_grandchildren() {
        let mut found = descendants(PS, 100);
        found.sort();
        assert_eq!(found, vec![200, 201]);
    }

    #[test]
    fn leaf_process_has_no_descendants() {
        assert!(descendants(PS, 201).is_empty());
        assert!(descendants(PS, 300).is_empty());
    }

    #[test]
    fn unknown_pid_and_junk_rows_are_harmless() {
        assert!(descendants(PS, 9999).is_empty());
        assert!(descendants("not a table\n\n", 100).is_empty());
    }

    #[test]
    fn self_parented_row_does_not_loop() {
        assert!(descendants("500 500\n", 500).is_empty());
    }

    fn is_alive(pid: u32) -> bool {
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    fn wait_until_gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !is_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// A launcher that forks a worker and waits on it — the shape of the
    /// yt-dlp bundle. Returns the launcher handle and the worker's pid.
    fn spawn_launcher_with_worker() -> (Child, u32) {
        let mut launcher = Command::new("/bin/sh")
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn launcher");
        let mut stdout = launcher.stdout.take().expect("launcher stdout");
        let mut buf = [0u8; 32];
        let n = stdout.read(&mut buf).expect("read worker pid");
        let worker = String::from_utf8_lossy(&buf[..n])
            .trim()
            .parse()
            .expect("worker pid");
        (launcher, worker)
    }

    #[test]
    fn kill_tree_takes_the_forked_worker() {
        let (mut launcher, worker) = spawn_launcher_with_worker();
        assert!(is_alive(worker), "worker should be running before the kill");

        kill_tree(launcher.id());
        let _ = launcher.wait();

        assert!(wait_until_gone(worker), "worker {} survived kill_tree", worker);
    }

    /// The bug this module exists for: killing only the process we spawned
    /// leaves the worker running, reparented to init.
    #[test]
    fn killing_only_the_launcher_leaves_the_worker() {
        let (mut launcher, worker) = spawn_launcher_with_worker();

        launcher.kill().expect("kill launcher");
        let _ = launcher.wait();
        std::thread::sleep(std::time::Duration::from_millis(200));

        assert!(is_alive(worker), "worker should have outlived its launcher");
        kill_tree(worker);
    }
}
