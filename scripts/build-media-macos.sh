#!/usr/bin/env bash
# Build Prism's LGPL media toolchain for macOS arm64 from pinned sources:
#   - a shared libmpv (libplacebo on Vulkan via MoltenVK, libass, lcms2, zimg,
#     dav1d) for the embedded player, and
#   - static ffmpeg and ffprobe command-line tools for yt-dlp.
#
# Nothing GPL or non-free goes in: ffmpeg is configured without
# --enable-gpl/--enable-nonfree and mpv with -Dgpl=false. The gates at the end
# check that on the built binaries, not on the flags.
#
#   scripts/build-media-macos.sh <out-dir>
#
# Every source is verified against scripts/toolchain.lock. With
# PRISM_TOOLCHAIN_BOOTSTRAP=1, an empty pin is computed and printed instead (to
# fill in the lock), and the script exits non-zero at the end, so a bootstrap
# build can never be shipped.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mkdir -p "${1:?usage: $0 <out-dir>}" && cd "$1" && pwd)"
# shellcheck source=toolchain.lock
source "$ROOT/scripts/toolchain.lock"

WORK="${PRISM_MEDIA_WORK:-$ROOT/.media-build}"
SRC="$WORK/src"
BUILD="$WORK/build"
PREFIX="$WORK/prefix"
mkdir -p "$SRC" "$BUILD" "$PREFIX"

export MACOSX_DEPLOYMENT_TARGET=13.0
export LIBRARY_PATH="$PREFIX/lib"
export CPATH="$PREFIX/include"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PATH="$PREFIX/bin:$PATH"
export CFLAGS="-O2 -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -I$PREFIX/include"
export CXXFLAGS="$CFLAGS"
export LDFLAGS="-mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -L$PREFIX/lib"
JOBS="$(sysctl -n hw.ncpu)"

UNPINNED=()

sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }

# fetch <name> <url> <expected-sha256 or empty>  → unpacked into $SRC/<name>
fetch() {
  local name=$1 url=$2 want=$3 file got
  file="$SRC/$name-$(basename "${url%%\?*}")"
  if [ ! -f "$file" ]; then
    echo "→ $name: $url"
    curl -fsSL --retry 3 --retry-delay 3 -o "$file" "$url"
  fi
  got=$(sha256_of "$file")
  if [ -z "$want" ]; then
    if [ "${PRISM_TOOLCHAIN_BOOTSTRAP:-0}" = 1 ]; then
      echo "  PIN $name $got"
      UNPINNED+=("$name=$got")
    else
      echo "✗ $name has no pin in scripts/toolchain.lock" >&2
      exit 1
    fi
  elif [ "$got" != "$want" ]; then
    echo "✗ SHA-256 mismatch for $name: expected $want, got $got" >&2
    exit 1
  fi
  rm -rf "${SRC:?}/$name"
  mkdir -p "$SRC/$name"
  case "$file" in
    *.tar.gz|*.tgz|*.tar.xz|*.tar.bz2|*.tar) tar -xf "$file" -C "$SRC/$name" --strip-components 1 ;;
    *) echo "unknown archive: $file" >&2; exit 1 ;;
  esac
}

meson_build() { # <name> [meson options…]
  local name=$1; shift
  meson setup "$BUILD/$name" "$SRC/$name" --prefix="$PREFIX" --libdir=lib --buildtype=release \
    --default-library=static -Dprefer_static=true "$@"
  meson compile -C "$BUILD/$name" -j "$JOBS"
  meson install -C "$BUILD/$name"
}

cmake_build() { # <name> [cmake options…]
  local name=$1; shift
  cmake -S "$SRC/$name" -B "$BUILD/$name" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET" -DCMAKE_OSX_ARCHITECTURES=arm64 "$@"
  cmake --build "$BUILD/$name" -j "$JOBS"
  cmake --install "$BUILD/$name"
}

autotools_build() { # <name> [configure options…]
  local name=$1; shift
  (cd "$SRC/$name" && ./configure --prefix="$PREFIX" --disable-shared --enable-static "$@" && make -j "$JOBS" && make install)
}

# Point libplacebo's two undirected glslang probes at the build prefix. The
# path is written out rather than reusing libplacebo's own vulkan_lib_dirs:
# the resource-limits probe runs before that variable is assigned, so naming
# it there is a meson error. -Dvulkan-sdk is this same prefix, so the two are
# the same directory either way.
patch_libplacebo_glslang() {
  local file="$SRC/libplacebo/src/glsl/meson.build" patched
  perl -pi -e "s{cxx\.find_library\('glslang-default-resource-limits', required: false\)}{cxx.find_library('glslang-default-resource-limits', required: false, dirs: ['$PREFIX/lib'])}; s{cxx\.find_library\('glslang', required: required, static: static\)}{cxx.find_library('glslang', required: required, static: static, dirs: ['$PREFIX/lib'])}" "$file"
  patched=$(grep -cF "dirs: ['" "$file")
  if [ "$patched" -ne 2 ]; then
    echo "✗ libplacebo's glslang probes are not the shape this patch expects" >&2
    exit 1
  fi
  echo "    patched libplacebo's glslang probes"
}

echo "== Sources =="
fetch dav1d "$DAV1D_URL" "$DAV1D_SHA256"
fetch opus "$OPUS_URL" "$OPUS_SHA256"
fetch lame "$LAME_URL" "$LAME_SHA256"
fetch freetype "$FREETYPE_URL" "$FREETYPE_SHA256"
fetch fribidi "$FRIBIDI_URL" "$FRIBIDI_SHA256"
fetch harfbuzz "$HARFBUZZ_URL" "$HARFBUZZ_SHA256"
fetch libass "$LIBASS_URL" "$LIBASS_SHA256"
fetch lcms2 "$LCMS2_URL" "$LCMS2_SHA256"
fetch zimg "$ZIMG_URL" "$ZIMG_SHA256"
fetch vulkan-headers "$VULKAN_HEADERS_URL" "$VULKAN_HEADERS_SHA256"
fetch vulkan-loader "$VULKAN_LOADER_URL" "$VULKAN_LOADER_SHA256"
fetch glslang "$GLSLANG_URL" "$GLSLANG_SHA256"
fetch moltenvk "$MOLTENVK_URL" "$MOLTENVK_SHA256"
fetch libplacebo "$LIBPLACEBO_URL" "$LIBPLACEBO_SHA256"
fetch ffmpeg "$FFMPEG_URL" "$FFMPEG_SHA256"
fetch mpv "$MPV_URL" "$MPV_SHA256"

echo "== Codecs and text =="
meson_build dav1d -Denable_tools=false -Denable_tests=false
autotools_build opus --disable-doc --disable-extra-programs
autotools_build lame --disable-frontend --disable-decoder
meson_build freetype -Dharfbuzz=disabled -Dbrotli=disabled -Dpng=disabled -Dbzip2=disabled
meson_build fribidi -Ddocs=false -Dbin=false -Dtests=false
meson_build harfbuzz -Dfreetype=enabled -Dglib=disabled -Dgobject=disabled -Dcairo=disabled \
  -Dicu=disabled -Dtests=disabled -Ddocs=disabled
meson_build libass -Dfontconfig=disabled
autotools_build lcms2
(cd "$SRC/zimg" && ./autogen.sh)
autotools_build zimg

echo "== Vulkan =="
cmake_build vulkan-headers
cmake_build glslang -DENABLE_OPT=OFF -DGLSLANG_TESTS=OFF -DBUILD_SHARED_LIBS=OFF -DENABLE_GLSLANG_BINARIES=OFF
cmake_build vulkan-loader -DVULKAN_HEADERS_INSTALL_DIR="$PREFIX" -DBUILD_TESTS=OFF
mkdir -p "$PREFIX/share/vulkan/icd.d"
MVK_DYLIB="$(find "$SRC/moltenvk" -path '*dylib/macOS/libMoltenVK.dylib' | head -1)"
MVK_ICD="$(find "$SRC/moltenvk" -path '*dylib/macOS/MoltenVK_icd.json' | head -1)"
[ -n "$MVK_DYLIB" ] && [ -n "$MVK_ICD" ] || { echo "✗ MoltenVK release layout changed" >&2; exit 1; }
cp "$MVK_DYLIB" "$PREFIX/lib/"
cp "$MVK_ICD" "$PREFIX/share/vulkan/icd.d/"

echo "== libplacebo =="
# meson goes in the venv alongside libplacebo's build-time Python modules, and
# meson_build picks it up from PATH below. libplacebo asks meson for a Python
# interpreter, and meson answers with the one it is itself running under — so a
# system meson would look for jinja2 in the system Python and not find it, no
# matter what the venv on PATH holds.
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install --quiet meson ninja jinja2 glad2
# libplacebo passes its search directory to the SPIRV probe but not to the
# glslang ones, and meson's find_library reads only the compiler's built-in
# paths plus a probe's own dirs:. LIBRARY_PATH, link arguments and a -L baked
# into the compiler all fail to reach it (the last also fails compile-only
# probes, which clang rejects for an unused -L). So give those two probes the
# same directory every other one gets.
patch_libplacebo_glslang
PATH="$WORK/venv/bin:$PATH" meson_build libplacebo -Dvulkan=enabled -Dvulkan-sdk="$PREFIX" \
  -Dvulkan-registry="$PREFIX/share/vulkan/registry/vk.xml" -Dglslang=enabled -Dshaderc=disabled \
  -Dopengl=disabled -Dd3d11=disabled -Dlcms=enabled -Ddovi=disabled -Dlibdovi=disabled \
  -Ddemos=false -Dtests=false

echo "== FFmpeg (LGPL) =="
(cd "$SRC/ffmpeg" && ./configure --prefix="$PREFIX" \
  --disable-gpl --disable-nonfree --disable-shared --enable-static \
  --disable-doc --disable-ffplay --disable-sdl2 --disable-xlib --disable-libxcb \
  --enable-videotoolbox --enable-audiotoolbox \
  --enable-libdav1d --enable-libopus --enable-libmp3lame \
  --pkg-config-flags=--static \
  --extra-cflags="$CFLAGS -I$PREFIX/include" --extra-ldflags="$LDFLAGS -L$PREFIX/lib" \
  && make -j "$JOBS" && make install)

echo "== libmpv (LGPL) =="
meson setup "$BUILD/mpv" "$SRC/mpv" --prefix="$PREFIX" --libdir=lib --buildtype=release \
  --default-library=shared -Dprefer_static=true \
  -Dgpl=false -Dlibmpv=true -Dcplayer=false -Dbuild-date=false \
  -Dlua=disabled -Djavascript=disabled -Dlibarchive=disabled -Dlibbluray=disabled \
  -Ddvdnav=disabled -Dcdda=disabled -Duchardet=disabled -Drubberband=disabled \
  -Dvapoursynth=disabled -Dzimg=enabled -Dlcms2=enabled -Dvulkan=enabled \
  -Dmanpage-build=disabled -Dswift-build=enabled -Dmacos-media-player=disabled
meson compile -C "$BUILD/mpv" -j "$JOBS"
meson install -C "$BUILD/mpv"

echo "== Package =="
rm -rf "${OUT:?}"/*
mkdir -p "$OUT/lib/vulkan/icd.d" "$OUT/bin" "$OUT/licenses"
cp -L "$PREFIX/lib/libmpv.2.dylib" "$OUT/lib/libmpv.dylib"
cp -L "$PREFIX/lib/libvulkan.1.dylib" "$OUT/lib/"
cp "$PREFIX/lib/libMoltenVK.dylib" "$OUT/lib/"
# The ICD manifest points at the driver relative to itself.
sed 's|"library_path": *"[^"]*"|"library_path": "../../libMoltenVK.dylib"|' \
  "$PREFIX/share/vulkan/icd.d/MoltenVK_icd.json" > "$OUT/lib/vulkan/icd.d/MoltenVK_icd.json"
cp "$PREFIX/bin/ffmpeg" "$PREFIX/bin/ffprobe" "$OUT/bin/"

for dylib in "$OUT"/lib/*.dylib; do
  install_name_tool -id "@loader_path/$(basename "$dylib")" "$dylib"
  otool -L "$dylib" | awk 'NR>1 {print $1}' | while read -r dep; do
    case "$dep" in
      "$PREFIX"/lib/libvulkan*) install_name_tool -change "$dep" "@loader_path/libvulkan.1.dylib" "$dylib" ;;
      "$PREFIX"/*) install_name_tool -change "$dep" "@loader_path/$(basename "$dep")" "$dylib" ;;
    esac
  done
done
find "$OUT" -type f \( -name '*.dylib' -o -path '*/bin/*' \) -exec codesign --force --sign - {} \;

{
  echo "Prism media toolchain (macOS arm64, LGPL) — built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  grep -E '_URL=' "$ROOT/scripts/toolchain.lock" | sed 's/_URL=/ /'
} > "$OUT/VERSIONS.txt"
for component in mpv ffmpeg libplacebo libass freetype fribidi harfbuzz lcms2 zimg dav1d opus lame glslang vulkan-loader moltenvk; do
  for f in "$SRC/$component"/COPYING* "$SRC/$component"/LICENSE* "$SRC/$component"/LICENCE*; do
    [ -f "$f" ] && mkdir -p "$OUT/licenses/$component" && cp "$f" "$OUT/licenses/$component/"
  done
done

echo "== Gates =="
fail=0
buildconf="$("$OUT/bin/ffmpeg" -hide_banner -buildconf)"
if echo "$buildconf" | grep -qE -- '--enable-(gpl|nonfree)'; then echo "✗ ffmpeg was built with GPL or non-free code"; fail=1; fi
if "$OUT/bin/ffmpeg" -hide_banner -L | grep -qiE 'GNU General Public License'; then echo "✗ ffmpeg reports a GPL license"; fail=1; fi
bad_links="$(find "$OUT" -type f \( -name '*.dylib' -o -path '*/bin/*' \) -exec otool -L {} \; | grep -E "/opt/homebrew|/usr/local|$WORK" || true)"
if [ -n "$bad_links" ]; then echo "✗ unresolved build-machine paths:"; echo "$bad_links"; fail=1; fi
if find "$OUT" -type f -exec otool -L {} \; 2>/dev/null | grep -qiE 'x264|x265|rubberband|postproc'; then echo "✗ GPL library linked"; fail=1; fi
for dylib in "$OUT"/lib/*.dylib; do
  if [ "$(otool -l "$dylib" | grep -c 'cmd LC_RPATH')" -gt 1 ]; then echo "✗ duplicate LC_RPATH in $dylib"; fail=1; fi
done
"$OUT/bin/ffprobe" -hide_banner -version | head -1

if [ "${#UNPINNED[@]}" -gt 0 ]; then
  echo "== Pins to add to scripts/toolchain.lock =="
  printf '%s\n' "${UNPINNED[@]}"
  echo "✗ bootstrap build — not for release"
  fail=1
fi
[ "$fail" = 0 ] && echo "== toolchain OK: $OUT ==" || exit 1
