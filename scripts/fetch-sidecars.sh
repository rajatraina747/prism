#!/usr/bin/env bash
# Fetch the pinned, checksum-verified third-party binaries Prism bundles.
#
#   scripts/fetch-sidecars.sh <macos|windows|linux> [--player]
#
# Reads scripts/sidecars.lock, downloads the exact release assets it names,
# verifies every file's SHA-256 against the lock, and places them where
# tauri.conf.json expects them (src-tauri/binaries for sidecars,
# src-tauri/lib for the embedded player's libraries). A mismatch aborts.
#
# --player also assembles the embedded-player libraries (macOS: via
# scripts/bundle-libmpv-macos.sh; Windows: wrapper DLL + LGPL libmpv).
# Linux has no player build yet.
#
# Works in bash on every CI runner (macOS, Windows via Git bash, Linux).
set -euo pipefail

PLATFORM="${1:-}"
WITH_PLAYER=0
if [ "${2:-}" = "--player" ]; then WITH_PLAYER=1; fi
case "$PLATFORM" in
  macos|windows|linux) ;;
  *) echo "usage: $0 <macos|windows|linux> [--player]" >&2; exit 2 ;;
esac

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=sidecars.lock
source "$ROOT/scripts/sidecars.lock"
BIN="$ROOT/src-tauri/binaries"
LIB="$ROOT/src-tauri/lib"
mkdir -p "$BIN"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# fetch <url> <dest> <expected-sha256>
fetch() {
  local url=$1 dest=$2 want=$3 got tmp
  echo "→ $url"
  # Download beside the destination and move it into place only once it has
  # been verified. Writing straight to the destination meant a connection that
  # dropped mid-transfer left a truncated binary sitting there looking like a
  # finished one — which a later build would happily bundle.
  tmp="$dest.part"
  rm -f "$tmp"
  if ! curl -fsSL --retry 3 --retry-delay 2 -o "$tmp" "$url"; then
    rm -f "$tmp"
    echo "✗ could not download $(basename "$dest") from $url" >&2
    exit 1
  fi
  got=$(sha256_of "$tmp")
  if [ "$got" != "$want" ]; then
    echo "✗ SHA-256 mismatch for $(basename "$dest")" >&2
    echo "    expected $want" >&2
    echo "    got      $got" >&2
    echo "  Refusing to build with an unverified binary. If upstream re-published the" >&2
    echo "  asset, re-run scripts/update-sidecars.sh, review the diff and commit." >&2
    rm -f "$tmp"
    exit 1
  fi
  mv -f "$tmp" "$dest"
  echo "✓ $(basename "$dest") verified"
}

# extract_member <archive> <member-path-inside> <dest-file>
extract_member() {
  local archive=$1 member=$2 dest=$3 tmp
  tmp=$(mktemp -d)
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then unzip -q -o "$archive" -d "$tmp"
      else 7z x -y -o"$tmp" "$archive" >/dev/null; fi ;;
    *.7z) 7z x -y -o"$tmp" "$archive" >/dev/null ;;
    *) echo "unknown archive type: $archive" >&2; exit 1 ;;
  esac
  mv "$tmp/$member" "$dest"
  rm -rf "$tmp"
}

YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"
DENO_BASE="https://github.com/denoland/deno/releases/download/$DENO_VERSION"
WRAPPER_BASE="https://github.com/nini22P/libmpv-wrapper/releases/download/$LIBMPV_WRAPPER_VERSION"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch_deno() { # <triple> <sha>
  local triple=$1 sha=$2 ext=""
  case "$triple" in *windows*) ext=".exe" ;; esac
  fetch "$DENO_BASE/deno-$triple.zip" "$TMP/deno-$triple.zip" "$sha"
  extract_member "$TMP/deno-$triple.zip" "deno$ext" "$BIN/deno-$triple$ext"
  chmod +x "$BIN/deno-$triple$ext"
}

echo "== Sidecars for $PLATFORM (yt-dlp $YTDLP_VERSION, Deno $DENO_VERSION) =="
case "$PLATFORM" in
  macos)
    # yt-dlp_macos is a universal2 binary — the same file serves both triples.
    fetch "$YTDLP_BASE/yt-dlp_macos" "$BIN/yt-dlp-aarch64-apple-darwin" "$YTDLP_SHA256_MACOS"
    cp "$BIN/yt-dlp-aarch64-apple-darwin" "$BIN/yt-dlp-x86_64-apple-darwin"
    chmod +x "$BIN"/yt-dlp-*-apple-darwin
    fetch_deno aarch64-apple-darwin "$DENO_SHA256_AARCH64_APPLE_DARWIN"
    fetch_deno x86_64-apple-darwin "$DENO_SHA256_X86_64_APPLE_DARWIN"
    ;;
  windows)
    fetch "$YTDLP_BASE/yt-dlp.exe" "$BIN/yt-dlp-x86_64-pc-windows-msvc.exe" "$YTDLP_SHA256_WINDOWS"
    fetch_deno x86_64-pc-windows-msvc "$DENO_SHA256_X86_64_PC_WINDOWS_MSVC"
    ;;
  linux)
    fetch "$YTDLP_BASE/yt-dlp_linux" "$BIN/yt-dlp-x86_64-unknown-linux-gnu" "$YTDLP_SHA256_LINUX"
    chmod +x "$BIN/yt-dlp-x86_64-unknown-linux-gnu"
    fetch_deno x86_64-unknown-linux-gnu "$DENO_SHA256_X86_64_UNKNOWN_LINUX_GNU"
    ;;
esac

if [ "$WITH_PLAYER" = 1 ]; then
  echo "== Embedded player libraries for $PLATFORM =="
  case "$PLATFORM" in
    macos)
      # Intel Macs have no published LGPL toolchain yet, and a local build
      # sometimes wants Homebrew's copy. That path is GPL — never a release.
      if [ "${PRISM_LIBMPV_FROM_BREW:-0}" = 1 ] || [ "$(uname -m)" != "arm64" ]; then
        echo "(Homebrew libmpv — GPL, not for release)"
        "$ROOT/scripts/bundle-libmpv-macos.sh"
      else
        # The LGPL toolchain built from pinned sources by
        # .github/workflows/media-toolchain.yml: libmpv with its Vulkan driver,
        # plus ffmpeg and ffprobe. Everything inside already points at
        # @loader_path and carries one rpath — the build gated on that.
        rm -rf "$LIB"
        mkdir -p "$LIB"
        fetch "$MEDIA_MACOS_ARM64_URL" "$TMP/prism-media.tar.xz" "$MEDIA_MACOS_ARM64_SHA256"
        tar -xJf "$TMP/prism-media.tar.xz" -C "$TMP"
        cp -R "$TMP/prism-media/lib/." "$LIB/"
        # ffmpeg and ffprobe ride along as resources rather than Tauri
        # sidecars: externalBin is shared with Windows and Linux, whose LGPL
        # builds aren't pinned yet, and naming them there would break both.
        mkdir -p "$LIB/bin"
        cp "$TMP/prism-media/bin/ffmpeg" "$TMP/prism-media/bin/ffprobe" "$LIB/bin/"
        chmod +x "$LIB/bin/ffmpeg" "$LIB/bin/ffprobe"
        cp -R "$TMP/prism-media/licenses" "$LIB/licenses"
        # The wrapper the vendored plugin loads libmpv through is built
        # separately from the media toolchain, so it is still fetched here.
        fetch "$WRAPPER_BASE/libmpv-wrapper-macos-aarch64.zip" "$TMP/wrapper.zip" \
          "$LIBMPV_WRAPPER_SHA256_MACOS_AARCH64"
        extract_member "$TMP/wrapper.zip" "bin/libmpv-wrapper.dylib" "$LIB/libmpv-wrapper.dylib"
        extract_member "$TMP/wrapper.zip" "LICENSE" "$LIB/libmpv-wrapper-LICENSE"
        {
          echo "libmpv-wrapper $LIBMPV_WRAPPER_VERSION"
          cat "$TMP/prism-media/VERSIONS.txt"
        } > "$LIB/VERSIONS.txt"
        # The gate the bundle script used to enforce, kept: nothing in a
        # release may resolve to a library on the build machine.
        if otool -L "$LIB"/*.dylib "$LIB"/bin/* 2>/dev/null | grep -qE "/opt/homebrew|/usr/local/(lib|opt)"; then
          echo "✗ bundled media libraries still reference the build machine" >&2
          exit 1
        fi
      fi
      ;;
    windows)
      mkdir -p "$LIB"
      fetch "$WRAPPER_BASE/libmpv-wrapper-windows-x86_64.zip" "$TMP/wrapper.zip" "$LIBMPV_WRAPPER_SHA256_WINDOWS_X86_64"
      extract_member "$TMP/wrapper.zip" "bin/libmpv-wrapper.dll" "$LIB/libmpv-wrapper.dll"
      extract_member "$TMP/wrapper.zip" "LICENSE" "$LIB/libmpv-wrapper-LICENSE"
      # Both DLLs must sit in the same directory: the wrapper resolves libmpv by
      # bare name, and the vendored plugin pre-loads it from beside the wrapper.
      fetch "https://github.com/zhongfly/mpv-winbuild/releases/download/$MPV_WINBUILD_TAG/$MPV_WINBUILD_ASSET" \
        "$TMP/mpv-dev.7z" "$MPV_WINBUILD_SHA256"
      extract_member "$TMP/mpv-dev.7z" "libmpv-2.dll" "$LIB/libmpv-2.dll"
      {
        echo "libmpv-wrapper $LIBMPV_WRAPPER_VERSION"
        echo "libmpv (zhongfly/mpv-winbuild, LGPL build) $MPV_WINBUILD_ASSET"
      } > "$LIB/VERSIONS.txt"
      ;;
    linux)
      echo "(no embedded player on Linux yet — skipping)"
      ;;
  esac
fi

echo "== done =="
