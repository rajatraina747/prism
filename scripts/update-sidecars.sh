#!/usr/bin/env bash
# Refresh scripts/sidecars.lock to the newest upstream releases, pulling each
# project's *published* checksums (not hashes of whatever we downloaded).
# Review `git diff scripts/sidecars.lock` before committing.
#
# Needs: gh (authenticated), curl, jq.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOCK="$ROOT/scripts/sidecars.lock"

hash_of_ps_sum() { tr -d '\r' | grep -oiE '[0-9a-f]{64}' | head -1 | tr 'A-F' 'a-f'; }

echo "yt-dlp…"
YTDLP_VERSION=$(gh api repos/yt-dlp/yt-dlp/releases/latest --jq .tag_name)
SUMS=$(curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/SHA2-256SUMS")
sum_for() { echo "$SUMS" | awk -v n="$1" '$2==n{print tolower($1)}'; }

echo "Deno…"
DENO_VERSION=$(gh api repos/denoland/deno/releases/latest --jq .tag_name)
deno_sum() { curl -fsSL "https://github.com/denoland/deno/releases/download/$DENO_VERSION/deno-$1.zip.sha256sum" | hash_of_ps_sum; }

echo "libmpv-wrapper…"
LIBMPV_WRAPPER_VERSION=$(gh api repos/nini22P/libmpv-wrapper/releases/latest --jq .tag_name)
wrapper_sum() { gh api repos/nini22P/libmpv-wrapper/releases/latest --jq ".assets[] | select(.name==\"libmpv-wrapper-$1.zip\") | .digest" | sed 's/^sha256://'; }

echo "mpv-winbuild…"
MPV_WINBUILD_TAG=$(gh api repos/zhongfly/mpv-winbuild/releases/latest --jq .tag_name)
MPV_WINBUILD_ASSET=$(gh api repos/zhongfly/mpv-winbuild/releases/latest --jq '.assets[] | select(.name|test("^mpv-dev-lgpl-x86_64-[0-9]")) | .name' | head -1)
MPV_WINBUILD_SHA256=$(gh api repos/zhongfly/mpv-winbuild/releases/latest --jq ".assets[] | select(.name==\"$MPV_WINBUILD_ASSET\") | .digest" | sed 's/^sha256://')

# Keep the explanatory header, rewrite the values.
HEADER=$(awk '/^# yt-dlp/{exit} {print}' "$LOCK")
{
  echo "$HEADER"
  echo "# yt-dlp — https://github.com/yt-dlp/yt-dlp/releases (hashes from SHA2-256SUMS)"
  echo "YTDLP_VERSION=$YTDLP_VERSION"
  echo "YTDLP_SHA256_MACOS=$(sum_for yt-dlp_macos)"
  echo "YTDLP_SHA256_LINUX=$(sum_for yt-dlp_linux)"
  echo "YTDLP_SHA256_WINDOWS=$(sum_for yt-dlp.exe)"
  echo
  echo "# Deno — https://github.com/denoland/deno/releases (hashes from <asset>.zip.sha256sum)"
  echo "DENO_VERSION=$DENO_VERSION"
  echo "DENO_SHA256_X86_64_APPLE_DARWIN=$(deno_sum x86_64-apple-darwin)"
  echo "DENO_SHA256_AARCH64_APPLE_DARWIN=$(deno_sum aarch64-apple-darwin)"
  echo "DENO_SHA256_X86_64_PC_WINDOWS_MSVC=$(deno_sum x86_64-pc-windows-msvc)"
  echo "DENO_SHA256_X86_64_UNKNOWN_LINUX_GNU=$(deno_sum x86_64-unknown-linux-gnu)"
  echo
  echo "# libmpv-wrapper — https://github.com/nini22P/libmpv-wrapper/releases (GitHub asset digests)"
  echo "LIBMPV_WRAPPER_VERSION=$LIBMPV_WRAPPER_VERSION"
  echo "LIBMPV_WRAPPER_SHA256_MACOS_AARCH64=$(wrapper_sum macos-aarch64)"
  echo "LIBMPV_WRAPPER_SHA256_MACOS_X86_64=$(wrapper_sum macos-x86_64)"
  echo "LIBMPV_WRAPPER_SHA256_WINDOWS_X86_64=$(wrapper_sum windows-x86_64)"
  echo
  echo "# libmpv for Windows — zhongfly's LGPL build, https://github.com/zhongfly/mpv-winbuild/releases"
  echo "MPV_WINBUILD_TAG=$MPV_WINBUILD_TAG"
  echo "MPV_WINBUILD_ASSET=$MPV_WINBUILD_ASSET"
  echo "MPV_WINBUILD_SHA256=$MPV_WINBUILD_SHA256"
  echo
  echo "# libmpv for macOS comes from Homebrew (see scripts/bundle-libmpv-macos.sh),"
  echo "# which has no stable download URL to pin; the exact formula versions used"
  echo "# are recorded into the bundle at resources/lib/VERSIONS.txt at build time."
} > "$LOCK.new"
mv "$LOCK.new" "$LOCK"
echo "Updated $LOCK — review with: git diff scripts/sidecars.lock"
