#!/usr/bin/env bash
# Copy the Windows/Linux media archives pinned in scripts/sidecars.lock into a
# release of this repo (MEDIA_THIRDPARTY_TAG), so a build still works after
# zhongfly and BtbN delete those nightlies. Each archive is checked against the
# pinned SHA-256 before upload. Run after scripts/update-sidecars.sh moves the
# pins; safe to re-run (existing assets are left alone).
#
# The release is created with --latest=false: the in-app updater reads
# releases/latest/download/latest.json, so this must never become "Latest".
#
# Needs: gh (authenticated, with write access), shasum or sha256sum.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$ROOT/scripts/sidecars.lock"
REPO=rajatraina747/prism
: "${MEDIA_THIRDPARTY_TAG:?sidecars.lock has no MEDIA_THIRDPARTY_TAG}"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT

get() { # <repo> <tag> <asset> <sha256>
  gh release download "$2" -R "$1" -p "$3" -D "$DIR" --clobber
  [ "$(sha "$DIR/$3")" = "$4" ] || { echo "✗ $3 doesn't match its pinned SHA-256" >&2; exit 1; }
  echo "✓ $3"
}
get zhongfly/mpv-winbuild "$MPV_WINBUILD_TAG" "$MPV_WINBUILD_ASSET" "$MPV_WINBUILD_SHA256"
get BtbN/FFmpeg-Builds "$BTBN_TAG" "$BTBN_FFMPEG_WIN64" "$BTBN_FFMPEG_WIN64_SHA256"
get BtbN/FFmpeg-Builds "$BTBN_TAG" "$BTBN_FFMPEG_LINUX64" "$BTBN_FFMPEG_LINUX64_SHA256"

if ! gh release view "$MEDIA_THIRDPARTY_TAG" -R "$REPO" >/dev/null 2>&1; then
  gh release create "$MEDIA_THIRDPARTY_TAG" -R "$REPO" --target main --latest=false \
    --title "Media (third-party) ${MEDIA_THIRDPARTY_TAG#media-thirdparty-}" \
    --notes "Byte-for-byte copies of the third-party LGPL media builds Prism bundles on Windows and Linux, pinned in scripts/sidecars.lock. Upstream deletes old nightlies after a few weeks; scripts/fetch-sidecars.sh fetches from here first and checks the same SHA-256s.

- $MPV_WINBUILD_ASSET from https://github.com/zhongfly/mpv-winbuild/releases/tag/$MPV_WINBUILD_TAG
- $BTBN_FFMPEG_WIN64 and $BTBN_FFMPEG_LINUX64 from https://github.com/BtbN/FFmpeg-Builds/releases/tag/$BTBN_TAG

Not a Prism release."
fi
have=$(gh release view "$MEDIA_THIRDPARTY_TAG" -R "$REPO" --json assets --jq '.assets[].name')
for f in "$MPV_WINBUILD_ASSET" "$BTBN_FFMPEG_WIN64" "$BTBN_FFMPEG_LINUX64"; do
  grep -qxF "$f" <<<"$have" && { echo "= $f already mirrored"; continue; }
  gh release upload "$MEDIA_THIRDPARTY_TAG" -R "$REPO" "$DIR/$f"
done
echo "Mirrored to https://github.com/$REPO/releases/tag/$MEDIA_THIRDPARTY_TAG"
latest=$(gh release view -R "$REPO" --json tagName --jq .tagName)
echo "Latest release is still: $latest"
