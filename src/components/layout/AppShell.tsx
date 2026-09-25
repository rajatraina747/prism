import React from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useQueue, useHistory, useSettings } from '@/stores/AppProvider';
import { useEngineStatus, publishEngineInfo } from '@/stores/engine-status';
import { useService } from '@/services/ServiceProvider';
import { useThemeSync } from '@/hooks/use-theme-sync';
import { useDropToAdd } from '@/hooks/use-drop-to-add';
import { pushDeepLink } from '@/lib/deep-link-bus';
import { setRemoteImagesAllowed } from '@/lib/remote-images';
import { onNavigateRequest } from '@/lib/nav-bus';
import { AddSheet, MOD_KEY } from '@/components/add/AddSheet';
import { toast } from 'sonner';
import {
  LayoutDashboard,
  ArrowDownToLine,
  Library as LibraryIcon,
  Rss,
  Settings2,
  Info,
  Plus,
  BarChart3,
} from 'lucide-react';

const NAV_ITEMS = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/queue', icon: ArrowDownToLine, label: 'Transfers' },
  { path: '/subscriptions', icon: Rss, label: 'Subscriptions' },
  { path: '/library', icon: LibraryIcon, label: 'Library' },
  { path: '/statistics', icon: BarChart3, label: 'Statistics' },
] as const;

const BOTTOM_ITEMS = [
  { path: '/settings', icon: Settings2, label: 'Settings' },
  { path: '/about', icon: Info, label: 'About' },
] as const;

function SidebarNav({ onAdd }: { onAdd: () => void }) {
  const { items: queueItems } = useQueue();
  const { items: historyItems } = useHistory();
  const activeCount = queueItems.filter(i => i.status === 'downloading' || i.status === 'queued').length;
  const failedCount = historyItems.filter(i => i.status === 'failed').length;
  const engine = useEngineStatus();

  return (
    <aside aria-label="Navigation" className="w-[220px] min-w-[220px] h-screen flex flex-col border-r border-border/50 bg-sidebar select-none">
      {/* Brand */}
      <div className="flex flex-col items-center gap-1.5 px-5 py-5 border-b border-border/30">
        <img src="/logo-nobg.webp" alt="Prism" className="w-24 h-24 rounded-2xl object-contain" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Prism</span>
        <span className="text-[11px] text-muted-foreground/60">by RainaCorp</span>
      </div>

      <div className="px-3 pt-3">
        <button
          type="button"
          onClick={onAdd}
          aria-keyshortcuts={MOD_KEY === '⌘' ? 'Meta+N' : 'Control+N'}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground text-[13px] font-medium hover:bg-primary/90 transition-colors active:scale-[0.98]"
        >
          <Plus className="w-4 h-4 shrink-0" strokeWidth={2} />
          <span>Add</span>
          <kbd className="ml-auto text-[10px] font-sans opacity-70">{MOD_KEY}N</kbd>
        </button>
      </div>

      {/* Main Nav */}
      <nav className="flex-1 px-3 py-3 space-y-0.5 overflow-y-auto">
        {NAV_ITEMS.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors duration-150',
              isActive
                ? 'bg-primary/12 text-primary'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span>{item.label}</span>
            {item.path === '/queue' && activeCount > 0 && (
              <span className="ml-auto text-[11px] tabular-nums font-semibold bg-primary/20 text-primary px-1.5 py-0.5 rounded-md">
                {activeCount}
              </span>
            )}
            {item.path === '/library' && failedCount > 0 && (
              <span
                title={`${failedCount} failed download${failedCount !== 1 ? 's' : ''}`}
                className="ml-auto text-[11px] tabular-nums font-semibold bg-destructive/15 text-destructive px-1.5 py-0.5 rounded-md"
              >
                {failedCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom Nav */}
      <div className="px-3 py-3 space-y-0.5 border-t border-border/30">
        {BOTTOM_ITEMS.map(item => (
          <NavLink
            key={item.path}
            to={item.path}
            className={({ isActive }) => cn(
              'flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors duration-150',
              isActive
                ? 'bg-primary/12 text-primary'
                : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
            )}
          >
            <item.icon className="w-4 h-4 shrink-0" strokeWidth={1.8} />
            <span>{item.label}</span>
            {item.path === '/settings' && engine?.updateAvailable && (
              <span
                title={`Downloader engine ${engine.latest} is available`}
                aria-label="Engine update available"
                className="ml-auto w-2 h-2 rounded-full bg-primary"
              />
            )}
          </NavLink>
        ))}
      </div>

    </aside>
  );
}

function PageHeader() {
  const location = useLocation();
  const titles: Record<string, string> = {
    '/': 'Dashboard',
    '/queue': 'Transfers',
    '/subscriptions': 'Subscriptions',
    '/library': 'Library',
    '/settings': 'Settings',
    '/about': 'About Prism',
    '/privacy': 'Privacy Policy',
    '/terms': 'Terms of Service',
    '/licenses': 'Open Source Licenses',
  };

  const service = useService();

  return (
    <header className="h-14 flex items-center px-6 border-b border-border/30 shrink-0">
      <h1 className="text-sm font-semibold text-foreground">
        {titles[location.pathname] || 'Prism'}
      </h1>
      {service.isDemo && (
        <span
          title="Browser demo: downloads are simulated and nothing is saved to disk"
          className="ml-3 px-2 py-0.5 rounded-full bg-warning/15 text-warning text-[10px] font-semibold uppercase tracking-wide"
        >
          Demo
        </span>
      )}
    </header>
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
  const { pauseAll } = useQueue();
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
  const [addOpen, setAddOpen] = React.useState(false);

  // The application menu names an intent; deciding what it means belongs here,
  // with the rest of the navigation, rather than in Rust.
  React.useEffect(() => service.onMenuAction(action => {
    if (action === 'add') {
      setAddOpen(true);
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
        <PageHeader />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
