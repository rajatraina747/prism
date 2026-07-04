import React, { createContext, useContext, useState, useEffect, useReducer, useRef, useCallback, type ReactNode } from 'react';
import type { DownloadItem, HistoryItem, AppPreferences, DownloadError } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { queueReducer } from '@/stores/queue-reducer';
import { scheduleGate } from '@/stores/schedule';
import { syncCrashReporting } from '@/services/crash-reporting';
import { useService } from '@/services/ServiceProvider';
import { diagnostics } from '@/services/diagnostics';
import { toast } from 'sonner';

function classifyError(msg: string): { category: DownloadError['category']; suggestion: string } {
  const lower = msg.toLowerCase();
  // Auth / access walls (yt-dlp phrases these many ways)
  if (lower.includes('sign in to confirm') || lower.includes('not a bot') || lower.includes('login required')
    || lower.includes('private video') || lower.includes('members-only') || lower.includes('age-restricted')
    || lower.includes('age restricted') || lower.includes('confirm your age'))
    return { category: 'auth', suggestion: 'This video requires sign-in — set "Browser cookies" in Settings to a browser where you\'re logged in' };
  // Gone / never existed
  if (lower.includes('video unavailable') || lower.includes('has been removed') || lower.includes('account terminated')
    || lower.includes('no longer available') || lower.includes('404'))
    return { category: 'parse', suggestion: 'This video is no longer available' };
  // Region locks
  if (lower.includes('not available in your country') || lower.includes('geo restrict') || lower.includes('georestrict'))
    return { category: 'parse', suggestion: 'Not available in your region' };
  // Rate limiting — transient, but retrying immediately makes it worse
  if (lower.includes('429') || lower.includes('too many requests') || lower.includes('rate limit'))
    return { category: 'network', suggestion: 'Rate limited by the site — wait a few minutes and retry' };
  if (lower.includes('permission') || lower.includes('access denied'))
    return { category: 'permission', suggestion: 'Check folder permissions' };
  if (lower.includes('disk') || lower.includes('space') || lower.includes('no space') || lower.includes('full'))
    return { category: 'storage', suggestion: 'Free up disk space' };
  if (lower.includes('codec') || lower.includes('format') || lower.includes('merge') || lower.includes('remux'))
    return { category: 'unknown', suggestion: 'Try a different format' };
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('connection') || lower.includes('network')
    || lower.includes('dns') || lower.includes('ssl') || lower.includes('unable to download'))
    return { category: 'network', suggestion: 'Check your connection' };
  if (lower.includes('not found') || lower.includes('unsupported') || lower.includes('unable to extract'))
    return { category: 'parse', suggestion: 'This URL may not be supported' };
  return { category: 'network', suggestion: 'Check your connection and retry' };
}

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

  // Persist. Queue writes are debounced: progress events mutate the queue
  // several times per second, and each save serializes the whole list to disk.
  // A trailing write within 300ms is plenty — on restart, in-flight items are
  // reset to 'queued' anyway, so losing the final progress tick is harmless.
  useEffect(() => {
    const t = setTimeout(() => service.persistence.saveQueue(queue), 300);
    return () => clearTimeout(t);
  }, [queue, service]);
  useEffect(() => { service.persistence.saveHistory(history); }, [history, service]);
  useEffect(() => { service.persistence.saveSettings(settings); }, [settings, service]);

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

  // Move completed/failed to history
  useEffect(() => {
    const terminal = queue.filter(i => i.status === 'completed' || i.status === 'failed' || i.status === 'canceled');
    if (terminal.length === 0) return;

    const timeout = setTimeout(() => {
      const historyItems: HistoryItem[] = terminal.map(i => ({
        id: i.id,
        metadata: i.metadata,
        settings: i.settings,
        status: i.status as 'completed' | 'failed' | 'canceled',
        completedAt: i.completedAt || new Date().toISOString(),
        fileSize: i.status === 'completed' ? i.totalBytes : i.downloadedBytes,
        filePath: i.filePath,
        error: i.error,
      }));
      // Cap history so history.json can't grow (and load/render) unboundedly
      setHistory(prev => [...historyItems, ...prev].slice(0, 2000));
      dispatch({ type: 'removeMany', ids: terminal.map(t => t.id) });
    }, 2000);
    return () => clearTimeout(timeout);
  }, [queue]);

  // Re-evaluate the quiet-hours gate once a minute while a schedule is on,
  // so held items start (or throttling changes) when the window flips.
  const [scheduleTick, setScheduleTick] = useState(0);
  useEffect(() => {
    if (!settings.scheduleEnabled) return;
    const t = setInterval(() => setScheduleTick(x => x + 1), 60_000);
    return () => clearInterval(t);
  }, [settings.scheduleEnabled]);

  // Push the quiet-hours throttle to the torrent engine (session-wide, so it
  // also caps seeding). yt-dlp downloads get the limit per-item at start time;
  // torrents run in a persistent session, so the limit is applied out-of-band.
  useEffect(() => {
    void scheduleTick;
    const gate = scheduleGate(settings, new Date());
    service.setTorrentRateLimit(gate.blockStarts ? null : gate.speedLimitOverrideBytes).catch(() => {});
  }, [settings, scheduleTick, service]);

  // Auto-start queued items
  useEffect(() => {
    void scheduleTick; // dep only: minute tick re-runs the gate below
    const gate = scheduleGate(settings, new Date());
    if (gate.blockStarts) return;

    const activeCount = queue.filter(i => i.status === 'downloading').length;
    const available = settings.maxConcurrentDownloads - activeCount;
    if (available <= 0) return;

    const toStart = queue
      .filter(i => i.status === 'queued' && !startedRef.current.has(i.id))
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
        (success, errorMsg, filePath, fileSize) => {
          startedRef.current.delete(item.id);
          cleanupRefs.current.delete(item.id);
          if (success) {
            diagnostics.log('info', `Download completed: ${item.metadata.title}`);
            dispatch({ type: 'completed', id: item.id, completedAt: new Date().toISOString(), filePath, fileSize });
            if (settings.notificationsEnabled) {
              toast.success(`Downloaded: ${item.metadata.title}`);
            }
            if (settings.soundEnabled) playNotificationSound();
          } else {
            const message = errorMsg || 'An unexpected error occurred';
            const { category, suggestion } = classifyError(message);

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
              toast.error(`Failed: ${item.metadata.title}`);
            }
            const err: DownloadError = {
              code: 'DOWNLOAD_FAILED',
              message,
              category,
              timestamp: new Date().toISOString(),
              suggestion,
            };
            dispatch({ type: 'failed', id: item.id, error: err });
          }
        }
      );
      cleanupRefs.current.set(item.id, cleanup);
    });
  }, [queue, settings, scheduleTick, service]);

  const addToQueue = useCallback((item: DownloadItem) => {
    diagnostics.log('info', `Added to queue: ${item.metadata.title}`);
    dispatch({ type: 'add', item });
  }, []);

  // Detach listeners AND kill the backend yt-dlp process for a download.
  const stopDownload = useCallback((id: string) => {
    cleanupRefs.current.get(id)?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    service.cancelDownload(id).catch(() => {});
  }, [service]);

  const removeFromQueue = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'remove', id });
  }, [stopDownload]);

  const pauseDownload = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'pause', id });
  }, [stopDownload]);

  const resumeDownload = useCallback((id: string) => {
    dispatch({ type: 'resume', id });
  }, []);

  const cancelDownload = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'cancel', id });
  }, [stopDownload]);

  const retryDownload = useCallback((id: string) => {
    stopDownload(id);
    dispatch({ type: 'retry', id });
  }, [stopDownload]);

  const clearCompleted = useCallback(() => {
    dispatch({ type: 'clearCompleted' });
  }, []);

  const startAll = useCallback(() => {
    dispatch({ type: 'startAll' });
  }, []);

  const pauseAll = useCallback(() => {
    // Side effect stays outside the reducer: kill each active process, then
    // let the (pure) transition flip statuses.
    queue.filter(i => i.status === 'downloading').forEach(i => stopDownload(i.id));
    dispatch({ type: 'pauseAll' });
  }, [queue, stopDownload]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    dispatch({ type: 'reorder', from: fromIndex, to: toIndex });
  }, []);

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
      <QueueContext.Provider value={{ items: queue, addToQueue, removeFromQueue, pauseDownload, resumeDownload, cancelDownload, retryDownload, clearCompleted, startAll, pauseAll, reorderQueue }}>
        <HistoryContext.Provider value={{ items: history, removeFromHistory, clearHistory }}>
          {children}
        </HistoryContext.Provider>
      </QueueContext.Provider>
    </SettingsContext.Provider>
  );
}
