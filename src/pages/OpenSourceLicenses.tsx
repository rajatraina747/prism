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
// app, scripts/sidecars.lock for the sidecars, and — for the macOS player and
// media tools — scripts/toolchain.lock, which lists every source the bundled
// libraries are built from (most of them linked statically, so they are
// credited here even though there is no separate dylib in the bundle).
const GROUPS: readonly CreditGroup[] = [
  {
    title: 'Download engines and sidecars',
    note: 'Separate programs bundled alongside Prism and run as child processes.',
    items: [
      { name: 'yt-dlp', version: 'pinned in scripts/sidecars.lock; self-updatable', license: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp' },
      { name: 'Deno', version: 'pinned in scripts/sidecars.lock', license: 'MIT', url: 'https://github.com/denoland/deno' },
      { name: 'librqbit', version: '9.x (embedded BitTorrent engine)', license: 'Apache-2.0', url: 'https://github.com/ikatson/rqbit' },
      { name: 'FFmpeg', version: 'bundled on every platform — LGPL builds, see below', license: 'LGPL-2.1-or-later', url: 'https://ffmpeg.org' },
    ],
  },
  {
    title: 'Embedded player',
    note: 'macOS ships the LGPL media toolchain Prism builds itself from pinned sources (scripts/build-media-macos.sh): libmpv built with -Dgpl=false, FFmpeg configured --disable-gpl --disable-nonfree, and a Vulkan driver. Nothing in it links x264, x265 or Rubber Band, and the build refuses to publish if any of that appears. Windows uses zhongfly\'s LGPL mpv build, and Windows and Linux both take their ffmpeg and ffprobe from BtbN\'s LGPL builds of the same ffmpeg branch macOS compiles, pinned to a dated build in scripts/sidecars.lock. The corresponding source for the macOS libraries — every upstream tarball, byte for byte, with the script that patches and builds them — is published beside the binaries on the media-toolchain release named in scripts/sidecars.lock. Full license texts ship in the app under resources/lib/licenses, and the exact versions are in resources/lib/VERSIONS.txt.',
    items: [
      { name: 'mpv / libmpv', version: '0.41.0 (macOS: Prism\'s LGPL build, -Dgpl=false) · Windows: zhongfly/mpv-winbuild LGPL build', license: 'LGPL-2.1-or-later', url: 'https://github.com/mpv-player/mpv' },
      { name: 'libmpv-wrapper', version: 'pinned in scripts/sidecars.lock', license: 'LGPL-2.1', url: 'https://github.com/nini22P/libmpv-wrapper' },
      { name: 'tauri-plugin-libmpv', version: '0.3.2 (vendored, patched — see src-tauri/vendor)', license: 'MPL-2.0', url: 'https://github.com/nini22P/tauri-plugin-libmpv' },
      { name: 'FFmpeg (libavcodec, libavformat, libavfilter, libavutil, libswscale, libswresample)', version: '8.1.2 (macOS bundle; ffmpeg and ffprobe also ship as tools)', license: 'LGPL-2.1-or-later (built --disable-gpl --disable-nonfree)', url: 'https://ffmpeg.org' },
      { name: 'libplacebo', version: '7.360.1 (macOS bundle, static)', license: 'LGPL-2.1-or-later', url: 'https://code.videolan.org/videolan/libplacebo' },
      { name: 'fast_float', version: '8.3.0 (macOS bundle, static — inside libplacebo)', license: 'Apache-2.0 / MIT / BSL-1.0', url: 'https://github.com/fastfloat/fast_float' },
      { name: 'libass', version: '0.17.5 (macOS bundle, static)', license: 'ISC', url: 'https://github.com/libass/libass' },
      { name: 'dav1d', version: '1.5.4 (macOS bundle, static)', license: 'BSD-2-Clause', url: 'https://code.videolan.org/videolan/dav1d' },
      { name: 'LAME', version: '3.101 (macOS bundle, static)', license: 'LGPL-2.0-or-later', url: 'https://lame.sourceforge.io' },
      { name: 'Opus', version: '1.5.2 (macOS bundle, static)', license: 'BSD-3-Clause', url: 'https://opus-codec.org' },
      { name: 'zimg', version: '3.0.6 (macOS bundle, static)', license: 'WTFPL', url: 'https://github.com/sekrit-twc/zimg' },
      { name: 'FreeType', version: '2.14.3 (macOS bundle, static)', license: 'FTL', url: 'https://freetype.org' },
      { name: 'HarfBuzz', version: '14.4.0 (macOS bundle, static)', license: 'MIT', url: 'https://github.com/harfbuzz/harfbuzz' },
      { name: 'FriBidi', version: '1.0.16 (macOS bundle, static)', license: 'LGPL-2.1-or-later', url: 'https://github.com/fribidi/fribidi' },
      { name: 'Little-CMS', version: '2.19.1 (macOS bundle, static)', license: 'MIT', url: 'https://www.littlecms.com' },
      { name: 'glslang', version: '16.6.0 (macOS bundle, static)', license: 'BSD-3-Clause / Apache-2.0', url: 'https://github.com/KhronosGroup/glslang' },
      { name: 'Vulkan Loader', version: 'vulkan-sdk-1.4.357.0 (macOS bundle)', license: 'Apache-2.0', url: 'https://github.com/KhronosGroup/Vulkan-Loader' },
      { name: 'Vulkan Headers', version: 'vulkan-sdk-1.4.357.0', license: 'Apache-2.0', url: 'https://github.com/KhronosGroup/Vulkan-Headers' },
      { name: 'MoltenVK', version: '1.4.2 (macOS bundle — Vulkan on Metal)', license: 'Apache-2.0', url: 'https://github.com/KhronosGroup/MoltenVK' },
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
          exact versions are in <span className="font-mono">resources/lib/VERSIONS.txt</span>. On macOS those
          libraries are Prism's own LGPL builds rather than a package manager's, so the corresponding source
          is published with them: <span className="font-mono">prism-media-sources.tar.gz</span> on the{' '}
          <span className="font-mono">media-toolchain</span> release pinned in{' '}
          <span className="font-mono">scripts/sidecars.lock</span> holds every upstream tarball byte for byte,
          together with <span className="font-mono">scripts/build-media-macos.sh</span> — which is also where
          Prism's own change to them lives, a patch to libplacebo's library probes. To relink against a
          different libmpv, replace the dylibs under <span className="font-mono">resources/lib</span>.
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
