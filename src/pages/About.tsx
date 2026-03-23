import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useService } from '@/services/ServiceProvider';
import { Panel } from '@/components/common';
import { ExternalLink, Heart, Shield, BookOpen, Sparkles } from 'lucide-react';

const LATEST_RELEASE = {
  version: '1.0.7',
  date: 'March 2026',
  highlights: [
    'Fixed YouTube bot detection with browser cookie authentication',
    'Fixed playlist queueing — videos now properly added to queue',
    'Better error messages when parsing fails',
    'Audio-only download mode — extract MP3 from any video',
    'Subtitle download support with 12 language options',
    'Download speed limiting from Settings',
    'Playlist support — queue entire playlists with one URL',
  ],
};

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
        <img src="/logo-nobg.png" alt="Prism" className="w-16 h-16 mx-auto mb-4 object-contain" />
        <h2 className="page-title">Prism</h2>
        <p className="page-subtitle">Premium Video Downloader</p>
        <p className="text-[10px] text-muted-foreground/60 mt-1">
          by{' '}
          <a href="https://www.rainacorp.co.uk" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground transition-colors">
            RainaCorp
          </a>
        </p>
      </div>

      <Panel className="animate-fade-in">
        <div className="divide-y divide-border/30">
          <InfoRow label="Version" value={`v${version}`} />
          <InfoRow label="Channel" value="Stable" />
          <InfoRow label="License" value="Personal Use" />
        </div>
      </Panel>

      {/* What's New */}
      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '80ms' } as React.CSSProperties}>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-primary" />
            <h3 className="text-xs font-semibold text-foreground">What's New</h3>
            <span className="text-[10px] text-muted-foreground ml-auto">{LATEST_RELEASE.date}</span>
          </div>
          <div className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
            {LATEST_RELEASE.highlights.map((item, i) => (
              <p key={i}>&#8226; {item}</p>
            ))}
          </div>
        </div>
      </Panel>

      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
        <div className="space-y-2">
          <button onClick={() => navigate('/privacy')} className="w-full text-left">
            <LinkRow icon={Shield} label="Privacy Policy" description="How Prism handles your data — spoiler: it stays on your device" />
          </button>
          <LinkRow icon={BookOpen} label="RainaCorp" description="Visit our website" href="https://www.rainacorp.co.uk" />
          <LinkRow icon={Heart} label="Credits" description="Built with React, TypeScript, Tailwind CSS, Tauri, and yt-dlp" />
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
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
      {href && <ExternalLink className="w-3 h-3 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity" />}
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer group"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer group">
      {content}
    </div>
  );
}
