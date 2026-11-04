import { useMemo, useState } from 'react';
import { useStats } from '@/stores/AppProvider';
import { Panel } from '@/components/common';
import { formatBytes } from '@/services';
import { topBy, engineTotals, periodTotals, chartBuckets, ACTIVITY_PERIODS, type StatsEngine, type ActivityPeriod } from '@/stores/stats';
import { ConfirmDialog } from '@/components/common';
import { cn } from '@/lib/utils';
import { CheckCircle2, XCircle, Ban, HardDrive, ArrowUpFromLine, ChevronRight, BarChart3 } from 'lucide-react';

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
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium text-foreground tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground/80 mt-0.5">{hint}</p>}
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
  if (rows.length === 0) return <p className="text-xs text-muted-foreground px-1 py-2">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map(row => (
        <li key={row.key}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
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

/** Lifetime download counters and the last 30 days, at the top of the
 * Library: the Statistics page until 2.6, whose four tiles and a chart
 * didn't need a sidebar slot. Collapsed to one line by default. */
export function ActivityPanel({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { stats, resetStats } = useStats();
  const [period, setPeriod] = useState<ActivityPeriod>(30);
  const [confirmReset, setConfirmReset] = useState(false);
  const days = useMemo(() => chartBuckets(stats, period), [stats, period]);
  const inPeriod = useMemo(() => periodTotals(stats, period), [stats, period]);
  const periodLabel = ACTIVITY_PERIODS.find(p => p.value === period)?.label ?? '';
  const sites = useMemo(() => topBy(stats.bySite), [stats]);
  const categories = useMemo(() => topBy(stats.byCategory), [stats]);
  const engines = useMemo(() => engineTotals(stats), [stats]);

  const busiest = Math.max(1, ...days.map(d => d.bytes));
  const finished = stats.completed + stats.failed + stats.canceled;

  const summary = finished === 0
    ? 'Nothing has finished downloading yet'
    : `${stats.completed.toLocaleString()} completed · ${formatBytes(stats.bytes)} since ${when(stats.since)}`;

  return (
    <section aria-label="Activity" className="mb-4 rounded-xl border border-border/30 bg-card/40">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <BarChart3 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="font-medium text-foreground">Activity</span>
        <span className="truncate tabular-nums">{summary}</span>
        <ChevronRight className={`w-3.5 h-3.5 ml-auto shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      {open && (
      <div className="px-3 pb-3">
      <div className="flex items-center gap-1 mb-3 flex-wrap" role="radiogroup" aria-label="Period">
        {ACTIVITY_PERIODS.map(p => (
          <button
            key={String(p.value)}
            type="button"
            role="radio"
            aria-checked={period === p.value}
            onClick={() => setPeriod(p.value)}
            className={cn(
              'px-2.5 py-1 rounded-lg text-xs font-medium transition-colors',
              period === p.value ? 'bg-primary/12 text-primary' : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
            )}
          >
            {p.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          className="ml-auto px-2.5 py-1 rounded-lg text-xs font-medium text-muted-foreground hover:bg-secondary hover:text-secondary-foreground transition-colors"
        >
          Reset statistics…
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
        <Tile icon={HardDrive} label={`Downloaded · ${periodLabel}`} value={formatBytes(inPeriod.bytes)} />
        <Tile icon={CheckCircle2} label={`Completed · ${periodLabel}`} value={inPeriod.items.toLocaleString()} />
        {/* Only completions are kept per day, so these two are lifetime figures. */}
        <Tile icon={XCircle} label="Failed · all time" value={stats.failed.toLocaleString()} />
        <Tile icon={Ban} label="Cancelled · all time" value={stats.canceled.toLocaleString()} />
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
        <h3 className="text-xs font-semibold text-foreground mb-2">{period === 'all' ? 'All time, by month' : period === 365 ? 'Last year, by month' : `Last ${periodLabel}`}</h3>
        {inPeriod.bytes === 0 ? (
          <p className="text-xs text-muted-foreground">Finished downloads will show up here.</p>
        ) : (
          <>
            <div className="flex items-end gap-[2px] h-24" role="img" aria-label={`Bytes downloaded, ${periodLabel}`}>
              {days.map(d => (
                <div
                  key={d.label}
                  title={`${d.label}: ${formatBytes(d.bytes)} · ${d.items} item${d.items === 1 ? '' : 's'}`}
                  className="flex-1 rounded-t bg-primary/60 hover:bg-primary transition-colors"
                  style={{ height: `${Math.max(d.bytes > 0 ? 4 : 1, (d.bytes / busiest) * 100)}%` }}
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-muted-foreground mt-1">
              <span>{days[0]?.label}</span>
              <span>{days[days.length - 1]?.label}</span>
            </div>
          </>
        )}
      </Panel>

      <div className="grid md:grid-cols-2 gap-3">
        <Panel>
          <h3 className="text-xs font-semibold text-foreground mb-2">By engine · all time</h3>
          <BarList
            rows={engines
              .filter(e => e.items > 0)
              .map(e => ({ key: ENGINE_LABELS[e.engine], items: e.items, bytes: e.bytes }))}
            empty="Nothing finished yet."
          />
        </Panel>

        <Panel>
          <h3 className="text-xs font-semibold text-foreground mb-2">By site · all time</h3>
          <BarList rows={sites} empty="Sites appear once downloads finish." />
        </Panel>
      </div>

      {categories.length > 0 && (
        <Panel className="mt-3">
          <h3 className="text-xs font-semibold text-foreground mb-2">By category · all time</h3>
          <BarList rows={categories} empty="" />
        </Panel>
      )}

      <p className="text-xs text-muted-foreground mt-4 px-1">
        These counters are kept separately from the Library, so removing entries from the Library
        doesn't change the totals above.
      </p>
      </div>
      )}
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset statistics?"
        description="Every counter starts again from zero today. Your Library and your files are not touched, and downloads already finished aren't counted again."
        confirmLabel="Reset"
        destructive
        onConfirm={() => { resetStats(); setConfirmReset(false); }}
      />
    </section>
  );
}
