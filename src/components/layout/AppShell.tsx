import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useQueue } from '@/stores/AppProvider';
import {
  LayoutDashboard,
  ArrowDownToLine,
  CheckCircle2,
  XCircle,
  Clock,
  Settings2,
  Info,
  Zap,
} from 'lucide-react';

const NAV_ITEMS = [
  { path: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { path: '/queue', icon: ArrowDownToLine, label: 'Queue', badgeKey: 'queue' as const },
  { path: '/downloads', icon: CheckCircle2, label: 'Downloads' },
  { path: '/failed', icon: XCircle, label: 'Failed' },
  { path: '/history', icon: Clock, label: 'History' },
] as const;

const BOTTOM_ITEMS = [
  { path: '/settings', icon: Settings2, label: 'Settings' },
  { path: '/about', icon: Info, label: 'About' },
] as const;

function SidebarNav() {
  const { items: queueItems } = useQueue();
  const activeCount = queueItems.filter(i => i.status === 'downloading' || i.status === 'queued').length;

  return (
    <aside className="w-[220px] min-w-[220px] h-screen flex flex-col border-r border-border/50 bg-sidebar select-none">
      {/* Brand */}
      <div className="h-14 flex items-center gap-2.5 px-5 border-b border-border/30">
        <div className="w-7 h-7 rounded-lg bg-primary/20 flex items-center justify-center">
          <Zap className="w-4 h-4 text-primary" strokeWidth={2.5} />
        </div>
        <span className="text-sm font-semibold tracking-tight text-foreground">Prism</span>
        <span className="text-[10px] font-medium text-muted-foreground ml-auto">v1.0</span>
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
              <span className="ml-auto text-[10px] tabular-nums font-semibold bg-primary/20 text-primary px-1.5 py-0.5 rounded-md">
                {activeCount}
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
    '/queue': 'Download Queue',
    '/downloads': 'Completed Downloads',
    '/failed': 'Failed Downloads',
    '/history': 'History',
    '/settings': 'Settings',
    '/about': 'About Prism',
  };

  return (
    <header className="h-14 flex items-center px-6 border-b border-border/30 shrink-0">
      <h1 className="text-sm font-semibold text-foreground">
        {titles[location.pathname] || 'Prism'}
      </h1>
    </header>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <SidebarNav />
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader />
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
