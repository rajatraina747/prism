// Lets code outside a route component (toasts fired from AppProvider, rows
// deep in a list) ask the app shell — which owns `navigate` — to go somewhere.

/** Where "Set browser cookies" lands. One place to change if Settings moves. */
export const COOKIES_SETTINGS_PATH = '/settings?section=downloads';

let listener: ((path: string) => void) | null = null;

export function requestNavigate(path: string) {
  listener?.(path);
}

export function onNavigateRequest(cb: (path: string) => void): () => void {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}
