import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { DownloadItem, DownloadCategory, TorrentDetails, TorrentPeer } from '@/types/models';
import { useService } from '@/services/ServiceProvider';
import { useSettings } from '@/stores/AppProvider';
import { formatBytes, formatSpeed, formatEta } from '@/services/utils';
import { PiecesBar } from '@/components/queue/PiecesBar';
import { ProgressBar } from '@/components/common';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { X, RefreshCw, FolderOpen, Play, MonitorPlay, Folder, ChevronRight } from 'lucide-react';

export interface DetailPanelProps {
  item: DownloadItem | null;
  height: number;
  onHeightChange: (h: number) => void;
  onClose: () => void;
  onUpdateFiles?: (id: string, onlyFiles: number[]) => void;
  onReannounce?: (id: string) => void;
  onSetCategory?: (id: string, category: DownloadCategory | null) => void;
  onSetLabels?: (id: string, labelIds: string[]) => void;
  playerAvailable?: boolean;
}

const MIN_H = 160;
const MAX_H = 600;
type Tab = 'general' | 'files' | 'peers' | 'trackers' | 'speed';

/**
 * qBittorrent-style detail panel under the transfers list. Tabs poll only
 * while visible (peers every 2 s, details once per item), and the speed
 * graph keeps its own 60-sample ring buffer per item.
 */
export function DetailPanel({ item, height, onHeightChange, onClose, onUpdateFiles, onReannounce, onSetCategory, onSetLabels, playerAvailable }: DetailPanelProps) {
  const [tab, setTab] = React.useState<Tab>('general');
  const isTorrent = item?.kind === 'torrent';
  React.useEffect(() => {
    if (!isTorrent && (tab === 'files' || tab === 'peers' || tab === 'trackers')) setTab('general');
  }, [isTorrent, tab]);

  // Drag-to-resize from the top edge.
  const dragging = React.useRef<{ startY: number; startH: number } | null>(null);
  const onHandleDown = (e: React.MouseEvent) => {
    dragging.current = { startY: e.clientY, startH: height };
    const move = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const next = Math.min(MAX_H, Math.max(MIN_H, dragging.current.startH + (dragging.current.startY - ev.clientY)));
      onHeightChange(next);
    };
    const up = () => {
      dragging.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  };

  if (!item) return null;

  return (
    <section
      aria-label="Transfer details"
      className="mt-3 glass-strong rounded-xl flex flex-col animate-fade-in"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize details panel"
        onMouseDown={onHandleDown}
        className="h-2 -mt-1 cursor-row-resize flex items-center justify-center group"
      >
        <div className="w-10 h-0.5 rounded-full bg-border group-hover:bg-primary/60 transition-colors" />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="flex-1 min-h-0 flex flex-col px-3 pb-3">
        <div className="flex items-center gap-2">
          <TabsList className="h-8">
            <TabsTrigger value="general" className="text-[11px] h-6">General</TabsTrigger>
            {isTorrent && <TabsTrigger value="files" className="text-[11px] h-6">Files</TabsTrigger>}
            {isTorrent && <TabsTrigger value="peers" className="text-[11px] h-6">Peers</TabsTrigger>}
            {isTorrent && <TabsTrigger value="trackers" className="text-[11px] h-6">Trackers</TabsTrigger>}
            <TabsTrigger value="speed" className="text-[11px] h-6">Speed</TabsTrigger>
          </TabsList>
          <span className="text-xs text-foreground truncate flex-1 min-w-0" title={item.metadata.title}>{item.metadata.title}</span>
          <button onClick={onClose} aria-label="Close details" className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <TabsContent value="general" className="flex-1 min-h-0 mt-2"><GeneralTab item={item} onReannounce={onReannounce} onSetCategory={onSetCategory} onSetLabels={onSetLabels} /></TabsContent>
        {isTorrent && <TabsContent value="files" className="flex-1 min-h-0 mt-2"><FilesTab item={item} onUpdateFiles={onUpdateFiles} playerAvailable={playerAvailable} /></TabsContent>}
        {isTorrent && <TabsContent value="peers" className="flex-1 min-h-0 mt-2"><PeersTab item={item} active={tab === 'peers'} /></TabsContent>}
        {isTorrent && <TabsContent value="trackers" className="flex-1 min-h-0 mt-2"><TrackersTab item={item} onReannounce={onReannounce} /></TabsContent>}
        <TabsContent value="speed" className="flex-1 min-h-0 mt-2"><SpeedTab item={item} /></TabsContent>
      </Tabs>
    </section>
  );
}

// ── General ─────────────────────────────────────────────────────────────

function useDetails(item: DownloadItem): TorrentDetails | null {
  const service = useService();
  const [details, setDetails] = React.useState<TorrentDetails | null>(null);
  const live = item.kind === 'torrent' && (item.status === 'downloading' || item.status === 'seeding' || item.status === 'paused');
  React.useEffect(() => {
    if (!live) { setDetails(null); return; }
    let cancelled = false;
    const load = () => service.getTorrentDetails(item.id).then(d => { if (!cancelled) setDetails(d); }).catch(() => {});
    load();
    // Metadata resolves later for magnets — poll slowly until we have it.
    const t = setInterval(() => { if (!details || details.totalBytes === 0) load(); }, 5000);
    return () => { cancelled = true; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, item.id, live]);
  return details;
}

function Row({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-[11px] py-0.5">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className={cn('text-foreground min-w-0 truncate', mono && 'font-mono')}>{children}</span>
    </div>
  );
}

function GeneralTab({ item, onReannounce, onSetCategory, onSetLabels }: {
  item: DownloadItem;
  onReannounce?: (id: string) => void;
  onSetCategory?: (id: string, category: DownloadCategory | null) => void;
  onSetLabels?: (id: string, labelIds: string[]) => void;
}) {
  const service = useService();
  const { preferences } = useSettings();
  const details = useDetails(item);
  // A category the item was filed under and that has since been deleted still
  // labels it — keep it in the list so picking something else is a choice, not
  // a side effect of opening the menu.
  const filedUnderMissing = !!item.settings.categoryId
    && !preferences.categories.some(c => c.id === item.settings.categoryId);
  const isTorrent = item.kind === 'torrent';
  const dest = item.settings.destination || '~/Downloads/Prism';
  const when = (iso?: string) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  return (
    <ScrollArea className="h-full pr-2">
      {isTorrent && item.pieces && item.pieces.length > 0 && (
        <div className="mb-2">
          <PiecesBar pieces={item.pieces} height="h-2.5" />
          <p className="text-[10px] text-muted-foreground mt-1">Pieces on disk{details ? ` · ${details.totalPieces.toLocaleString()} × ${formatBytes(details.pieceLength)}` : ''}</p>
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6">
        <div>
          <Row label="Status">{item.status}{item.stage === 'processing' ? ' · processing' : ''}</Row>
          <Row label="Size">{item.totalBytes > 0 ? formatBytes(item.totalBytes) : isTorrent ? 'pending (resolving metadata)' : '—'}</Row>
          <Row label="Downloaded">{formatBytes(item.downloadedBytes)} ({item.progress.toFixed(1)}%)</Row>
          {isTorrent && <Row label="Uploaded">{formatBytes(item.uploadedBytes ?? 0)} · ratio {(item.ratio ?? 0).toFixed(2)}</Row>}
          <Row label="Speed">↓ {formatSpeed(item.speed)}{isTorrent ? ` · ↑ ${formatSpeed(item.uploadSpeed ?? 0)}` : ''}</Row>
          <Row label="ETA">{formatEta(item.eta)}</Row>
          {isTorrent && <Row label="Peers">{item.peers ?? 0} connected · {item.peersSeen ?? 0} seen{(item.peerlessSecs ?? 0) >= 60 ? ` · peerless for ${formatEta(item.peerlessSecs ?? 0)}` : ''}</Row>}
        </div>
        <div>
          <Row label="Save path">
            <button
              className="hover:text-primary transition-colors inline-flex items-center gap-1 max-w-full"
              onClick={() => service.showInFolder(item.filePath ?? dest).catch((e) => toast.error(String(e)))}
              title="Show in folder"
            >
              <FolderOpen className="w-3 h-3 shrink-0" /><span className="truncate">{dest}</span>
            </button>
          </Row>
          {onSetCategory && (
            <Row label="Category">
              <select
                value={item.settings.categoryId ?? ''}
                onChange={(e) => onSetCategory(item.id, preferences.categories.find(c => c.id === e.target.value) ?? null)}
                aria-label="Category"
                className="bg-input border border-border/40 rounded-md px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary/50 max-w-[180px]"
              >
                <option value="">None</option>
                {preferences.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                {filedUnderMissing && (
                  <option value={item.settings.categoryId}>{item.settings.categoryName ?? 'Deleted category'}</option>
                )}
              </select>
              {item.status === 'queued' ? '' : ' · label only while it runs'}
            </Row>
          )}
          <Row label="Added">{when(item.addedAt)}</Row>
          <Row label="Started">{when(item.startedAt)}</Row>
          {isTorrent && details && <Row label="Info hash" mono>{details.infoHash}</Row>}
          {isTorrent && details && <Row label="Files">{details.fileCount} · {details.private ? 'private torrent' : 'public (DHT/PEX allowed)'}</Row>}
          {!isTorrent && <Row label="Source">{item.metadata.source.domain}</Row>}
          {!isTorrent && item.settings.format && <Row label="Format">{item.settings.format.resolution} · {item.settings.format.container.toUpperCase()}</Row>}
          {isTorrent && onReannounce && (item.status === 'downloading' || item.status === 'seeding') && (
            <button onClick={() => onReannounce(item.id)} className="mt-1 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-[11px] text-secondary-foreground hover:bg-secondary/80 transition-colors">
              <RefreshCw className="w-3 h-3" /> Update tracker
            </button>
          )}
        </div>
      </div>
      {onSetLabels && preferences.labels.length > 0 && (
        <div className="flex items-baseline gap-3 mt-2 pt-2 border-t border-border/20">
          <span className="w-28 shrink-0 text-[11px] text-muted-foreground">Labels</span>
          <span className="flex flex-wrap gap-1">
            {preferences.labels.map(label => {
              const on = item.settings.labelIds?.includes(label.id) ?? false;
              return (
                <button
                  key={label.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => {
                    const current = item.settings.labelIds ?? [];
                    onSetLabels(item.id, on ? current.filter(x => x !== label.id) : [...current, label.id]);
                  }}
                  className={cn(
                    'px-1.5 py-0.5 rounded-md text-[10px] border transition-colors',
                    on
                      ? 'bg-primary/15 border-primary/40 text-primary'
                      : 'bg-input border-border/40 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label.name || 'Unnamed'}
                </button>
              );
            })}
          </span>
        </div>
      )}
    </ScrollArea>
  );
}

// ── Files ───────────────────────────────────────────────────────────────

interface FileNode { index: number; name: string; size: number; progress: number }
interface FolderNode { path: string; files: FileNode[]; size: number; done: number }

function groupByFolder(files: FileNode[]): FolderNode[] {
  const map = new Map<string, FolderNode>();
  for (const f of files) {
    const parts = f.name.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const node = map.get(dir) ?? { path: dir, files: [], size: 0, done: 0 };
    node.files.push(f);
    node.size += f.size;
    node.done += f.size * (f.progress / 100);
    map.set(dir, node);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function FilesTab({ item, onUpdateFiles, playerAvailable }: { item: DownloadItem; onUpdateFiles?: (id: string, onlyFiles: number[]) => void; playerAvailable?: boolean }) {
  const service = useService();
  const files: FileNode[] = (item.files ?? []).map((f, index) => ({ index, ...f }));
  const [collapsed, setCollapsed] = React.useState<Set<string>>(new Set());
  if (files.length === 0) {
    return <p className="text-[11px] text-muted-foreground px-1">File list appears once the torrent's metadata has been fetched from peers.</p>;
  }
  const canEdit = !!onUpdateFiles && (item.status === 'downloading' || item.status === 'paused');
  const dest = (item.settings.destination || '~/Downloads/Prism').replace(/\/+$/, '');
  const folders = groupByFolder(files);
  const selectedSet = item.settings.selectedFiles;
  const isSelected = (i: number) => selectedSet?.includes(i) ?? true;
  const toggle = (i: number) => {
    const current = selectedSet ?? files.map(f => f.index);
    const next = isSelected(i) ? current.filter(x => x !== i) : [...current, i].sort((a, b) => a - b);
    if (next.length === 0) { toast.error('At least one file must stay selected'); return; }
    onUpdateFiles?.(item.id, next);
  };
  const errToast = (e: unknown) => toast.error(e instanceof Error ? e.message : String(e));

  return (
    <ScrollArea className="h-full pr-2">
      <div className="space-y-1">
        {folders.map(folder => {
          const isCollapsed = collapsed.has(folder.path);
          return (
            <div key={folder.path || '(root)'}>
              {folder.path && (
                <button
                  onClick={() => setCollapsed(s => { const n = new Set(s); if (n.has(folder.path)) n.delete(folder.path); else n.add(folder.path); return n; })}
                  className="w-full flex items-center gap-1.5 text-[11px] text-foreground py-0.5 hover:text-primary transition-colors"
                  aria-expanded={!isCollapsed}
                >
                  <ChevronRight className={cn('w-3 h-3 transition-transform', !isCollapsed && 'rotate-90')} />
                  <Folder className="w-3 h-3 text-muted-foreground" />
                  <span className="truncate">{folder.path}</span>
                  <span className="ml-auto text-muted-foreground tabular-nums">{formatBytes(folder.size)} · {folder.size > 0 ? Math.round((folder.done / folder.size) * 100) : 100}%</span>
                </button>
              )}
              {!isCollapsed && folder.files.map(f => {
                const sel = isSelected(f.index);
                const base = f.name.split('/').pop() ?? f.name;
                const full = `${dest}/${f.name}`;
                const complete = f.progress >= 100;
                return (
                  <div key={f.index} className={cn('flex items-center gap-2 text-[11px] py-0.5 tabular-nums', folder.path && 'pl-6')}>
                    {canEdit ? (
                      <input type="checkbox" checked={sel} onChange={() => toggle(f.index)} aria-label={`Download ${base}`} className="w-3 h-3 accent-primary shrink-0 cursor-pointer" />
                    ) : <span className="w-3" />}
                    <span className={cn('truncate flex-1 text-foreground', !sel && 'line-through opacity-50')} title={f.name}>{base}</span>
                    <span className="w-16 text-right text-muted-foreground">{formatBytes(f.size)}</span>
                    <div className="w-24"><ProgressBar value={sel ? f.progress : 0} /></div>
                    <span className="w-9 text-right text-muted-foreground">{sel ? `${f.progress.toFixed(0)}%` : '—'}</span>
                    <span className="flex items-center gap-0.5 w-16 justify-end">
                      {complete && playerAvailable && (
                        <button title="Play in Prism" aria-label={`Play ${base} in Prism`} className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground"
                          onClick={() => import('@/lib/player-window').then(({ openInPlayer }) => openInPlayer({ path: full, title: base })).catch(errToast)}>
                          <MonitorPlay className="w-3 h-3" />
                        </button>
                      )}
                      {complete && (
                        <button title="Open" aria-label={`Open ${base}`} className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground" onClick={() => service.openFile(full).catch(errToast)}>
                          <Play className="w-3 h-3" />
                        </button>
                      )}
                      <button title="Show in folder" aria-label={`Show ${base} in folder`} className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground" onClick={() => service.showInFolder(complete ? full : dest).catch(errToast)}>
                        <FolderOpen className="w-3 h-3" />
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── Peers ───────────────────────────────────────────────────────────────

function PeersTab({ item, active }: { item: DownloadItem; active: boolean }) {
  const service = useService();
  const [peers, setPeers] = React.useState<TorrentPeer[] | null>(null);
  const live = item.status === 'downloading' || item.status === 'seeding';
  React.useEffect(() => {
    if (!active || !live) return;
    let cancelled = false;
    const poll = () => service.getTorrentPeers(item.id).then(p => { if (!cancelled) setPeers(p); }).catch(() => { if (!cancelled) setPeers([]); });
    poll();
    const t = setInterval(poll, 2000);
    return () => { cancelled = true; clearInterval(t); };
  }, [service, item.id, active, live]);

  if (!live) return <p className="text-[11px] text-muted-foreground px-1">Peers are listed while the torrent is downloading or seeding.</p>;
  if (peers === null) return <p className="text-[11px] text-muted-foreground px-1">Loading peers…</p>;
  if (peers.length === 0) {
    return (
      <p className="text-[11px] text-muted-foreground px-1">
        No peers yet. Prism is asking the trackers, the DHT and the local network every few minutes — low-seed torrents can sit here for a while and still complete.
      </p>
    );
  }
  const liveCount = peers.filter(p => p.state === 'live').length;
  return (
    <ScrollArea className="h-full pr-2">
      <table className="w-full text-[11px] tabular-nums">
        <thead className="text-muted-foreground">
          <tr className="text-left">
            <th className="font-medium py-1 pr-2">Address</th>
            <th className="font-medium py-1 pr-2">Client</th>
            <th className="font-medium py-1 pr-2">Via</th>
            <th className="font-medium py-1 pr-2">State</th>
            <th className="font-medium py-1 pr-2 text-right">↓ speed</th>
            <th className="font-medium py-1 pr-2 text-right">↑ speed</th>
            <th className="font-medium py-1 pr-2 text-right">Downloaded</th>
            <th className="font-medium py-1 text-right">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {peers.map(p => (
            <tr key={p.addr} className={cn('border-t border-border/20', p.state !== 'live' && 'opacity-60')}>
              <td className="py-1 pr-2 font-mono text-foreground">{p.addr}</td>
              <td className="py-1 pr-2 truncate max-w-[160px]" title={p.client ?? undefined}>{p.client ?? '—'}</td>
              <td className="py-1 pr-2">{p.kind}</td>
              <td className="py-1 pr-2">{p.state}{p.errors > 0 ? ` (${p.errors} err)` : ''}</td>
              <td className="py-1 pr-2 text-right">{formatSpeed(p.downBps)}</td>
              <td className="py-1 pr-2 text-right">{formatSpeed(p.upBps)}</td>
              <td className="py-1 pr-2 text-right">{formatBytes(p.downloaded)}</td>
              <td className="py-1 text-right">{formatBytes(p.uploaded)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-[10px] text-muted-foreground mt-2">{liveCount} connected · {peers.length - liveCount} connecting/other. Per-peer progress and flags aren't reported by the engine.</p>
    </ScrollArea>
  );
}

// ── Trackers ────────────────────────────────────────────────────────────

function TrackersTab({ item, onReannounce }: { item: DownloadItem; onReannounce?: (id: string) => void }) {
  const details = useDetails(item);
  const navigate = useNavigate();
  const { preferences } = useSettings();
  const extra = preferences.extraTrackers.split(/[\n,]/).map(s => s.trim()).filter(Boolean);
  const live = item.status === 'downloading' || item.status === 'seeding';
  return (
    <ScrollArea className="h-full pr-2">
      <div className="flex items-center gap-2 mb-2">
        {onReannounce && (
          <button disabled={!live} onClick={() => onReannounce(item.id)} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-secondary text-[11px] text-secondary-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50">
            <RefreshCw className="w-3 h-3" /> Update tracker
          </button>
        )}
        <button onClick={() => navigate('/settings')} className="text-[11px] text-muted-foreground hover:text-foreground transition-colors">Add trackers in Settings →</button>
      </div>
      {details ? (
        details.trackers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">No trackers in this torrent — peers come from DHT, PEX and the local network only.</p>
        ) : (
          <ul className="space-y-0.5">
            {details.trackers.map(t => (
              <li key={t} className="text-[11px] font-mono text-foreground truncate" title={t}>{t}</li>
            ))}
          </ul>
        )
      ) : (
        <p className="text-[11px] text-muted-foreground">Tracker list appears once the torrent is active.</p>
      )}
      {extra.length > 0 && (
        <div className="mt-3">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Added to every torrent (Settings)</p>
          <ul className="space-y-0.5">{extra.map(t => <li key={t} className="text-[11px] font-mono text-muted-foreground truncate" title={t}>{t}</li>)}</ul>
        </div>
      )}
      <p className="text-[10px] text-muted-foreground mt-3">
        Prism announces to every tracker on start and re-announces automatically every 5 minutes while no peers are connected. Per-tracker status (last announce, seeders/leechers) isn't reported by the engine.
      </p>
    </ScrollArea>
  );
}

// ── Speed ───────────────────────────────────────────────────────────────

const SAMPLES = 60;

function SpeedTab({ item }: { item: DownloadItem }) {
  const ring = React.useRef<{ id: string; down: number[]; up: number[] }>({ id: item.id, down: [], up: [] });
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (ring.current.id !== item.id) ring.current = { id: item.id, down: [], up: [] };
    const r = ring.current;
    r.down.push(item.speed || 0);
    r.up.push(item.uploadSpeed || 0);
    if (r.down.length > SAMPLES) r.down.shift();
    if (r.up.length > SAMPLES) r.up.shift();
    force();
  }, [item.id, item.speed, item.uploadSpeed, item.progress]);

  const { down, up } = ring.current;
  const max = Math.max(1, ...down, ...up);
  const W = 600, H = 80;
  const path = (xs: number[]) => xs.map((v, i) => `${(i / (SAMPLES - 1)) * W},${H - (v / max) * (H - 4) - 2}`).join(' ');
  const padLeft = (xs: number[]) => [...Array(SAMPLES - xs.length).fill(0), ...xs];
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground mb-1">
        <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-primary inline-block" /> ↓ {formatSpeed(item.speed || 0)}</span>
        {item.kind === 'torrent' && <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success inline-block" /> ↑ {formatSpeed(item.uploadSpeed || 0)}</span>}
        <span className="ml-auto">peak {formatSpeed(max)} · last {SAMPLES} s</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flex-1 w-full min-h-0 rounded-lg bg-secondary/40" role="img" aria-label="Transfer speed over the last minute">
        <polyline fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" points={path(padLeft(down))} vectorEffect="non-scaling-stroke" />
        {item.kind === 'torrent' && <polyline fill="none" stroke="hsl(var(--success))" strokeWidth="1.5" points={path(padLeft(up))} vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}
