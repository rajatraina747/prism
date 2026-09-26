// Which desktop Prism runs on, for wording that differs between them. The
// webview's user agent says: WebView2 on Windows, WKWebView on macOS.

const agent = typeof navigator !== 'undefined' ? navigator.userAgent : '';

export const IS_MAC = agent.includes('Mac');
export const IS_WINDOWS = agent.includes('Windows');

/** Where deleted files go, by this desktop's name for it. */
export const TRASH_NAME = IS_WINDOWS ? 'Recycle Bin' : 'Trash';
