import React from 'react';
import { useService } from '@/services/ServiceProvider';
import { useSettings } from '@/stores/AppProvider';
import { CheckCircle2, AlertTriangle, FolderOpen, Cookie, X, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

import { IS_MAC, IS_WINDOWS } from '@/lib/platform';
import { DisabledReason } from '@/components/common/DisabledReason';
import { t } from '@/i18n';

const FFMPEG_HINT = IS_MAC
  ? 'brew install ffmpeg'
  : IS_WINDOWS
    ? 'winget install Gyan.FFmpeg'
    : 'sudo apt install ffmpeg';

/**
 * First-run setup: the three things that actually decide whether a first
 * download works — where files go, whether ffmpeg is present (merges,
 * thumbnails, SponsorBlock all need it), and how sign-in-required videos
 * are handled. Dismissible; never shown again once dismissed.
 */
export function SetupCard() {
  const service = useService();
  const { preferences, updatePreference } = useSettings();
  const [ffmpeg, setFfmpeg] = React.useState<boolean | null>(null);
  const [checking, setChecking] = React.useState(false);

  const checkFfmpeg = React.useCallback(() => {
    setChecking(true);
    service.ffmpegAvailable()
      .then(setFfmpeg)
      .catch(() => setFfmpeg(false))
      .finally(() => setChecking(false));
  }, [service]);

  React.useEffect(() => { checkFfmpeg(); }, [checkFfmpeg]);

  if (preferences.setupCardDismissed) return null;

  const cookies = preferences.cookiesFromBrowser;

  return (
    <section
      aria-label={t('setup.label')}
      className="mt-4 glass-strong rounded-xl p-4 animate-fade-in relative"
    >
      <button
        onClick={() => updatePreference('setupCardDismissed', true)}
        aria-label={t('setup.dismiss')}
        className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <p className="text-xs font-semibold text-foreground">{t('setup.title')}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{t('setup.subtitle')}</p>

      <ol className="mt-3 space-y-2.5">
        {/* 1. Destination */}
        <li className="flex items-start gap-3">
          <StepIcon ok />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{t('setup.folder.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('setup.folder.body')}
            </p>
            <button
              onClick={async () => {
                const dir = await service.pickDirectory().catch(() => null);
                if (dir) updatePreference('defaultSaveFolder', dir);
              }}
              className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground hover:bg-secondary transition-colors"
            >
              <FolderOpen className="w-3 h-3 shrink-0" />
              <span className="font-mono truncate max-w-[260px]">{preferences.defaultSaveFolder}</span>
            </button>
          </div>
        </li>

        {/* 2. ffmpeg */}
        <li className="flex items-start gap-3">
          <StepIcon ok={ffmpeg === true} pending={ffmpeg === null} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{ffmpeg === true ? t('setup.ffmpeg.found') : ffmpeg === false ? t('setup.ffmpeg.notFound') : t('setup.ffmpeg.checking')}</p>
            {ffmpeg === false ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('setup.ffmpeg.needed')}
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="text-xs font-mono px-2 py-1 rounded-md bg-input border border-border/40 text-foreground">{FFMPEG_HINT}</code>
                  <DisabledReason reason={checking ? t('setup.ffmpeg.busy') : null}>
                    <button
                      onClick={checkFfmpeg}
                      disabled={checking}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className={cn('w-3 h-3', checking && 'animate-spin')} /> {t('setup.ffmpeg.checkAgain')}
                    </button>
                  </DisabledReason>
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t('setup.ffmpeg.ok')}</p>
            )}
          </div>
        </li>

        {/* 3. Cookies */}
        <li className="flex items-start gap-3">
          <StepIcon ok={cookies !== 'none'} pending={cookies === 'none'} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">{t('setup.cookies.title')}</p>
            <p className="text-xs text-muted-foreground">
              {t('setup.cookies.body')}
              {IS_MAC && ` ${t('setup.cookies.macNote')}`}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Cookie className="w-3 h-3 text-muted-foreground" />
              <select
                value={cookies}
                onChange={(e) => updatePreference('cookiesFromBrowser', e.target.value as typeof cookies)}
                aria-label={t('setup.cookies.label')}
                className="px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none"
              >
                <option value="none">{t('browsers.none')}</option>
                <option value="safari">{t('browsers.safari')}</option>
                <option value="chrome">{t('browsers.chrome')}</option>
                <option value="firefox">{t('browsers.firefox')}</option>
                <option value="edge">{t('browsers.edge')}</option>
                <option value="brave">{t('browsers.brave')}</option>
              </select>
            </div>
          </div>
        </li>
      </ol>

      <div className="mt-3 flex justify-end">
        <button
          onClick={() => updatePreference('setupCardDismissed', true)}
          className="px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors active:scale-[0.97]"
        >
          {t('common.done')}
        </button>
      </div>
    </section>
  );
}

function StepIcon({ ok, pending }: { ok: boolean; pending?: boolean }) {
  if (ok) return <CheckCircle2 className="w-4 h-4 text-success shrink-0 mt-0.5" aria-hidden />;
  if (pending) return <span className="w-4 h-4 rounded-full border border-border/60 shrink-0 mt-0.5" aria-hidden />;
  return <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" aria-hidden />;
}
