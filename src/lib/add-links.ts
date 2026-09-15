// Turning whatever the user hands Prism — pasted text, a text file, a link
// dragged from a browser, a .torrent file — into a list of addable links.

/** Largest dropped .torrent read into memory (real ones are KBs). */
export const MAX_TORRENT_DROP_BYTES = 16 * 1024 * 1024;

const LINK_RE = /^(https?:\/\/\S+|magnet:\?\S+)$/i;
const TEXT_FILE_RE = /\.(txt|text|csv|list|urls)$/i;

/** http(s) and magnet links in `text`, one per whitespace-separated token,
 * de-duplicated, in order. */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of text.split(/\s+/)) {
    const t = token.trim();
    if (t && LINK_RE.test(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

export interface DropResult {
  links: string[];
  errors: string[];
}

/** Everything addable in a drop: `.torrent` files (via `importTorrent`, which
 * returns a magnet), text files of links, or dragged links/text. */
export async function linksFromDrop(
  dt: Pick<DataTransfer, 'files' | 'getData'>,
  importTorrent: (name: string, bytes: Uint8Array) => Promise<string>,
): Promise<DropResult> {
  const links: string[] = [];
  const errors: string[] = [];
  const files = Array.from(dt.files ?? []);
  if (files.length > 0) {
    for (const file of files) {
      if (/\.torrent$/i.test(file.name)) {
        if (file.size > MAX_TORRENT_DROP_BYTES) {
          errors.push(`${file.name} is too large to be a .torrent file`);
          continue;
        }
        try {
          links.push(await importTorrent(file.name, new Uint8Array(await file.arrayBuffer())));
        } catch (e) {
          errors.push(e instanceof Error ? e.message : String(e));
        }
      } else if (TEXT_FILE_RE.test(file.name) || file.type === 'text/plain') {
        links.push(...extractLinks(await file.text()));
      } else {
        errors.push(`Prism can't add ${file.name} — drop links, .torrent files or a text file of links`);
      }
    }
  } else {
    const uriList = dt.getData('text/uri-list')
      .split('\n')
      .filter(l => !l.trim().startsWith('#'))
      .join('\n');
    links.push(...extractLinks(`${uriList}\n${dt.getData('text/plain')}`));
  }
  return { links: [...new Set(links)], errors };
}
