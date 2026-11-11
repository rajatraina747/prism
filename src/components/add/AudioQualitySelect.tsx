import { t } from '@/i18n';
import { AUDIO_QUALITIES, audioQualityLabel } from '@/lib/audio-quality';
import { cn } from '@/lib/utils';
import type { AudioQuality } from '@/types/models';

/** The audio quality menu: in the details dialog, batch options and Settings. */
export function AudioQualitySelect({ value, onChange, className }: {
  value: AudioQuality;
  onChange: (q: AudioQuality) => void;
  className?: string;
}) {
  return (
    <select
      aria-label={t('audio.label')}
      value={value}
      onChange={e => onChange(e.target.value as AudioQuality)}
      className={cn('px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer', className)}
    >
      {AUDIO_QUALITIES.map(q => <option key={q} value={q}>{audioQualityLabel(q)}</option>)}
    </select>
  );
}
