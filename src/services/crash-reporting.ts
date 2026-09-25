import type * as SentryTypes from '@sentry/react';

// Opt-in crash reporting. Doubly gated: does nothing unless the app was
// built with VITE_SENTRY_DSN *and* the user enabled the setting. The Rust
// side has the equivalent gate for panics (see lib.rs).
//
// What leaves the machine: the error type, a scrubbed message, a stack trace
// of Prism's own code, app version, OS. What never does: URLs, file paths,
// download history, console output, request bodies. The CSP in
// tauri.conf.json allows connections to Sentry's ingest hosts only.
//
// The SDK is loaded on demand: most users never turn this on, so it stays
// out of the startup bundle.

const DSN = import.meta.env.VITE_SENTRY_DSN as string | undefined;

let active = false;
let sdk: typeof SentryTypes | null = null;
let loading: Promise<typeof SentryTypes> | null = null;

function loadSdk(): Promise<typeof SentryTypes> {
  loading ??= import('@sentry/react').then((m) => { sdk = m; return m; });
  return loading;
}

const URL_RE = /\b(?:https?|magnet|file|ftp):\/\/?[^\s'"<>]+/gi;
// Home folders, other drives and mounts, shares, temp and `~/` paths, running
// on across single spaces (file names have them): over-scrubbing is the safe
// way to be wrong (REVIEW 2026-09-26 L1).
const PATH_RE = /(?:\/Users\/|\/home\/|\/Volumes\/|\/mnt\/|\/media\/|\/run\/media\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/|[A-Za-z]:\\|\\\\[^\s\\'"]+\\)[^\s'":<>]*(?: [^\s'":<>]+)*/g;

/** Replace anything that looks like a URL or a home-relative path. */
export function scrubText(s: string): string {
  return s.replace(URL_RE, '[url]').replace(PATH_RE, '[path]');
}

/** Strip identifying detail from an event before it is sent. */
export function scrubEvent<T extends SentryTypes.ErrorEvent>(event: T): T {
  if (event.message) event.message = scrubText(event.message);
  if (event.logentry?.message) event.logentry.message = scrubText(event.logentry.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubText(ex.value);
  }
  // A desktop app has no request to report, and breadcrumbs are disabled at
  // init — clear both anyway so a future integration can't reintroduce them.
  delete event.request;
  event.breadcrumbs = [];
  return event;
}

export function crashReportingAvailable(): boolean {
  return Boolean(DSN);
}

/** Bring the SDK in line with the user's setting. Safe to call repeatedly. */
export function syncCrashReporting(enabled: boolean, appVersion?: string): void {
  if (!DSN) return;
  if (enabled && !active) {
    active = true;
    void loadSdk().then((Sentry) => {
      // The setting may have flipped back while the chunk was loading.
      if (!active) return;
      Sentry.init({
        dsn: DSN,
        release: appVersion ? `prism@${appVersion}` : undefined,
        // Crashes only — no performance tracing, no session replay, no PII.
        tracesSampleRate: 0,
        sendDefaultPii: false,
        // No console/fetch/navigation breadcrumbs: they would carry URLs and
        // the player's diagnostic console.log lines.
        integrations: (defaults) => defaults.filter((i) => i.name !== 'Breadcrumbs'),
        beforeBreadcrumb: () => null,
        beforeSend: (event) => scrubEvent(event),
      });
    });
  } else if (!enabled && active) {
    active = false;
    void sdk?.close();
  }
}

/** Report a caught error (e.g. from the ErrorBoundary). No-op when off. */
export function reportError(error: unknown): void {
  if (!active || !sdk) return;
  sdk.captureException(error);
}
