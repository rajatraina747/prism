import React, { createContext, useContext, useState, useEffect, useReducer, useRef, useCallback, type ReactNode } from 'react';
import type { DownloadItem, HistoryItem, AppPreferences, DownloadError, DownloadCategory } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { queueReducer } from '@/stores/queue-reducer';
import { applyCategory, categoryFor } from '@/stores/categories';
import { scheduleGate } from '@/stores/schedule';
import { syncCrashReporting } from '@/services/crash-reporting';
import { useService } from '@/services/ServiceProvider';
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
  clearHistory: () => void;
}

interface SettingsActions {
  preferences: AppPreferences;
  updatePreference: <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => void;
  resetToDefaults: () => void;
}

// ── Contexts ──
const QueueContext = createContext<QueueActions | null>(null);
const HistoryContext = createContext<HistoryActions | null>(null);
const SettingsContext = createContext<SettingsActions | null>(null);

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

// ── Provider ──
export function AppProvider({ children }: { children: ReactNode }) {
  const service = useService();

  // Queue transitions live in queueReducer (pure, guarded); this component
  // only performs side effects — spawning/killing downloads — and dispatches.
  const [queue, dispatch] = useReducer(queueReducer, null, () => service.persistence.loadQueue());
  const [history, setHistory] = useState<HistoryItem[]>(() => service.persistence.loadHistory());
  // Merge over defaults so settings saved by older versions pick up new keys
  const [settings, setSettings] = useState<AppPreferences>(() => ({ ...DEFAULT_PREFERENCES, ...service.persistence.loadSettings() }));
  const cleanupRefs = useRef<Map<string, () => void>>(new Map());
  const startedRef = useRef<Set<string>>(new Set());
  // Items whose backend kill hasn't come back yet — see the auto-start effect.
  const stoppingRef = useRef<Set<string>>(new Set());
  const [stoppedTick, setStoppedTick] = useState(0);

  // Persist. Queue writes are debounced: progress events mutate the queue
  // several times per second, and each save serializes the whole list to disk.
  // A trailing write within 300ms is plenty — on restart, in-flight items are
  // reset to 'queued' anyway, so losing the final progress tick is harmless.
  useEffect(() => {
    const t = setTimeout(() => service.persistence.saveQueue(queue), 300);
    return () => clearTimeout(t);
  }, [queue, service]);
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
                  await service.installUpdate();
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
      // Cap history so history.json can't grow (and load/render) unboundedly
      setHistory(prev => [...historyItems, ...prev].slice(0, 2000));
      dispatch({ type: 'removeMany', ids: terminal.map(t => t.id) });
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
            if (settings.notificationsEnabled) {
              toast.success(`Downloaded: ${item.metadata.title}`);
              // Toasts are invisible when the window is hidden/in the tray —
              // that's exactly when a finished download needs an OS notification.
              if (!document.hasFocus()) {
                service.notify('Download complete', item.metadata.title).catch(() => {});
              }
            }
            if (settings.soundEnabled) playNotificationSound();
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
            if (settings.notificationsEnabled) {
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
    const item = queue.find(i => i.id === id);
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
  }, [queue, service, stopDownload]);

  const resumeDownload = useCallback((id: string) => {
    const item = queue.find(i => i.id === id);
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
  }, [queue, service, stopDownload]);

  const cancelDownload = useCallback((id: string) => {
    const item = queue.find(i => i.id === id);
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
  }, [queue, service, stopDownload]);

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
    queue.filter(i => i.status === 'paused').forEach(i => resumeDownload(i.id));
  }, [queue, resumeDownload]);

  const pauseAll = useCallback(() => {
    // Side effect stays outside the reducer: pause torrents natively (their
    // handles survive, so resume is instant) and kill yt-dlp processes, then
    // let the (pure) transition flip statuses.
    queue
      .filter(i => i.status === 'downloading' || i.status === 'seeding')
      .forEach(i => {
        if (i.kind === 'torrent' && cleanupRefs.current.has(i.id)) {
          service.pauseTorrent(i.id).catch(() => stopDownload(i.id));
        } else {
          stopDownload(i.id);
        }
      });
    dispatch({ type: 'pauseAll' });
  }, [queue, service, stopDownload]);

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
    const item = queue.find(i => i.id === id);
    const cleanup = cleanupRefs.current.get(id);
    cleanup?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    dispatch({ type: 'remove', id });
    service.removeTorrentData(id)
      .then(() => toast.success(`Removed ${item?.metadata.title ?? 'torrent'} and deleted its files`))
      .catch((e) => toast.error(`Couldn't delete files: ${e instanceof Error ? e.message : e}`));
  }, [queue, service]);

  const moveToTop = useCallback((id: string) => {
    const from = queue.findIndex(i => i.id === id);
    if (from > 0) dispatch({ type: 'reorder', from, to: 0 });
  }, [queue]);

  const moveToBottom = useCallback((id: string) => {
    const from = queue.findIndex(i => i.id === id);
    if (from >= 0 && from < queue.length - 1) dispatch({ type: 'reorder', from, to: queue.length - 1 });
  }, [queue]);

  const removeFromHistory = useCallback((id: string) => {
    setHistory(prev => prev.filter(i => i.id !== id));
  }, []);

  const clearHistory = useCallback(() => { setHistory([]); }, []);

  const updatePreference = useCallback(<K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetToDefaults = useCallback(() => { setSettings(DEFAULT_PREFERENCES); }, []);

  return (
    <SettingsContext.Provider value={{ preferences: settings, updatePreference, resetToDefaults }}>
      <QueueContext.Provider value={{ items: queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue, updateTorrentFiles, setItemCategory, setItemLabels, reannounceTorrent, recheckTorrent, removeWithData, moveToTop, moveToBottom }}>
        <HistoryContext.Provider value={{ items: history, removeFromHistory, clearHistory }}>
          {children}
        </HistoryContext.Provider>
      </QueueContext.Provider>
    </SettingsContext.Provider>
  );
}
