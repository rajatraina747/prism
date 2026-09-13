import React from 'react';
import { useService } from '@/services/ServiceProvider';
import { useSettings } from '@/stores/AppProvider';
import { CheckCircle2, AlertTriangle, FolderOpen, Cookie, X, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac');
const IS_WINDOWS = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

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
      aria-label="First-run setup"
      className="mt-4 glass-strong rounded-xl p-4 animate-fade-in relative"
    >
      <button
        onClick={() => updatePreference('setupCardDismissed', true)}
        aria-label="Dismiss setup"
        className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      <p className="text-xs font-semibold text-foreground">Three things before your first download</p>
      <p className="text-[11px] text-muted-foreground mt-0.5">Takes a minute. You can change all of these later in Settings.</p>

      <ol className="mt-3 space-y-2.5">
        {/* 1. Destination */}
        <li className="flex items-start gap-3">
          <StepIcon ok />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">Where downloads go</p>
            <p className="text-[11px] text-muted-foreground">
              Any folder you pick works — external drives and network shares included.
            </p>
            <button
              onClick={async () => {
                const dir = await service.pickDirectory().catch(() => null);
                if (dir) updatePreference('defaultSaveFolder', dir);
              }}
              className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-input border border-border/40 text-[11px] text-foreground hover:bg-secondary transition-colors"
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
            <p className="text-xs font-medium text-foreground">ffmpeg {ffmpeg === true ? 'found' : ffmpeg === false ? 'not found' : '…'}</p>
            {ffmpeg === false ? (
              <>
                <p className="text-[11px] text-muted-foreground">
                  Needed to merge video + audio above 720p, embed thumbnails and chapters, and for SponsorBlock.
                  Install it, then check again:
                </p>
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="text-[11px] font-mono px-2 py-1 rounded-md bg-input border border-border/40 text-foreground">{FFMPEG_HINT}</code>
                  <button
                    onClick={checkFfmpeg}
                    disabled={checking}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                  >
                    <RefreshCw className={cn('w-3 h-3', checking && 'animate-spin')} /> Check again
                  </button>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">High-quality merges, thumbnails and chapters are all available.</p>
            )}
          </div>
        </li>

        {/* 3. Cookies */}
        <li className="flex items-start gap-3">
          <StepIcon ok={cookies !== 'none'} pending={cookies === 'none'} />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">Sign-in-required and age-restricted videos</p>
            <p className="text-[11px] text-muted-foreground">
              Optional. Prism can use a browser's cookies so those videos work. Cookies are read locally and sent only
              to the video's site.
              {IS_MAC && ' Safari needs Full Disk Access for Prism (System Settings → Privacy & Security); Chrome will ask for Keychain access once.'}
            </p>
            <div className="mt-1.5 flex items-center gap-1.5">
              <Cookie className="w-3 h-3 text-muted-foreground" />
              <select
                value={cookies}
                onChange={(e) => updatePreference('cookiesFromBrowser', e.target.value as typeof cookies)}
                aria-label="Browser cookies"
                className="px-2 py-1 rounded-md bg-input border border-border/40 text-[11px] text-foreground outline-none"
              >
                <option value="none">Don't use browser cookies</option>
                <option value="safari">Safari</option>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="edge">Edge</option>
                <option value="brave">Brave</option>
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
          Done
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
