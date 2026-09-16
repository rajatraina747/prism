import { useMemo } from 'react';
import { useStats } from '@/stores/AppProvider';
import { Panel } from '@/components/common';
import { formatBytes } from '@/services';
import { topBy, recentDays, engineTotals, type StatsEngine } from '@/stores/stats';
import { CheckCircle2, XCircle, Ban, HardDrive, ArrowUpFromLine } from 'lucide-react';

// Charts are drawn by hand, the way the player's speed graph is: a handful of
// bars doesn't justify a charting library, and these stay in step with the
// app's own colours for free.

const ENGINE_LABELS: Record<StatsEngine, string> = {
  ytdlp: 'Video sites',
  torrent: 'Torrents',
  direct: 'Direct files',
};

function when(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

function Tile({ icon: Icon, label, value, hint }: {
  icon: React.ElementType;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-secondary/30 border border-border/20">
      <Icon className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-sm font-medium text-foreground tabular-nums">{value}</p>
        {hint && <p className="text-[10px] text-muted-foreground/80 mt-0.5">{hint}</p>}
      </div>
    </div>
  );
}

/** Horizontal bars, widest first. Values are bytes; the count rides along. */
function BarList({ rows, empty }: {
  rows: { key: string; items: number; bytes: number }[];
  empty: string;
}) {
  const max = Math.max(1, ...rows.map(r => r.bytes));
  if (rows.length === 0) return <p className="text-[11px] text-muted-foreground px-1 py-2">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map(row => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-[11px]">
            <span className="text-foreground truncate" title={row.key}>{row.key}</span>
            <span className="text-muted-foreground tabular-nums shrink-0">
              {formatBytes(row.bytes)} · {row.items}
            </span>
          </div>
          <div className="mt-0.5 h-1.5 rounded-full bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-primary/70"
              style={{ width: `${Math.max(2, (row.bytes / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

export default function Statistics() {
  const { stats } = useStats();
  const days = useMemo(() => recentDays(stats, 30), [stats]);
  const sites = useMemo(() => topBy(stats.bySite), [stats]);
  const categories = useMemo(() => topBy(stats.byCategory), [stats]);
  const engines = useMemo(() => engineTotals(stats), [stats]);

  const busiest = Math.max(1, ...days.map(d => d.bytes));
  const finished = stats.completed + stats.failed + stats.canceled;

  return (
    <div className="page-container max-w-3xl mx-auto">
      <div className="page-header">
        <h2 className="page-title">Statistics</h2>
        <p className="page-subtitle">
          {finished === 0
            ? 'Nothing has finished downloading yet.'
            : `Everything Prism has finished since ${when(stats.since)}.`}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <Tile icon={HardDrive} label="Downloaded" value={formatBytes(stats.bytes)} />
        <Tile icon={CheckCircle2} label="Completed" value={stats.completed.toLocaleString()} />
        <Tile icon={XCircle} label="Failed" value={stats.failed.toLocaleString()} />
        <Tile icon={Ban} label="Canceled" value={stats.canceled.toLocaleString()} />
      </div>

      {/* Upload is a torrent figure, and only ever counted live — nothing in
          history records it, so it can't be backfilled. Saying so beats
          showing a number that looks like a lifetime total and isn't. */}
      {stats.uploadedSince && (
        <div className="mb-4">
          <Tile
            icon={ArrowUpFromLine}
            label="Uploaded (torrents)"
            value={formatBytes(stats.uploadedBytes)}
            hint={`Counted from ${when(stats.uploadedSince)} — earlier uploads weren't recorded`}
          />
        </div>
      )}

      <Panel className="mb-4">
        <h3 className="text-xs font-semibold text-foreground mb-2">Last 30 days</h3>
        {stats.bytes === 0 ? (
          <p className="text-[11px] text-muted-foreground">Finished downloads will show up here.</p>
        ) : (
          <>
            <div className="flex items-end gap-[2px] h-24" role="img" aria-label="Bytes downloaded per day over the last 30 days">
              {days.map(d => (
                <div
                  key={d.day}
                  title={`${d.day}: ${formatBytes(d.bytes)} · ${d.items} item${d.items === 1 ? '' : 's'}`}
                  className="flex-1 rounded-t bg-primary/60 hover:bg-primary transition-colors"
                  style={{ height: `${Math.max(d.bytes > 0 ? 4 : 1, (d.bytes / busiest) * 100)}%` }}
                />
              ))}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>{days[0]?.day}</span>
              <span>{days[days.length - 1]?.day}</span>
            </div>
          </>
        )}
      </Panel>

      <div className="grid md:grid-cols-2 gap-3">
        <Panel>
          <h3 className="text-xs font-semibold text-foreground mb-2">By engine</h3>
          <BarList
            rows={engines
              .filter(e => e.items > 0)
              .map(e => ({ key: ENGINE_LABELS[e.engine], items: e.items, bytes: e.bytes }))}
            empty="Nothing finished yet."
          />
        </Panel>

        <Panel>
          <h3 className="text-xs font-semibold text-foreground mb-2">By site</h3>
          <BarList rows={sites} empty="Sites appear once downloads finish." />
        </Panel>
      </div>

      {categories.length > 0 && (
        <Panel className="mt-3">
          <h3 className="text-xs font-semibold text-foreground mb-2">By category</h3>
          <BarList rows={categories} empty="" />
        </Panel>
      )}

      <p className="text-[10px] text-muted-foreground mt-4 px-1">
        These counters are kept separately from the Library, which only remembers the most recent
        2,000 downloads — so the totals above reach further back than the list does.
      </p>
    </div>
  );
}
