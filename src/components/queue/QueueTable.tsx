import React, { useState, useRef, useCallback } from 'react';
import type { DownloadItem } from '@/types/models';
import { StatusBadge, ProgressBar, Thumb } from '@/components/common';
import { PiecesBar } from '@/components/queue/PiecesBar';
import { formatBytes, formatSpeed, formatEta } from '@/services';
import { FailureNote } from '@/components/common/FailureNote';
import { INTERNAL_DRAG_TYPE } from '@/hooks/use-drop-to-add';
import { useService } from '@/services/ServiceProvider';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  Pause, Play, X, RotateCcw, Trash2, GripVertical, ArrowDownToLine, Link, Magnet, RefreshCw,
  ShieldCheck, ArrowUpToLine, ArrowDownToLine as ToBottom, FolderOpen, Info, Trash,
} from 'lucide-react';

/** Everything a row can ask the page to do. Torrent-only handlers are optional
 * so the table also works for plain HTTP queues (and older tests). */
export interface QueueRowActions {
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  onUpdateFiles?: (id: string, onlyFiles: number[]) => void;
  onReannounce?: (id: string) => void;
  onRecheck?: (id: string) => void;
  onRemoveWithData?: (id: string) => void;
  onMoveTop?: (id: string) => void;
  onMoveBottom?: (id: string) => void;
  onShowInFolder?: (id: string) => void;
  onOpenDetails?: (id: string) => void;
}

export interface SelectMods { shift: boolean; meta: boolean }


interface QueueTableProps extends QueueRowActions {
  items: DownloadItem[];
  selectedIds?: Set<string>;
  onSelect?: (id: string, mods: SelectMods) => void;
  /** Quiet hours are holding new downloads until this time ("07:00"). */
  heldUntil?: string;
}

export function QueueTable({ items, selectedIds, onSelect, onReorder, heldUntil, ...actions }: QueueTableProps) {
  // Roving tabindex: one row is in the tab order — the first selected one,
  // else the first row — and arrow keys (global shortcuts) move from there.
  const focusIndex = Math.max(0, items.findIndex(i => selectedIds?.has(i.id)));
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const dragNodeRef = useRef<HTMLDivElement | null>(null);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    // Tells the window-level drop-to-add that this drag is a reorder.
    e.dataTransfer.setData(INTERNAL_DRAG_TYPE, String(index));
    if (e.currentTarget instanceof HTMLElement) {
      dragNodeRef.current = e.currentTarget as HTMLDivElement;
      e.currentTarget.style.opacity = '0.5';
    }
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragNodeRef.current) dragNodeRef.current.style.opacity = '1';
    setDragIndex(null);
    setOverIndex(null);
    dragNodeRef.current = null;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setOverIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    const fromIndex = dragIndex;
    if (fromIndex !== null && fromIndex !== toIndex && onReorder) onReorder(fromIndex, toIndex);
    setDragIndex(null);
    setOverIndex(null);
  }, [dragIndex, onReorder]);

  return (
    // Own provider so the table also works outside App's root provider
    // (tests, the web demo's isolated renders); nesting providers is fine.
    <TooltipProvider delayDuration={400}>
    <div className="space-y-1.5" role="listbox" aria-label="Transfers" aria-multiselectable={onSelect ? true : undefined}>
      {items.map((item, index) => {
        const isDropTarget = overIndex === index && dragIndex !== null && dragIndex !== index;
        const isBeingDragged = dragIndex === index;

        return (
          <div
            key={item.id}
            role="presentation"
            draggable={!!onReorder}
            onDragStart={(e) => handleDragStart(e, index)}
            onDragEnd={handleDragEnd}
            onDragOver={(e) => handleDragOver(e, index)}
            onDrop={(e) => handleDrop(e, index)}
            className={cn(
              'transition-all duration-200',
              isDropTarget && dragIndex !== null && dragIndex < index && 'translate-y-1 border-b-2 border-b-primary/40',
              isDropTarget && dragIndex !== null && dragIndex > index && '-translate-y-1 border-t-2 border-t-primary/40',
              isBeingDragged && 'opacity-50 scale-[0.98]',
            )}
          >
            <QueueRow
              item={item}
              index={index}
              count={items.length}
              selected={selectedIds?.has(item.id) ?? false}
              focusable={index === focusIndex}
              heldUntil={heldUntil}
              onSelect={onSelect}
              onReorder={onReorder}
              {...actions}
            />
          </div>
        );
      })}
    </div>
    </TooltipProvider>
  );
}

const QueueRow = React.memo(function QueueRow({
  item, index, count, selected, focusable, heldUntil, onSelect,
  onPause, onResume, onCancel, onRetry, onRemove, onReorder, onUpdateFiles,
  onReannounce, onRecheck, onRemoveWithData, onMoveTop, onMoveBottom, onShowInFolder, onOpenDetails,
}: QueueRowActions & {
  item: DownloadItem; index: number; count: number;
  selected: boolean;
  focusable: boolean;
  heldUntil?: string;
  onSelect?: (id: string, mods: SelectMods) => void;
}) {
  // When the keyboard moves the selection, move focus with it — but only if
  // focus is already in the list, so a background change never steals it.
  const rowRef = useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = rowRef.current;
    if (selected && el && document.activeElement !== el && document.activeElement?.closest('[role="listbox"]') === el.closest('[role="listbox"]')) {
      el.focus();
    }
  }, [selected]);
  const service = useService();
  const copyLink = useCallback(() => {
    service.copyToClipboard(item.metadata.source.url)
      .then(() => toast.success(item.kind === 'torrent' ? 'Magnet link copied' : 'Link copied'))
      .catch(() => toast.error('Could not copy link'));
  }, [service, item.metadata.source.url, item.kind]);

  const isActive = item.status === 'downloading';
  const isPaused = item.status === 'paused';
  const isSeeding = item.status === 'seeding';
  const isFailed = item.status === 'failed';
  const isQueued = item.status === 'queued';
  const isTerminal = item.status === 'completed' || item.status === 'canceled';
  const isTorrent = item.kind === 'torrent';
  const isLive = isActive || isSeeding;
  const [showFiles, setShowFiles] = useState(false);
  const files = item.files ?? [];
  const sizeKnown = item.totalBytes > 0;

  const handleClick = (e: React.MouseEvent) => {
    // Clicks on controls inside the row shouldn't change the selection.
    if ((e.target as HTMLElement).closest('button, input, a, [role="button"]')) return;
    onSelect?.(item.id, { shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

  const row = (
    <div
      ref={rowRef}
      role="option"
      aria-selected={selected}
      aria-label={`${item.metadata.title}, ${item.status}`}
      tabIndex={focusable ? 0 : -1}
      data-selected={selected || undefined}
      onClick={handleClick}
      onDoubleClick={() => onOpenDetails?.(item.id)}
      className={cn(
        'surface-row rounded-xl p-3.5 animate-fade-in cursor-default transition-shadow',
        selected && 'ring-1 ring-primary/60 bg-primary/5',
      )}
      style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}
    >
      <div className="flex items-start gap-3">
        {/* Drag Handle — also a keyboard control: focus it and use arrow keys */}
        {onReorder && (
          <div
            role="button"
            tabIndex={0}
            data-reorder-handle
            className="flex items-center justify-center w-5 h-12 shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-muted-foreground focus:text-muted-foreground transition-colors"
            title="Drag to reorder (or focus and use arrow keys)"
            aria-label={`Reorder ${item.metadata.title} — position ${index + 1} of ${count}. Use arrow keys to move.`}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              // The handle owns the arrows: without this the Transfers
              // shortcuts also moved the selection on the same keypress.
              e.preventDefault();
              e.stopPropagation();
              if (e.key === 'ArrowUp' && index > 0) onReorder(index, index - 1);
              else if (e.key === 'ArrowDown' && index < count - 1) onReorder(index, index + 1);
            }}
          >
            <GripVertical className="w-4 h-4" strokeWidth={1.5} />
          </div>
        )}

        {/* Thumbnail — Thumb falls back to a neutral tile (torrents have none) */}
        <Thumb
          src={item.metadata.thumbnail}
          className="w-20 h-12"
          fallbackIcon={isTorrent
            ? <Magnet className="w-4 h-4 text-muted-foreground/50" />
            : <ArrowDownToLine className="w-4 h-4 text-muted-foreground/50" />}
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <KindBadge torrent={isTorrent} />
            <h4 className="text-xs font-medium text-foreground truncate">{item.metadata.title}</h4>
            <StatusBadge status={item.status} />
          </div>

          {/* Progress bar for active/paused/seeding, with the pieces map beneath for torrents */}
          {(isActive || isPaused || isSeeding) && (
            <div className="mb-1.5 space-y-0.5">
              <ProgressBar value={item.progress} />
              {isTorrent && item.pieces && item.pieces.length > 0 && !isSeeding && (
                <PiecesBar pieces={item.pieces} height="h-[3px]" className="opacity-80" />
              )}
            </div>
          )}

          {/* Stats row */}
          <div className="flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums flex-wrap">
            {item.settings.audioOnly ? (
              <span className="text-primary/80">Audio only</span>
            ) : item.settings.format ? (
              <span>{item.settings.format.resolution} · {item.settings.format.container.toUpperCase()}</span>
            ) : null}
            {item.settings.downloadSubtitles && (
              <span className="text-muted-foreground/70">+ Subs</span>
            )}
            {isActive && item.stage === 'processing' ? (
              <span className="text-primary/80">Processing — merging &amp; finishing up…</span>
            ) : isActive && (
              <>
                <span>
                  {sizeKnown
                    ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)}`
                    : isTorrent ? 'size pending' : formatBytes(item.downloadedBytes)}
                </span>
                <span>{formatSpeed(item.speed)}</span>
                {isTorrent && <span title="Upload speed">↑ {formatSpeed(item.uploadSpeed ?? 0)}</span>}
                <span>ETA {formatEta(item.eta)}</span>
                <span>{item.progress.toFixed(1)}%</span>
                {isTorrent && <SwarmHealth item={item} />}
                {isTorrent && (item.ratio ?? 0) > 0 && <span title="Share ratio">ratio {(item.ratio ?? 0).toFixed(2)}</span>}
              </>
            )}
            {isSeeding && (
              <>
                <span className="text-success">Seeding</span>
                <span>↑ {formatSpeed(item.uploadSpeed ?? 0)}</span>
                <span>{item.peers ?? 0} peers</span>
                <span>ratio {(item.ratio ?? 0).toFixed(2)}</span>
                {item.uploadedBytes !== undefined && <span>{formatBytes(item.uploadedBytes)} uploaded</span>}
              </>
            )}
            {isPaused && (
              <span>
                {sizeKnown
                  ? `${formatBytes(item.downloadedBytes)} / ${formatBytes(item.totalBytes)} · ${item.progress.toFixed(1)}%`
                  : `${formatBytes(item.downloadedBytes)} · size pending`}
              </span>
            )}
            {isQueued && (heldUntil
              ? <span className="text-warning">Held for quiet hours · until {heldUntil}</span>
              : <span>Waiting for a slot</span>)}
          </div>

          {isFailed && item.error && (
            <FailureNote error={item.error} onRetry={() => onRetry(item.id)} />
          )}

          {/* Multi-file torrent breakdown (quick glance; the detail panel has the full tree) */}
          {isTorrent && files.length > 1 && (isActive || isSeeding || isPaused) && (
            <div className="mt-1.5">
              <button
                onClick={() => setShowFiles(v => !v)}
                className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
              >
                {showFiles ? '▾' : '▸'} {files.length} files
              </button>
              {showFiles && (
                <div className="mt-1 space-y-0.5">
                  {files.map((f, i) => {
                    // Selection is editable mid-download (uTorrent-style skip):
                    // absent selectedFiles means "all files".
                    const fileSelected = item.settings.selectedFiles?.includes(i) ?? true;
                    const canEdit = !!onUpdateFiles && (isActive || isPaused);
                    return (
                      <div key={i} className="flex items-center gap-2 text-[11px] text-muted-foreground tabular-nums">
                        {canEdit && (
                          <input
                            type="checkbox"
                            checked={fileSelected}
                            aria-label={`Download ${f.name.split('/').pop()}`}
                            className="w-3 h-3 accent-primary shrink-0 cursor-pointer"
                            onChange={() => {
                              const current = item.settings.selectedFiles ?? files.map((_, idx) => idx);
                              const next = fileSelected
                                ? current.filter(x => x !== i)
                                : [...current, i].sort((a, b) => a - b);
                              if (next.length === 0) {
                                toast.error('At least one file must stay selected');
                                return;
                              }
                              onUpdateFiles(item.id, next);
                            }}
                          />
                        )}
                        <span className={cn('truncate flex-1', !fileSelected && 'line-through opacity-50')} title={f.name}>
                          {f.name.split('/').pop()}
                        </span>
                        <span>{formatBytes(f.size)}</span>
                        <span className="w-9 text-right">{fileSelected ? `${f.progress.toFixed(0)}%` : '—'}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {onOpenDetails && (
            <ActionButton icon={Info} onClick={() => onOpenDetails(item.id)} tooltip="Details" />
          )}
          <ActionButton
            icon={Link}
            onClick={copyLink}
            tooltip={isTorrent ? 'Copy magnet link' : 'Copy source link'}
          />
          {isTorrent && isLive && onReannounce && (
            <ActionButton icon={RefreshCw} onClick={() => onReannounce(item.id)} tooltip="Update tracker" />
          )}
          {isLive && (
            <ActionButton icon={Pause} onClick={() => onPause(item.id)} tooltip="Pause" />
          )}
          {isPaused && (
            <ActionButton icon={Play} onClick={() => onResume(item.id)} tooltip="Resume" />
          )}
          {(isActive || isPaused || isSeeding || isQueued) && (
            <ActionButton icon={X} onClick={() => onCancel(item.id)} tooltip={isSeeding ? 'Stop seeding' : 'Cancel'} />
          )}
          {(isTerminal || isFailed) && (
            <ActionButton icon={Trash2} onClick={() => onRemove(item.id)} tooltip="Remove" />
          )}
        </div>
      </div>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        {onOpenDetails && <ContextMenuItem onSelect={() => onOpenDetails(item.id)}><Info className="w-3.5 h-3.5 mr-2" />Details</ContextMenuItem>}
        {isLive && <ContextMenuItem onSelect={() => onPause(item.id)}><Pause className="w-3.5 h-3.5 mr-2" />Pause</ContextMenuItem>}
        {isPaused && <ContextMenuItem onSelect={() => onResume(item.id)}><Play className="w-3.5 h-3.5 mr-2" />Resume</ContextMenuItem>}
        {isFailed && <ContextMenuItem onSelect={() => onRetry(item.id)}><RotateCcw className="w-3.5 h-3.5 mr-2" />Retry</ContextMenuItem>}
        {isTorrent && isLive && onReannounce && (
          <ContextMenuItem onSelect={() => onReannounce(item.id)}><RefreshCw className="w-3.5 h-3.5 mr-2" />Update tracker</ContextMenuItem>
        )}
        {isTorrent && (isLive || isPaused) && onRecheck && (
          <ContextMenuItem onSelect={() => onRecheck(item.id)}><ShieldCheck className="w-3.5 h-3.5 mr-2" />Force re-check</ContextMenuItem>
        )}
        {(onMoveTop || onMoveBottom) && <ContextMenuSeparator />}
        {onMoveTop && <ContextMenuItem disabled={index === 0} onSelect={() => onMoveTop(item.id)}><ArrowUpToLine className="w-3.5 h-3.5 mr-2" />Move to top</ContextMenuItem>}
        {onMoveBottom && <ContextMenuItem disabled={index === count - 1} onSelect={() => onMoveBottom(item.id)}><ToBottom className="w-3.5 h-3.5 mr-2" />Move to bottom</ContextMenuItem>}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={copyLink}><Link className="w-3.5 h-3.5 mr-2" />{isTorrent ? 'Copy magnet link' : 'Copy source link'}</ContextMenuItem>
        {onShowInFolder && <ContextMenuItem onSelect={() => onShowInFolder(item.id)}><FolderOpen className="w-3.5 h-3.5 mr-2" />Show in folder</ContextMenuItem>}
        <ContextMenuSeparator />
        {(isActive || isPaused || isSeeding || isQueued) && (
          <ContextMenuItem onSelect={() => onCancel(item.id)}><X className="w-3.5 h-3.5 mr-2" />{isSeeding ? 'Stop seeding' : 'Cancel'}</ContextMenuItem>
        )}
        {(isTerminal || isFailed) && (
          <ContextMenuItem onSelect={() => onRemove(item.id)}><Trash2 className="w-3.5 h-3.5 mr-2" />Remove</ContextMenuItem>
        )}
        {isTorrent && onRemoveWithData && (
          <ContextMenuItem className="text-destructive focus:text-destructive" onSelect={() => onRemoveWithData(item.id)}>
            <Trash className="w-3.5 h-3.5 mr-2" />Remove and delete files…
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function KindBadge({ torrent }: { torrent: boolean }) {
  const Icon = torrent ? Magnet : Link;
  return (
    <span
      className="inline-flex items-center justify-center w-4 h-4 rounded bg-secondary/70 text-muted-foreground shrink-0"
      title={torrent ? 'BitTorrent' : 'Direct download'}
      aria-label={torrent ? 'BitTorrent' : 'Direct download'}
    >
      <Icon className="w-2.5 h-2.5" strokeWidth={2} />
    </span>
  );
}

/// Peer count with swarm-health context. 0 connected reads very differently
/// depending on whether the swarm has peers we just can't reach yet, and how
/// long it's been that way.
export function SwarmHealth({ item }: { item: DownloadItem }) {
  const peers = item.peers ?? 0;
  const seen = item.peersSeen ?? 0;
  const connecting = item.peersConnecting ?? 0;
  const peerless = item.peerlessSecs ?? 0;
  const since = peerless >= 60 ? ` · ${formatEta(peerless)}` : '';
  if (peers > 0) {
    return <span title={`${seen} peers discovered in the swarm`}>{peers} peers{seen > peers ? ` · ${seen} seen` : ''}</span>;
  }
  if (connecting > 0) {
    return <span className="text-primary/80">connecting to {connecting} peers…</span>;
  }
  if (seen > 0) {
    return <span className="text-warning" title="Peers exist but none are reachable — possible NAT/firewall issue">0 of {seen} peers reachable{since}</span>;
  }
  return (
    <span className="text-muted-foreground/70" title="Prism keeps announcing to trackers and the DHT every 5 minutes">
      searching for peers{since || '…'}
    </span>
  );
}

function ActionButton({ icon: Icon, onClick, tooltip }: { icon: React.ElementType; onClick: () => void; tooltip: string }) {
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          aria-label={tooltip}
          className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
        >
          <Icon className="w-3.5 h-3.5" strokeWidth={1.8} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-[11px]">{tooltip}</TooltipContent>
    </Tooltip>
  );
}
