import React, { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from 'react';
import type { Subscription } from '@/types/models';
import { diffFeed, entryToDownloadItem } from '@/stores/subscription-check';
import { useQueue, useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { generateId } from '@/services/utils';
import { diagnostics } from '@/services/diagnostics';
import { toast } from 'sonner';

interface SubscriptionActions {
  items: Subscription[];
  /** Parse the feed, seed seenUrls (only videos published after subscribing
   * are downloaded), and save. Throws if the URL can't be parsed as a feed. */
  addSubscription: (url: string) => Promise<Subscription>;
  removeSubscription: (id: string) => void;
  toggleSubscription: (id: string) => void;
  setAudioOnly: (id: string, audioOnly: boolean) => void;
  /** Check one subscription (or all enabled ones) immediately. */
  checkNow: (id?: string) => Promise<void>;
  checking: boolean;
}

// How many newest feed entries a poll fetches. Seeding uses the same window,
// so anything that can ever appear in a future poll is already marked seen at
// subscribe time — entries below the window are older and can't re-enter it.
const POLL_WINDOW = 100;

const SubscriptionsContext = createContext<SubscriptionActions | null>(null);

export function useSubscriptions() {
  const ctx = useContext(SubscriptionsContext);
  if (!ctx) throw new Error('useSubscriptions must be used within SubscriptionsProvider');
  return ctx;
}

export function SubscriptionsProvider({ children }: { children: ReactNode }) {
  const service = useService();
  const { addToQueue } = useQueue();
  const { preferences } = useSettings();

  const [subs, setSubs] = useState<Subscription[]>(() => service.persistence.loadSubscriptions());
  const [checking, setChecking] = useState(false);
  // Serializes checks: the interval tick, manual checkNow, and startup check
  // must not overlap or a slow feed would double-enqueue its new entries.
  const checkingRef = useRef(false);
  // Live snapshots so the long-lived interval never works from stale closures.
  const subsRef = useRef(subs);
  subsRef.current = subs;
  const prefsRef = useRef(preferences);
  prefsRef.current = preferences;

  useEffect(() => { service.persistence.saveSubscriptions(subs); }, [subs, service]);

  const runCheck = useCallback(async (onlyId?: string) => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const targets = subsRef.current.filter(s => (onlyId ? s.id === onlyId : s.enabled));
      for (const sub of targets) {
        const checkedAt = new Date().toISOString();
        try {
          const feed = await service.parsePlaylist(sub.url, POLL_WINDOW);
          const { newEntries, seenUrls } = diffFeed(sub, feed.entries);
          for (const entry of newEntries) {
            addToQueue(entryToDownloadItem(entry, sub, prefsRef.current));
          }
          if (newEntries.length > 0) {
            diagnostics.log('info', `Subscription "${sub.title}": queued ${newEntries.length} new video(s)`);
            if (prefsRef.current.notificationsEnabled) {
              toast(`${sub.title}: ${newEntries.length} new video${newEntries.length !== 1 ? 's' : ''} queued`);
            }
          }
          setSubs(prev => prev.map(s =>
            s.id === sub.id ? { ...s, seenUrls, lastCheckedAt: checkedAt, lastError: undefined } : s
          ));
        } catch (e) {
          const msg = typeof e === 'string' ? e : e instanceof Error ? e.message : 'Check failed';
          diagnostics.log('warn', `Subscription check failed: ${sub.title}`, { error: msg });
          setSubs(prev => prev.map(s =>
            s.id === sub.id ? { ...s, lastCheckedAt: checkedAt, lastError: msg } : s
          ));
        }
      }
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [service, addToQueue]);

  // Scheduler: one check shortly after launch, then on the configured interval.
  useEffect(() => {
    if (subs.length === 0) return;
    const intervalMs = Math.max(5, preferences.subscriptionCheckIntervalMinutes) * 60_000;
    const startup = setTimeout(() => runCheck(), 15_000);
    const interval = setInterval(() => runCheck(), intervalMs);
    return () => {
      clearTimeout(startup);
      clearInterval(interval);
    };
  }, [subs.length, preferences.subscriptionCheckIntervalMinutes, runCheck]);

  const addSubscription = useCallback(async (url: string): Promise<Subscription> => {
    if (subsRef.current.some(s => s.url === url)) {
      throw new Error('Already subscribed to this URL');
    }
    const feed = await service.parsePlaylist(url, POLL_WINDOW);
    const sub: Subscription = {
      id: generateId(),
      url,
      title: feed.title,
      addedAt: new Date().toISOString(),
      enabled: true,
      audioOnly: false,
      seenUrls: feed.entries.map(e => e.url),
    };
    setSubs(prev => [...prev, sub]);
    diagnostics.log('info', `Subscribed: ${sub.title} (${feed.entries.length} existing videos marked seen)`);
    return sub;
  }, [service]);

  const removeSubscription = useCallback((id: string) => {
    setSubs(prev => prev.filter(s => s.id !== id));
  }, []);

  const toggleSubscription = useCallback((id: string) => {
    setSubs(prev => prev.map(s => (s.id === id ? { ...s, enabled: !s.enabled } : s)));
  }, []);

  const setAudioOnly = useCallback((id: string, audioOnly: boolean) => {
    setSubs(prev => prev.map(s => (s.id === id ? { ...s, audioOnly } : s)));
  }, []);

  const checkNow = useCallback((id?: string) => runCheck(id), [runCheck]);

  return (
    <SubscriptionsContext.Provider value={{ items: subs, addSubscription, removeSubscription, toggleSubscription, setAudioOnly, checkNow, checking }}>
      {children}
    </SubscriptionsContext.Provider>
  );
}
