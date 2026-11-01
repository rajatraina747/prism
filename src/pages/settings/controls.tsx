import React from 'react';
import type { StorageSummary } from '@/services/types';
import { CommitInput } from '@/components/common';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { ChevronRight, ChevronDown, HelpCircle } from 'lucide-react';


// ── Accessible setting rows ──
// Every control inside a SettingRow is labelled by the row's label and
// described by its description, so assistive tech announces "Listen port,
// 4240, Incoming peer connections use this port" instead of "4240".

const RowIds = React.createContext<{ labelId: string; descId?: string } | null>(null);

function useRowA11y() {
  const ids = React.useContext(RowIds);
  return ids ? { 'aria-labelledby': ids.labelId, 'aria-describedby': ids.descId } : {};
}

/** A small (?) that explains a term of art in place. */
export function HelpTip({ term, text }: { term: string; text: string }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${term}?`}
          className="inline-flex text-muted-foreground/60 hover:text-muted-foreground focus-visible:text-foreground transition-colors"
        >
          <HelpCircle className="w-3 h-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

/** Bring torrents over from qBittorrent or Transmission (client_import.rs). */
export function SettingRow({ label, description, help, children }: {
  label: string;
  description?: string;
  /** [term, explanation] for jargon in the label. */
  help?: [string, string];
  children: React.ReactNode;
}) {
  const id = React.useId();
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className="flex items-center justify-between py-2.5 min-h-[40px]">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <span id={labelId}>{label}</span>
          {help && <HelpTip term={help[0]} text={help[1]} />}
        </p>
        {description && <p id={descId} className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">
        <RowIds.Provider value={{ labelId, descId }}>{children}</RowIds.Provider>
      </div>
    </div>
  );
}

export function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="pt-3 first:pt-0">
      <h3 className="panel-header mb-1">{title}</h3>
      <div className="divide-y divide-border/30">{children}</div>
    </section>
  );
}

/** Progressive disclosure for settings most people never need. */
export function Advanced({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="pt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {open ? 'Hide advanced settings' : 'Show advanced settings'}
      </button>
      {open && <div id={id} className="mt-1">{children}</div>}
    </div>
  );
}

export function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const a11y = useRowA11y();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...a11y}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors duration-200 active:scale-[0.95]',
        checked ? 'bg-primary' : 'bg-muted'
      )}
    >
      <div className={cn(
        'absolute top-0.5 w-4 h-4 rounded-full bg-foreground transition-transform duration-200',
        checked ? 'translate-x-4' : 'translate-x-0.5'
      )} />
    </button>
  );
}

/** What the download folder is holding, above the setting that chooses it.
 *
 * The loader is passed in rather than the service: this sits outside the
 * Settings component, so reaching for a `service` from here would bind to
 * something that isn't in scope. */
export function StorageTile({ folder, load }: { folder: string; load: () => Promise<StorageSummary> }) {
  const [summary, setSummary] = React.useState<StorageSummary | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setFailed(false);
    load()
      .then(s => { if (!cancelled) setSummary(s); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // `load` closes over the folder, which is the only thing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  const size = (bytes: number) => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  };

  return (
    <div className="mb-3 px-3 py-2.5 rounded-xl bg-secondary/30 border border-border/20">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11px] text-muted-foreground">In this folder</span>
        {failed ? (
          <span className="text-[11px] text-muted-foreground">Couldn't read it</span>
        ) : summary ? (
          <span className="text-xs text-foreground tabular-nums">
            {summary.partial && '≥ '}{size(summary.bytes)} · {summary.files.toLocaleString()} file{summary.files === 1 ? '' : 's'}
            <span className="text-muted-foreground"> · {size(summary.freeBytes)} free</span>
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">Measuring…</span>
        )}
      </div>
      {summary?.partial && (
        <p className="text-[10px] text-muted-foreground/80 mt-0.5">
          A big folder — counting stopped early, so this is at least that much.
        </p>
      )}
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const a11y = useRowA11y();
  return (
    <select
      value={value}
      {...a11y}
      onChange={e => onChange(e.target.value as T)}
      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Numeric field that keeps what you type (so "1." and "" are allowed mid-edit)
 * and clamps to [min, max] when you leave it. */
export function NumberInput({ value, onChange, min, max, step, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  const a11y = useRowA11y();
  const [text, setText] = React.useState(String(value));
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        inputMode={step && step < 1 ? 'decimal' : 'numeric'}
        value={text}
        {...a11y}
        onFocus={() => { focused.current = true; }}
        onChange={e => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => {
          focused.current = false;
          const n = Number(text);
          const next = text.trim() === '' || !Number.isFinite(n) ? clamp(value) : clamp(n);
          onChange(next);
          setText(String(next));
        }}
        min={min}
        max={max}
        step={step}
        className="w-20 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none tabular-nums text-right"
      />
      {unit && <span className="text-[11px] text-muted-foreground" aria-hidden="true">{unit}</span>}
    </div>
  );
}

export function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const a11y = useRowA11y();
  return (
    <CommitInput
      value={value}
      {...a11y}
      onCommit={onChange}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="w-56 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
    />
  );
}

