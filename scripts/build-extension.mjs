#!/usr/bin/env node
// Build the Prism Downloader extension for Firefox and for Chromium browsers
// (Edge Add-ons, and Chrome as an unpacked extension) from one source.
//
//   node scripts/build-extension.mjs            → extension/dist/{firefox,chromium}/ + a zip of each
//
// The manifest is extension/manifests/base.json with the browser's own file
// laid over it: Firefox needs its gecko id and an event-page background,
// Chromium a service worker. Everything else is shared, background.js
// included (it uses `browser` where it exists, else `chrome`).

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension');
export const TARGETS = ['firefox', 'chromium'];

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** The manifest for one browser: the base with its overlay's keys laid over. */
export function manifestFor(target, dir = root) {
  const base = readJson(join(dir, 'manifests', 'base.json'));
  const overlay = readJson(join(dir, 'manifests', `${target}.json`));
  return { ...base, ...overlay };
}

function build(target) {
  const manifest = manifestFor(target);
  const out = join(root, 'dist', target);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'src'), out, { recursive: true });
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const zip = join(root, 'dist', `prism-downloader-${target}-${manifest.version}.zip`);
  rmSync(zip, { force: true });
  // -X: no extra file attributes, so the zip depends only on the contents.
  execFileSync('zip', ['-r', '-X', '-q', zip, '.'], { cwd: out });
  return zip;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const target of TARGETS) {
    console.log(build(target));
  }
}
