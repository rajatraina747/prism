import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '@/components/common';
import { ArrowLeft, ExternalLink } from 'lucide-react';

const LICENSES = [
  { name: 'React', version: '18.x', license: 'MIT', url: 'https://github.com/facebook/react' },
  { name: 'TypeScript', version: '5.x', license: 'Apache-2.0', url: 'https://github.com/microsoft/TypeScript' },
  { name: 'Vite', version: '5.x', license: 'MIT', url: 'https://github.com/vitejs/vite' },
  { name: 'Tauri', version: '2.x', license: 'MIT/Apache-2.0', url: 'https://github.com/tauri-apps/tauri' },
  { name: 'Tailwind CSS', version: '3.x', license: 'MIT', url: 'https://github.com/tailwindlabs/tailwindcss' },
  { name: 'shadcn/ui', version: '—', license: 'MIT', url: 'https://github.com/shadcn-ui/ui' },
  { name: 'yt-dlp', version: 'latest', license: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp' },
  { name: 'React Router', version: '6.x', license: 'MIT', url: 'https://github.com/remix-run/react-router' },
  { name: 'TanStack Query', version: '5.x', license: 'MIT', url: 'https://github.com/TanStack/query' },
  { name: 'Lucide Icons', version: '0.x', license: 'ISC', url: 'https://github.com/lucide-icons/lucide' },
  { name: 'next-themes', version: '0.x', license: 'MIT', url: 'https://github.com/pacocoursey/next-themes' },
  { name: 'Sonner', version: '1.x', license: 'MIT', url: 'https://github.com/emilkowalski/sonner' },
  { name: 'clsx', version: '2.x', license: 'MIT', url: 'https://github.com/lukeed/clsx' },
  { name: 'tailwind-merge', version: '2.x', license: 'MIT', url: 'https://github.com/dcastil/tailwind-merge' },
  { name: 'Radix UI', version: '1.x', license: 'MIT', url: 'https://github.com/radix-ui/primitives' },
  { name: 'Serde', version: '1.x', license: 'MIT/Apache-2.0', url: 'https://github.com/serde-rs/serde' },
  { name: 'Tokio', version: '1.x', license: 'MIT', url: 'https://github.com/tokio-rs/tokio' },
  { name: 'regex (Rust)', version: '1.x', license: 'MIT/Apache-2.0', url: 'https://github.com/rust-lang/regex' },
] as const;

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
        <p className="page-subtitle">Prism is built with the following open source software</p>
      </div>

      <Panel className="animate-fade-in">
        <div className="divide-y divide-border/30">
          {LICENSES.map(lib => (
            <a
              key={lib.name}
              href={lib.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 py-2.5 hover:bg-secondary/30 -mx-4 px-4 rounded-lg transition-colors group"
            >
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground">{lib.name}</p>
                <p className="text-[10px] text-muted-foreground">v{lib.version}</p>
              </div>
              <span className="text-[10px] font-medium text-muted-foreground bg-secondary/60 px-2 py-0.5 rounded">
                {lib.license}
              </span>
              <ExternalLink className="w-3 h-3 text-muted-foreground/40 opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
            </a>
          ))}
        </div>
      </Panel>

      <div className="mt-4 px-4 py-3 rounded-xl bg-secondary/30 border border-border/20 animate-fade-in" style={{ animationDelay: '80ms' } as React.CSSProperties}>
        <p className="text-[11px] text-muted-foreground leading-relaxed text-pretty">
          Prism gratefully acknowledges the open source community. The above list includes primary
          dependencies. Each library may have its own transitive dependencies with their own licenses.
          Full license texts are available in the respective project repositories.
        </p>
      </div>
    </div>
  );
}
