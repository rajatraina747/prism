import { useEffect, useState, type ElementType, type ReactNode } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { Bug, Check, ChevronRight, ExternalLink, Heart, Loader2, Sparkles } from 'lucide-react';
import { publicAsset } from '@/lib/public-asset';
import type { IPrismService } from '@/services/types';

type AboutService = Pick<IPrismService, 'getAppVersion' | 'checkForUpdates' | 'openExternal'>;
type Destination = 'updates' | 'licenses';

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'current' }
  | { kind: 'available'; version?: string }
  | { kind: 'error'; message: string };

const RELEASES_URL = 'https://github.com/rajatraina747/prism/releases';
const RAINACORP_URL = 'https://www.rainacorp.co.uk';
const bugReportUrl = (version: string) =>
  `https://github.com/rajatraina747/prism/issues/new?template=bug_report.yml&version=${encodeURIComponent(version)}`;

const smallButton =
  'h-7 px-3 rounded-lg text-xs font-medium bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]';

export function AboutPanel({
  service,
  showInMain,
}: {
  service: AboutService;
  showInMain: (destination: Destination) => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateState>({ kind: 'idle' });

  useEffect(() => {
    service.getAppVersion().then(setVersion).catch(() => {});
  }, [service]);

  const check = async () => {
    setUpdate({ kind: 'checking' });
    const result = await service.checkForUpdates();
    if (result.available) setUpdate({ kind: 'available', version: result.version });
    else if (result.error) setUpdate({ kind: 'error', message: result.error });
    else setUpdate({ kind: 'current' });
  };

  const open = (url: string) => {
    service.openExternal(url).catch(() => {});
  };

  return (
    <main className="h-screen flex flex-col overflow-hidden select-none bg-background">
      {/* Under the macOS traffic lights: the window has no title bar to drag by. */}
      <div data-tauri-drag-region className="h-8 shrink-0" />

      <section className="flex flex-col items-center px-6 text-center">
        <img src={publicAsset('logo-nobg.webp')} alt="" draggable={false} className="w-36 h-36 object-contain -my-1" />
        <h1 className="sr-only">Prism</h1>
        <p className="text-xs text-muted-foreground">Downloads, plays and converts video</p>
        <p className="mt-3 text-sm font-medium text-foreground tabular-nums min-h-5">
          {version && `Version ${version}`}
        </p>
        <div className="mt-2 h-14 flex flex-col items-center justify-start gap-1.5" aria-live="polite">
          <UpdateStatus update={update} onCheck={check} onOpenSettings={() => showInMain('updates')} />
        </div>
      </section>

      <nav className="mt-auto mx-3 pt-2 border-t border-border/60" aria-label="More about Prism">
        <Row icon={Sparkles} onClick={() => open(RELEASES_URL)} trailing={<ExternalLink className="w-3 h-3" />}>
          Release notes
        </Row>
        <Row icon={Bug} onClick={() => open(bugReportUrl(version ?? ''))} trailing={<ExternalLink className="w-3 h-3" />}>
          Report a bug
        </Row>
        <Row icon={Heart} onClick={() => showInMain('licenses')} trailing={<ChevronRight className="w-3.5 h-3.5" />}>
          Credits &amp; licenses
        </Row>
      </nav>

      <footer className="py-3 text-center text-xs text-muted-foreground">
        by{' '}
        <button
          onClick={() => open(RAINACORP_URL)}
          className="text-foreground hover:text-primary transition-colors"
        >
          RainaCorp
        </button>
      </footer>
    </main>
  );
}

function UpdateStatus({
  update,
  onCheck,
  onOpenSettings,
}: {
  update: UpdateState;
  onCheck: () => void;
  onOpenSettings: () => void;
}) {
  switch (update.kind) {
    case 'idle':
      return <button onClick={onCheck} className={smallButton}>Check for updates</button>;
    case 'checking':
      return (
        <span className="h-7 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          Checking…
        </span>
      );
    case 'current':
      return (
        <span className="h-7 flex items-center gap-1.5 text-xs text-success">
          <Check className="w-3.5 h-3.5" />
          You're on the latest version
        </span>
      );
    case 'available':
      return (
        <>
          <span className="text-xs text-foreground">
            {update.version ? `Version ${update.version} is available` : 'An update is available'}
          </span>
          <button onClick={onOpenSettings} className={smallButton}>Open Settings</button>
        </>
      );
    case 'error':
      return (
        <>
          <span className="text-xs text-muted-foreground" title={update.message}>Couldn't check for updates</span>
          <button onClick={onCheck} className={smallButton}>Try again</button>
        </>
      );
  }
}

function Row({
  icon: Icon,
  onClick,
  trailing,
  children,
}: {
  icon: ElementType;
  onClick: () => void;
  trailing: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="w-full h-9 px-2.5 flex items-center gap-2.5 rounded-lg text-xs font-medium text-foreground hover:bg-secondary/50 transition-colors group"
    >
      <Icon className="w-3.5 h-3.5 text-muted-foreground" />
      <span className="flex-1 text-left">{children}</span>
      <span className="text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity">
        {trailing}
      </span>
    </button>
  );
}

/** The window itself. Deliberately skips the service's `init()`, which loads
 * the app's saved data: this window has neither the need nor the permission. */
export default function AboutWindow() {
  const [service, setService] = useState<AboutService | null>(null);

  useEffect(() => {
    const load = isTauri()
      ? import('@/services/tauri').then(m => new m.TauriPrismService())
      : import('@/services/mock').then(m => new m.MockPrismService());
    load.then(setService).catch(() => {});
  }, []);

  if (!service) return null;

  const showInMain = (destination: Destination) => {
    if (isTauri()) invoke('about_show_in_main', { destination }).catch(() => {});
  };
  return <AboutPanel service={service} showInMain={showInMain} />;
}
