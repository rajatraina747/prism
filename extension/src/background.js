// Prism Downloader: one background script for Firefox (an MV3 event page)
// and Chromium browsers (an MV3 service worker). See ../README.md.
//
// Hands URLs to the Prism desktop app via its prism://add?url=... deep link.
// The app validates the inner URL (http/https only) on its side too; the
// check here just avoids pointless round-trips for blob:/about: URLs.

// Firefox has `browser`; Chrome and Edge have `chrome`. The calls used here
// are the same on both.
const api = globalThis.browser ?? globalThis.chrome;

const MENU_ITEMS = [
  { id: 'prism-page', title: 'Download this page in Prism', contexts: ['page', 'video', 'audio'] },
  { id: 'prism-link', title: 'Download link in Prism', contexts: ['link'] },
];

api.runtime.onInstalled.addListener(() => {
  for (const item of MENU_ITEMS) {
    api.contextMenus.create(item);
  }
});

function sendToPrism(tabId, target) {
  if (!/^https?:\/\//i.test(target || '')) {
    return;
  }
  const deepLink = 'prism://add?url=' + encodeURIComponent(target);
  // Navigating to an external protocol hands off to the OS handler and leaves
  // the page in place; Firefox may show a "launch application" prompt with a
  // remember-my-choice option.
  api.tabs.update(tabId, { url: deepLink });
}

api.contextMenus.onClicked.addListener((info, tab) => {
  // For links use the link target; for pages and embedded media use the page
  // URL — media srcUrl is often a blob: or expiring CDN URL that yt-dlp can't
  // extract from anyway.
  const target = info.menuItemId === 'prism-link' ? info.linkUrl : info.pageUrl;
  if (tab && tab.id !== undefined) {
    sendToPrism(tab.id, target);
  }
});

api.action.onClicked.addListener((tab) => {
  if (tab && tab.id !== undefined) {
    sendToPrism(tab.id, tab.url);
  }
});
