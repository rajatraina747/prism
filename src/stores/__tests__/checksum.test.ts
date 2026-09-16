import { describe, it, expect } from 'vitest';
import { normalizeSha256 } from '../checksum';

const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('normalizeSha256', () => {
  it('takes a hash however it was published', () => {
    expect(normalizeSha256(HASH)).toBe(HASH);
    expect(normalizeSha256(`  ${HASH}  `)).toBe(HASH);
    expect(normalizeSha256(HASH.toUpperCase())).toBe(HASH);
    expect(normalizeSha256(`sha256:${HASH}`)).toBe(HASH);
    expect(normalizeSha256(`SHA256:${HASH.toUpperCase()}`)).toBe(HASH);
    // A whole line of `shasum -a 256` output, file name and all.
    expect(normalizeSha256(`${HASH}  ubuntu-24.04.iso`)).toBe(HASH);
  });

  it('refuses anything that is not a SHA-256 instead of storing it', () => {
    expect(normalizeSha256(null)).toBeNull();
    expect(normalizeSha256(undefined)).toBeNull();
    expect(normalizeSha256('')).toBeNull();
    expect(normalizeSha256('   ')).toBeNull();
    // An MD5 and a SHA-1: right idea, wrong hash.
    expect(normalizeSha256('d41d8cd98f00b204e9800998ecf8427e')).toBeNull();
    expect(normalizeSha256('da39a3ee5e6b4b0d3255bfef95601890afd80709')).toBeNull();
    expect(normalizeSha256(HASH.slice(0, 63))).toBeNull();
    expect(normalizeSha256(`${HASH}a`)).toBeNull();
    expect(normalizeSha256(HASH.replace('e', 'z'))).toBeNull();
  });
});
