#!/usr/bin/env bash
# Fetch the pinned, checksum-verified third-party binaries Prism bundles.
#
#   scripts/fetch-sidecars.sh <macos|windows|linux> [--player]
#
# Reads scripts/sidecars.lock, downloads the exact release assets it names,
# verifies every file's SHA-256 against the lock, and places them where
# tauri.conf.json expects them (src-tauri/binaries for sidecars,
# src-tauri/ytdlp for yt-dlp's onedir build, src-tauri/lib for the embedded
# player's libraries). A mismatch aborts.
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

# BtbN's LGPL ffmpeg builds for Windows and Linux; macOS gets ffmpeg from the
# toolchain Prism builds itself (see the player section below).
BTBN_BASE="https://github.com/BtbN/FFmpeg-Builds/releases/download/$BTBN_TAG"
YTDLP_BASE="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"
DENO_BASE="https://github.com/denoland/deno/releases/download/$DENO_VERSION"

# stage_ffmpeg <archive> — unpack one of BtbN's builds and put ffmpeg, ffprobe
# and the libraries they need under $LIB, in the same shape macOS uses, so
# find_ffmpeg looks in one place on every platform (resources/lib/bin).
#
# The binaries are located rather than assumed: if upstream rearranges its
# archive this fails loudly instead of quietly bundling nothing.
stage_ffmpeg() {
  local archive=$1 tmp found bindir libdir
  tmp=$(mktemp -d)
  case "$archive" in
    *.zip)
      if command -v unzip >/dev/null 2>&1; then unzip -q -o "$archive" -d "$tmp"
      else 7z x -y -o"$tmp" "$archive" >/dev/null; fi ;;
    *.tar.xz) tar -xJf "$archive" -C "$tmp" ;;
    *) echo "unknown archive type: $archive" >&2; exit 1 ;;
  esac

  found=$(find "$tmp" -type f \( -name ffmpeg -o -name ffmpeg.exe \) | head -1)
  if [ -z "$found" ]; then
    echo "✗ no ffmpeg inside $(basename "$archive") — has the archive layout changed?" >&2
    exit 1
  fi
  bindir=$(dirname "$found")

  mkdir -p "$LIB/bin"
  # Everything beside it (on Windows that is the DLLs a shared build needs),
  # minus ffplay, which Prism never runs.
  find "$bindir" -maxdepth 1 -type f ! -name 'ffplay*' -exec cp {} "$LIB/bin/" \;
  chmod +x "$LIB"/bin/* 2>/dev/null || true

  # A shared build on Linux keeps its libraries in a sibling lib/ and finds
  # them through an $ORIGIN/../lib rpath, so that relationship has to survive
  # the copy: resources/lib/bin/ffmpeg then resolves resources/lib/lib.
  libdir="$(dirname "$bindir")/lib"
  if [ -d "$libdir" ]; then
    mkdir -p "$LIB/lib"
    find "$libdir" -maxdepth 1 -name '*.so*' -exec cp -a {} "$LIB/lib/" \;

    # These libraries reference each other by bare soname — libswscale.so.9
    # needs libavutil.so.60 — and carry no RUNPATH of their own. At runtime
    # that is fine, because the loader is searching on behalf of ffmpeg and
    # ffmpeg's own $ORIGIN/../lib rpath covers the whole set.
    #
    # linuxdeploy does not work that way. It walks every ELF in the AppDir and
    # resolves each one's dependencies in isolation, with no executable's rpath
    # in play, so libswscale.so.9 sends it looking for libavutil.so.60 on the
    # system, where a bundled ffmpeg's libraries are of course not installed.
    # It then fails the entire AppImage:
    #
    #     ERROR: Could not find dependency: libavutil.so.60
    #     ERROR: Failed to deploy dependencies for existing files
    #
    # and tauri reports only `failed to run linuxdeploy` (v2.0.0-rc.1 and
    # rc.2). Giving each library $ORIGIN makes the sibling lookup succeed for
    # linuxdeploy and the loader alike, and resolves to these same files rather
    # than to a second copy deployed into usr/lib. Only the real files are
    # patched: the version symlinks beside them would be replaced by regular
    # files, and the chain is what the sonames point at.
    if [ "$PLATFORM" = linux ]; then
      if ! command -v patchelf >/dev/null 2>&1; then
        echo "✗ patchelf is needed to stage the Linux ffmpeg libraries" >&2
        exit 1
      fi
      find "$LIB/lib" -maxdepth 1 -type f -name '*.so*' \
        -exec patchelf --set-rpath '$ORIGIN' {} \;
    fi
  fi
  rm -rf "$tmp"
}
# stage_ytdlp <asset> <sha> <executable-in-zip> — yt-dlp's onedir build,
# unpacked into src-tauri/ytdlp with its executable renamed yt-dlp[.exe]; the
# bundle ships that folder as a resource (engine.rs finds it there).
YTDLP_DIR="$ROOT/src-tauri/ytdlp"
stage_ytdlp() {
  local asset=$1 sha=$2 exe=$3 ext=""
  case "$exe" in *.exe) ext=".exe" ;; esac
  fetch "$YTDLP_BASE/$asset" "$TMP/$asset" "$sha"
  rm -rf "$YTDLP_DIR"
  mkdir -p "$YTDLP_DIR"
  if command -v unzip >/dev/null 2>&1; then unzip -q -o "$TMP/$asset" -d "$YTDLP_DIR"
  else 7z x -y -o"$YTDLP_DIR" "$TMP/$asset" >/dev/null; fi
  if [ ! -f "$YTDLP_DIR/$exe" ] || [ ! -d "$YTDLP_DIR/_internal" ]; then
    echo "✗ $asset isn't laid out as $exe + _internal/ — has the archive changed?" >&2
    exit 1
  fi
  mv "$YTDLP_DIR/$exe" "$YTDLP_DIR/yt-dlp$ext"
  chmod +x "$YTDLP_DIR/yt-dlp$ext"
  # The one-file sidecars earlier builds used; nothing bundles them now.
  rm -f "$BIN"/yt-dlp-*
  echo "✓ yt-dlp $YTDLP_VERSION staged in src-tauri/ytdlp"
}

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
    # yt-dlp_macos is universal2 — the same folder serves both architectures.
    stage_ytdlp yt-dlp_macos.zip "$YTDLP_ZIP_SHA256_MACOS" yt-dlp_macos
    fetch_deno aarch64-apple-darwin "$DENO_SHA256_AARCH64_APPLE_DARWIN"
    fetch_deno x86_64-apple-darwin "$DENO_SHA256_X86_64_APPLE_DARWIN"
    ;;
  windows)
    stage_ytdlp yt-dlp_win.zip "$YTDLP_ZIP_SHA256_WINDOWS" yt-dlp.exe
    fetch_deno x86_64-pc-windows-msvc "$DENO_SHA256_X86_64_PC_WINDOWS_MSVC"
    ;;
  linux)
    stage_ytdlp yt-dlp_linux.zip "$YTDLP_ZIP_SHA256_LINUX" yt-dlp_linux
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
      fetch "$BTBN_BASE/$BTBN_FFMPEG_WIN64" "$TMP/ffmpeg-win64.zip" "$BTBN_FFMPEG_WIN64_SHA256"
      stage_ffmpeg "$TMP/ffmpeg-win64.zip"
      {
        echo "libmpv-wrapper $LIBMPV_WRAPPER_VERSION"
        echo "libmpv (zhongfly/mpv-winbuild, LGPL build) $MPV_WINBUILD_ASSET"
        echo "ffmpeg (BtbN LGPL build) $BTBN_FFMPEG_WIN64"
      } > "$LIB/VERSIONS.txt"
      ;;
    linux)
      # No embedded player on Linux yet, but ffmpeg is bundled all the same, so
      # merging and audio extraction don't depend on what the distro ships.
      mkdir -p "$LIB"
      fetch "$BTBN_BASE/$BTBN_FFMPEG_LINUX64" "$TMP/ffmpeg-linux64.tar.xz" "$BTBN_FFMPEG_LINUX64_SHA256"
      stage_ffmpeg "$TMP/ffmpeg-linux64.tar.xz"
      echo "ffmpeg (BtbN LGPL build) $BTBN_FFMPEG_LINUX64" > "$LIB/VERSIONS.txt"
      ;;
  esac
fi

echo "== done =="
