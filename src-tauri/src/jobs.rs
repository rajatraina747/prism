//! Starts that haven't registered with their engine yet.
//!
//! Every engine registers a job only after something slow: yt-dlp after it
//! spawns, a torrent after up to 45 s of magnet metadata, a direct link after
//! a probe of up to 75 s, a conversion after finding ffmpeg. A stop that
//! arrived in that window found nothing to stop and was a no-op, so a magnet
//! removed while fetching metadata downloaded anyway, with no queue item to
//! show it, and seeded on every launch (REVIEW 2026-09-23 B-5).
//!
//! Now each start command takes a [`Ticket`] before its first await, every
//! cancel command marks the id's ticket, and the engine checks its ticket
//! just before it registers, backing out quietly if the start was stopped.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

fn pending() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A start in progress. Dropping it (the engine registered, or gave up)
/// takes it out of the registry.
pub struct Ticket {
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl Ticket {
    /// Whether a stop for this id arrived since the start began.
    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut map) = pending().lock() {
            // Only our own entry: a newer start for the same id owns it now.
            if map.get(&self.id).is_some_and(|flag| Arc::ptr_eq(flag, &self.cancelled)) {
                map.remove(&self.id);
            }
        }
    }
}

/// Begin a start for `id`. Call before the command's first await. A newer
/// start for the same id replaces an older one's entry, so a stop reaches
/// the newest.
pub fn begin(id: &str) -> Ticket {
    let cancelled = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = pending().lock() {
        map.insert(id.to_string(), cancelled.clone());
    }
    Ticket { id: id.to_string(), cancelled }
}

/// Stop a start that hasn't registered yet. A no-op for an id with none,
/// so every engine's cancel command can call it.
pub fn cancel(id: &str) {
    if let Ok(mut map) = pending().lock() {
        if let Some(flag) = map.remove(id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_before_registering_is_seen() {
        let ticket = begin("b5-a");
        assert!(!ticket.cancelled());
        cancel("b5-a");
        assert!(ticket.cancelled());
    }

    #[test]
    fn a_stop_for_an_id_with_no_start_does_nothing() {
        cancel("b5-nothing");
        assert!(!begin("b5-nothing").cancelled(), "no stale stop carries over to a later start");
    }

    #[test]
    fn a_newer_start_takes_the_stop_and_the_older_one_leaves_it_alone() {
        let older = begin("b5-b");
        let newer = begin("b5-b");
        drop(older);
        cancel("b5-b");
        assert!(newer.cancelled(), "the older ticket's drop must not remove the newer entry");
    }

    #[test]
    fn a_finished_start_is_forgotten() {
        drop(begin("b5-c"));
        assert!(pending().lock().unwrap().get("b5-c").is_none());
    }
}
