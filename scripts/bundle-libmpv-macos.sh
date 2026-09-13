#!/usr/bin/env bash
# Collect the embedded player's native libraries into src-tauri/lib so the
# bundler ships them (tauri.macos.conf.json → resources/lib). Produces a fully
# self-contained tree: libmpv-wrapper.dylib, libmpv.dylib, and every
# transitive dependency, with install names rewritten to @loader_path so
# nothing points at /opt/homebrew on user machines.
#
# Run on macOS with Homebrew mpv + dylibbundler installed (CI does this).
set -euo pipefail

cd "$(dirname "$0")/.."
LIB=src-tauri/lib
# shellcheck source=sidecars.lock
source scripts/sidecars.lock
ARCH=$(uname -m)
case "$ARCH" in
  arm64) WRAPPER_ZIP="libmpv-wrapper-macos-aarch64.zip"; WRAPPER_SHA="$LIBMPV_WRAPPER_SHA256_MACOS_AARCH64" ;;
  x86_64) WRAPPER_ZIP="libmpv-wrapper-macos-x86_64.zip"; WRAPPER_SHA="$LIBMPV_WRAPPER_SHA256_MACOS_X86_64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

rm -rf "$LIB"
mkdir -p "$LIB"

echo "==> Fetching libmpv-wrapper $LIBMPV_WRAPPER_VERSION ($ARCH)"
WRAPPER_TMP=$(mktemp -d)
curl -fsSL --retry 3 -o "$WRAPPER_TMP/wrapper.zip" \
  "https://github.com/nini22P/libmpv-wrapper/releases/download/${LIBMPV_WRAPPER_VERSION}/${WRAPPER_ZIP}"
GOT=$(shasum -a 256 "$WRAPPER_TMP/wrapper.zip" | awk '{print $1}')
if [ "$GOT" != "$WRAPPER_SHA" ]; then
  echo "ERROR: libmpv-wrapper checksum mismatch (expected $WRAPPER_SHA, got $GOT)" >&2
  echo "       Refusing to bundle an unverified library. See scripts/sidecars.lock." >&2
  exit 1
fi
echo "    verified sha256"
unzip -oj "$WRAPPER_TMP/wrapper.zip" "bin/libmpv-wrapper.dylib" "LICENSE" -d "$LIB"
mv "$LIB/LICENSE" "$LIB/libmpv-wrapper-LICENSE"
rm -rf "$WRAPPER_TMP"

echo "==> Copying libmpv from Homebrew"
BREW_LIBMPV=$(readlink -f "$(brew --prefix)/lib/libmpv.dylib")
cp "$BREW_LIBMPV" "$LIB/libmpv.dylib"
chmod u+w "$LIB/libmpv.dylib"

# Homebrew has no pinnable download for mpv, so record exactly what went in.
# Ships inside the bundle (resources/lib/VERSIONS.txt) so a user or a
# licensing question can be answered from the artifact itself.
# The *linked* keg is what libmpv actually loads (/opt/homebrew/opt/<f> →
# Cellar/<f>/<version>); `brew list --versions` is ambiguous when two
# versions of a formula are installed side by side.
keg_of() { readlink -f "$(brew --prefix "$1" 2>/dev/null)" 2>/dev/null || true; }
keg_version() { basename "$(keg_of "$1")"; }
{
  echo "libmpv-wrapper $LIBMPV_WRAPPER_VERSION"
  echo "libmpv (Homebrew) $(keg_version mpv)"
  echo "ffmpeg (Homebrew, via libmpv) $(keg_version ffmpeg)"
  echo "built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$LIB/VERSIONS.txt"
# Rewrite its install-name ID too — nothing links against it (we dlopen), but
# the verification below rightly refuses any /opt/homebrew string in the tree.
install_name_tool -id "@loader_path/libmpv.dylib" "$LIB/libmpv.dylib"

echo "==> Bundling libmpv's dependency tree (dylibbundler)"
# -of overwrite, -cd create dir, -b bundle deps; -p sets the new install
# prefix so every reference resolves relative to the loading dylib.
dylibbundler -of -cd -b \
  -x "$LIB/libmpv.dylib" \
  -d "$LIB" \
  -p "@loader_path/" > /dev/null

# Homebrew ships some dylibs read-only; tauri-build re-copies resources over
# previous copies and fails EACCES on read-only targets. Normalize.
chmod -R u+w "$LIB"

# dylibbundler adds an `@loader_path/` rpath to its `-x` target without
# checking whether Homebrew's original binary already carries one (common —
# Homebrew bottles are increasingly built with relative rpaths for Cellar
# relocatability). Two IDENTICAL LC_RPATH entries make the file entirely
# unloadable: dyld refuses to dlopen a dylib with a duplicate rpath, so the
# player silently failed to start on every launch. Collapse duplicates to one.
echo "==> De-duplicating rpath entries"
for dylib in "$LIB"/*.dylib; do
  while [ "$(otool -l "$dylib" | grep -c 'cmd LC_RPATH')" -gt 1 ]; do
    install_name_tool -delete_rpath "@loader_path/" "$dylib" 2>/dev/null \
      || install_name_tool -delete_rpath "@loader_path" "$dylib"
  done
done

# License compliance: the tree above is (L)GPL-heavy (mpv, FFmpeg, x264,
# x265, rubberband, …). Ship every formula's license text with the app so
# the bundle carries the notices those licenses require, plus a manifest of
# what came from where. mpv's runtime dependency closure from Homebrew is
# exactly the set dylibbundler just copied.
echo "==> Collecting license texts (resources/lib/licenses)"
LICDIR="$LIB/licenses"
mkdir -p "$LICDIR"
{
  echo "Third-party components bundled with Prism's embedded player (macOS)."
  echo "One directory per Homebrew formula; versions as linked at build time."
  echo
} > "$LICDIR/MANIFEST.txt"
# Full recursive dependency list (not --installed, which can omit formulae
# that have several versions installed); formulae without a linked keg are
# skipped — they weren't bundled either.
for formula in mpv $(brew deps mpv); do
  keg=$(keg_of "$formula")
  [ -n "$keg" ] && [ -d "$keg" ] || continue
  ver=$(basename "$keg")
  dest="$LICDIR/$formula"
  mkdir -p "$dest"
  found=0
  for f in "$keg"/LICENSE* "$keg"/COPYING* "$keg"/Copyright* "$keg"/COPYRIGHT* "$keg"/LICENCE* "$keg"/NOTICE*; do
    [ -f "$f" ] || continue
    cp "$f" "$dest/"
    found=1
  done
  lic=$(brew info --json=v2 "$formula" 2>/dev/null | /usr/bin/python3 -c 'import json,sys; d=json.load(sys.stdin)["formulae"][0]; print(d.get("license") or "unknown")' 2>/dev/null || echo unknown)
  echo "$formula $ver — $lic$( [ $found = 1 ] || echo ' (no license file in keg; see homepage)')" >> "$LICDIR/MANIFEST.txt"
done
cp "$LIB/libmpv-wrapper-LICENSE" "$LICDIR/libmpv-wrapper-LICENSE.txt"
echo "libmpv-wrapper $LIBMPV_WRAPPER_VERSION — LGPL-2.1" >> "$LICDIR/MANIFEST.txt"
cp LICENSE "$LICDIR/Prism-LICENSE.txt"
echo "    $(find "$LICDIR" -type f | wc -l | tr -d ' ') license files"

echo "==> Ad-hoc signing the tree"
find "$LIB" -name "*.dylib" -exec codesign --force --sign - {} \;

echo "==> Verifying no /opt/homebrew or /usr/local references remain"
BAD=$(find "$LIB" -name "*.dylib" -exec otool -L {} \; | grep -E "/opt/homebrew|/usr/local" || true)
if [ -n "$BAD" ]; then
  echo "ERROR: unresolved external references:" >&2
  echo "$BAD" >&2
  exit 1
fi

COUNT=$(find "$LIB" -name "*.dylib" | wc -l | tr -d ' ')
SIZE=$(du -sh "$LIB" | cut -f1)
echo "==> Done: $COUNT dylibs, $SIZE in $LIB"
