import React from 'react';
import { Panel } from '@/components/common';
import { Zap, ExternalLink, Heart, Shield, BookOpen, MessageCircle } from 'lucide-react';

export default function About() {
  return (
    <div className="page-container max-w-lg mx-auto">
      <div className="page-header text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/15 mb-4">
          <Zap className="w-7 h-7 text-primary" strokeWidth={2} />
        </div>
        <h2 className="page-title">Prism</h2>
        <p className="page-subtitle">Premium Video Downloader</p>
      </div>

      <Panel className="animate-fade-in">
        <div className="divide-y divide-border/30">
          <InfoRow label="Version" value="1.0.0" />
          <InfoRow label="Build" value="2026.03.22-stable" />
          <InfoRow label="Channel" value="Stable" />
          <InfoRow label="Architecture" value="Web Preview (Tauri-ready)" />
          <InfoRow label="License" value="Personal Use" />
        </div>
      </Panel>

      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '80ms' } as React.CSSProperties}>
        <div className="space-y-3">
          <h3 className="text-xs font-semibold text-foreground">What's New</h3>
          <div className="text-xs text-muted-foreground space-y-1.5 leading-relaxed">
            <p>• Initial release with full queue management</p>
            <p>• Multi-format video quality selection</p>
            <p>• Download history with search and filtering</p>
            <p>• Configurable concurrent downloads</p>
            <p>• Pause, resume, retry, and cancel support</p>
            <p>• Local-first data persistence</p>
          </div>
        </div>
      </Panel>

      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
        <div className="space-y-2">
          <LinkRow icon={Shield} label="Privacy & Lawful Use" description="Prism respects content rights. Users must comply with applicable laws." />
          <LinkRow icon={BookOpen} label="Documentation" description="Guides, API reference, and integration docs" />
          <LinkRow icon={MessageCircle} label="Support" description="Get help or report issues" />
          <LinkRow icon={Heart} label="Credits" description="Built with React, TypeScript, and Tailwind CSS" />
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

function LinkRow({ icon: Icon, label, description }: { icon: React.ElementType; label: string; description: string }) {
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-secondary/50 transition-colors cursor-pointer group">
      <div className="w-7 h-7 rounded-md bg-secondary/70 flex items-center justify-center shrink-0">
        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        <p className="text-[10px] text-muted-foreground">{description}</p>
      </div>
      <ExternalLink className="w-3 h-3 text-muted-foreground/50 opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
  );
}
