import type {
  AppPreferences, DownloadItem, WhenDoneAction, PostCompletionAction,
} from '@/types/models';

// Re-exported so callers of this module have one place to import from, while
// the type itself stays in models.ts — settings need it too, and the two
// modules importing each other would be a cycle for no benefit.
export type { WhenDoneAction, PostCompletionAction };

/** What to do with a download that has just finished: whatever was chosen for
 * that item, or the default. 'nothing' set on the item is a real choice and
 * beats the default — otherwise it could never be turned off for one item. */
export function postCompletionFor(
  item: Pick<DownloadItem, 'settings'>,
  prefs: Pick<AppPreferences, 'defaultWhenComplete'>,
): PostCompletionAction {
  return item.settings.whenComplete ?? prefs.defaultWhenComplete ?? 'nothing';
}

/** Whether an action needs a file to act on — `open` and `reveal` are
 * meaningless without a path, and a torrent can finish without one. */
export function needsFile(action: PostCompletionAction): boolean {
  return action === 'open' || action === 'reveal';
}

// What happens once the queue finishes.
//
// The whole thing turns on one rule: the action fires on a transition from
// busy to idle, never on a standing start. Without that, turning "sleep when
// done" on with nothing in the queue would put the machine to sleep on the
// spot — the setting would be a trap rather than a convenience.

/** How long the toast counts down before the action happens. Long enough to
 * catch it after walking back to the desk, short enough to be useful. */
export const WHEN_DONE_COUNTDOWN_SECONDS = 60;

/**
 * Whether an item still needs Prism to be awake.
 *
 * `paused` deliberately does not count: a paused download will never finish on
 * its own, so treating it as busy would mean the action never fires for anyone
 * who parks something indefinitely. Seeding does count — uploading is real
 * work someone opted into — unless they have explicitly said otherwise.
 */
export function isBusy(item: DownloadItem, ignoreSeeding: boolean): boolean {
  switch (item.status) {
    case 'queued':
    case 'parsing':
    case 'ready':
    case 'downloading':
      return true;
    case 'seeding':
      return !ignoreSeeding;
    default:
      return false;
  }
}

/** Is anything still working? The one definition — the Transfers header and
 * the when-done trigger must never disagree about what "finished" means. */
export function isQueueBusy(items: DownloadItem[], ignoreSeeding = false): boolean {
  return items.some(item => isBusy(item, ignoreSeeding));
}

export interface WhenDoneState {
  /** Something has actually been working during this session. */
  wasBusy: boolean;
  /** The countdown has already been started once for this quiet period, so a
   * re-render can't start a second one. */
  armed: boolean;
}

export const IDLE_WHEN_DONE: WhenDoneState = { wasBusy: false, armed: false };

type WhenDonePrefs = Pick<AppPreferences, 'whenDoneAction' | 'whenDoneIgnoresSeeding'>;

/**
 * Fold the queue into the when-done state, saying whether the countdown should
 * start now. Pure, so the rule that matters — fires once, only after real work
 * — is testable without a machine to put to sleep.
 */
export function evaluateWhenDone(
  prev: WhenDoneState,
  items: DownloadItem[],
  prefs: WhenDonePrefs,
): { state: WhenDoneState; start: boolean } {
  if (prefs.whenDoneAction === 'nothing') {
    // Forget any history: turning it on later must still need fresh work.
    return { state: IDLE_WHEN_DONE, start: false };
  }

  const busy = isQueueBusy(items, prefs.whenDoneIgnoresSeeding);
  if (busy) {
    // Work is under way — remember it, and let a later quiet period arm again.
    return { state: { wasBusy: true, armed: false }, start: false };
  }
  if (prev.wasBusy && !prev.armed) {
    return { state: { wasBusy: false, armed: true }, start: true };
  }
  return { state: prev.armed ? prev : IDLE_WHEN_DONE, start: false };
}

/** What the countdown toast says. */
export function whenDoneLabel(action: WhenDoneAction): string {
  switch (action) {
    case 'sleep': return 'Sleeping';
    case 'shutdown': return 'Shutting down';
    case 'quit': return 'Quitting Prism';
    case 'nothing': return '';
  }
}
