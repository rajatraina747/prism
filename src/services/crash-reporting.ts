import * as Sentry from '@sentry/react';

// Opt-in crash reporting. Doubly gated: does nothing unless the app was
// built with VITE_SENTRY_DSN *and* the user enabled the setting. The Rust
// side has the equivalent gate for panics (see lib.rs).

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let active = false;

export function crashReportingAvailable(): boolean {
  return Boolean(DSN);
}

/** Bring the SDK in line with the user's setting. Safe to call repeatedly. */
export function syncCrashReporting(enabled: boolean, appVersion?: string): void {
  if (!DSN) return;
  if (enabled && !active) {
    Sentry.init({
      dsn: DSN,
      release: appVersion ? `prism@${appVersion}` : undefined,
      // Crashes only — no performance tracing, no session replay, no PII.
      tracesSampleRate: 0,
      sendDefaultPii: false,
      autoSessionTracking: false,
    });
    active = true;
  } else if (!enabled && active) {
    void Sentry.close();
    active = false;
  }
}

/** Report a caught error (e.g. from the ErrorBoundary). No-op when off. */
export function reportError(error: unknown): void {
  if (!active) return;
  Sentry.captureException(error);
}
