import { Film, Music } from 'lucide-react';
import { cn } from '@/lib/utils';
import { QUALITY_CHOICES, type BatchChoice, type DefaultQuality } from '@/types/models';

const kindClass = (on: boolean) => cn(
  'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97] border',
  on ? 'bg-primary/15 text-primary border-primary/30' : 'bg-secondary/50 text-secondary-foreground hover:bg-secondary border-transparent',
);

/** Video or audio, and the quality, for every video in a list or batch. */
export function BatchOptions({ value, onChange }: { value: BatchChoice; onChange: (choice: BatchChoice) => void }) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button type="button" aria-pressed={!value.audioOnly} onClick={() => onChange({ ...value, audioOnly: false })} className={kindClass(!value.audioOnly)}>
        <Film className="w-3 h-3" /> Video
      </button>
      <button type="button" aria-pressed={value.audioOnly} onClick={() => onChange({ ...value, audioOnly: true })} className={kindClass(value.audioOnly)}>
        <Music className="w-3 h-3" /> Audio only
      </button>
      {!value.audioOnly && (
        <select
          aria-label="Quality"
          value={value.quality}
          onChange={e => onChange({ ...value, quality: e.target.value as DefaultQuality })}
          className="ml-auto px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
        >
          {QUALITY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      )}
    </div>
  );
}
