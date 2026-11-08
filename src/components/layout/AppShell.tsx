import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useQueue, useQueueActions, useHistory, useSettings } from '@/stores/AppProvider';
import { useEngineStatus, publishEngineInfo } from '@/stores/engine-status';
import { useService } from '@/services/ServiceProvider';
import { useThemeSync } from '@/hooks/use-theme-sync';
import { useDropToAdd } from '@/hooks/use-drop-to-add';
import { usePlayerAvailable } from '@/hooks/use-player-available';
import { pushDeepLink } from '@/lib/deep-link-bus';
import { setRemoteImagesAllowed } from '@/lib/remote-images';
import { onNavigateRequest, onAddRequest } from '@/lib/nav-bus';
import { onStoreProblem, describeStoreProblem } from '@/lib/store-problems';
import { AddSheet, MOD_KEY } from '@/components/add/AddSheet';
import { OutboundLink } from '@/components/common';
import { toast } from 'sonner';
import {
  ArrowDownToLine,
  Library as LibraryIcon,
  Rss,
  Settings2,
  Plus,
  PlayCircle,
} from 'lucide-react';
import { publicAsset } from "@/lib/public-asset";

/** "Play a File…" from the app menu (⌘O): any audio or video on this
 * computer, picked in a dialog Rust shows. Dynamic import keeps the Tauri
 * window APIs out of the web-demo bundle. */
function playAFile() {
  import('@/lib/player-window')
    .then(({ pickAndPlay }) => pickAndPlay())
    .catch((e) => toast.error(`Couldn't play that file: ${e instanceof Error ? e.message : e}`));
}

const NAV_ITEMS = [
  { path: '/', icon: ArrowDownToLine, label: 'Downloads' },
  { path: '/subscriptions', icon: Rss, label: 'Subscriptions' },
  { path: '/library', icon: LibraryIcon, label: 'Library' },
] as const;

/** Pages reached from Settings, which keep Settings lit in the sidebar. */
const UNDER_SETTINGS = ['/about', '/privacy', '/terms', '/licenses'];

const BOTTOM_ITEMS = [
  { path: '/settings', icon: Settings2, label: 'Settings' },
] as const;

function SidebarNav({ onAdd }: { onAdd: () => void }) {
  const { items: queueItems } = useQueue();
  const { items: historyItems } = useHistory();
  const activeCount = queueItems.filter(i => i.status === 'downloading' || i.status === 'queued').length;
  const failedCount = historyItems.filter(i => i.status === 'failed').length;
  const engine = useEngineStatus();
  const playerAvailable = usePlayerAvailable();
  const service = useService();
  const { pathname } = useLocation();

  return (
    <aside aria-label="Navigation" className="w-[220px] min-w-[220px] max-[999px]:w-16 max-[999px]:min-w-16 h-screen flex flex-col border-r border-border/50 bg-sidebar select-none">
      {/* Brand. Below 1000px the sidebar is icons only, and this is the logo. */}
      <div className="flex items-center gap-3 px-4 h-[72px] border-b border-border/30 max-[999px]:justify-center max-[999px]:px-0">
        <img src={publicAsset("logo-nobg.webp")} alt="Prism" className="w-11 h-11 rounded-xl object-contain shrink-0" />
        <div className="min-w-0 max-[999px]:sr-only">
          <p className="text-base font-semibold tracking-tight text-foreground leading-tight whitespace-nowrap flex items-center gap-2">
            Prism
            {service.isDemo && (
              <span
                title="Browser demo: downloads are simulated and nothing is saved to disk"
                className="px-1.5 rounded-full bg-warning/15 text-warning text-xs font-semibold uppercase tracking-wide"
              >
                Demo
              </span>
            )}
          </p>
          <p className="text-xs text-muted-foreground leading-tight whitespace-nowrap">by RainaCorp</p>
        </div>
      </div>

      <div className="px-3 pt-3 max-[999px]:px-2">
        <button
          type="button"
          onClick={onAdd}
          title={`Add (${MOD_KEY}N)`}
          aria-keyshortcuts={MOD_KEY === '⌘' ? 'Meta+N' : 'Control+N'}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors active:scale-[0.98] max-[999px]:justify-center max-[999px]:px-0"
        >
          <Plus className="w-4 h-4 shrink-0" strokeWidth={2} />
          <span className="max-[999px]:sr-only">Add</span>
          <kbd className="ml-auto text-xs font-sans opacity-70 max-[999px]:hidden">{MOD_KEY}N</kbd>
        </button>
        {playerAvailable && (
          <button
            type="button"
            onClick={playAFile}
            title={`Play any video or audio file on this computer (${MOD_KEY}O)`}
            aria-keyshortcuts={MOD_KEY === '⌘' ? 'Meta+O' : 'Control+O'}
            className="mt-1.5 w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-secondary text-secondary-foreground text-sm font-medium hover:bg-secondary/80 transition-colors active:scale-[0.98] max-[999px]:justify-center max-[999px]:px-0"
          >
            <PlayCircle className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span className="max-[999px]:sr-only">Play a file</span>
            <kbd className="ml-auto text-xs font-sans opacity-70 max-[999px]:hidden">{MOD_KEY}O</kbd>
          </button>
        )}
      </div>

      {/* Main Nav */}
      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto max-[999px]:px-2">
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            title={item.label}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 max-[999px]:justify-center max-[999px]:px-0 relative',
              isActive
                ? 'bg-primary/12 text-primary'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span className="max-[999px]:sr-only">{item.label}</span>
            {item.path === '/' && activeCount > 0 && (
              <span className="ml-auto text-xs tabular-nums font-semibold bg-primary/20 text-primary px-1.5 py-0.5 rounded-md max-[999px]:absolute max-[999px]:-top-1 max-[999px]:right-1 max-[999px]:px-1 max-[999px]:py-0">
                {activeCount}
              </span>
            )}
            {item.path === '/library' && failedCount > 0 && (
              <span
                title={`${failedCount} failed download${failedCount !== 1 ? 's' : ''}`}
                className="ml-auto text-xs tabular-nums font-semibold bg-destructive/15 text-destructive px-1.5 py-0.5 rounded-md max-[999px]:absolute max-[999px]:-top-1 max-[999px]:right-1 max-[999px]:px-1 max-[999px]:py-0"
              >
                {failedCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom Nav */}
      <div className="px-3 py-3 space-y-0.5 border-t border-border/30 max-[999px]:px-2">
        <OutboundLink
          href="https://www.rainacorp.co.uk"
          title="RainaCorp — rainacorp.co.uk"
          className="flex flex-col items-center gap-1 py-2 mb-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors group"
        >
          <img src={publicAsset("rainacorp-logo.webp")} alt="" className="w-7 h-7 object-contain opacity-70 group-hover:opacity-100 transition-opacity" />
          <span className="text-xs font-semibold tracking-wide whitespace-nowrap max-[999px]:sr-only">A RAINACORP PRODUCT</span>
          <span className="text-xs whitespace-nowrap max-[999px]:sr-only">rainacorp.co.uk</span>
        </OutboundLink>
        {BOTTOM_ITEMS.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            // About and the legal pages live under Settings now.
            title={item.label}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors duration-150 max-[999px]:justify-center max-[999px]:px-0 relative',
              isActive || (item.path === '/settings' && UNDER_SETTINGS.includes(pathname))
                ? 'bg-primary/12 text-primary'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span className="max-[999px]:sr-only">{item.label}</span>
            {item.path === '/settings' && engine?.updateAvailable && (
              <span
                title={`Downloader engine ${engine.latest} is available`}
                aria-label="Engine update available"
                className="ml-auto w-2 h-2 rounded-full bg-primary max-[999px]:absolute max-[999px]:top-1 max-[999px]:right-3"
              />
            )}
          </NavLink>
        ))}
      </div>

    </aside>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  useThemeSync();
  const service = useService();
  const navigate = useNavigate();

  // react-router rebuilds `navigate` on every location change, so keep it in a
  // ref: with it in the dep array the deep-link subscription would be torn down
  // and rebuilt on every page switch.
  const navigateRef = React.useRef(navigate);
  React.useLayoutEffect(() => { navigateRef.current = navigate; }, [navigate]);

  // Deep links can arrive on any page; buffer them and jump to the Dashboard,
  // which drains the buffer and submits the URL (after confirming, for links
  // from outside the app).
  React.useEffect(() => service.onDeepLink((url, origin) => {
    pushDeepLink(url, origin);
    navigateRef.current('/');
  }), [service]);

  // Navigation asked for from outside a route (e.g. a failure toast's
  // "Set browser cookies").
  React.useEffect(() => onNavigateRequest((path) => navigateRef.current(path)), []);
  // A damaged or unsaveable data file is worth a word (lib/json-store.ts).
  React.useEffect(() => onStoreProblem((p) => {
    const { title, description } = describeStoreProblem(p);
    (p.kind === 'recovered' ? toast.warning : toast.error)(title, { description, duration: 15000 });
  }), []);

  // Engine freshness: an hourly look at a lookup Rust caches for a day, so
  // GitHub is asked at most daily. Offline or rate-limited just means no nudge.
  const { preferences } = useSettings();
  const { engineAutoCheck, engineAutoUpdate } = preferences;

  // No thumbnails straight from the sites while a proxy is set (M6).
  React.useEffect(() => {
    setRemoteImagesAllowed(!preferences.proxyUrl?.trim());
  }, [preferences.proxyUrl]);
  React.useEffect(() => {
    if (service.isDemo || !engineAutoCheck) return;
    let cancelled = false;
    const run = async () => {
      try {
        const info = await service.checkEngineUpdate(false);
        if (cancelled) return;
        publishEngineInfo(info);
        if (info.updateAvailable && engineAutoUpdate) {
          const version = await service.updateEngine();
          toast.success(`Downloader engine updated to ${version}`);
          publishEngineInfo(await service.getEngineInfo());
        }
      } catch { /* try again on the next tick */ }
    };
    void run();
    const timer = setInterval(() => void run(), 60 * 60 * 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [service, engineAutoCheck, engineAutoUpdate]);

  const addLinks = React.useCallback((links: string[]) => {
    pushDeepLink(links, 'app');
    navigateRef.current('/');
  }, []);

  // Global hotkeys. Rust owns the registration (see src-tauri/src/shortcuts.rs)
  // and tells us which one fired. "Show Prism" never arrives here — raising a
  // hidden window is Rust's job.
  const { pauseAll } = useQueueActions();
  // Compared by value: `preferences.shortcuts` is a fresh object whenever
  // settings are saved, and re-registering system-wide keys on every render
  // would be a lot of churn for nothing.
  const shortcutsKey = JSON.stringify(preferences.shortcuts);
  React.useEffect(() => {
    if (service.isDemo) return;
    service.setShortcuts(JSON.parse(shortcutsKey)).catch((e: unknown) => {
      toast.error(e instanceof Error ? e.message : 'Could not register that shortcut');
    });
  }, [service, shortcutsKey]);

  React.useEffect(() => service.onShortcut(async (action) => {
    if (action === 'pauseAll') {
      pauseAll();
      return;
    }
    if (action === 'addFromClipboard') {
      try {
        const text = (await service.readClipboard()).trim();
        if (text) addLinks([text]);
        else toast('Nothing on the clipboard to add');
      } catch {
        toast.error('Could not read the clipboard');
      }
    }
  }), [service, pauseAll, addLinks]);

  // One Add surface: the sheet (sidebar button, ⌘N / ⌘L from any page)…
  // Every page scrolls in this one <main>, so a new page would open at the
  // previous page's scroll position (the Library opened with its title
  // scrolled out of view). Back to the top on each route change.
  const mainRef = React.useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  React.useLayoutEffect(() => { if (mainRef.current) mainRef.current.scrollTop = 0; }, [pathname]);
  const [addOpen, setAddOpen] = React.useState(false);
  React.useEffect(() => onAddRequest(() => setAddOpen(true)), []);
  // Files opened with Prism from Finder / Explorer (Rust queues them, so a
  // cold start's arrive before this listens).
  React.useEffect(() => {
    let unlisten: (() => void) | undefined;
    let live = true;
    (async () => {
      const { isTauri } = await import('@tauri-apps/api/core');
      if (!isTauri() || !live) return;
      const { playOpenedMedia } = await import('@/lib/player-window');
      const { listen } = await import('@tauri-apps/api/event');
      const play = () => playOpenedMedia().catch((e) => toast.error(`Couldn't play that file: ${e instanceof Error ? e.message : e}`));
      unlisten = await listen('open-media-file', play);
      if (!live) { unlisten(); return; }
      play();
    })();
    return () => { live = false; unlisten?.(); };
  }, []);

  // The application menu names an intent; deciding what it means belongs here,
  // with the rest of the navigation, rather than in Rust.
  React.useEffect(() => service.onMenuAction(action => {
    if (action === 'add') {
      setAddOpen(true);
      return;
    }
    if (action === 'open-media') {
      playAFile();
      return;
    }
    if (action.startsWith('nav:')) {
      navigateRef.current(action.slice('nav:'.length));
    }
  }), [service]);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N' || e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        setAddOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // …and drops anywhere in the window — the drop is the intent.
  const dragging = useDropToAdd(
    (name, bytes) => service.importTorrentFile(name, bytes),
    ({ links, errors }) => {
      errors.forEach(msg => toast.error(msg));
      if (links.length > 0) addLinks(links);
    },
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <SidebarNav onAdd={() => setAddOpen(true)} />
      <AddSheet open={addOpen} onOpenChange={setAddOpen} onAdd={addLinks} />
      {dragging && (
        <div aria-hidden="true" className="fixed inset-0 z-[60] pointer-events-none flex items-center justify-center bg-background/70 border-2 border-dashed border-primary/60 rounded-xl m-2">
          <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-card border border-border/60 text-sm font-medium text-primary">
            <Plus className="w-4 h-4" /> Drop to add links, .torrent files or a list
          </div>
        </div>
      )}
      <div className="flex-1 flex flex-col min-w-0">
        <main ref={mainRef} className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
