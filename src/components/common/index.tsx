import React from 'react';
import type { DownloadStatus } from '@/types/models';
import { cn } from '@/lib/utils';
import type { LucideIcon } from 'lucide-react';

// ── Empty State ──
interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-16 text-center animate-fade-in', className)}>
      <div className="mb-4 rounded-2xl bg-secondary/50 p-4">
        <Icon className="h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-medium text-foreground mb-1">{title}</h3>
      <p className="text-xs text-muted-foreground max-w-[280px] text-pretty">{description}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Status Badge ──
const STATUS_CONFIG: Record<DownloadStatus, { label: string; className: string }> = {
  queued: { label: 'Queued', className: 'bg-secondary text-secondary-foreground' },
  parsing: { label: 'Parsing', className: 'bg-warning/15 text-warning animate-pulse-soft' },
  ready: { label: 'Ready', className: 'bg-primary/15 text-primary' },
  downloading: { label: 'Downloading', className: 'bg-primary/15 text-primary animate-pulse-soft' },
  paused: { label: 'Paused', className: 'bg-warning/15 text-warning' },
  completed: { label: 'Completed', className: 'bg-success/15 text-success' },
  failed: { label: 'Failed', className: 'bg-destructive/15 text-destructive' },
  canceled: { label: 'Canceled', className: 'bg-muted text-muted-foreground' },
};

export function StatusBadge({ status }: { status: DownloadStatus }) {
  const config = STATUS_CONFIG[status];
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase', config.className)}>
      {config.label}
    </span>
  );
}

// ── Progress Bar ──
interface ProgressBarProps {
  value: number;
  className?: string;
  size?: 'sm' | 'md';
  animated?: boolean;
}

export function ProgressBar({ value, className, size = 'sm', animated = true }: ProgressBarProps) {
  const height = size === 'sm' ? 'h-1' : 'h-1.5';
  return (
    <div className={cn('w-full rounded-full bg-secondary overflow-hidden', height, className)}>
      <div
        className={cn(
          'h-full rounded-full bg-primary transition-[width] duration-300 ease-out',
          animated && value < 100 && value > 0 && 'bg-gradient-to-r from-primary to-primary/80'
        )}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

// ── Panel ──
interface PanelProps {
  title?: string;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
  style?: React.CSSProperties;
}

export function Panel({ title, children, className, action }: PanelProps) {
  return (
    <div className={cn('panel', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between mb-3">
          {title && <span className="panel-header mb-0">{title}</span>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
