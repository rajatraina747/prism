import { createContext } from 'react';

/** What the Settings search box holds; rows that don't match hide. */
export const SettingsQuery = createContext('');

/** The heading of the group a row sits in, which search matches too:
 * "speed" should find the rows under "Speed limits". */
export const SettingsGroupTitle = createContext('');

/** Whether every word of the query appears in one of the texts. */
export function matchesQuery(query: string, ...texts: (string | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  return q.split(/\s+/).every(word => hay.includes(word));
}
