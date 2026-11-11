import React, { createContext, useContext, useState, useEffect, useReducer, useRef, useCallback, useMemo, type ReactNode } from 'react';
import type { DownloadItem, HistoryItem, AppPreferences, DownloadCategory, PostCompletionAction } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { queueReducer, type QueueAction } from '@/stores/queue-reducer';
import { remoteQueueReducer, patchesAfter, type QueuePatch } from '@/stores/remote-queue';
import { installAppUpdate } from '@/stores/app-update';
import { mergeHistory, mergeSettings } from '@/stores/backup';
import { applyCategory, categoryFor } from '@/stores/categories';
import { migrateSettings } from '@/stores/settings-migrations';
import { hydrateStats, recordCompletion, backfillFromHistory, resetStats as freshStats, type Stats } from '@/stores/stats';
import { whenDoneLabel } from '@/stores/completion';
import { syncCrashReporting } from '@/services/crash-reporting';
import { useService } from '@/services/ServiceProvider';
import { diagnostics } from '@/services/diagnostics';
import { toast } from 'sonner';
import { classifyError, errorText } from '@/services/errors';
import { requestNavigate, COOKIES_SETTINGS_PATH, ENGINE_SETTINGS_PATH } from '@/lib/nav-bus';
import { t } from '@/i18n';

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

/** A queue action Rust refused (see src-tauri/src/queue.rs). */
function reportQueueError(e: unknown) {
  toast.error(errorText(e, t('notices.queueFailed')).message);
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
  /** Restart the torrent engine so its settings apply now: running torrents
   * pause, the engine restarts, they carry on (no re-check of their data). */
  restartTorrentEngine: () => Promise<void>;
}

interface HistoryActions {
  items: HistoryItem[];
  removeFromHistory: (id: string) => void;
  /** Several at once, in one update (Library → Clear: one setHistory, not
   * one per row). */
  removeManyFromHistory: (ids: string[]) => void;
  /** Put a removed entry back, for an undo. Removing from the Library only
   * drops the record — the files are untouched — so this genuinely restores
   * everything that was lost. */
  restoreHistory: (item: HistoryItem) => void;
  /** Merge a backup's Library into this one (see stores/backup.ts). */
  importHistory: (items: HistoryItem[]) => void;
  clearHistory: () => void;
}

interface SettingsActions {
  preferences: AppPreferences;
  updatePreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  resetToDefaults: () => void;
  /** Take a backup's settings, keeping this machine's folders. */
  importSettings: (incoming: Partial<AppPreferences>) => void;
}

interface StatsValue {
  stats: Stats;
  /** Start the counters again from now (Library → Activity). */
  resetStats: () => void;
}

// ── Contexts ──
const QueueContext = createContext<QueueActions | null>(null);
/** The queue's actions without its items: these keep their identity, so a
 * component that only acts on the queue doesn't re-render on every progress
 * update (REVIEW 2026-09-28 P-9). */
const QueueActionsContext = createContext<Omit<QueueActions, 'items'> | null>(null);
const HistoryContext = createContext<HistoryActions | null>(null);
const SettingsContext = createContext<SettingsActions | null>(null);
const StatsContext = createContext<StatsValue | null>(null);

export function useQueue() {
  const ctx = useContext(QueueContext);
  if (!ctx) throw new Error('useQueue must be used within AppProvider');
  return ctx;
}

/** The queue's actions only. Prefer this to `useQueue` wherever the items
 * aren't read. */
export function useQueueActions() {
  const ctx = useContext(QueueActionsContext);
  if (!ctx) throw new Error('useQueueActions must be used within AppProvider');
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
/** One countdown toast, so a call-off can dismiss it. */
const WHEN_DONE_TOAST = 'when-done';

export function AppProvider({ children }: { children: ReactNode }) {
  const service = useService();

  // The queue belongs to the service: Rust's on the desktop (queue.rs), the
  // web demo's stand-in (services/mock-queue.ts) in the browser. The page
  // keeps a copy to render, and every action below goes to it. There used to
  // be a second, page-side queue engine for the demo here (REVIEW 2026-09-28
  // A-1).
  const remote = service.queue;
  const [queue, dispatchRemote] = useReducer(remoteQueueReducer, []);
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
          toast(t('notices.updateAvailable'), {
            description: t('notices.updateReady', { version: result.version }),
            action: {
              label: t('notices.install'),
              onClick: async () => {
                toast.info(t('notices.installing'));
                try {
                  // Joins an install already running from Settings rather
                  // than starting a second download.
                  await installAppUpdate(onProgress => service.installUpdate(onProgress));
                  toast.success(t('settings.page.installed'));
                } catch (e) {
                  toast.error(t('settings.page.updateFailed', { error: e instanceof Error ? e.message : String(e) }));
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

  // Read through refs: the queue's handlers and the action callbacks below
  // must not change identity (and re-subscribe, or break row memos) on every
  // progress update.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const serviceRef = useRef(service);
  serviceRef.current = service;
  // The failure toast's Retry fires long after this render; read the current
  // retryDownload through a ref (assigned where it's defined, below).
  const retryRef = useRef<(id: string) => void>(() => {});

  // The queue: its snapshot, then its events — Library entries, statistics,
  // toasts, the when-done countdown.
  useEffect(() => {
    // Patches that land before the snapshot wait for it: only the ones newer
    // than it apply (C-9). Afterwards a patch the snapshot already covered
    // is dropped too.
    let snapshotSeq: number | null = null;
    const early: QueuePatch[] = [];
    const stop = remote.subscribe({
      changed: patch => {
        if (snapshotSeq === null) { early.push(patch); return; }
        if (patch.seq !== undefined && patch.seq <= snapshotSeq) return;
        dispatchRemote({ type: 'patch', patch });
      },
      archived: entries => {
        // A torrent is listed when it starts seeding and its entry replaced
        // when seeding ends: the same id, the newer entry.
        setHistory(prev => {
          const incoming = new Map(entries.map(e => [e.history.id, e.history]));
          const kept = prev.map(h => incoming.get(h.id) ?? h);
          const known = new Set(prev.map(h => h.id));
          return [...entries.map(e => e.history).filter(h => !known.has(h.id)), ...kept];
        });
        // Counted once, when the item leaves the queue.
        const final = entries.filter(e => (e.stage ?? 'final') === 'final');
        setStats(s => final.reduce(
          (acc, e) => recordCompletion(acc, e.item, e.item.status as 'completed' | 'failed' | 'canceled'),
          s,
        ));
        // Content-level duplicates: only answerable once a file exists.
        for (const { item } of final) {
          if (item.status !== 'completed' || !item.filePath) continue;
          void serviceRef.current
            .indexDownload(item.filePath, item.metadata.title)
            .then(existing => { if (existing) toast.info(t('notices.alreadyHad', { title: existing.title }), { duration: 8000 }); })
            .catch(() => {});
        }
      },
      notice: n => {
        const current = settingsRef.current;
        if (n.kind === 'completed') {
          diagnostics.log('info', `Download completed: ${n.title}`);
          if (current.notificationsEnabled) toast.success(t('notices.downloaded', { title: n.title }));
          if (current.soundEnabled) playNotificationSound();
        } else if (n.kind === 'quality' && n.actual && n.requested) {
          diagnostics.log('warn', `Quality mismatch: requested ${n.requested}p, got ${n.actual}p`, { title: n.title });
          toast.warning(t('notices.shortfall', { actual: n.actual, requested: n.requested }), { description: n.title, duration: 8000 });
        } else if (n.kind === 'failed') {
          const message = n.message ?? t('notices.failedGeneric');
          diagnostics.log('error', `Download failed: ${n.title}`, { error: message });
          if (!current.notificationsEnabled) return;
          const { suggestion, action } = classifyError(message, n.engineCode);
          toast.error(t('notices.failed', { title: n.title }), {
            description: suggestion,
            action: action === 'cookies'
              ? { label: t('common.failure.setCookies'), onClick: () => requestNavigate(COOKIES_SETTINGS_PATH) }
              : action === 'engine'
                ? { label: t('common.failure.updateEngine'), onClick: () => requestNavigate(ENGINE_SETTINGS_PATH) }
                : action === 'retry'
                  ? { label: t('common.retry'), onClick: () => retryRef.current(n.id) }
                  : undefined,
            duration: 10000,
          });
        }
      },
      whenDone: ({ action, seconds }) => {
        toast(t('notices.whenDone', { action: whenDoneLabel(action), count: seconds }), {
          id: WHEN_DONE_TOAST,
          description: t('notices.allFinished'),
          duration: seconds * 1000,
          action: { label: t('common.cancel'), onClick: () => { void remote.cancelWhenDone(); } },
        });
      },
      whenDoneCalledOff: () => {
        toast.dismiss(WHEN_DONE_TOAST);
        toast(t('notices.calledOff'));
      },
    });
    // A torrent removed along with its files leaves the Library too.
    const stopRemoved = service.onLibraryRemoved?.(ids => setHistory(prev => prev.filter(h => !ids.includes(h.id))));
    // After listening, so nothing between the two is missed.
    remote.snapshot()
      .then(({ items, seq }) => {
        snapshotSeq = seq;
        dispatchRemote({ type: 'snapshot', items });
        for (const patch of patchesAfter(early, seq)) dispatchRemote({ type: 'patch', patch });
        early.length = 0;
      })
      .catch(reportQueueError);
    return () => { stop(); stopRemoved?.(); };
  }, [remote, service]);

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
    const filed = category ? applyCategory(stamped, category) : stamped;
    remote.add(filed).catch(e => toast.error(t('notices.addFailed', { title: item.metadata.title, error: errorText(e).message })));
  }, [settings.filenameTemplate, settings.categories, remote]);

  const removeFromQueue = useCallback((id: string) => {
    remote.remove(id).catch(reportQueueError);
  }, [remote]);

  const pauseDownload = useCallback((id: string) => {
    remote.pause(id).catch(reportQueueError);
  }, [remote]);

  const resumeDownload = useCallback((id: string) => {
    remote.resume(id).catch(reportQueueError);
  }, [remote]);

  const cancelDownload = useCallback((id: string) => {
    remote.cancel(id).catch(reportQueueError);
  }, [remote]);

  const retryDownload = useCallback((id: string) => {
    remote.retry(id).catch(reportQueueError);
  }, [remote]);
  retryRef.current = retryDownload;

  const clearCompleted = useCallback(() => {
    remote.clearCompleted().catch(reportQueueError);
  }, [remote]);

  const startAll = useCallback(() => {
    remote.resumeAll().catch(reportQueueError);
  }, [remote]);

  const pauseAll = useCallback(() => {
    remote.pauseAll().catch(reportQueueError);
  }, [remote]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    remote.reorder(fromIndex, toIndex).catch(reportQueueError);
  }, [remote]);

  const updateTorrentFiles = useCallback((id: string, onlyFiles: number[]) => {
    remote.updateTorrentFiles(id, onlyFiles).catch((e) => toast.error(t('notices.filesFailed', { error: errorText(e).message })));
  }, [remote]);

  // Changes to one item's settings. The rules for each are the reducer's
  // (queue-reducer.ts) either way: with Rust's queue the page works out the
  // new settings the same way and sends them, to apply only while the item
  // is still in the state they were worked out for.
  const changeItem = useCallback((action: QueueAction & { id: string }) => {
    const item = queueRef.current.find(i => i.id === action.id);
    if (!item) return;
    const [next] = queueReducer([item], action);
    if (next !== item) remote.setSettings(item.id, next.settings, item.status).catch(reportQueueError);
  }, [remote]);

  const setItemCategory = useCallback((id: string, category: DownloadCategory | null) => {
    changeItem({ type: 'setCategory', id, category });
  }, [changeItem]);

  const setItemLabels = useCallback((id: string, labelIds: string[]) => {
    changeItem({ type: 'setLabels', id, labelIds });
  }, [changeItem]);

  const setItemChecksum = useCallback((id: string, sha256: string | null) => {
    changeItem({ type: 'setChecksum', id, sha256 });
  }, [changeItem]);

  const setItemWhenComplete = useCallback((id: string, action: PostCompletionAction | null) => {
    changeItem({ type: 'setWhenComplete', id, action });
  }, [changeItem]);

  const setItemStartAt = useCallback((id: string, startAt: string | null) => {
    changeItem({ type: 'setStartAt', id, startAt });
  }, [changeItem]);

  const setItemClip = useCallback(
    (id: string, clipStart: string | null, clipEnd: string | null, splitChapters: boolean) => {
      changeItem({ type: 'setClip', id, clipStart, clipEnd, splitChapters });
    },
    [changeItem],
  );

  const reannounceTorrent = useCallback((id: string) => {
    service.reannounceTorrent(id)
      .then(() => toast.success(t('notices.reannounced')))
      .catch((e) => toast.error(t('notices.reannounceFailed', { error: e instanceof Error ? e.message : String(e) })));
  }, [service]);

  const recheckTorrent = useCallback((id: string) => {
    service.recheckTorrent(id)
      .then(() => toast.success(t('notices.rechecking')))
      .catch((e) => toast.error(t('notices.recheckFailed', { error: e instanceof Error ? e.message : String(e) })));
  }, [service]);

  const removeWithData = useCallback((id: string) => {
    const item = queueRef.current.find(i => i.id === id);
    remote.removeWithData(id)
      .then(() => toast.success(t('notices.deleted', { title: item?.metadata.title ?? t('notices.torrent') })))
      .catch((e) => toast.error(t('notices.deleteFailed', { error: errorText(e).message })));
  }, [remote]);

  const moveToTop = useCallback((id: string) => {
    const from = queueRef.current.findIndex(i => i.id === id);
    if (from > 0) reorderQueue(from, 0);
  }, [reorderQueue]);

  const moveToBottom = useCallback((id: string) => {
    const current = queueRef.current;
    const from = current.findIndex(i => i.id === id);
    if (from >= 0 && from < current.length - 1) reorderQueue(from, current.length - 1);
  }, [reorderQueue]);

  const restartTorrentEngine = useCallback(async () => {
    await remote.restartTorrentEngine();
  }, [remote]);

  const removeFromHistory = useCallback((id: string) => {
    setHistory(prev => prev.filter(i => i.id !== id));
  }, []);

  const removeManyFromHistory = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const gone = new Set(ids);
    setHistory(prev => prev.filter(i => !gone.has(i.id)));
  }, []);

  const restoreHistory = useCallback((item: HistoryItem) => {
    setHistory(prev => (
      // Guard against a double undo, and keep the list in completion order so
      // a restored entry lands back where it was rather than at the top.
      prev.some(i => i.id === item.id)
        ? prev
        : [...prev, item].sort((a, b) => b.completedAt.localeCompare(a.completedAt))
    ));
  }, []);

  const clearHistory = useCallback(() => { setHistory([]); }, []);
  const importHistory = useCallback((items: HistoryItem[]) => {
    setHistory(prev => mergeHistory(prev, items));
  }, []);
  const importSettings = useCallback((incoming: Partial<AppPreferences>) => {
    setSettings(prev => mergeSettings(prev, incoming));
  }, []);

  const updatePreference = useCallback(<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetToDefaults = useCallback(() => { setSettings(DEFAULT_PREFERENCES); }, []);

  // Context values are memoized, and the callbacks above read the queue
  // through queueRef, so they keep their identity across progress ticks:
  // otherwise every tick handed every consumer a new object and broke
  // QueueRow's memo (REVIEW 2026-09-23 P-1).
  const settingsValue = useMemo(
    () => ({ preferences: settings, updatePreference, resetToDefaults, importSettings }),
    [settings, updatePreference, resetToDefaults, importSettings],
  );
  const queueActions = useMemo(
    () => ({ addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom, restartTorrentEngine }),
    [addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom, restartTorrentEngine],
  );
  const queueValue = useMemo(
    () => ({ items: queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom, restartTorrentEngine }),
    [queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, setItemChecksum, setItemWhenComplete, setItemStartAt, setItemClip, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom, restartTorrentEngine],
  );
  const historyValue = useMemo(
    () => ({ items: history, removeFromHistory, removeManyFromHistory, restoreHistory, importHistory, clearHistory }),
    [history, removeFromHistory, removeManyFromHistory, restoreHistory, importHistory, clearHistory],
  );
  const resetStats = useCallback(() => setStats(freshStats()), []);
  const statsValue = useMemo(() => ({ stats, resetStats }), [stats, resetStats]);

  return (
    <SettingsContext.Provider value={settingsValue}>
      <QueueActionsContext.Provider value={queueActions}>
      <QueueContext.Provider value={queueValue}>
        <HistoryContext.Provider value={historyValue}>
          <StatsContext.Provider value={statsValue}>
            {children}
          </StatsContext.Provider>
        </HistoryContext.Provider>
      </QueueContext.Provider>
      </QueueActionsContext.Provider>
    </SettingsContext.Provider>
  );
}
