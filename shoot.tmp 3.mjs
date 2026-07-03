// Screenshot rig: seeds the Prism web demo (mock service) with realistic
// state, then captures dark/light shots for the RainaCorp site.
import { chromium } from '@playwright/test';

const OUT = process.env.OUT_DIR;
const BASE = 'http://localhost:8080';

const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();

const fmt = (label, res, size) => ({
  id: `f-${res}`, label, resolution: res, container: 'mp4', codec: 'H.264',
  fileSize: size, quality: res === '2160p' ? 'best' : res === '1080p' ? 'high' : 'medium',
});

const item = (id, title, thumb, domain, url, size, done, status, res, label) => ({
  id,
  metadata: {
    title, duration: 600 + (id.charCodeAt(0) % 9) * 137, thumbnail: thumb,
    source: { url, domain, addedAt: iso(30) }, formats: [],
    uploader: domain.replace('www.', ''),
  },
  settings: {
    format: fmt(label, res, size), destination: '~/Downloads/Prism',
    filename: title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_'),
    retryCount: 3, startImmediately: true,
  },
  status, progress: size ? Math.round((done / size) * 100) : 0,
  speed: 0, eta: 0, downloadedBytes: done, totalBytes: size, retryAttempt: 0,
});

const T = (vid) => `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`;

const queue = [
  item('q1', 'Inside the James Webb Space Telescope — Full Documentary', T('4P8fKd0IVOs'), 'www.youtube.com', 'https://www.youtube.com/watch?v=q1', 1_850_000_000, 830_000_000, 'downloading', '2160p', '4K Ultra HD'),
  item('q2', 'How the Silicon Chip Changed Everything', T('IkRXpFIRUl4'), 'www.youtube.com', 'https://www.youtube.com/watch?v=q2', 640_000_000, 120_000_000, 'downloading', '1080p', 'Full HD'),
  item('q3', 'Alpine Cabin Build — Timelapse, Start to Finish', T('aqz-KE-bpKQ'), 'vimeo.com', 'https://vimeo.com/q3', 890_000_000, 311_000_000, 'paused', '1080p', 'Full HD'),
  item('q4', 'The Mathematics of Juggling', T('7DHE8RnsCQ8'), 'www.youtube.com', 'https://www.youtube.com/watch?v=q4', 420_000_000, 0, 'queued', '720p', 'HD'),
];

const hist = (id, title, thumb, domain, size, hoursAgo, res, label) => ({
  id,
  metadata: {
    title, duration: 480 + (id.charCodeAt(1) % 9) * 111, thumbnail: thumb,
    source: { url: `https://${domain}/${id}`, domain, addedAt: iso(hoursAgo * 60 + 20) }, formats: [],
  },
  settings: {
    format: fmt(label, res, size), destination: '~/Downloads/Prism',
    filename: title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_'),
    retryCount: 3, startImmediately: true,
  },
  status: 'completed', completedAt: iso(hoursAgo * 60), fileSize: size,
  filePath: `~/Downloads/Prism/${title.slice(0, 18)}.mp4`,
});

const history = [
  hist('h1', 'Kurzgesagt — What if the Moon Crashed into Earth?', T('lheapd7bgLA'), 'www.youtube.com', 512_000_000, 3, '1080p', 'Full HD'),
  hist('h2', 'Studio Session — Analog Synth Ambient Mix', T('5qap5aO4i9A'), 'www.youtube.com', 96_000_000, 7, '720p', 'HD'),
  hist('h3', 'Financial Times — Global Supply Chains, Explained', T('1BsfmyGV1lY'), 'www.youtube.com', 380_000_000, 26, '1080p', 'Full HD'),
  hist('h4', 'Cooking the Perfect Neapolitan Pizza at Home', T('xLBw9CDoezA'), 'www.youtube.com', 298_000_000, 49, '1080p', 'Full HD'),
];

const subs = [
  { id: 's1', url: 'https://www.youtube.com/@veritasium', title: 'Veritasium', addedAt: iso(4320), enabled: true, audioOnly: false, seenUrls: [], lastCheckedAt: iso(12) },
  { id: 's2', url: 'https://www.youtube.com/@mkbhd', title: 'Marques Brownlee', addedAt: iso(2880), enabled: true, audioOnly: false, seenUrls: [], lastCheckedAt: iso(12) },
  { id: 's3', url: 'https://www.youtube.com/playlist?list=PLlaN88a7y2_plecYoJxvRFTLHVbIVAOoc', title: 'Lo-fi Study Beats (Playlist)', addedAt: iso(1440), enabled: false, audioOnly: true, seenUrls: [], lastCheckedAt: iso(600) },
];

async function shoot(theme) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
  const page = await ctx.newPage();

  const settings = {
    defaultSaveFolder: '~/Downloads/Prism', maxConcurrentDownloads: 3, bandwidthLimit: 0,
    defaultRetryCount: 3, theme, launchOnStartup: false, minimizeToTray: true, autoUpdate: true,
    logLevel: 'info', notificationsEnabled: true, soundEnabled: false, cookiesFromBrowser: 'none',
    subscriptionCheckIntervalMinutes: 30, sponsorBlock: 'mark', crashReportingEnabled: false,
    audioFormat: 'mp3',
    scheduleEnabled: false, scheduleStartHour: 8, scheduleEndHour: 23, scheduleMode: 'limit', scheduleLimitMBps: 5,
  };

  await page.addInitScript(({ q, h, s, st, th }) => {
    localStorage.setItem('prism_queue', JSON.stringify(q));
    localStorage.setItem('prism_history', JSON.stringify(h));
    localStorage.setItem('prism_subscriptions', JSON.stringify(s));
    localStorage.setItem('prism_settings', JSON.stringify(st));
    localStorage.setItem('theme', th);
  }, { q: queue, h: history, s: subs, st: settings, th: theme });

  await page.goto(BASE + '/');
  // Let the splash finish and mock downloads advance a little
  await page.waitForTimeout(6500);
  await page.screenshot({ path: `${OUT}/dashboard-${theme}.png` });

  // Client-side navigation via the sidebar — a full goto re-triggers the splash
  await page.click('nav >> text=Queue');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/queue-${theme}.png` });

  await page.click('nav >> text=Subscriptions');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/subscriptions-${theme}.png` });

  await page.click('nav >> text=History');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/history-${theme}.png` });

  await browser.close();
}

await shoot('dark');
await shoot('light');
console.log('done');
