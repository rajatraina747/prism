/** A SHA-256 in the one shape the engine accepts: 64 lower-case hex digits.
 *
 * People paste these from wherever the file was published — upper case, with
 * a `sha256:` prefix, or as a whole line of `shasum` output with the file name
 * after it. All of those are the same hash, so they are accepted. Anything
 * that isn't a SHA-256 returns null and is refused rather than quietly stored,
 * because a mistyped hash that is never checked is worse than no hash at all. */
export function normalizeSha256(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // `shasum -a 256 file` prints "<hash>  <name>": take the hash.
  const token = (raw.trim().split(/\s+/)[0] ?? '').toLowerCase();
  const stripped = token.startsWith('sha256:') ? token.slice('sha256:'.length) : token;
  return /^[0-9a-f]{64}$/.test(stripped) ? stripped : null;
}
