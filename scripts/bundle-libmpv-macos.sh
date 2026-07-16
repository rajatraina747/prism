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
ARCH=$(uname -m)
case "$ARCH" in
  arm64) WRAPPER_ZIP="libmpv-wrapper-macos-aarch64.zip" ;;
  x86_64) WRAPPER_ZIP="libmpv-wrapper-macos-x86_64.zip" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

rm -rf "$LIB"
mkdir -p "$LIB"

echo "==> Fetching libmpv-wrapper ($ARCH)"
curl -fsSL -o /tmp/libmpv-wrapper.zip \
  "https://github.com/nini22P/libmpv-wrapper/releases/latest/download/${WRAPPER_ZIP}"
unzip -oj /tmp/libmpv-wrapper.zip "bin/libmpv-wrapper.dylib" "LICENSE" -d "$LIB"
mv "$LIB/LICENSE" "$LIB/libmpv-wrapper-LICENSE"

echo "==> Copying libmpv from Homebrew"
BREW_LIBMPV=$(readlink -f "$(brew --prefix)/lib/libmpv.dylib")
cp "$BREW_LIBMPV" "$LIB/libmpv.dylib"
chmod u+w "$LIB/libmpv.dylib"
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
