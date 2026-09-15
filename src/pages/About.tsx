import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useService } from '@/services/ServiceProvider';
import { Panel, OutboundLink } from '@/components/common';
import { ExternalLink, Heart, Shield, BookOpen, Sparkles, Bug } from 'lucide-react';

export default function About() {
  const service = useService();
  const navigate = useNavigate();
  const [version, setVersion] = React.useState('1.0.0');

  React.useEffect(() => {
    service.getAppVersion().then(setVersion).catch(() => {});
  }, [service]);

  return (
    <div className="page-container max-w-lg mx-auto">
      <div className="page-header text-center">
        <img src="/logo-nobg.webp" alt="Prism" className="w-16 h-16 mx-auto mb-4 object-contain" />
        <h2 className="page-title">Prism</h2>
        <p className="page-subtitle">Premium Video Downloader</p>
        <p className="text-[11px] text-muted-foreground/60 mt-1">
          by{' '}
          <OutboundLink href="https://www.rainacorp.co.uk" className="hover:text-muted-foreground transition-colors">
            RainaCorp
          </OutboundLink>
        </p>
      </div>

      <Panel className="animate-fade-in">
        <div className="divide-y divide-border/30">
          <InfoRow label="Version" value={`v${version}`} />
          <InfoRow label="Channel" value="Stable" />
          <InfoRow label="License" value="MIT (Prism source) · bundled player libraries under their own licenses" />
        </div>
      </Panel>

      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
        <div className="space-y-2">
          <LinkRow
            icon={Sparkles}
            label="Release notes"
            description="What changed in each version"
            href="https://github.com/rajatraina747/prism/releases"
          />
          <LinkRow
            icon={Bug}
            label="Report a bug"
            description="Opens a bug report on GitHub — Settings → Diagnostics → Export logs helps"
            href={`https://github.com/rajatraina747/prism/issues/new?template=bug_report.yml&version=${encodeURIComponent(version)}`}
          />
          <button onClick={() => navigate('/privacy')} className="w-full text-left">
            <LinkRow icon={Shield} label="Privacy Policy" description="How Prism handles your data — spoiler: it stays on your device" />
          </button>
          <LinkRow icon={BookOpen} label="RainaCorp" description="Visit our website" href="https://www.rainacorp.co.uk" />
          <button onClick={() => navigate('/licenses')} className="w-full text-left">
            <LinkRow icon={Heart} label="Credits & licenses" description="Tauri, React, yt-dlp, Deno, librqbit, mpv/FFmpeg and everything else Prism ships with" />
          </button>
        </div>
      </Panel>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-medium text-foreground tabular-nums">{value}</span>
    </div>
  );
}

function LinkRow({ icon: Icon, label, description, href }: { icon: React.ElementType; label: string; description: string; href?: string }) {
  const content = (
    <>
      <div className="w-7 h-7 rounded-md bg-secondary/70 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      {href && <ExternalLink className="w-3 h-3 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity" />}
    </>
  );

  if (href) {
    return (
      <OutboundLink
        href={href}
        className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer group"
      >
        {content}
      </OutboundLink>
    );
  }

  // No link behind it (Credits) — don't dress it up as something to click.
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg group">
      {content}
    </div>
  );
}
