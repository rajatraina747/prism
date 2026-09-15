import type { DownloadError } from '@/types/models';
import { classifyError, conciseError } from '@/services/errors';
import { requestNavigate, COOKIES_SETTINGS_PATH } from '@/lib/nav-bus';

/** Why a download failed and what to do about it: the suggestion first, the
 * engine's own words (one line; full text on hover) beneath, then the fix.
 * Retry is always offered — classification is a best guess — but the fix that
 * matters (browser cookies) comes first. Used on Transfers rows and in the
 * Library. */
export function FailureNote({ error, onRetry, retryLabel = 'Retry' }: {
  error: DownloadError;
  onRetry: () => void;
  retryLabel?: string;
}) {
  const { suggestion, action } = classifyError(error.message, error.engineCode);
  return (
    <div className="mt-1.5 space-y-1">
      <p className="text-[11px] text-destructive">{error.suggestion ?? suggestion}</p>
      <p className="text-[11px] text-muted-foreground/70 truncate" title={error.detail ?? error.message}>{conciseError(error.message)}</p>
      <div className="flex items-center gap-1.5 pt-0.5">
        {action === 'cookies' && (
          <button
            type="button"
            onClick={() => requestNavigate(COOKIES_SETTINGS_PATH)}
            className="px-2 py-1 rounded-md bg-primary/15 text-[11px] font-medium text-primary hover:bg-primary/25 transition-colors active:scale-[0.97]"
          >
            Set browser cookies
          </button>
        )}
        <button
          type="button"
          onClick={onRetry}
          className="px-2 py-1 rounded-md bg-secondary text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
        >
          {retryLabel}
        </button>
      </div>
    </div>
  );
}
