import React from 'react';
import { toast } from 'sonner';
import { ArrowDownToLine, CheckCircle2, FolderOpen, Gauge, HardDrive, MonitorPlay, Play } from 'lucide-react';
import { Panel, Thumb } from '@/components/common';
import { useService } from '@/services/ServiceProvider';
import { formatBytes, formatSpeed } from '@/services';
import type { HistoryItem } from '@/types/models';
import { t } from '@/i18n';

function StatTile({ icon: Icon, value, label, delay }: { icon: React.ElementType; value: string; label: string; delay: number }) {
  return (
    <div
      className="glass-strong rounded-xl px-3.5 py-3 flex items-center gap-3 animate-fade-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
        <Icon className="w-4 h-4 text-primary" strokeWidth={1.8} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground tabular-nums truncate">{value}</p>
        <p className="text-xs text-muted-foreground truncate">{label}</p>
      </div>
    </div>
  );
}

/** The four numbers at the top of Downloads. */
export function StatTiles({ active, speed, completed, totalBytes }: {
  active: number;
  speed: number;
  completed: number;
  totalBytes: number;
}) {
  return (
    <div className="grid grid-cols-4 max-[699px]:grid-cols-2 gap-3 mb-4">
      <StatTile icon={ArrowDownToLine} value={String(active)} label={t('queue.home.active')} delay={40} />
      <StatTile icon={Gauge} value={speed > 0 ? formatSpeed(speed) : '—'} label={t('queue.home.currentSpeed')} delay={70} />
      <StatTile icon={CheckCircle2} value={String(completed)} label={t('queue.home.completed')} delay={100} />
      <StatTile icon={HardDrive} value={totalBytes > 0 ? formatBytes(totalBytes) : '—'} label={t('queue.home.totalDownloaded')} delay={130} />
    </div>
  );
}

const iconButton = 'p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]';

function playInPrism(path: string, title: string) {
  // Dynamic import keeps the Tauri window APIs out of the web-demo bundle path.
  import('@/lib/player-window')
    .then(({ openInPlayer }) => openInPlayer({ path, title }))
    .catch((e) => toast.error(t('library.page.playerFailed', { error: e instanceof Error ? e.message : String(e) })));
}

/** The last few finished downloads, so a quiet Downloads page still shows
 * something and what just finished is one click from playing. */
export function RecentDownloads({ items, playerAvailable }: { items: HistoryItem[]; playerAvailable: boolean }) {
  const service = useService();
  return (
    <Panel title={t('queue.home.recentDownloads')} className="mt-4 animate-fade-in">
      <div className="space-y-1">
        {items.map(item => (
          <div key={item.id} className="flex items-center gap-3 py-1.5 group">
            <Thumb
              src={item.metadata.thumbnail}
              className="w-16 h-9"
              fallbackIcon={<CheckCircle2 className="w-3.5 h-3.5 text-muted-foreground" />}
            />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-foreground truncate">{item.metadata.title}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {formatBytes(item.fileSize)} · {new Date(item.completedAt).toLocaleDateString()}
              </p>
            </div>
            {item.filePath && (
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                {playerAvailable ? (
                  <button type="button" onClick={() => playInPrism(item.filePath!, item.metadata.title)} title={t('queue.home.playInPrism')} aria-label={t('details.playInPrismLabel', { name: item.metadata.title })} className={iconButton}>
                    <MonitorPlay className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => service.openFile(item.filePath!).catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                    title={t('queue.home.play')}
                    aria-label={t('queue.home.playLabel', { name: item.metadata.title })}
                    className={iconButton}
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => service.showInFolder(item.filePath!).catch(() => toast.error(t('library.page.fileNotFound')))}
                  title={t('queue.home.showInFolder')}
                  aria-label={t('details.showLabel', { name: item.metadata.title })}
                  className={iconButton}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
