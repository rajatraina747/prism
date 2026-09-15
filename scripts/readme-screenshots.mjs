// Regenerates docs/screenshots/*.png from the web build's real UI, seeded with
// public Blender Foundation open movies (CC BY) instead of anyone's history.
//
//   npm run dev            # in another terminal (serves http://localhost:8080)
//   node scripts/readme-screenshots.mjs
//
// The browser demo simulates downloads, so Transfers shows live progress. Its
// "Demo" badge is hidden for the capture; everything else is the shipped UI.

import { chromium } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const OUT = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

const now = Date.now();
const ago = (minutes) => new Date(now - minutes * 60_000).toISOString();
const yt = (id) => ({ url: `https://www.youtube.com/watch?v=${id}`, thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` });

const FILMS = [
  ['aqz-KE-bpKQ', 'Big Buck Bunny 60fps 4K — Official Blender Foundation Short Film', 635, 2160],
  ['eRsGyueVLvQ', 'Sintel — Open Movie by Blender Foundation', 888, 1080],
  ['R6MlUcmOul8', 'Tears of Steel — Blender Open Movie', 734, 1080],
  ['WhWc3b3KhnY', 'Spring — Blender Open Movie', 464, 2160],
  ['Y-rmzh0PI3c', 'Cosmos Laundromat — First Cycle', 730, 1080],
  ['mN0zPOpADL4', 'Agent 327: Operation Barbershop', 231, 1080],
];

function item(i, [id, title, duration, height], extra) {
  const { url, thumb } = yt(id);
  const size = Math.round(duration * (height >= 2160 ? 2.4 : 0.9) * 1_000_000);
  return {
    id: `shot-${i}`,
    metadata: { title, duration, thumbnail: thumb, source: { url, domain: 'youtube.com', addedAt: ago(30 + i) }, formats: [] },
    settings: {
      format: { id: 'x', label: `${height}p MP4`, resolution: `${height}p`, container: 'mp4', codec: 'h264/aac', fileSize: size, quality: 'high' },
      destination: '~/Downloads/Prism', filename: title, retryCount: 3, startImmediately: true,
    },
    totalBytes: size,
    ...extra(size),
  };
}

const history = FILMS.slice(3).map((f, i) => item(10 + i, f, (size) => ({
  status: 'completed', completedAt: ago(90 + i * 45), fileSize: size, actualHeight: f[3],
})));

const queue = FILMS.slice(0, 3).map((f, i) => item(i, f, (size) => ({
  status: 'downloading', progress: [62, 35, 8][i], downloadedBytes: Math.round(size * [0.62, 0.35, 0.08][i]),
  speed: 0, eta: 0, retryAttempt: 0,
})));

const settings = (theme) => ({
  theme, setupCardDismissed: true, clipboardWatchEnabled: false, notificationsEnabled: false, soundEnabled: false,
});

const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: theme });
    await page.addInitScript(({ history, queue, settings }) => {
      localStorage.setItem('prism_splash_seen', '1');
      localStorage.setItem('prism_history', JSON.stringify(history));
      localStorage.setItem('prism_queue', JSON.stringify(queue));
      localStorage.setItem('prism_settings', JSON.stringify(settings));
    }, { history, queue, settings: settings(theme) });

    const shoot = async (path, file) => {
      await page.goto(`${BASE}${path}`);
      await page.addStyleTag({ content: '[title^="Browser demo"]{display:none!important}' });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2500); // simulated progress + thumbnails settle
      await page.screenshot({ path: `${OUT}${file}` });
      console.log(`wrote docs/screenshots/${file}`);
    };

    await shoot('/', `app-${theme}.png`);
    if (theme === 'dark') await shoot('/queue', 'queue-dark.png');
    await page.close();
  }
} finally {
  await browser.close();
}
