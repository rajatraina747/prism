import type { DownloadCategory, DownloadItem, DownloadKind } from '@/types/models';
import { siteKey } from '@/services/utils';

// Which category claims a download. Pure, so the rules are unit-testable and
// the same answer is used by the queue, the details dialog and Settings.

/** A category's host rule matches the item's host and its subdomains:
 * `youtube.com` claims `music.youtube.com`, but never `notyoutube.com`. */
function hostMatches(rule: string, host: string): boolean {
  const wanted = siteKey(rule) ?? rule.trim().toLowerCase();
  if (!wanted) return false;
  return host === wanted || host.endsWith(`.${wanted}`);
}

function kindOf(item: DownloadItem): DownloadKind {
  return item.kind ?? 'http';
}

export function categoryMatches(category: DownloadCategory, item: DownloadItem): boolean {
  const domains = category.domains.filter(d => d.trim());
  const kinds = category.kinds;
  // A category with no rules at all claims nothing: it would swallow
  // everything, which is never what someone meant by leaving it blank.
  if (domains.length === 0 && kinds.length === 0) return false;
  if (kinds.length > 0 && !kinds.includes(kindOf(item))) return false;
  if (domains.length > 0) {
    const host = siteKey(item.metadata.source.url) ?? '';
    if (!host || !domains.some(rule => hostMatches(rule, host))) return false;
  }
  return true;
}

/** The first category whose rules match — order is the user's priority. */
export function categoryFor(categories: DownloadCategory[], item: DownloadItem): DownloadCategory | null {
  return categories.find(category => categoryMatches(category, item)) ?? null;
}

/** The item as its category would have it: the category's destination and
 * file name template, and the category recorded on it. Anything the category
 * leaves blank is left as it was. */
export function applyCategory(item: DownloadItem, category: DownloadCategory): DownloadItem {
  return {
    ...item,
    settings: {
      ...item.settings,
      destination: category.destination.trim() || item.settings.destination,
      filenameTemplate: category.filenameTemplate.trim() || item.settings.filenameTemplate,
      categoryId: category.id,
      categoryName: category.name,
    },
  };
}
