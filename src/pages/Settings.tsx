import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { useEngineStatus, publishEngineInfo } from '@/stores/engine-status';
import { diagnostics } from '@/services/diagnostics';
import { formatReleaseNotes, generateId } from '@/services';
import type { DownloadCategory } from '@/types/models';
import { Panel, ConfirmDialog } from '@/components/common';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  FolderOpen, Film, Magnet, Gauge, Globe, Bell, Palette, HardDrive,
  RefreshCw, Bug, Shield, ChevronRight, ChevronDown, Loader2, AlertTriangle, HelpCircle,
} from 'lucide-react';

// ── Accessible setting rows ──
// Every control inside a SettingRow is labelled by the row's label and
// described by its description, so assistive tech announces "Listen port,
// 4240, Incoming peer connections use this port" instead of "4240".

const RowIds = React.createContext<{ labelId: string; descId?: string } | null>(null);

function useRowA11y() {
  const ids = React.useContext(RowIds);
  return ids ? { 'aria-labelledby': ids.labelId, 'aria-describedby': ids.descId } : {};
}

/** A small (?) that explains a term of art in place. */
function HelpTip({ term, text }: { term: string; text: string }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${term}?`}
          className="inline-flex text-muted-foreground/60 hover:text-muted-foreground focus-visible:text-foreground transition-colors"
        >
          <HelpCircle className="w-3 h-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-[11px] leading-relaxed">{text}</TooltipContent>
    </Tooltip>
  );
}

function SettingRow({ label, description, help, children }: {
  label: string;
  description?: string;
  /** [term, explanation] for jargon in the label. */
  help?: [string, string];
  children: React.ReactNode;
}) {
  const id = React.useId();
  const labelId = `${id}-label`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <div className="flex items-center justify-between py-2.5 min-h-[40px]">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-xs font-medium text-foreground flex items-center gap-1.5">
          <span id={labelId}>{label}</span>
          {help && <HelpTip term={help[0]} text={help[1]} />}
        </p>
        {description && <p id={descId} className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">
        <RowIds.Provider value={{ labelId, descId }}>{children}</RowIds.Provider>
      </div>
    </div>
  );
}

function SettingGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="pt-3 first:pt-0">
      <h3 className="panel-header mb-1">{title}</h3>
      <div className="divide-y divide-border/30">{children}</div>
    </section>
  );
}

/** Progressive disclosure for settings most people never need. */
function Advanced({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const id = React.useId();
  return (
    <div className="pt-3">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-controls={id}
        className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {open ? 'Hide advanced settings' : 'Show advanced settings'}
      </button>
      {open && <div id={id} className="mt-1">{children}</div>}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  const a11y = useRowA11y();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      {...a11y}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative w-9 h-5 rounded-full transition-colors duration-200 active:scale-[0.95]',
        checked ? 'bg-primary' : 'bg-muted'
      )}
    >
      <div className={cn(
        'absolute top-0.5 w-4 h-4 rounded-full bg-foreground transition-transform duration-200',
        checked ? 'translate-x-4' : 'translate-x-0.5'
      )} />
    </button>
  );
}

function Select<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  const a11y = useRowA11y();
  return (
    <select
      value={value}
      {...a11y}
      onChange={e => onChange(e.target.value as T)}
      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

/** Numeric field that keeps what you type (so "1." and "" are allowed mid-edit)
 * and clamps to [min, max] when you leave it. */
function NumberInput({ value, onChange, min, max, step, unit }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  const a11y = useRowA11y();
  const [text, setText] = React.useState(String(value));
  const focused = React.useRef(false);
  React.useEffect(() => { if (!focused.current) setText(String(value)); }, [value]);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        inputMode={step && step < 1 ? 'decimal' : 'numeric'}
        value={text}
        {...a11y}
        onFocus={() => { focused.current = true; }}
        onChange={e => {
          setText(e.target.value);
          const n = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => {
          focused.current = false;
          const n = Number(text);
          const next = text.trim() === '' || !Number.isFinite(n) ? clamp(value) : clamp(n);
          onChange(next);
          setText(String(next));
        }}
        min={min}
        max={max}
        step={step}
        className="w-20 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none tabular-nums text-right"
      />
      {unit && <span className="text-[11px] text-muted-foreground" aria-hidden="true">{unit}</span>}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const a11y = useRowA11y();
  return (
    <input
      type="text"
      value={value}
      {...a11y}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="w-56 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
    />
  );
}

const SECTIONS = [
  { id: 'video', label: 'Video', icon: Film },
  { id: 'bittorrent', label: 'BitTorrent', icon: Magnet },
  { id: 'speed', label: 'Speed & schedule', icon: Gauge },
  { id: 'network', label: 'Network', icon: Globe },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'diagnostics', label: 'Diagnostics', icon: Bug },
  { id: 'legal', label: 'Legal', icon: Shield },
] as const;

/** Section ids from before the 1.9 restructure, so old links still land. */
const SECTION_ALIASES: Record<string, string> = { downloads: 'video', queue: 'speed' };

function resolveSection(requested: string | null): string | null {
  if (!requested) return null;
  const id = SECTION_ALIASES[requested] ?? requested;
  return SECTIONS.some(s => s.id === id) ? id : null;
}

/** Torrent limits are stored in KB/s (what the engine takes); every speed is
 * shown in MB/s so the three limits read the same. */
const kbpsToMbps = (kbps: number) => Math.round((kbps / 1024) * 100) / 100;
const mbpsToKbps = (mbps: number) => Math.round(mbps * 1024);

const HELP = {
  cookies: ['browser cookies', 'Some videos need a signed-in session. Prism lets yt-dlp borrow that browser\'s cookies for the request on this machine; they are never uploaded anywhere else.'],
  container: ['a container', 'The container (.mp4, .mkv, .webm) wraps the video and audio streams. Remuxing re-wraps them without re-encoding — fast and lossless — but VP9 and AV1, the codecs sites use for 4K and HDR, play poorly inside .mp4 in QuickTime.'],
  sponsorblock: ['SponsorBlock', 'A community database of sponsor, intro and self-promotion segments in YouTube videos.'],
  ratio: ['share ratio', 'Uploaded ÷ downloaded. A ratio of 1.0 means you have given the swarm back as much as you took.'],
  trackers: ['an announce URL', 'A tracker introduces peers to each other; its announce URL is where a client reports in, e.g. udp://tracker.example.org:1337/announce.'],
  dht: ['DHT', 'Distributed Hash Table: finds peers through other clients instead of a tracker. Most magnet links depend on it.'],
  lsd: ['LSD', 'Local Service Discovery: finds peers on your own network by multicast.'],
  utp: ['uTP', 'Micro Transport Protocol: a UDP transport that backs off when your connection is busy, so torrents don\'t swamp everything else.'],
  upnp: ['UPnP', 'Universal Plug and Play: Prism asks your router to open a port so peers can connect to you directly.'],
  blocklist: ['a p2p blocklist', 'A list of IP ranges (the P2P/eMule format uTorrent and qBittorrent use) the torrent engine will refuse to connect to.'],
  proxy: ['socks5h', 'socks5h:// sends DNS lookups through the proxy as well; socks5:// resolves names on this machine first, which can reveal the sites you visit.'],
  ipv4: ['IPv4-only', 'Many sites throttle or block downloads over IPv6. Turn this off only if your network has no IPv4.'],
} satisfies Record<string, [string, string]>;

/** Sample values for the file name template preview. */
const SAMPLE_TEMPLATE_VARS = {
  title: 'Never Gonna Give You Up',
  uploader: 'Rick Astley',
  site: 'youtube.com',
  id: 'dQw4w9WgXcQ',
  date: '20091025',
  resolution: '1080p',
  category: 'Music',
};

export default function Settings() {
  const { preferences: p, updatePreference, resetToDefaults } = useSettings();
  const service = useService();
  const navigate = useNavigate();
  // `?section=` opens a specific section (e.g. "Set browser cookies" from a
  // failed download), including when Settings is already open.
  const [searchParams] = useSearchParams();
  const requestedSection = resolveSection(searchParams.get('section'));
  const [activeSection, setActiveSection] = React.useState<string>(requestedSection ?? 'video');
  React.useEffect(() => {
    if (requestedSection) setActiveSection(requestedSection);
  }, [requestedSection]);
  const [updateState, setUpdateState] = React.useState<'idle' | 'checking' | 'available' | 'installing' | 'up-to-date' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = React.useState<string | undefined>();
  const [updateNotes, setUpdateNotes] = React.useState<string | undefined>();
  const [updateError, setUpdateError] = React.useState<string | undefined>();
  const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
  const [engineUpdating, setEngineUpdating] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [ffmpegOk, setFfmpegOk] = React.useState(true);
  const engine = useEngineStatus();
  const [templatePreview, setTemplatePreview] = React.useState<{ ok: boolean; text: string } | null>(null);

  const updateCategory = React.useCallback((id: string, change: Partial<DownloadCategory>) => {
    updatePreference('categories', p.categories.map(c => (c.id === id ? { ...c, ...change } : c)));
  }, [p.categories, updatePreference]);

  // Live preview of the file name template, rendered by the same code that
  // names real downloads.
  React.useEffect(() => {
    if (activeSection !== 'storage') return;
    const timer = setTimeout(() => {
      service.previewFilenameTemplate(p.filenameTemplate, SAMPLE_TEMPLATE_VARS)
        .then(text => setTemplatePreview({ ok: true, text }))
        .catch((e: unknown) => setTemplatePreview({
          ok: false,
          text: typeof e === 'string' ? e : e instanceof Error ? e.message : 'Invalid template',
        }));
    }, 250);
    return () => clearTimeout(timer);
  }, [activeSection, p.filenameTemplate, service]);

  React.useEffect(() => {
    if (activeSection !== 'updates') return;
    service.getEngineVersion().then(setEngineVersion).catch(() => setEngineVersion(null));
    service.getEngineInfo().then(publishEngineInfo).catch(() => {});
  }, [activeSection, service]);

  React.useEffect(() => {
    service.ffmpegAvailable().then(setFfmpegOk).catch(() => {});
  }, [service]);

  return (
    <div className="page-container">
      <div className="page-header">
        <h2 className="page-title">Settings</h2>
        <p className="page-subtitle">Configure Prism preferences</p>
      </div>

      <Tabs value={activeSection} onValueChange={setActiveSection} orientation="vertical" className="flex gap-6">
        <TabsList aria-label="Settings sections" className="w-44 shrink-0 h-auto flex flex-col items-stretch justify-start gap-0.5 bg-transparent p-0">
          {SECTIONS.map(s => (
            <TabsTrigger
              key={s.id}
              value={s.id}
              className={cn(
                'justify-start gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
                'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground',
                'data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:shadow-none',
              )}
            >
              <s.icon className="w-3.5 h-3.5" strokeWidth={1.8} aria-hidden="true" />
              {s.label}
              {s.id === 'updates' && engine?.updateAvailable && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" aria-label="Engine update available" />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1 min-w-0">
          <Panel className="animate-fade-in" key={activeSection}>
            <TabsContent value="video" className="mt-0">
              {!ffmpegOk && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 mb-2 rounded-lg bg-warning/10 border border-warning/25">
                  <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">ffmpeg not found</p>
                    <p className="text-[11px] text-muted-foreground mt-0.5">
                      Without it, high-quality merges, embedded thumbnails/chapters, and SponsorBlock
                      won't work. Prism ships its own copy on macOS, so if it's missing there,
                      reinstalling Prism restores it. On Windows install{' '}
                      <span className="font-mono">winget install Gyan.FFmpeg</span>, on Linux your
                      distro's <span className="font-mono">ffmpeg</span> package — then restart Prism.
                    </p>
                  </div>
                </div>
              )}
              <SettingGroup title="Access">
                <SettingRow label="Browser cookies" help={HELP.cookies} description="Use a browser's sign-in for members-only, private and age-restricted videos">
                  <Select
                    value={p.cookiesFromBrowser}
                    options={[
                      { value: 'none', label: 'Off' },
                      { value: 'safari', label: 'Safari' },
                      { value: 'chrome', label: 'Chrome' },
                      { value: 'firefox', label: 'Firefox' },
                      { value: 'edge', label: 'Edge' },
                      { value: 'brave', label: 'Brave' },
                    ]}
                    onChange={v => updatePreference('cookiesFromBrowser', v)}
                  />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Files">
                <SettingRow label="Audio format" description="For audio-only downloads. MP3 plays everywhere; M4A is smaller at the same quality; Opus is smallest">
                  <Select
                    value={p.audioFormat}
                    options={[
                      { value: 'mp3', label: 'MP3' },
                      { value: 'm4a', label: 'M4A (AAC)' },
                      { value: 'opus', label: 'Opus' },
                    ]}
                    onChange={v => updatePreference('audioFormat', v)}
                  />
                </SettingRow>
                <SettingRow label="Keep original container" help={HELP.container} description="Off: every video becomes .mp4 for QuickTime and Finder. On: 4K/HDR downloads stay .mkv/.webm as the site serves them — better in VLC and mpv">
                  <Toggle checked={p.keepOriginalContainer} onChange={v => updatePreference('keepOriginalContainer', v)} />
                </SettingRow>
                <SettingRow label="SponsorBlock" help={HELP.sponsorblock} description="Mark sponsor segments as chapters, or cut them out (needs ffmpeg)">
                  <Select
                    value={p.sponsorBlock}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'mark', label: 'Mark as chapters' },
                      { value: 'remove', label: 'Remove segments' },
                    ]}
                    onChange={v => updatePreference('sponsorBlock', v)}
                  />
                </SettingRow>
              </SettingGroup>
            </TabsContent>

            <TabsContent value="bittorrent" className="mt-0">
              <SettingGroup title="Seeding">
                <SettingRow label="When a torrent finishes" description="How long to keep uploading to the swarm afterwards">
                  <Select
                    value={p.seedingPolicy}
                    options={[
                      { value: 'stop', label: 'Stop at 100%' },
                      { value: 'ratio', label: 'Seed to target ratio' },
                      { value: 'seed', label: 'Seed until stopped' },
                    ]}
                    onChange={v => updatePreference('seedingPolicy', v)}
                  />
                </SettingRow>
                {p.seedingPolicy === 'ratio' && (
                  <SettingRow label="Target ratio" help={HELP.ratio} description="Stop seeding once uploaded ÷ downloaded reaches this">
                    <NumberInput value={p.seedRatioTarget} onChange={v => updatePreference('seedRatioTarget', v)} min={0.1} max={10} step={0.1} />
                  </SettingRow>
                )}
                {p.seedingPolicy !== 'stop' && (
                  <SettingRow label="Seed time limit" description="Stop seeding after this long, whatever the ratio (0 = no limit)">
                    <NumberInput value={p.seedTimeLimitMinutes} onChange={v => updatePreference('seedTimeLimitMinutes', v)} min={0} max={525600} unit="min" />
                  </SettingRow>
                )}
              </SettingGroup>
              <SettingGroup title="Finding peers">
                <SettingRow label="Extra trackers" help={HELP.trackers} description="Added to every torrent (comma or newline separated). Helps when a magnet's own trackers are dead">
                  <TextInput value={p.extraTrackers} onChange={v => updatePreference('extraTrackers', v)} placeholder="udp://tracker.example.org:1337/announce" />
                </SettingRow>
                <SettingRow label="Give up on peerless torrents after" description="Minutes with no peers before a torrent is marked failed. 0 = never: Prism keeps re-announcing every 5 minutes">
                  <NumberInput value={p.torrentGiveUpMinutes} onChange={v => updatePreference('torrentGiveUpMinutes', v)} min={0} max={10080} unit="min" />
                </SettingRow>
              </SettingGroup>
              <Advanced>
                <SettingGroup title="Engine (applies on next launch)">
                  <SettingRow label="DHT" help={HELP.dht} description="Find peers without a tracker. Off = tracker-only">
                    <Toggle checked={p.torrentDht} onChange={v => updatePreference('torrentDht', v)} />
                  </SettingRow>
                  <SettingRow label="Local peer discovery" help={HELP.lsd} description="Find peers on your own network">
                    <Toggle checked={p.torrentLsd} onChange={v => updatePreference('torrentLsd', v)} />
                  </SettingRow>
                  <SettingRow label="uTP transport" help={HELP.utp} description="Accept and make uTP connections alongside TCP (still maturing in the engine)">
                    <Toggle checked={p.torrentUtp} onChange={v => updatePreference('torrentUtp', v)} />
                  </SettingRow>
                  <SettingRow label="UPnP port forwarding" help={HELP.upnp} description="Faster swarms, but it tells your network this machine accepts connections — turn off when using a proxy for privacy">
                    <Toggle checked={p.torrentUpnp} onChange={v => updatePreference('torrentUpnp', v)} />
                  </SettingRow>
                  <SettingRow label="Listen port" description="Incoming peer connections (and the UPnP mapping) use this port">
                    <NumberInput value={p.torrentListenPort} onChange={v => updatePreference('torrentListenPort', v)} min={1024} max={65535} />
                  </SettingRow>
                  <SettingRow label="Max peers per torrent" description="0 = engine default. Lower it on slow or metered connections">
                    <NumberInput value={p.torrentPeerLimit} onChange={v => updatePreference('torrentPeerLimit', v)} min={0} max={10000} />
                  </SettingRow>
                  <SettingRow label="IP blocklist" help={HELP.blocklist} description="URL of a blocklist (https, gz supported). Empty = off">
                    <TextInput value={p.blocklistUrl} onChange={v => updatePreference('blocklistUrl', v)} placeholder="https://example.com/blocklist.p2p.gz" />
                  </SettingRow>
                </SettingGroup>
              </Advanced>
            </TabsContent>

            <TabsContent value="speed" className="mt-0">
              <SettingGroup title="Queue">
                <SettingRow label="Max concurrent downloads" description="Transfers running at the same time">
                  <NumberInput value={p.maxConcurrentDownloads} onChange={v => updatePreference('maxConcurrentDownloads', v)} min={1} max={10} />
                </SettingRow>
                <SettingRow label="Retries on failure" description="Attempts before a download is marked failed">
                  <NumberInput value={p.defaultRetryCount} onChange={v => updatePreference('defaultRetryCount', v)} min={0} max={10} />
                </SettingRow>
                <SettingRow label="Subscription check interval" description="How often subscribed channels and playlists are checked for new videos">
                  <NumberInput value={p.subscriptionCheckIntervalMinutes} onChange={v => updatePreference('subscriptionCheckIntervalMinutes', v)} min={5} max={1440} unit="min" />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Speed limits (0 = unlimited)">
                <SettingRow label="Video downloads" description="Per download; applies when a download starts">
                  <NumberInput value={p.bandwidthLimit} onChange={v => updatePreference('bandwidthLimit', v)} min={0} max={10000} step={0.5} unit="MB/s" />
                </SettingRow>
                <SettingRow label="Torrent download" description="All torrents together; applies immediately">
                  <NumberInput value={kbpsToMbps(p.torrentDownloadLimitKBps)} onChange={v => updatePreference('torrentDownloadLimitKBps', mbpsToKbps(v))} min={0} max={10000} step={0.1} unit="MB/s" />
                </SettingRow>
                <SettingRow label="Torrent upload" description="All seeding and uploading together; applies immediately">
                  <NumberInput value={kbpsToMbps(p.torrentUploadLimitKBps)} onChange={v => updatePreference('torrentUploadLimitKBps', mbpsToKbps(v))} min={0} max={10000} step={0.1} unit="MB/s" />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title="Quiet hours">
                <SettingRow label="Quiet hours" description="Hold or slow down downloads during part of the day">
                  <Toggle checked={p.scheduleEnabled} onChange={v => updatePreference('scheduleEnabled', v)} />
                </SettingRow>
                {p.scheduleEnabled && (
                  <>
                    <SettingRow label="From" description="Hour the window starts (24-hour clock)">
                      <NumberInput value={p.scheduleStartHour} onChange={v => updatePreference('scheduleStartHour', v)} min={0} max={23} unit=":00" />
                    </SettingRow>
                    <SettingRow label="Until" description="Hour the window ends; wraps past midnight">
                      <NumberInput value={p.scheduleEndHour} onChange={v => updatePreference('scheduleEndHour', v)} min={0} max={23} unit=":00" />
                    </SettingRow>
                    <SettingRow label="During quiet hours" description="Hold new downloads entirely, or start them slower (torrents are slowed too)">
                      <Select
                        value={p.scheduleMode}
                        options={[
                          { value: 'limit', label: 'Slow down' },
                          { value: 'pause', label: 'Hold downloads' },
                        ]}
                        onChange={v => updatePreference('scheduleMode', v)}
                      />
                    </SettingRow>
                    {p.scheduleMode === 'limit' && (
                      <SettingRow label="Quiet-hours speed" description="Cap for downloads started, and torrents running, during the window">
                        <NumberInput value={p.scheduleLimitMBps} onChange={v => updatePreference('scheduleLimitMBps', v)} min={1} max={1000} unit="MB/s" />
                      </SettingRow>
                    )}
                  </>
                )}
              </SettingGroup>

              <SettingGroup title="When a download finishes">
                <SettingRow label="Then" description="For every download, unless one is set differently in its details">
                  <Select
                    value={p.defaultWhenComplete}
                    options={[
                      { value: 'nothing', label: 'Do nothing' },
                      { value: 'notify', label: 'Notify me' },
                      { value: 'open', label: 'Open the file' },
                      { value: 'reveal', label: 'Show in folder' },
                    ]}
                    onChange={v => updatePreference('defaultWhenComplete', v)}
                  />
                </SettingRow>
              </SettingGroup>

              <SettingGroup title="When everything finishes">
                <SettingRow label="Then" description="Happens a minute after the last download ends, and only after Prism has actually been working — with a countdown you can call off">
                  <Select
                    value={p.whenDoneAction}
                    options={[
                      { value: 'nothing', label: 'Do nothing' },
                      { value: 'sleep', label: 'Sleep' },
                      { value: 'shutdown', label: 'Shut down' },
                      { value: 'quit', label: 'Quit Prism' },
                    ]}
                    onChange={v => updatePreference('whenDoneAction', v)}
                  />
                </SettingRow>
                {p.whenDoneAction !== 'nothing' && (
                  <SettingRow label="Seeding torrents" description="Uploading counts as work, so nothing happens while a torrent is still seeding">
                    <Select
                      value={p.whenDoneIgnoresSeeding ? 'ignore' : 'wait'}
                      options={[
                        { value: 'wait', label: 'Wait for seeding' },
                        { value: 'ignore', label: "Don't wait" },
                      ]}
                      onChange={v => updatePreference('whenDoneIgnoresSeeding', v === 'ignore')}
                    />
                  </SettingRow>
                )}
              </SettingGroup>
            </TabsContent>

            <TabsContent value="network" className="mt-0">
              <SettingGroup title="Connection">
                <SettingRow label="Proxy" help={HELP.proxy} description="Video downloads go fully through it — use socks5h:// so DNS does too. Torrents send only peer connections through a socks5 proxy (DHT, trackers and UPnP stay direct). Empty = direct">
                  <TextInput value={p.proxyUrl} onChange={v => updatePreference('proxyUrl', v)} placeholder="socks5h://127.0.0.1:9050" />
                </SettingRow>
                <SettingRow label="Use IPv4 only" help={HELP.ipv4} description="For video downloads and link lookups. On by default">
                  <Toggle checked={p.forceIpv4} onChange={v => updatePreference('forceIpv4', v)} />
                </SettingRow>
              </SettingGroup>
            </TabsContent>

            <TabsContent value="storage" className="mt-0">
              <div className="divide-y divide-border/30">
                <SettingRow label="Download location" description="Any folder you pick — including external drives and network shares — is allowed; system folders (Library, AppData, dotfiles) never are">
                  <button
                    type="button"
                    {...{ 'aria-label': `Download location: ${p.defaultSaveFolder}. Choose a folder` }}
                    onClick={async () => {
                      const dir = await service.pickDirectory();
                      if (dir) updatePreference('defaultSaveFolder', dir);
                    }}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                  >
                    <FolderOpen className="w-3 h-3 shrink-0" />
                    {p.defaultSaveFolder}
                  </button>
                </SettingRow>
                <SettingRow label="File names" description="How new downloads are named. Placeholders: {title} {uploader} {site} {resolution} {date} (the day it was added); a / makes a subfolder. Torrents keep their own names">
                  <div className="flex flex-col items-end gap-1">
                    <input
                      type="text"
                      value={p.filenameTemplate}
                      onChange={e => updatePreference('filenameTemplate', e.target.value)}
                      placeholder="{title}"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label="File name template"
                      className="w-56 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
                    />
                    {templatePreview && (
                      <span
                        className={cn('text-[11px] max-w-56 truncate', templatePreview.ok ? 'text-muted-foreground' : 'text-destructive')}
                        title={templatePreview.text}
                      >
                        {templatePreview.ok ? `e.g. ${templatePreview.text}.mp4` : templatePreview.text}
                      </span>
                    )}
                  </div>
                </SettingRow>
                <SettingRow label="Move finished downloads" description="Take each finished download out of the working folder. Torrents move once seeding ends, and nothing is ever overwritten">
                  <Toggle checked={p.moveCompletedEnabled} onChange={v => updatePreference('moveCompletedEnabled', v)} />
                </SettingRow>
                {p.moveCompletedEnabled && (
                  <SettingRow label="Move them to" description="Where finished downloads end up">
                    <button
                      type="button"
                      {...{ 'aria-label': `Move finished downloads to: ${p.moveCompletedTo || 'not set yet'}. Choose a folder` }}
                      onClick={async () => {
                        const dir = await service.pickDirectory();
                        if (dir) updatePreference('moveCompletedTo', dir);
                      }}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      {p.moveCompletedTo || 'Choose a folder…'}
                    </button>
                  </SettingRow>
                )}
                <SettingRow label="Categories" description="Sort downloads as they arrive: the first category whose rules match gives a download its folder and file names. Leave a box empty to use the defaults">
                  <div className="flex flex-col items-end gap-2">
                    {p.categories.map((category, index) => (
                      <div key={category.id} className="flex flex-col items-end gap-1 p-2 rounded-lg bg-input/60 border border-border/40">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={category.name}
                            onChange={e => updateCategory(category.id, { name: e.target.value })}
                            placeholder="Name"
                            aria-label={`Category ${index + 1} name`}
                            className="w-28 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none"
                          />
                          <input
                            type="text"
                            value={category.domains.join(', ')}
                            onChange={e => updateCategory(category.id, { domains: e.target.value.split(',').map(d => d.trim()).filter(Boolean) })}
                            placeholder="youtube.com"
                            spellCheck={false}
                            aria-label={`Category ${index + 1} sites`}
                            className="w-36 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono"
                          />
                          <button
                            type="button"
                            aria-label={`Remove category ${category.name || index + 1}`}
                            onClick={() => updatePreference('categories', p.categories.filter(c => c.id !== category.id))}
                            className="px-2 py-1 rounded-md bg-secondary text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                          >
                            Remove
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={category.filenameTemplate}
                            onChange={e => updateCategory(category.id, { filenameTemplate: e.target.value })}
                            placeholder="File names, e.g. {uploader}/{title}"
                            spellCheck={false}
                            aria-label={`Category ${index + 1} file names`}
                            className="w-44 px-2 py-1 rounded-md bg-input border border-border/40 text-[11px] text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
                          />
                          <button
                            type="button"
                            aria-label={`Category ${index + 1} folder: ${category.destination || 'the default download folder'}. Choose a folder`}
                            onClick={async () => {
                              const dir = await service.pickDirectory();
                              if (dir) updateCategory(category.id, { destination: dir });
                            }}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-input border border-border/40 text-[11px] text-muted-foreground hover:bg-secondary transition-colors max-w-44"
                          >
                            <FolderOpen className="w-3 h-3 shrink-0" />
                            <span className="truncate">{category.destination || 'Default folder'}</span>
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => updatePreference('categories', [
                        ...p.categories,
                        { id: generateId(), name: '', destination: '', filenameTemplate: '', domains: [], kinds: [] },
                      ])}
                      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      Add a category
                    </button>
                  </div>
                </SettingRow>
                <SettingRow label="Labels" description="Tags you put on a download by hand, several at a time. They group things after the fact and change nothing about where a download goes">
                  <div className="flex flex-col items-end gap-1.5">
                    {p.labels.map((label, index) => (
                      <div key={label.id} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={label.name}
                          onChange={e => updatePreference('labels', p.labels.map(l => (l.id === label.id ? { ...l, name: e.target.value } : l)))}
                          placeholder="Name"
                          aria-label={`Label ${index + 1} name`}
                          className="w-36 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none"
                        />
                        <button
                          type="button"
                          aria-label={`Remove label ${label.name || index + 1}`}
                          onClick={() => updatePreference('labels', p.labels.filter(l => l.id !== label.id))}
                          className="px-2 py-1 rounded-md bg-secondary text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => updatePreference('labels', [...p.labels, { id: generateId(), name: '' }])}
                      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      Add a label
                    </button>
                  </div>
                </SettingRow>
                <SettingRow label="Watch folders" description="Drop a .torrent file or a text file of links into one of these and Prism adds it. Handled files are renamed, never deleted">
                  <div className="flex flex-col items-end gap-1.5">
                    {p.watchFolders.map(folder => (
                      <div key={folder.path} className="flex items-center gap-1.5">
                        <span className="text-[11px] text-muted-foreground max-w-48 truncate" title={folder.path}>{folder.path}</span>
                        <button
                          type="button"
                          aria-label={`Stop watching ${folder.path}`}
                          onClick={() => updatePreference('watchFolders', p.watchFolders.filter(f => f.path !== folder.path))}
                          className="px-2 py-1 rounded-md bg-secondary text-[11px] font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={async () => {
                        const dir = await service.pickDirectory();
                        if (dir && !p.watchFolders.some(f => f.path === dir)) {
                          updatePreference('watchFolders', [...p.watchFolders, { path: dir, enabled: true }]);
                        }
                      }}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      Add a folder…
                    </button>
                  </div>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="notifications" className="mt-0">
              <div className="divide-y divide-border/30">
                <SettingRow label="Notifications" description="Show notifications for download events">
                  <Toggle checked={p.notificationsEnabled} onChange={v => updatePreference('notificationsEnabled', v)} />
                </SettingRow>
                <SettingRow label="Sound effects" description="Play a sound when a download finishes">
                  <Toggle checked={p.soundEnabled} onChange={v => updatePreference('soundEnabled', v)} />
                </SettingRow>
                <SettingRow label="Clipboard link detection" description="When Prism regains focus, check the clipboard for a video link and offer a one-click fetch. Off = Prism never reads the clipboard on its own">
                  <Toggle checked={p.clipboardWatchEnabled} onChange={v => updatePreference('clipboardWatchEnabled', v)} />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="appearance" className="mt-0">
              <div className="divide-y divide-border/30">
                <SettingRow label="Theme" description="Application color scheme">
                  <Select
                    value={p.theme}
                    options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]}
                    onChange={v => updatePreference('theme', v)}
                  />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="updates" className="mt-0">
              <div className="divide-y divide-border/30">
                <SettingRow label="Auto-update" description="Check for a new version on launch and offer to install it">
                  <Toggle checked={p.autoUpdate} onChange={v => updatePreference('autoUpdate', v)} />
                </SettingRow>
                <SettingRow label="Check for updates" description={
                  updateState === 'available' ? `Version ${updateVersion} is available` :
                  updateState === 'up-to-date' ? 'You are on the latest version' :
                  updateState === 'error' ? `Could not check for updates${updateError ? ` — ${updateError}` : ''}` :
                  undefined
                }>
                  <div className="flex items-center gap-2" aria-live="polite">
                    {updateState === 'available' && (
                      <button
                        type="button"
                        onClick={async () => {
                          setUpdateState('installing');
                          toast.info('Downloading and installing update — Prism will restart shortly...');
                          try {
                            await service.installUpdate();
                            // relaunch() is called inside installUpdate — if we reach here it didn't restart
                            toast.success('Update installed! Please restart Prism to apply.');
                          } catch (e) {
                            toast.error('Update failed: ' + (e instanceof Error ? e.message : String(e)));
                            setUpdateState('available');
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
                      >
                        Install Update
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={updateState === 'checking' || updateState === 'installing'}
                      onClick={async () => {
                        setUpdateState('checking');
                        const result = await service.checkForUpdates();
                        setUpdateError(result.error);
                        if (result.available) {
                          setUpdateState('available');
                          setUpdateVersion(result.version);
                          setUpdateNotes(result.notes);
                          toast.success(`Update ${result.version} available!`);
                        } else if (result.error) {
                          setUpdateState('error');
                          toast.error('Could not check for updates');
                        } else {
                          setUpdateState('up-to-date');
                          toast.success('You are on the latest version');
                        }
                      }}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]',
                        updateState === 'checking' || updateState === 'installing'
                          ? 'bg-secondary/50 text-muted-foreground cursor-not-allowed'
                          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                      )}
                    >
                      {updateState === 'checking' ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Checking...
                        </span>
                      ) : updateState === 'installing' ? (
                        <span className="flex items-center gap-1.5">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Installing...
                        </span>
                      ) : 'Check Now'}
                    </button>
                  </div>
                </SettingRow>
                {updateState === 'available' && updateNotes && (
                  <div className="py-2.5">
                    <p className="text-[11px] text-muted-foreground font-medium mb-1">Release Notes</p>
                    <p className="text-[11px] text-muted-foreground/70 whitespace-pre-line">{formatReleaseNotes(updateNotes)}</p>
                  </div>
                )}
                <SettingRow
                  label="Downloader engine"
                  description={engine?.updateAvailable
                    ? `yt-dlp ${engineVersion ?? engine.activeVersion ?? ''} — ${engine.latest} is available`
                    : engineVersion ? `yt-dlp ${engineVersion} — update when sites stop working` : 'Update the yt-dlp engine when sites stop working'}
                >
                  <button
                    type="button"
                    disabled={engineUpdating}
                    onClick={async () => {
                      setEngineUpdating(true);
                      try {
                        const v = await service.updateEngine();
                        setEngineVersion(v);
                        service.getEngineInfo().then(publishEngineInfo).catch(() => {});
                        toast.success(`Downloader engine updated to ${v}`);
                      } catch (e) {
                        toast.error('Engine update failed: ' + (e instanceof Error ? e.message : String(e)));
                      } finally {
                        setEngineUpdating(false);
                      }
                    }}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-xs font-medium transition-colors active:scale-[0.97]',
                      engineUpdating
                        ? 'bg-secondary/50 text-muted-foreground cursor-not-allowed'
                        : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                    )}
                  >
                    {engineUpdating ? (
                      <span className="flex items-center gap-1.5">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Updating...
                      </span>
                    ) : 'Update Engine'}
                  </button>
                </SettingRow>
                <SettingRow label="Check for engine updates" description="Once a day, compare the downloader engine with the newest yt-dlp release">
                  <Toggle checked={p.engineAutoCheck} onChange={v => updatePreference('engineAutoCheck', v)} />
                </SettingRow>
                <SettingRow label="Update the engine automatically" description="Install a newer yt-dlp as soon as the daily check finds one">
                  <Toggle checked={p.engineAutoUpdate} onChange={v => updatePreference('engineAutoUpdate', v)} />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="diagnostics" className="mt-0">
              <div className="divide-y divide-border/30">
                <SettingRow label="Log level" description="Verbosity of diagnostic logs">
                  <Select
                    value={p.logLevel}
                    options={[{ value: 'error', label: 'Error' }, { value: 'warn', label: 'Warning' }, { value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]}
                    onChange={v => updatePreference('logLevel', v)}
                  />
                </SettingRow>
                <SettingRow label="Crash reporting" description="Send anonymous crash reports to help fix bugs. Off by default; no personal data or download history is included">
                  <Toggle checked={p.crashReportingEnabled} onChange={v => updatePreference('crashReportingEnabled', v)} />
                </SettingRow>
                <SettingRow label="Export logs" description="Save the in-app diagnostic log as JSON, to attach to a bug report">
                  <button
                    type="button"
                    onClick={async () => {
                      await service.exportLogs(diagnostics.getLogs());
                      toast.success('Logs exported');
                    }}
                    className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                  >
                    Export
                  </button>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="legal" className="mt-0">
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                  Prism is a general-purpose video download utility. Users are responsible for ensuring they have the right to download any content. Do not use Prism to circumvent DRM or access restrictions.
                </p>
                <div className="divide-y divide-border/30">
                  {([['Privacy Policy', '/privacy'], ['Terms of Service', '/terms'], ['Open Source Licenses', '/licenses']] as const).map(([label, path]) => (
                    <button key={path} type="button" onClick={() => navigate(path)} className="w-full flex items-center justify-between py-2.5 min-h-[40px] text-left">
                      <span className="text-xs font-medium text-foreground">{label}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            </TabsContent>
          </Panel>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive transition-colors active:scale-[0.97]"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </Tabs>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset all settings?"
        description="Every preference — download location, proxy, quiet hours, per-site quality memory — goes back to its default. This can't be undone."
        confirmLabel="Reset Everything"
        destructive
        onConfirm={() => { resetToDefaults(); toast.success('Settings reset to defaults'); }}
      />
    </div>
  );
}
