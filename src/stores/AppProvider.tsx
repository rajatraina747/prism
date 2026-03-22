import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { DownloadItem, HistoryItem, AppPreferences, DownloadError } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import { useService } from '@/services/ServiceProvider';
import { diagnostics } from '@/services/diagnostics';
import { toast } from 'sonner';

function playNotificationSound() {
  try {
    const ctx = new AudioContext();
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
    setTimeout(() => ctx.close(), 500);
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

  const [queue, setQueue] = useState<DownloadItem[]>(() => service.persistence.loadQueue());
  const [history, setHistory] = useState<HistoryItem[]>(() => service.persistence.loadHistory());
  const [settings, setSettings] = useState<AppPreferences>(() => service.persistence.loadSettings() || DEFAULT_PREFERENCES);
  const cleanupRefs = useRef<Map<string, () => void>>(new Map());
  const startedRef = useRef<Set<string>>(new Set());

  // Persist
  useEffect(() => { service.persistence.saveQueue(queue); }, [queue, service]);
  useEffect(() => { service.persistence.saveHistory(history); }, [history, service]);
  useEffect(() => { service.persistence.saveSettings(settings); }, [settings, service]);

  // Sync log level preference to diagnostics service
  useEffect(() => { diagnostics.setLogLevel(settings.logLevel); }, [settings.logLevel]);

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
      setHistory(prev => [...historyItems, ...prev]);
      setQueue(prev => prev.filter(i => !terminal.some(t => t.id === i.id)));
    }, 2000);
    return () => clearTimeout(timeout);
  }, [queue]);

  // Auto-start queued items
  useEffect(() => {
    const activeCount = queue.filter(i => i.status === 'downloading').length;
    const available = settings.maxConcurrentDownloads - activeCount;
    if (available <= 0) return;

    const toStart = queue
      .filter(i => i.status === 'queued' && !startedRef.current.has(i.id))
      .slice(0, available);

    if (toStart.length === 0) return;

    toStart.forEach(item => {
      startedRef.current.add(item.id);
      setQueue(prev => prev.map(i =>
        i.id === item.id ? { ...i, status: 'downloading' as const, startedAt: new Date().toISOString() } : i
      ));

      const cleanup = service.startDownload(
        item,
        (data) => {
          setQueue(prev => prev.map(i =>
            i.id === item.id && i.status === 'downloading'
              ? { ...i, ...data }
              : i
          ));
        },
        (success, errorMsg, filePath, fileSize) => {
          startedRef.current.delete(item.id);
          cleanupRefs.current.delete(item.id);
          if (success) {
            diagnostics.log('info', `Download completed: ${item.metadata.title}`);
            setQueue(prev => prev.map(i =>
              i.id === item.id ? { ...i, status: 'completed' as const, progress: 100, completedAt: new Date().toISOString(), filePath, totalBytes: fileSize ?? i.totalBytes } : i
            ));
            if (settings.notificationsEnabled) {
              toast.success(`Downloaded: ${item.metadata.title}`);
            }
            if (settings.soundEnabled) playNotificationSound();
          } else {
            diagnostics.log('error', `Download failed: ${item.metadata.title}`, { error: errorMsg });
            if (settings.notificationsEnabled) {
              toast.error(`Failed: ${item.metadata.title}`);
            }
            const err: DownloadError = {
              code: 'DOWNLOAD_FAILED',
              message: errorMsg || 'An unexpected error occurred',
              category: 'network',
              timestamp: new Date().toISOString(),
              suggestion: 'Check your connection and retry the download',
            };
            setQueue(prev => prev.map(i =>
              i.id === item.id ? { ...i, status: 'failed' as const, error: err } : i
            ));
          }
        }
      );
      cleanupRefs.current.set(item.id, cleanup);
    });
  }, [queue, settings.maxConcurrentDownloads, service]);

  const addToQueue = useCallback((item: DownloadItem) => {
    diagnostics.log('info', `Added to queue: ${item.metadata.title}`);
    setQueue(prev => [...prev, item]);
  }, []);

  const removeFromQueue = useCallback((id: string) => {
    cleanupRefs.current.get(id)?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    setQueue(prev => prev.filter(i => i.id !== id));
  }, []);

  const pauseDownload = useCallback((id: string) => {
    cleanupRefs.current.get(id)?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    setQueue(prev => prev.map(i =>
      i.id === id ? { ...i, status: 'paused' as const, speed: 0, eta: 0 } : i
    ));
  }, []);

  const resumeDownload = useCallback((id: string) => {
    setQueue(prev => prev.map(i =>
      i.id === id ? { ...i, status: 'queued' as const } : i
    ));
  }, []);

  const cancelDownload = useCallback((id: string) => {
    cleanupRefs.current.get(id)?.();
    cleanupRefs.current.delete(id);
    startedRef.current.delete(id);
    setQueue(prev => prev.map(i =>
      i.id === id ? { ...i, status: 'canceled' as const } : i
    ));
  }, []);

  const retryDownload = useCallback((id: string) => {
    setQueue(prev => prev.map(i =>
      i.id === id ? { ...i, status: 'queued' as const, progress: 0, downloadedBytes: 0, speed: 0, eta: 0, error: undefined, retryAttempt: i.retryAttempt + 1 } : i
    ));
  }, []);

  const clearCompleted = useCallback(() => {
    setQueue(prev => prev.filter(i => i.status !== 'completed'));
  }, []);

  const startAll = useCallback(() => {
    setQueue(prev => prev.map(i =>
      i.status === 'paused' ? { ...i, status: 'queued' as const } : i
    ));
  }, []);

  const pauseAll = useCallback(() => {
    queue.filter(i => i.status === 'downloading').forEach(i => {
      cleanupRefs.current.get(i.id)?.();
      cleanupRefs.current.delete(i.id);
      startedRef.current.delete(i.id);
    });
    setQueue(prev => prev.map(i =>
      i.status === 'downloading' ? { ...i, status: 'paused' as const, speed: 0, eta: 0 } : i
    ));
  }, [queue]);

  const reorderQueue = useCallback((fromIndex: number, toIndex: number) => {
    setQueue(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
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
