import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useService } from '@/services/ServiceProvider';
import { Panel, OutboundLink } from '@/components/common';
import { ExternalLink, Heart, Shield, BookOpen, Sparkles, Bug, ArrowLeft } from 'lucide-react';
import { publicAsset } from "@/lib/public-asset";
import { t } from '@/i18n';

export default function About() {
  const service = useService();
  const navigate = useNavigate();
  const [version, setVersion] = React.useState('1.0.0');

  React.useEffect(() => {
    service.getAppVersion().then(setVersion).catch(() => {});
  }, [service]);

  return (
    <div className="page-container max-w-2xl">
      <div className="page-header">
        <button
          onClick={() => navigate('/settings?section=privacy')}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-3"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          {t('about.backToSettings')}
        </button>
        <div className="flex items-center gap-4">
          <img src={publicAsset("logo-nobg.webp")} alt="" className="w-16 h-16 object-contain shrink-0" />
          <div>
            <h1 className="page-title">{t('common.appName')}</h1>
            <p className="page-subtitle">{t('about.tagline')}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {t('about.by')}{' '}
              <OutboundLink href="https://www.rainacorp.co.uk" className="text-foreground hover:text-primary transition-colors">
                {t('common.companyName')}
              </OutboundLink>
            </p>
          </div>
        </div>
      </div>

      <Panel className="animate-fade-in">
        <div className="divide-y divide-border/30">
          <InfoRow label={t('about.version')} value={t('about.versionValue', { version })} />
          <InfoRow label={t('about.channel')} value={t('about.stable')} />
          <InfoRow label={t('about.license')} value={t('about.licenseValue')} />
        </div>
      </Panel>

      <Panel className="mt-4 animate-fade-in" style={{ animationDelay: '160ms' } as React.CSSProperties}>
        <div className="space-y-2">
          <LinkRow
            icon={Sparkles}
            label={t('about.releaseNotes')}
            description={t('about.releaseNotesDescription')}
            href="https://github.com/rajatraina747/prism/releases"
          />
          <LinkRow
            icon={Bug}
            label={t('about.reportBug')}
            description={t('about.reportBugDescription')}
            href={`https://github.com/rajatraina747/prism/issues/new?template=bug_report.yml&version=${encodeURIComponent(version)}`}
          />
          <button onClick={() => navigate('/privacy')} className="w-full text-left">
            <LinkRow icon={Shield} label={t('about.privacy')} description={t('about.privacyDescription')} />
          </button>
          <LinkRow icon={BookOpen} label={t('common.companyName')} description={t('about.website')} href="https://www.rainacorp.co.uk" />
          <button onClick={() => navigate('/licenses')} className="w-full text-left">
            <LinkRow icon={Heart} label={t('about.credits')} description={t('about.creditsDescription')} />
          </button>
        </div>
      </Panel>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-6 py-2.5">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-medium text-foreground tabular-nums text-right">{value}</span>
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
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {href && <ExternalLink className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />}
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
