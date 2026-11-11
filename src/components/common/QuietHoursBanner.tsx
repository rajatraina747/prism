import React from 'react';
import { Moon } from 'lucide-react';
import { useSettings } from '@/stores/AppProvider';
import { quietHoursStatus } from '@/stores/schedule';
import { requestNavigate } from '@/lib/nav-bus';
import { useTranslation } from 'react-i18next';

/** The current time, re-read every minute (quiet hours change on the hour). */
export function useMinuteClock(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Says plainly that quiet hours are holding or slowing downloads, and until
 * when — otherwise a held queue reads exactly like one waiting for a slot. */
export function QuietHoursBanner({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { preferences } = useSettings();
  const now = useMinuteClock();
  const status = quietHoursStatus(preferences, now);
  if (!status) return null;
  return (
    <div
      role="status"
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg bg-warning/10 border border-warning/25 text-xs ${className ?? ''}`}
    >
      <Moon className="w-3.5 h-3.5 text-warning shrink-0" aria-hidden="true" />
      <p className="flex-1 min-w-0 text-foreground">
        <span className="font-medium">{t('common.quietHours.until', { time: status.until })}</span>{' '}
        <span className="text-muted-foreground">
          {status.mode === 'pause'
            ? t('common.quietHours.pause')
            : t('common.quietHours.limit', { mbps: status.limitMBps })}
        </span>
      </p>
      <button
        type="button"
        onClick={() => requestNavigate('/settings?section=speed')}
        className="shrink-0 px-2 py-1 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        {t('common.change')}
      </button>
    </div>
  );
}
