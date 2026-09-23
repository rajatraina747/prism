import React, { createContext, useContext, useState, useEffect, useReducer, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { DownloadItem, HistoryItem, AppPreferences, DownloadError, DownloadCategory, PostCompletionAction } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { queueReducer } from '@/stores/queue-reducer';
import { createThrottledSaver, queueShape } from '@/stores/queue-save';
import { installAppUpdate } from '@/stores/app-update';
import { applyCategory, categoryFor } from '@/stores/categories';
import { migrateSettings } from '@/stores/settings-migrations';
import { hydrateStats, recordCompletion, backfillFromHistory, type Stats } from '@/stores/stats';
import {
  evaluateWhenDone, whenDoneLabel, IDLE_WHEN_DONE, postCompletionFor, needsFile,
  WHEN_DONE_COUNTDOWN_SECONDS, type WhenDoneState,
} from '@/stores/completion';
import { scheduleGate, itemStartBlocked } from '@/stores/schedule';
import { syncCrashReporting } from '@/services/crash-reporting';
import { useService } from '@/services/ServiceProvider';
import { overallProgress } from '@/stores/progress';
import { diagnostics } from '@/services/diagnostics';
import { toast } from 'sonner';
import { classifyError, errorText } from '@/services/errors';
import { requestNavigate, COOKIES_SETTINGS_PATH, ENGINE_SETTINGS_PATH } from '@/lib/nav-bus';

let audioCtx: AudioContext | null = null;
function playNotificationSound() {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch { /* audio not available */ }
}

// ── Types ──
interface QueueActions {
  items: DownloadItem[];
  addToQueue: (item: DownloadItem) => void;
  removeFromQueue: (id: string) => void;
  pauseDownload: (id: string) => void;
  resumeDownload: (id: string) => void;
  cancelDownload: (id: string) => void;
  retryDownload: (id: string) => void;
  clearCompleted: () => void;
  startAll: () => void;
  pauseAll: () => void;
  reorderQueue: (fromIndex: number, toIndex: number) => void;
  updateTorrentFiles: (id: string, onlyFiles: number[]) => void;
  /** File an item under a category by hand (null clears it). */
  setItemCategory: (id: string, category: DownloadCategory | null) => void;
  /** Replace the labels on an item (an empty list clears them). */
  setItemLabels: (id: string, labelIds: string[]) => void;
  /** The SHA-256 a queued direct download has to match (null clears it). */
  setItemChecksum: (id: string, sha256: string | null) => void;
  /** What to do when this one finishes (null = follow the setting). */
  setItemWhenComplete: (id: string, action: PostCompletionAction | null) => void;
  /** Hold one download until a given time (RFC 3339); null starts it normally. */
  setItemStartAt: (id: string, startAt: string | null) => void;
  /** Fetch part of a video rather than all of it, or split it by chapter. The
   * three go together: Rust validates the range as a unit. */
  setItemClip: (id: string, clipStart: string | null, clipEnd: string | null, splitChapters: boolean) => void;
  /** Torrent: fresh announce to trackers/DHT ("Update tracker"). */
  reannounceTorrent: (id: string) => void;
  /** Torrent: hash every piece on disk again ("Force re-check"). */
  recheckTorrent: (id: string) => void;
  /** Torrent: stop, remove from the queue, and delete its files. */
  removeWithData: (id: string) => void;
  moveToTop: (id: string) => void;
  moveToBottom: (id: string) => void;
}

interface HistoryActions {
  items: HistoryItem[];
  removeFromHistory: (id: string) => void;
  /** Put a removed entry back, for an undo. Removing from the Library only
   * drops the record — the files are untouched — so this genuinely restores
   * everything that was lost. */
  restoreHistory: (item: HistoryItem) => void;
  clearHistory: () => void;
}

interface SettingsActions {
  preferences: AppPreferences;
  updatePreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  resetToDefaults: () => void;
}

interface StatsValue {
  stats: Stats;
}

// ── Contexts ──
const QueueContext = createContext<QueueActions | null>(null);
const HistoryContext = createContext<HistoryActions | null>(null);
const SettingsContext = createContext<SettingsActions | null>(null);
const StatsContext = createContext<StatsValue | null>(null);

export function useQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue must be used within AppProvider');
  return ctx;
}

export function useHistory() {
  const ctx = useContext(HistoryContext);
  if (!ctx) throw new Error('useHistory must be used within AppProvider');
  return ctx;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within AppProvider');
  return ctx;
}

export function useStats() {
  const ctx = useContext(StatsContext);
  if (!ctx) throw new Error('useStats must be used within AppProvider');
  return ctx;
}

// ── Provider ──
export function AppProvider({ children }: { children: ReactNode }) {
  const service = useService();

  // Queue transitions live in queueReducer (pure, guarded); this component
  // only performs side effects — spawning/killing downloads — and dispatches.
  const [queue, dispatch] = useReducer(queueReducer, null, () => service.persistence.loadQueue());
  const [history, setHistory] = useState<HistoryItem[]>(() => service.persistence.loadHistory());
  // Migrate whatever was stored into the shape this build expects, then merge
  // it over the defaults so settings saved by older versions pick up new keys.
  const [settings, setSettings] = useState<AppPreferences>(() => ({
    ...DEFAULT_PREFERENCES,
    ...migrateSettings(service.persistence.loadSettings()),
  }));
  // Lifetime counters. Their own record rather than a view of history, which
  // is capped at 2,000 rows and forgets everything older.
  const [stats, setStats] = useState<Stats>(() => hydrateStats(service.persistence.loadStats()));
  // Whether the queue has been busy, so "when done" fires on finishing rather
  // than the moment it is switched on. A ref, not state: it must not cause a
  // render, and the effect below reads it on every queue change anyway.
  const whenDoneRef = useRef<WhenDoneState>(IDLE_WHEN_DONE);
  // The running countdown. Held in a ref rather than in the effect's scope:
  // the effect re-runs on every queue change, and clearing the timer in its
  // cleanup would cancel a countdown already under way the moment any late
  // event arrived — which is exactly when nobody is watching.
  const whenDoneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cleanupRefs = useRef<Map<string, () => void>>(new Map());
  const startedRef = useRef<Set<string>>(new Set());
  // Items whose backend kill hasn't come back yet — see the auto-start effect.
  const stoppingRef = useRef<Set<string>>(new Set());
  const [stoppedTick, setStoppedTick] = useState(0);

  // Persist. A change to which items exist or their status is saved at once,
  // because the next launch acts on it. Progress alone is throttled: it
  // arrives several times a second, and each save serializes the whole list.
  // See stores/queue-save.ts for why this can't be a debounce or a flush on quit.
  const queueSaver = useMemo(
    () => createThrottledSaver<DownloadItem[]>(q => service.persistence.saveQueue(q), { wait: 300, maxWait: 2000 }),
    [service],
  );
  const queueShapeRef = useRef<string | null>(null);
  useEffect(() => {
    const shape = queueShape(queue);
    if (shape !== queueShapeRef.current) {
      queueShapeRef.current = shape;
      queueSaver.flush(queue);
    } else {
      queueSaver.schedule(queue);
    }
  }, [queue, queueSaver]);
  useEffect(() => () => queueSaver.flush(), [queueSaver]);
  // History is rewritten in full on every completion (and can hold 2,000
  // rows) — debounce it like the queue so a burst of finishing playlist items
  // doesn't serialize the file once per item.
  useEffect(() => {
    const t = setTimeout(() => service.persistence.saveHistory(history), 300);
    return () => clearTimeout(t);
  }, [history, service]);
  // Settings too: text fields (proxy URL, tracker list) change on every
  // keystroke, and each change used to rewrite settings.json.
  useEffect(() => {
    const t = setTimeout(() => service.persistence.saveSettings(settings), 300);
    return () => clearTimeout(t);
  }, [settings, service]);
  useEffect(() => {
    const t = setTimeout(() => service.persistence.saveStats(stats), 300);
    return () => clearTimeout(t);
  }, [stats, service]);

  // Seed the counters from whatever history exists, once. Older downloads are
  // the only record of themselves, and history is forgotten as it grows past
  // its cap — so this is the one chance to count them. Safe to run again: it
  // only picks up rows newer than the last backfill.
  useEffect(() => {
    setStats(s => backfillFromHistory(s, service.persistence.loadHistory()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync log level preference to diagnostics service
  useEffect(() => { diagnostics.setLogLevel(settings.logLevel); }, [settings.logLevel]);

  // Sync opt-in crash reporting (no-op unless built with a DSN)
  useEffect(() => {
    if (!settings.crashReportingEnabled) {
      syncCrashReporting(false);
      return;
    }
    service.getAppVersion()
      .then(v => syncCrashReporting(true, v))
      .catch(() => syncCrashReporting(true));
  }, [settings.crashReportingEnabled, service]);

  // Auto-check for updates on startup (if enabled)
  const autoUpdateChecked = useRef(false);
  useEffect(() => {
    if (!settings.autoUpdate || autoUpdateChecked.current) return;
    autoUpdateChecked.current = true;
    // Small delay so the app finishes rendering first
    const timeout = setTimeout(async () => {
      try {
        const result = await service.checkForUpdates();
        if (result.available) {
          diagnostics.log('info', `Update available: ${result.version}`);
          toast('Update available', {
            description: `Version ${result.version} is ready to install`,
            action: {
              label: 'Install',
              onClick: async () => {
                toast.info('Downloading and installing — Prism will restart shortly...');
                try {
                  // Joins an install already running from Settings rather
                  // than starting a second download.
                  await installAppUpdate(onProgress => service.installUpdate(onProgress));
                  toast.success('Update installed! Please restart Prism to apply.');
                } catch (e) {
                  toast.error('Update failed: ' + (e instanceof Error ? e.message : String(e)));
                }
              },
            },
            duration: 15000,
          });
        }
      } catch {
        // Silently fail — don't bother the user on startup
      }
    }, 3000);
    return () => clearTimeout(timeout);
  }, [settings.autoUpdate, service]);

  // Move completed/failed/canceled items to history.
  //
  // The effect must NOT depend on `queue` itself: every progress event
  // produces a new array, and an effect keyed on it re-arms its timer on
  // each tick — with any transfer active the archive never fired, so a
  // finished download sat in the queue invisibly (hidden from Transfers,
  // absent from Library) until every transfer went idle. Key it on the
  // set of terminal ids instead, which only changes when something
  // actually finishes; the queue is read through a ref when it fires.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Read through a ref for the same reason as the queue above: this effect is
  // keyed on terminalKey alone and must not re-arm. Making the service a
  // dependency would put that back at the mercy of an identity change.
  const serviceRef = useRef(service);
  serviceRef.current = service;
  const terminalKey = queue
    .filter(i => i.status === 'completed' || i.status === 'failed' || i.status === 'canceled')
    .map(i => i.id)
    .join('|');
  useEffect(() => {
    if (terminalKey === '') return;

    const timeout = setTimeout(() => {
      const terminal = queueRef.current.filter(i => i.status === 'completed' || i.status === 'failed' || i.status === 'canceled');
      if (terminal.length === 0) return;
      const historyItems: HistoryItem[] = terminal.map(i => ({
        id: i.id,
        metadata: i.metadata,
        settings: i.settings,
        status: i.status as 'completed' | 'failed' | 'canceled',
        completedAt: i.completedAt || new Date().toISOString(),
        fileSize: i.status === 'completed' ? i.totalBytes : i.downloadedBytes,
        // Real size (when known) so a retry starts with it instead of a
        // placeholder — torrents would otherwise need peers to learn it.
        totalBytes: i.totalBytes > 0 ? i.totalBytes : undefined,
        filePath: i.filePath,
        error: i.error,
        // Torrents: keep the file list (names relative to the destination) so
        // Library can play/reveal each file. Capped — a huge torrent's list
        // shouldn't bloat history.json.
        files: i.kind === 'torrent' && i.status === 'completed' && i.files?.length
          ? i.files.slice(0, 500).map(({ name, size }) => ({ name, size }))
          : undefined,
        actualHeight: i.actualHeight,
        outputFolder: i.outputFolder,
      }));
      // Count them here rather than at each call site: this is the one place
      // every finished download passes through, and while they are still
      // queue items their engine and uploaded bytes are known — neither
      // survives into history.
      setStats(s => terminal.reduce(
        (acc, i) => recordCompletion(acc, i, i.status as 'completed' | 'failed' | 'canceled'),
        s,
      ));
      // Cap history so history.json can't grow (and load/render) unboundedly
      setHistory(prev => [...historyItems, ...prev].slice(0, 2000));
      dispatch({ type: 'removeMany', ids: terminal.map(t => t.id) });

      // Content-level duplicates. Only answerable once a file exists, so it
      // reports afterwards ("you already had this") rather than pretending the
      // same thing could be known at add time, where only the URL is in hand.
      // Advisory: a failure here must not disturb archiving.
      for (const done of terminal) {
        if (done.status !== 'completed' || !done.filePath) continue;
        const { filePath, metadata } = done;
        void serviceRef.current
          .indexDownload(filePath, metadata.title)
          .then(existing => {
            if (existing) {
              toast.info(`You already had this: ${existing.title}`, { duration: 8000 });
            }
          })
          .catch(() => { /* the index is a convenience, not a guarantee */ });
      }
    }, 300);
    return () => clearTimeout(timeout);
  }, [terminalKey]);

  // Re-evaluate the quiet-hours gate once a minute while a schedule is on,
  // so held items start (or throttling changes) when the window flips.
  const [scheduleTick, setScheduleTick] = useState(0);
  useEffect(() => {
    if (!settings.scheduleEnabled) return;
    const t = setInterval(() => setScheduleTick(x => x + 1), 60_000);
    return () => clearInterval(t);
  }, [settings.scheduleEnabled]);

  // Dock (macOS) and taskbar (Windows) progress. Keyed on the value actually
  // shown: the queue ticks several times a second and every push is an IPC
  // call, so only a change someone could see is worth sending.
  const shownProgress = useRef('');
  useEffect(() => {
    const overall = overallProgress(queue);
    const key = overall ? `${overall.percent}:${overall.paused}` : 'idle';
    if (key === shownProgress.current) return;
    shownProgress.current = key;
    void service.setProgress(overall?.percent ?? null, overall?.paused ?? false);
  }, [queue, service]);

  // Sleep, shut down or quit once everything has finished. The decision is
  // made in stores/completion.ts, which only says yes after the queue has
  // actually been working — turning the setting on with an empty queue must
  // not put the machine to sleep on the spot.
  useEffect(() => {
    const { state, start } = evaluateWhenDone(whenDoneRef.current, queue, settings);
    whenDoneRef.current = state;
    if (!start) return;

    const action = settings.whenDoneAction;
    const cancel = () => {
      if (whenDoneTimerRef.current) clearTimeout(whenDoneTimerRef.current);
      whenDoneTimerRef.current = null;
    };
    cancel();
    whenDoneTimerRef.current = setTimeout(() => {
      whenDoneTimerRef.current = null;
      service.whenDone(action).catch(e => {
        toast.error(`Couldn't ${action}: ${e instanceof Error ? e.message : e}`);
      });
    }, WHEN_DONE_COUNTDOWN_SECONDS * 1000);

    toast(`${whenDoneLabel(action)} in ${WHEN_DONE_COUNTDOWN_SECONDS} seconds`, {
      description: 'Everything has finished downloading.',
      duration: WHEN_DONE_COUNTDOWN_SECONDS * 1000,
      action: { label: 'Cancel', onClick: cancel },
    });
  }, [queue, settings, service]);

  // Only on unmount: a countdown must survive the effect above re-running.
  useEffect(() => () => {
    if (whenDoneTimerRef.current) clearTimeout(whenDoneTimerRef.current);
  }, []);

  // Push the effective session-wide torrent caps: the user's download/upload
  // limits, tightened by the Quiet Hours override while it's active. yt-dlp
  // downloads get their limit per-item at start time; torrents run in a
  // persistent session, so the limits are applied out-of-band and live.
  useEffect(() => {
    void scheduleTick;
    const gate = scheduleGate(settings, new Date());
    const userDown = settings.torrentDownloadLimitKBps > 0 ? settings.torrentDownloadLimitKBps * 1024 : null;
    const userUp = settings.torrentUploadLimitKBps > 0 ? settings.torrentUploadLimitKBps * 1024 : null;
    const override = gate.blockStarts ? null : gate.speedLimitOverrideBytes;
    const tighter = (a: number | null, b: number | null | undefined) =>
      a == null ? (b ?? null) : b == null ? a : Math.min(a, b);
    service.setTorrentRateLimits(tighter(userDown, override), tighter(userUp, override)).catch(() => {});
    // Direct downloads get their own limit per item at start, like yt-dlp;
    // this cap reaches the ones already running when quiet hours begin.
    service.setDirectRateLimit(override ?? null).catch(() => {});
  }, [settings, scheduleTick, service]);

  // The failure toast's Retry fires long after this render; read the current
  // retryDownload through a ref (assigned where it's defined, below).
  const retryRef = useRef<(id: string) => void>(() => {});

  // Auto-start queued items
  useEffect(() => {
    void scheduleTick; // dep only: minute tick re-runs the gate below
    const gate = scheduleGate(settings, new Date());
    if (gate.blockStarts) return;

    const activeCount = queue.filter(i => i.status === 'downloading').length;
    const available = settings.maxConcurrentDownloads - activeCount;
    if (available <= 0) return;

    const toStart = queue
      // An item whose kill is still in flight has to wait for it: starting
      // now means the backend kills the *new* process when the cancel lands,
      // leaving the item 'downloading' with nothing behind it. stoppedTick
      // re-runs this effect as each kill settles.
      .filter(i => i.status === 'queued' && !startedRef.current.has(i.id) && !stoppingRef.current.has(i.id))
      // An item waiting for its own start time holds back only itself — the
      // rest of the queue carries on, which is the whole point of scheduling
      // one download for later. The minute tick above re-runs this, so it
      // starts on its own when the time comes.
      .filter(i => !itemStartBlocked(i, new Date()))
      .slice(0, available);

    if (toStart.length === 0) return;

    toStart.forEach(item => {
      startedRef.current.add(item.id);
      dispatch({ type: 'markStarted', id: item.id, startedAt: new Date().toISOString() });

      // During a 'limit' quiet-hours window, spawn with the throttled rate.
      const effectiveItem = gate.speedLimitOverrideBytes
        ? { ...item, settings: { ...item.settings, speedLimit: gate.speedLimitOverrideBytes } }
        : item;

      const cleanup = service.startDownload(
        effectiveItem,
        (data) => {
          // seeding is a status signal, not an item field — split it out so the
          // reducer can drive the downloading→seeding transition.
          const { seeding, ...rest } = data;
          dispatch({ type: 'progress', id: item.id, data: rest, seeding });
        },
        (success, errorMsg, filePath, fileSize, actualHeight, outputFolder) => {
          // The settings as they are now, not as they were when this download
          // started: turning notifications off mid-download has to count
          // (REVIEW 2026-09-23).
          const current = settingsRef.current;
          startedRef.current.delete(item.id);
          cleanupRefs.current.delete(item.id);
          if (success) {
            diagnostics.log('info', `Download completed: ${item.metadata.title}`);
            dispatch({ type: 'completed', id: item.id, completedAt: new Date().toISOString(), filePath, fileSize, actualHeight, outputFolder });
            // Silent quality degradation is worth a loud flag: the site didn't
            // deliver the resolution the user picked (e.g. it vanished, or
            // only exists in a codec the extractor couldn't use).
            const requestedHeight = parseInt(item.settings.format?.resolution ?? '', 10);
            if (actualHeight && requestedHeight && actualHeight < requestedHeight) {
              diagnostics.log('warn', `Quality mismatch: requested ${requestedHeight}p, got ${actualHeight}p`, { title: item.metadata.title });
              toast.warning(`Downloaded at ${actualHeight}p — ${requestedHeight}p wasn't delivered`, {
                description: item.metadata.title,
                duration: 8000,
              });
            }
            if (current.notificationsEnabled) {
              toast.success(`Downloaded: ${item.metadata.title}`);
              // Toasts are invisible when the window is hidden/in the tray —
              // that's exactly when a finished download needs an OS notification.
              if (!document.hasFocus()) {
                service.notify('Download complete', item.metadata.title).catch(() => {});
              }
            }
            if (current.soundEnabled) playNotificationSound();

            // Then whatever was asked for this download in particular. A
            // torrent can finish without a single file path, so opening or
            // revealing falls back to the folder rather than throwing.
            const after = postCompletionFor(item, current);
            const target = filePath ?? outputFolder ?? item.settings.destination;
            if (after === 'notify') {
              service.notify('Download complete', item.metadata.title).catch(() => {});
            } else if (needsFile(after) && target) {
              const act = after === 'open' ? service.openFile(target) : service.showInFolder(target);
              act.catch(() => toast.error(`Couldn't ${after} ${item.metadata.title}`));
            }
          } else {
            // Rust sends a structured EngineError; the web demo plain text.
            const { message, detail, engineCode } = errorText(errorMsg);
            const { category, suggestion, action } = classifyError(message, engineCode);

            // Transient (network) failures: retry automatically with backoff
            // before surfacing a failure. Keeps status 'downloading' during the
            // wait so the concurrency slot stays held; the reducer guard means
            // a user cancel/pause during the wait wins.
            if (category === 'network' && item.retryAttempt < 2) {
              const delay = 5000 * Math.pow(2, item.retryAttempt);
              diagnostics.log('warn', `Download failed, retrying in ${delay / 1000}s (attempt ${item.retryAttempt + 1}/2): ${item.metadata.title}`, { error: message });
              setTimeout(() => dispatch({ type: 'requeueForRetry', id: item.id }), delay);
              return;
            }

            diagnostics.log('error', `Download failed: ${item.metadata.title}`, { error: errorMsg });
            if (current.notificationsEnabled) {
              toast.error(`Failed: ${item.metadata.title}`, {
                description: suggestion,
                action: action === 'cookies'
                  ? { label: 'Set browser cookies', onClick: () => requestNavigate(COOKIES_SETTINGS_PATH) }
                  : action === 'engine'
                    ? { label: 'Update engine', onClick: () => requestNavigate(ENGINE_SETTINGS_PATH) }
                    : action === 'retry'
                      ? { label: 'Retry', onClick: () => retryRef.current(item.id) }
                      : undefined,
                duration: 10000,
              });
              if (!document.hasFocus()) {
                service.notify('Download failed', item.metadata.title).catch(() => {});
              }
            }
            const err: DownloadError = {
              code: 'DOWNLOAD_FAILED',
              message,
              category,
              timestamp: new Date().toISOString(),
              suggestion,
              ...(engineCode ? { engineCode } : {}),
              ...(detail ? { detail } : {}),
            };
            dispatch({ type: 'failed', id: item.id, error: err });
          }
        }
      );
      cleanupRefs.current.set(item.id, cleanup);
    });
  }, [queue, settings, scheduleTick, stoppedTick, service]);

  const addToQueue = useCallback((item: DownloadItem) => {
    diagnostics.log('info', `Added to queue: ${item.metadata.title}`);
    // Fix the naming rule when the item is queued, so changing the preference
    // later can't rename a download halfway (a resume must find its partial
    // file). The default template leaves naming exactly as it was; torrents
    // keep the names their creators gave them.
    const template = settings.filenameTemplate.trim();
    const stamped = item.kind === 'torrent' || item.settings.filenameTemplate || !template || template === '{title}'
      ? item
      : { ...item, settings: { ...item.settings, filenameTemplate: template } };
    // Sort it into a category, unless one was already chosen for it in the
    // details dialog. Also fixed now rather than looked up later, so editing
    // a category can't move a download that is already under way.
    const category = stamped.settings.categoryId ? null : categoryFor(settings.categories, stamped);
    dispatch({ type: 'add', item: category ? applyCategory(stamped, category) : stamped });
  }, [settings.filenameTemplate, settings.categories]);

  // Detach listeners AND kill the backend yt-dlp process for a download.
  const stopDownload = useCallback((id: string) => {
    cleanupRefs.current.get(id)?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    stoppingRef.current.add(id);
    service.cancelDownload(id).catch(() => {}).finally(() => {
      stoppingRef.current.delete(id);
      // Nudge the auto-start effect: an item resumed during the kill is
      // startable now.
      setStoppedTick(t => t + 1);
    });
  }, [service]);

  const removeFromQueue = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'remove', id });
  }, [stopDownload]);

  const pauseDownload = useCallback((id: string) => {
    const item = queueRef.current.find(i => i.id === id);
    // A torrent with a live listener pauses in place: the engine keeps the
    // handle, so resume needs no re-add and no hash re-check of the data on
    // disk. Falls back to kill-and-requeue if the native pause fails (e.g.
    // the torrent is still initializing).
    if (item?.kind === 'torrent' && cleanupRefs.current.has(id)) {
      dispatch({ type: 'pause', id });
      service.pauseTorrent(id).catch(() => stopDownload(id));
      return;
    }
    stopDownload(id);
    dispatch({ type: 'pause', id });
  }, [service, stopDownload]);

  const resumeDownload = useCallback((id: string) => {
    const item = queueRef.current.find(i => i.id === id);
    // Natively-paused torrent: unpause and go straight back to downloading —
    // the auto-start effect must not spawn a second add (startedRef still
    // holds the id, so it won't).
    if (item?.kind === 'torrent' && cleanupRefs.current.has(id)) {
      service.resumeTorrent(id).then(() => {
        dispatch({ type: 'resume', id });
        dispatch({ type: 'markStarted', id, startedAt: item.startedAt ?? new Date().toISOString() });
      }).catch(() => {
        // Engine lost the handle — detach and take the fresh-add path.
        stopDownload(id);
        dispatch({ type: 'resume', id });
      });
      return;
    }
    dispatch({ type: 'resume', id });
  }, [service, stopDownload]);

  const cancelDownload = useCallback((id: string) => {
    const item = queueRef.current.find(i => i.id === id);
    if (item?.status === 'seeding') {
      // Stopping a seed is a success, not a cancel: the download finished, the
      // user is just ending the upload. The backend emits a success completion
      // for a finished torrent, which drives seeding → completed through the
      // still-attached listener. Keep listeners alive; don't kill via stopDownload.
      const hasListener = cleanupRefs.current.has(id);
      service.cancelDownload(id).catch(() => {});
      if (!hasListener) {
        // No live listener (shouldn't happen for a seeding item) — complete directly.
        startedRef.current.delete(id);
        dispatch({ type: 'completed', id, completedAt: new Date().toISOString() });
      }
      return;
    }
    stopDownload(id);
    dispatch({ type: 'cancel', id });
  }, [service, stopDownload]);

  const retryDownload = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'retry', id });
  }, [stopDownload]);
  retryRef.current = retryDownload;

  const clearCompleted = useCallback(() => {
    dispatch({ type: 'clearCompleted' });
  }, []);

  const startAll = useCallback(() => {
    // Per-item rather than the bulk 'startAll' action: natively-paused
    // torrents are still in startedRef, so the auto-start effect would skip
    // them — resumeDownload routes each item down the right path.
    queueRef.current.filter(i => i.status === 'paused').forEach(i => resumeDownload(i.id));
  }, [resumeDownload]);

  const pauseAll = useCallback(() => {
    // Side effect stays outside the reducer: pause torrents natively (their
    // handles survive, so resume is instant) and kill yt-dlp processes, then
    // let the (pure) transition flip statuses.
    queueRef.current
      .filter(i => i.status === 'downloading' || i.status === 'seeding')
      .forEach(i => {
        if (i.kind === 'torrent' && cleanupRefs.current.has(i.id)) {
          service.pauseTorrent(i.id).catch(() => stopDownload(i.id));
        } else {
          stopDownload(i.id);
        }
      });
    dispatch({ type: 'pauseAll' });
  }, [service, stopDownload]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({ type: 'reorder', from: fromIndex, to: toIndex });
  }, []);

  const updateTorrentFiles = useCallback((id: string, onlyFiles: number[]) => {
    // Engine first, then state — the selection in settings should only change
    // once the swarm is actually downloading that subset.
    service.updateTorrentFiles(id, onlyFiles)
      .then(() => dispatch({ type: 'setSelectedFiles', id, files: onlyFiles }))
      .catch((e) => toast.error(`Couldn't update file selection: ${e}`));
  }, [service]);

  const setItemCategory = useCallback((id: string, category: DownloadCategory | null) => {
    dispatch({ type: 'setCategory', id, category });
  }, []);

  const setItemLabels = useCallback((id: string, labelIds: string[]) => {
    dispatch({ type: 'setLabels', id, labelIds });
  }, []);

  const setItemChecksum = useCallback((id: string, sha256: string | null) => {
    dispatch({ type: 'setChecksum', id, sha256 });
  }, []);

  const setItemWhenComplete = useCallback((id: string, action: PostCompletionAction | null) => {
    dispatch({ type: 'setWhenComplete', id, action });
  }, []);

  const setItemStartAt = useCallback((id: string, startAt: string | null) => {
    dispatch({ type: 'setStartAt', id, startAt });
  }, []);

  const setItemClip = useCallback(
    (id: string, clipStart: string | null, clipEnd: string | null, splitChapters: boolean) => {
      dispatch({ type: 'setClip', id, clipStart, clipEnd, splitChapters });
    },
    [],
  );

  const reannounceTorrent = useCallback((id: string) => {
    service.reannounceTorrent(id)
      .then(() => toast.success('Asked trackers and DHT for peers'))
      .catch((e) => toast.error(`Couldn't update tracker: ${e instanceof Error ? e.message : e}`));
  }, [service]);

  const recheckTorrent = useCallback((id: string) => {
    service.recheckTorrent(id)
      .then(() => toast.success('Re-checking files on disk'))
      .catch((e) => toast.error(`Couldn't re-check: ${e instanceof Error ? e.message : e}`));
  }, [service]);

  const removeWithData = useCallback((id: string) => {
    // Engine first (it owns the files), then drop the item. The listener is
    // torn down without a completion so nothing lands in history as "done".
    const item = queueRef.current.find(i => i.id === id);
    const cleanup = cleanupRefs.current.get(id);
    cleanup?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    dispatch({ type: 'remove', id });
    service.removeTorrentData(id)
      .then(() => toast.success(`Removed ${item?.metadata.title ?? 'torrent'} and deleted its files`))
      .catch((e) => toast.error(`Couldn't delete files: ${e instanceof Error ? e.message : e}`));
  }, [service]);

  const moveToTop = useCallback((id: string) => {
    const from = queueRef.current.findIndex(i => i.id === id);
    if (from > 0) dispatch({ type: 'reorder', from, to: 0 });
  }, []);

  const moveToBottom = useCallback((id: string) => {
    const current = queueRef.current;
    const from = current.findIndex(i => i.id === id);
    if (from >= 0 && from < current.length - 1) dispatch({ type: 'reorder', from, to: current.length - 1 });
  }, []);

  const removeFromHistory = useCallback((id: string) => {
    setHistory(prev => prev.filter(i => i.id !== id));
  }, []);

  const restoreHistory = useCallback((item: HistoryItem) => {
    setHistory(prev => (
      // Guard against a double undo, and keep the list in completion order so
      // a restored entry lands back where it was rather than at the top.
      prev.some(i => i.id === item.id)
        ? prev
        : [...prev, item].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 2000)
    ));
  }, []);

  const clearHistory = useCallback(() => { setHistory([]); }, []);

  const updatePreference = useCallback(<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetToDefaults = useCallback(() => { setSettings(DEFAULT_PREFERENCES); }, []);

  // Context values are memoized, and the callbacks above read the queue
  // through queueRef, so they keep their identity across progress ticks:
  // otherwise every tick handed every consumer a new object and broke
  // QueueRow's memo (REVIEW 2026-09-23 P-1).
  const settingsValue = useMemo(
    () => ({ preferences: settings, updatePreference, resetToDefaults }),
    [settings, updatePreference, resetToDefaults],
  );
  const queueValue = useMemo(
    () => ({ items: queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom }),
    [queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom],
  );
  const historyValue = useMemo(
    () => ({ items: history, removeFromHistory, restoreHistory, clearHistory }),
    [history, removeFromHistory, restoreHistory, clearHistory],
  );
  const statsValue = useMemo(() => ({ stats }), [stats]);

  return (
    <SettingsContext.Provider value={settingsValue}>
      <QueueContext.Provider value={queueValue}>
        <HistoryContext.Provider value={historyValue}>
          <StatsContext.Provider value={statsValue}>
            {children}
          </StatsContext.Provider>
        </HistoryContext.Provider>
      </QueueContext.Provider>
    </SettingsContext.Provider>
  );
}
