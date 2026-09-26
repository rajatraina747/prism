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

echo "Prism's own media toolchain…"
# This one Prism publishes itself (.github/workflows/media-toolchain.yml):
# take the newest dated release and the checksums published with it.
PRISM_REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
MEDIA_TAG=$(gh api "repos/$PRISM_REPO/releases" --jq '[.[] | select(.tag_name|startswith("media-toolchain-"))][0].tag_name')
media_asset_id() { gh api "repos/$PRISM_REPO/releases/tags/$MEDIA_TAG" --jq ".assets[] | select(.name==\"$1\") | .id"; }
MEDIA_SUMS=$(gh api -H "Accept: application/octet-stream" "repos/$PRISM_REPO/releases/assets/$(media_asset_id SHA256SUMS.txt)")
media_sum() { echo "$MEDIA_SUMS" | awk -v n="$1" '$2==n{print tolower($1)}'; }

echo "BtbN ffmpeg…"
# The branch tracks the ffmpeg the macOS toolchain builds (scripts/toolchain.lock)
# so a bug report means the same thing on every platform — change it here when
# that moves, not by hand in the lock.
BTBN_BRANCH=8.1
BTBN_TAG=$(gh api repos/BtbN/FFmpeg-Builds/releases --jq '[.[] | select(.tag_name|startswith("autobuild-"))][0].tag_name')
BTBN_SUMS=$(curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/$BTBN_TAG/checksums.sha256")
btbn_asset() { echo "$BTBN_SUMS" | awk -v p="$1" '$2 ~ p {print $2}' | head -1; }
btbn_sum() { echo "$BTBN_SUMS" | awk -v n="$1" '$2==n{print tolower($1)}'; }
BTBN_FFMPEG_WIN64=$(btbn_asset "win64-lgpl-shared-$BTBN_BRANCH\\.zip$")
BTBN_FFMPEG_LINUX64=$(btbn_asset "linux64-lgpl-shared-$BTBN_BRANCH\\.tar\\.xz$")

# Keep the explanatory header, rewrite the values.
HEADER=$(awk '/^# yt-dlp/{exit} {print}' "$LOCK")
{
  echo "$HEADER"
  echo "# yt-dlp — https://github.com/yt-dlp/yt-dlp/releases (hashes from SHA2-256SUMS)"
  echo "YTDLP_VERSION=$YTDLP_VERSION"
  echo "# The \"onedir\" builds (a folder, unpacked once when Prism is installed), not"
  echo "# the one-file ones: those unpack ~70 MB into a temp folder on every single"
  echo "# run, which cost ~5 s per lookup and per download on macOS (REVIEW 2026-09-26)."
  echo "YTDLP_ZIP_SHA256_MACOS=$(sum_for yt-dlp_macos.zip)"
  echo "# Linux keeps the one-file build: linuxdeploy (AppImage) resolves every"
  echo "# library it finds, and the onedir's Python modules only find libpython at"
  echo "# run time, the trap the bundled ffmpeg libraries once fell into."
  echo "YTDLP_SHA256_LINUX=$(sum_for yt-dlp_linux)"
  echo "YTDLP_ZIP_SHA256_WINDOWS=$(sum_for yt-dlp_win.zip)"
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
  echo "# LGPL media toolchain for macOS arm64 — libmpv, ffmpeg and ffprobe built"
  echo "# from pinned sources by scripts/build-media-macos.sh and published by"
  echo "# .github/workflows/media-toolchain.yml. This replaces the Homebrew libmpv"
  echo "# bundle, which had no stable URL to pin and made the macOS build GPL."
  echo "#"
  echo "# prism-media-sources.tar.gz on the same release is the corresponding source"
  echo "# for the LGPL written offer: every upstream tarball byte for byte, next to"
  echo "# the script that patches and builds them. Keep it pinned so the offer can"
  echo "# always be honoured with exactly what these binaries were built from."
  echo "MEDIA_MACOS_ARM64_URL=https://github.com/$PRISM_REPO/releases/download/$MEDIA_TAG/prism-media-macos-arm64.tar.xz"
  echo "MEDIA_MACOS_ARM64_SHA256=$(media_sum prism-media-macos-arm64.tar.xz)"
  echo "MEDIA_MACOS_ARM64_SOURCES_URL=https://github.com/$PRISM_REPO/releases/download/$MEDIA_TAG/prism-media-sources.tar.gz"
  echo "MEDIA_MACOS_ARM64_SOURCES_SHA256=$(media_sum prism-media-sources.tar.gz)"
  echo
  echo "# ffmpeg for Windows and Linux — BtbN's LGPL builds,"
  echo "# https://github.com/BtbN/FFmpeg-Builds (hashes from the release's"
  echo "# checksums.sha256). Pinned to a dated autobuild tag: \`latest\` there is a"
  echo "# rolling tag and would silently change what a release ships."
  echo "#"
  echo "# The $BTBN_BRANCH branch on purpose — it is the same ffmpeg the macOS toolchain"
  echo "# builds, so a bug report means the same thing on every platform. Shared"
  echo "# rather than static: the static build is roughly twice the size for the"
  echo "# same two programs, and the libraries travel with them."
  echo "BTBN_TAG=$BTBN_TAG"
  echo "BTBN_FFMPEG_WIN64=$BTBN_FFMPEG_WIN64"
  echo "BTBN_FFMPEG_WIN64_SHA256=$(btbn_sum "$BTBN_FFMPEG_WIN64")"
  echo "BTBN_FFMPEG_LINUX64=$BTBN_FFMPEG_LINUX64"
  echo "BTBN_FFMPEG_LINUX64_SHA256=$(btbn_sum "$BTBN_FFMPEG_LINUX64")"
} > "$LOCK.new"
mv "$LOCK.new" "$LOCK"
echo "Updated $LOCK — review with: git diff scripts/sidecars.lock"
