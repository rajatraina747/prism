import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel, OutboundLink } from '@/components/common';
import { ArrowLeft, ExternalLink } from 'lucide-react';

interface Credit {
  name: string;
  version: string;
  license: string;
  url: string;
}

interface CreditGroup {
  title: string;
  note?: string;
  items: readonly Credit[];
}

// Keep in step with what actually ships: package.json / Cargo.toml for the
// app, scripts/sidecars.lock for the sidecars, and the dylib set produced by
// scripts/bundle-libmpv-macos.sh (resources/lib) for the macOS player.
const GROUPS: readonly CreditGroup[] = [
  {
    title: 'Download engines and sidecars',
    note: 'Separate programs bundled alongside Prism and run as child processes.',
    items: [
      { name: 'yt-dlp', version: 'pinned in scripts/sidecars.lock; self-updatable', license: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp' },
      { name: 'Deno', version: 'pinned in scripts/sidecars.lock', license: 'MIT', url: 'https://github.com/denoland/deno' },
      { name: 'librqbit', version: '9.x (embedded BitTorrent engine)', license: 'Apache-2.0', url: 'https://github.com/ikatson/rqbit' },
      { name: 'FFmpeg (your installation)', version: 'not bundled — used from your system when present', license: 'LGPL-2.1+ / GPL-2.0+', url: 'https://ffmpeg.org' },
    ],
  },
  {
    title: 'Embedded player',
    note: 'The macOS build bundles mpv from Homebrew, which links GPL-licensed codecs (x264, x265, rubberband) and a GPL-enabled FFmpeg. The macOS binary as a whole is therefore distributed under GPL-2.0-or-later terms; the Windows build uses an LGPL-only mpv. Full license texts ship in the app under resources/lib/licenses, and the exact versions used are recorded in resources/lib/VERSIONS.txt.',
    items: [
      { name: 'mpv / libmpv', version: '0.41 (macOS: Homebrew build, GPL) · Windows: zhongfly/mpv-winbuild LGPL build', license: 'GPL-2.0-or-later / LGPL-2.1-or-later', url: 'https://github.com/mpv-player/mpv' },
      { name: 'libmpv-wrapper', version: 'pinned in scripts/sidecars.lock', license: 'LGPL-2.1', url: 'https://github.com/nini22P/libmpv-wrapper' },
      { name: 'tauri-plugin-libmpv', version: '0.3.2 (vendored, patched — see src-tauri/vendor)', license: 'MPL-2.0', url: 'https://github.com/nini22P/tauri-plugin-libmpv' },
      { name: 'FFmpeg (libavcodec, libavformat, libavfilter, libavutil, libswscale, libswresample, libavdevice)', version: 'macOS bundle', license: 'GPL-2.0-or-later (built with --enable-gpl)', url: 'https://ffmpeg.org' },
      { name: 'x264', version: 'macOS bundle', license: 'GPL-2.0-or-later', url: 'https://www.videolan.org/developers/x264.html' },
      { name: 'x265', version: 'macOS bundle', license: 'GPL-2.0-or-later', url: 'https://bitbucket.org/multicoreware/x265_git' },
      { name: 'Rubber Band', version: 'macOS bundle', license: 'GPL-2.0-or-later', url: 'https://breakfastquay.com/rubberband/' },
      { name: 'libplacebo', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://code.videolan.org/videolan/libplacebo' },
      { name: 'libass', version: 'macOS bundle', license: 'ISC', url: 'https://github.com/libass/libass' },
      { name: 'dav1d', version: 'macOS bundle', license: 'BSD-2-Clause', url: 'https://code.videolan.org/videolan/dav1d' },
      { name: 'SVT-AV1', version: 'macOS bundle', license: 'BSD-3-Clause-Clear', url: 'https://gitlab.com/AOMediaCodec/SVT-AV1' },
      { name: 'libvpx', version: 'macOS bundle', license: 'BSD-3-Clause', url: 'https://chromium.googlesource.com/webm/libvpx' },
      { name: 'libvmaf', version: 'macOS bundle', license: 'BSD-2-Clause-Patent', url: 'https://github.com/Netflix/vmaf' },
      { name: 'LAME', version: 'macOS bundle', license: 'LGPL-2.0-or-later', url: 'https://lame.sourceforge.io' },
      { name: 'Opus', version: 'macOS bundle', license: 'BSD-3-Clause', url: 'https://opus-codec.org' },
      { name: 'libsamplerate', version: 'macOS bundle', license: 'BSD-2-Clause', url: 'https://github.com/libsndfile/libsamplerate' },
      { name: 'zimg', version: 'macOS bundle', license: 'WTFPL', url: 'https://github.com/sekrit-twc/zimg' },
      { name: 'FreeType', version: 'macOS bundle', license: 'FTL', url: 'https://freetype.org' },
      { name: 'fontconfig', version: 'macOS bundle', license: 'MIT', url: 'https://www.freedesktop.org/wiki/Software/fontconfig/' },
      { name: 'HarfBuzz', version: 'macOS bundle', license: 'MIT', url: 'https://github.com/harfbuzz/harfbuzz' },
      { name: 'FriBidi', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://github.com/fribidi/fribidi' },
      { name: 'Graphite2', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://github.com/silnrsi/graphite' },
      { name: 'GLib', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://gitlab.gnome.org/GNOME/glib' },
      { name: 'gettext (libintl)', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://www.gnu.org/software/gettext/' },
      { name: 'libbluray', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://www.videolan.org/developers/libbluray.html' },
      { name: 'libudfread', version: 'macOS bundle', license: 'LGPL-2.1-or-later', url: 'https://code.videolan.org/videolan/libudfread' },
      { name: 'libarchive', version: 'macOS bundle', license: 'BSD-2-Clause', url: 'https://www.libarchive.org' },
      { name: 'LuaJIT', version: 'macOS bundle', license: 'MIT', url: 'https://luajit.org' },
      { name: 'MuJS', version: 'macOS bundle', license: 'ISC', url: 'https://mujs.com' },
      { name: 'OpenSSL', version: 'macOS bundle', license: 'Apache-2.0', url: 'https://www.openssl.org' },
      { name: 'uchardet', version: 'macOS bundle', license: 'MPL-1.1 / GPL-2.0+ / LGPL-2.1+', url: 'https://www.freedesktop.org/wiki/Software/uchardet/' },
      { name: 'libunibreak', version: 'macOS bundle', license: 'Zlib', url: 'https://github.com/adah1972/libunibreak' },
      { name: 'Little-CMS', version: 'macOS bundle', license: 'MIT', url: 'https://www.littlecms.com' },
      { name: 'libjpeg-turbo', version: 'macOS bundle', license: 'IJG / BSD-3-Clause / Zlib', url: 'https://libjpeg-turbo.org' },
      { name: 'libpng', version: 'macOS bundle', license: 'PNG Reference Library License', url: 'http://www.libpng.org' },
      { name: 'shaderc', version: 'macOS bundle', license: 'Apache-2.0', url: 'https://github.com/google/shaderc' },
      { name: 'Vulkan Loader', version: 'macOS bundle', license: 'Apache-2.0', url: 'https://github.com/KhronosGroup/Vulkan-Loader' },
      { name: 'BLAKE2 (libb2)', version: 'macOS bundle', license: 'CC0-1.0', url: 'https://github.com/BLAKE2/libb2' },
      { name: 'LZ4', version: 'macOS bundle', license: 'BSD-2-Clause', url: 'https://github.com/lz4/lz4' },
      { name: 'XZ Utils (liblzma)', version: 'macOS bundle', license: '0BSD', url: 'https://tukaani.org/xz/' },
      { name: 'Zstandard', version: 'macOS bundle', license: 'BSD-3-Clause', url: 'https://github.com/facebook/zstd' },
      { name: 'PCRE2', version: 'macOS bundle', license: 'BSD-3-Clause', url: 'https://github.com/PCRE2Project/pcre2' },
    ],
  },
  {
    title: 'Application framework',
    items: [
      { name: 'Tauri', version: '2.x', license: 'MIT / Apache-2.0', url: 'https://github.com/tauri-apps/tauri' },
      { name: 'React', version: '18.x', license: 'MIT', url: 'https://github.com/facebook/react' },
      { name: 'TypeScript', version: '5.x', license: 'Apache-2.0', url: 'https://github.com/microsoft/TypeScript' },
      { name: 'Vite', version: '5.x', license: 'MIT', url: 'https://github.com/vitejs/vite' },
      { name: 'Tailwind CSS', version: '3.x', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
      { name: 'shadcn/ui', version: '—', license: 'MIT', url: 'https://github.com/shadcn-ui/ui' },
      { name: 'Radix UI', version: '1.x', license: 'MIT', url: 'https://github.com/radix-ui/primitives' },
      { name: 'React Router', version: '7.x', license: 'MIT', url: 'https://github.com/remix-run/react-router' },
      { name: 'Lucide Icons', version: '0.x', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
      { name: 'next-themes', version: '0.x', license: 'MIT', url: 'https://github.com/pacocoursey/next-themes' },
      { name: 'Sonner', version: '1.x', license: 'MIT', url: 'https://github.com/emilkowalski/sonner' },
      { name: 'clsx', version: '2.x', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
      { name: 'tailwind-merge', version: '2.x', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
      { name: 'Sentry SDK (React + Rust)', version: '10.x / 0.48', license: 'MIT', url: 'https://github.com/getsentry/sentry-javascript' },
    ],
  },
  {
    title: 'Rust backend',
    items: [
      { name: 'Serde', version: '1.x', license: 'MIT / Apache-2.0', url: 'https://github.com/serde-rs/serde' },
      { name: 'Tokio', version: '1.x', license: 'MIT', url: 'https://github.com/tokio-rs/tokio' },
      { name: 'reqwest + rustls', version: '0.12 / 0.23', license: 'MIT / Apache-2.0', url: 'https://github.com/seanmonstar/reqwest' },
      { name: 'regex', version: '1.x', license: 'MIT / Apache-2.0', url: 'https://github.com/rust-lang/regex' },
      { name: 'url', version: '2.x', license: 'MIT / Apache-2.0', url: 'https://github.com/servo/rust-url' },
      { name: 'chrono', version: '0.4', license: 'MIT / Apache-2.0', url: 'https://github.com/chronotope/chrono' },
      { name: 'sha2 (RustCrypto)', version: '0.10', license: 'MIT / Apache-2.0', url: 'https://github.com/RustCrypto/hashes' },
      { name: 'dirs', version: '6.x', license: 'MIT / Apache-2.0', url: 'https://github.com/dirs-dev/dirs-rs' },
      { name: 'opener', version: '0.7', license: 'MIT / Apache-2.0', url: 'https://github.com/Seeker14491/opener' },
      { name: 'anyhow', version: '1.x', license: 'MIT / Apache-2.0', url: 'https://github.com/dtolnay/anyhow' },
      { name: 'fs2', version: '0.4', license: 'MIT / Apache-2.0', url: 'https://github.com/danburkert/fs2-rs' },
      { name: 'libc', version: '0.2', license: 'MIT / Apache-2.0', url: 'https://github.com/rust-lang/libc' },
      { name: 'objc2', version: '0.6', license: 'MIT', url: 'https://github.com/madsmtm/objc2' },
    ],
  },
];

export default function OpenSourceLicenses() {
  const navigate = useNavigate();

  return (
    <div className="page-container max-w-2xl mx-auto">
      <div className="page-header">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Settings
        </button>
        <h2 className="page-title">Open Source Licenses</h2>
        <p className="page-subtitle">Prism is MIT-licensed and built with the following open source software</p>
      </div>

      <div className="mb-4 px-4 py-3 rounded-xl bg-secondary/30 border border-border/20 animate-fade-in">
        <p className="text-[11px] text-muted-foreground leading-relaxed text-pretty">
          <strong className="text-foreground">Source code and license texts.</strong> Prism's own source is at{' '}
          <OutboundLink href="https://github.com/rajatraina747/prism" className="text-primary hover:underline">github.com/rajatraina747/prism</OutboundLink>{' '}
          (MIT). The full license text of every library bundled with the embedded player ships inside the
          app (macOS: <span className="font-mono">Prism.app/Contents/Resources/lib/licenses</span>), and the
          exact versions are in <span className="font-mono">resources/lib/VERSIONS.txt</span>. The LGPL/GPL
          libraries are unmodified Homebrew builds; their corresponding source is published by Homebrew
          (<span className="font-mono">brew fetch --build-from-source &lt;formula&gt;</span>) and the exact
          assembly recipe is <span className="font-mono">scripts/bundle-libmpv-macos.sh</span> in the repository.
          To relink against a different libmpv, replace the dylibs under <span className="font-mono">resources/lib</span>.
        </p>
      </div>

      {GROUPS.map((group, gi) => (
        <div key={group.title} className="mb-4 animate-fade-in" style={{ animationDelay: `${gi * 60}ms` } as React.CSSProperties}>
          <h3 className="text-xs font-semibold text-foreground mb-1.5 px-1">{group.title}</h3>
          {group.note && (
            <p className="text-[11px] text-muted-foreground leading-relaxed text-pretty mb-2 px-1">{group.note}</p>
          )}
          <Panel>
            <div className="divide-y divide-border/30">
              {group.items.map(lib => (
                <OutboundLink
                  key={lib.name}
                  href={lib.url}
                  className="flex items-center gap-3 py-2.5 hover:bg-secondary/30 -mx-4 px-4 rounded-lg transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground">{lib.name}</p>
                    <p className="text-[11px] text-muted-foreground">{lib.version}</p>
                  </div>
                  <span className="text-[11px] font-medium text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded text-right max-w-[45%]">
                    {lib.license}
                  </span>
                  <ExternalLink className="w-3 h-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
                </OutboundLink>
              ))}
            </div>
          </Panel>
        </div>
      ))}

      <div className="mt-2 px-4 py-3 rounded-xl bg-secondary/30 border border-border/20">
        <p className="text-[11px] text-muted-foreground leading-relaxed text-pretty">
          Prism gratefully acknowledges the open source community. Transitive dependencies of the libraries
          above carry their own licenses; the bundled license folder and the lockfiles in the repository are
          the authoritative lists.
        </p>
      </div>
    </div>
  );
}
