import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { diagnostics } from '@/services/diagnostics';
import { formatReleaseNotes } from '@/services';
import { Panel, ConfirmDialog } from '@/components/common';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  FolderOpen, Download, Gauge, Bell, Palette, HardDrive,
  RefreshCw, Bug, Shield, ChevronRight, Loader2, AlertTriangle,
} from 'lucide-react';

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 min-h-[40px]">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && <p className="text-[11px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
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

function Select({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NumberInput({ value, onChange, min, max }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  // Clamp on blur, not on change — clamping mid-keystroke fights the user
  // (typing "10" with min 5 would snap the intermediate "1" to 5).
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  return (
    <input
      type="number"
      value={value}
      onChange={e => {
        const n = Number(e.target.value);
        if (!Number.isNaN(n)) onChange(n);
      }}
      onBlur={() => onChange(clamp(value))}
      min={min}
      max={max}
      className="w-16 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none tabular-nums text-right"
    />
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text"
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      className="w-56 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground/50"
    />
  );
}

const SECTIONS = [
  { id: 'downloads', label: 'Downloads', icon: Download },
  { id: 'queue', label: 'Queue', icon: Gauge },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'updates', label: 'Updates', icon: RefreshCw },
  { id: 'diagnostics', label: 'Diagnostics', icon: Bug },
  { id: 'legal', label: 'Legal', icon: Shield },
] as const;

export default function Settings() {
  const { preferences: p, updatePreference, resetToDefaults } = useSettings();
  const service = useService();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = React.useState('downloads');
  const [updateState, setUpdateState] = React.useState<'idle' | 'checking' | 'available' | 'installing' | 'up-to-date' | 'error'>('idle');
  const [updateVersion, setUpdateVersion] = React.useState<string | undefined>();
  const [updateNotes, setUpdateNotes] = React.useState<string | undefined>();
  const [updateError, setUpdateError] = React.useState<string | undefined>();
  const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
  const [engineUpdating, setEngineUpdating] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [ffmpegOk, setFfmpegOk] = React.useState(true);

  React.useEffect(() => {
    if (activeSection !== 'updates') return;
    service.getEngineVersion().then(setEngineVersion).catch(() => setEngineVersion(null));
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

      <div className="flex gap-6">
        {/* Section Nav */}
        <nav className="w-44 shrink-0 space-y-0.5">
          {SECTIONS.map(s => (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs font-medium transition-colors active:scale-[0.98]',
                activeSection === s.id
                  ? 'bg-primary/12 text-primary'
                  : 'text-muted-foreground hover:bg-secondary hover:text-secondary-foreground'
              )}
            >
              <s.icon className="w-3.5 h-3.5" strokeWidth={1.8} />
              {s.label}
            </button>
          ))}
        </nav>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <Panel className="animate-fade-in" key={activeSection}>
            {activeSection === 'downloads' && (
              <div className="divide-y divide-border/30">
                {!ffmpegOk && (
                  <div className="flex items-start gap-2.5 px-3 py-2.5 mb-1 rounded-lg bg-warning/10 border border-warning/25">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-foreground">ffmpeg not found</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Without it, high-quality merges, embedded thumbnails/chapters, and SponsorBlock
                        won't work. On macOS install it with <span className="font-mono">brew install ffmpeg</span>,
                        then restart Prism.
                      </p>
                    </div>
                  </div>
                )}
                <SettingRow label="Default retry count" description="Number of retry attempts on failure">
                  <NumberInput value={p.defaultRetryCount} onChange={v => updatePreference('defaultRetryCount', v)} min={0} max={10} />
                </SettingRow>
                <SettingRow label="Browser cookies" description="Use a browser's cookies for sign-in-required and age-restricted videos">
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
                    onChange={v => updatePreference('cookiesFromBrowser', v as any)}
                  />
                </SettingRow>
                <SettingRow label="Audio format" description="Container for audio-only downloads. MP3 is most compatible; M4A is smaller at the same quality; Opus is smallest">
                  <Select
                    value={p.audioFormat}
                    options={[
                      { value: 'mp3', label: 'MP3' },
                      { value: 'm4a', label: 'M4A (AAC)' },
                      { value: 'opus', label: 'Opus' },
                    ]}
                    onChange={v => updatePreference('audioFormat', v as any)}
                  />
                </SettingRow>
                <SettingRow label="Keep original container" description="Off (default): every video is remuxed to .mp4 for QuickTime/Finder compatibility. On: VP9/AV1 downloads stay in .mkv/.webm as the site serves them — better for VLC/mpv users and 4K/HDR sources">
                  <Toggle checked={p.keepOriginalContainer} onChange={v => updatePreference('keepOriginalContainer', v)} />
                </SettingRow>
                <SettingRow label="SponsorBlock" description="Mark or remove sponsor segments using crowd-sourced data (requires ffmpeg)">
                  <Select
                    value={p.sponsorBlock}
                    options={[
                      { value: 'off', label: 'Off' },
                      { value: 'mark', label: 'Mark as chapters' },
                      { value: 'remove', label: 'Remove segments' },
                    ]}
                    onChange={v => updatePreference('sponsorBlock', v as any)}
                  />
                </SettingRow>
                <SettingRow label="Torrent seeding" description="After a torrent finishes, how long to keep uploading to the swarm. Seeding to ratio 1.0 shares back roughly what you downloaded">
                  <Select
                    value={p.seedingPolicy}
                    options={[
                      { value: 'stop', label: "Stop at 100%" },
                      { value: 'ratio', label: 'Seed to ratio 1.0' },
                      { value: 'seed', label: 'Seed until stopped' },
                    ]}
                    onChange={v => updatePreference('seedingPolicy', v as any)}
                  />
                </SettingRow>
                <SettingRow label="Extra trackers" description="Announce URLs added to every torrent (comma or newline separated). Helps find peers when a magnet's own trackers are dead">
                  <TextInput
                    value={p.extraTrackers}
                    onChange={v => updatePreference('extraTrackers', v)}
                    placeholder="udp://tracker.example.org:1337/announce"
                  />
                </SettingRow>
                <SettingRow label="IP blocklist" description="URL of a standard p2p blocklist for the torrent engine (gz supported). Takes effect on next launch. Leave empty to disable">
                  <TextInput
                    value={p.blocklistUrl}
                    onChange={v => updatePreference('blocklistUrl', v)}
                    placeholder="https://example.com/blocklist.p2p.gz"
                  />
                </SettingRow>
                <SettingRow label="Proxy" description="Video downloads (yt-dlp) go fully through the proxy — use socks5h:// so DNS does too. Torrents route only peer connections through a socks5 proxy: DHT, trackers and UPnP still use your real address, and http proxies are ignored for torrents. Leave empty for a direct connection">
                  <TextInput
                    value={p.proxyUrl}
                    onChange={v => updatePreference('proxyUrl', v)}
                    placeholder="socks5h://127.0.0.1:9050"
                  />
                </SettingRow>
                <SettingRow label="Torrent UPnP port forwarding" description="Ask your router to forward a port so other peers can reach you (faster swarms). Publishes this machine's reachability; turn off when using a proxy for privacy. Applies on next launch">
                  <Toggle checked={p.torrentUpnp} onChange={v => updatePreference('torrentUpnp', v)} />
                </SettingRow>
                <SettingRow label="Torrent DHT" description="Find peers through the distributed hash table as well as trackers. Off = tracker-only. Applies on next launch">
                  <Toggle checked={p.torrentDht} onChange={v => updatePreference('torrentDht', v)} />
                </SettingRow>
                <SettingRow label="Local peer discovery" description="Find peers on your own network (LSD). Applies on next launch">
                  <Toggle checked={p.torrentLsd} onChange={v => updatePreference('torrentLsd', v)} />
                </SettingRow>
                <SettingRow label="uTP transport" description="Accept and make uTP connections alongside TCP (kinder to home routers; still maturing in the engine). Applies on next launch">
                  <Toggle checked={p.torrentUtp} onChange={v => updatePreference('torrentUtp', v)} />
                </SettingRow>
                <SettingRow label="Listen port" description="Incoming peer connections (and the UPnP mapping) use this port. Applies on next launch">
                  <NumberInput value={p.torrentListenPort} onChange={v => updatePreference('torrentListenPort', Math.max(1024, Math.min(65535, v)))} min={1024} max={65535} />
                </SettingRow>
                <SettingRow label="Max peers per torrent" description="0 = engine default. Lower it on slow connections or metered links. Applies to torrents added after the change">
                  <NumberInput value={p.torrentPeerLimit} onChange={v => updatePreference('torrentPeerLimit', Math.max(0, Math.min(10000, v)))} min={0} max={10000} />
                </SettingRow>
                <SettingRow label="Torrent download limit" description="Session-wide cap for all torrents, in KB/s (0 = unlimited). Applies immediately; Quiet Hours can lower it further">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.torrentDownloadLimitKBps} onChange={v => updatePreference('torrentDownloadLimitKBps', Math.max(0, v))} min={0} />
                    <span className="text-[11px] text-muted-foreground">KB/s</span>
                  </div>
                </SettingRow>
                <SettingRow label="Torrent upload limit" description="Session-wide cap on seeding/upload, in KB/s (0 = unlimited). Applies immediately">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.torrentUploadLimitKBps} onChange={v => updatePreference('torrentUploadLimitKBps', Math.max(0, v))} min={0} />
                    <span className="text-[11px] text-muted-foreground">KB/s</span>
                  </div>
                </SettingRow>
                <SettingRow label="Give up on peerless torrents after" description="Minutes with no connected peers before a torrent is marked failed. 0 = never: Prism keeps re-announcing to trackers and the DHT every 5 minutes, like uTorrent or Vuze">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.torrentGiveUpMinutes} onChange={v => updatePreference('torrentGiveUpMinutes', Math.max(0, Math.min(10080, v)))} min={0} max={10080} />
                    <span className="text-[11px] text-muted-foreground">min</span>
                  </div>
                </SettingRow>
                <SettingRow label="Seed ratio target" description="For the 'Seed to ratio' policy: stop once uploaded ÷ downloaded reaches this">
                  <TextInput
                    value={String(p.seedRatioTarget)}
                    onChange={v => { const n = Number(v); if (Number.isFinite(n)) updatePreference('seedRatioTarget', Math.max(0.1, Math.min(10, n))); }}
                    placeholder="1.0"
                  />
                </SettingRow>
                <SettingRow label="Seed time limit" description="Stop seeding after this many minutes under any policy except 'Stop at 100%' (0 = no limit)">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.seedTimeLimitMinutes} onChange={v => updatePreference('seedTimeLimitMinutes', Math.max(0, Math.min(525600, v)))} min={0} max={525600} />
                    <span className="text-[11px] text-muted-foreground">min</span>
                  </div>
                </SettingRow>
              </div>
            )}

            {activeSection === 'queue' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Max concurrent downloads" description="Number of simultaneous downloads">
                  <NumberInput value={p.maxConcurrentDownloads} onChange={v => updatePreference('maxConcurrentDownloads', Math.max(1, Math.min(10, v)))} min={1} max={10} />
                </SettingRow>
                <SettingRow label="Bandwidth limit" description="Maximum download speed (0 = unlimited)">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.bandwidthLimit} onChange={v => updatePreference('bandwidthLimit', v)} min={0} />
                    <span className="text-[11px] text-muted-foreground">MB/s</span>
                  </div>
                </SettingRow>
                <SettingRow label="Subscription check interval" description="How often to check subscribed channels and playlists for new videos">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.subscriptionCheckIntervalMinutes} onChange={v => updatePreference('subscriptionCheckIntervalMinutes', Math.max(5, Math.min(1440, v)))} min={5} max={1440} />
                    <span className="text-[11px] text-muted-foreground">min</span>
                  </div>
                </SettingRow>
                <SettingRow label="Quiet hours" description="Hold or throttle new downloads during part of the day (applies when a download starts)">
                  <Toggle checked={p.scheduleEnabled} onChange={v => updatePreference('scheduleEnabled', v)} />
                </SettingRow>
                {p.scheduleEnabled && (
                  <>
                    <SettingRow label="Window" description="Start and end hour (24h clock; wraps overnight)">
                      <div className="flex items-center gap-1.5">
                        <NumberInput value={p.scheduleStartHour} onChange={v => updatePreference('scheduleStartHour', Math.max(0, Math.min(23, v)))} min={0} max={23} />
                        <span className="text-[11px] text-muted-foreground">to</span>
                        <NumberInput value={p.scheduleEndHour} onChange={v => updatePreference('scheduleEndHour', Math.max(0, Math.min(23, v)))} min={0} max={23} />
                        <span className="text-[11px] text-muted-foreground">h</span>
                      </div>
                    </SettingRow>
                    <SettingRow label="During quiet hours" description="Hold downloads entirely, or start them at a reduced speed">
                      <Select
                        value={p.scheduleMode}
                        options={[
                          { value: 'limit', label: 'Throttle' },
                          { value: 'pause', label: 'Hold downloads' },
                        ]}
                        onChange={v => updatePreference('scheduleMode', v as 'pause' | 'limit')}
                      />
                    </SettingRow>
                    {p.scheduleMode === 'limit' && (
                      <SettingRow label="Quiet-hours speed" description="Speed limit applied to downloads started during the window">
                        <div className="flex items-center gap-1.5">
                          <NumberInput value={p.scheduleLimitMBps} onChange={v => updatePreference('scheduleLimitMBps', Math.max(1, Math.min(1000, v)))} min={1} max={1000} />
                          <span className="text-[11px] text-muted-foreground">MB/s</span>
                        </div>
                      </SettingRow>
                    )}
                  </>
                )}
              </div>
            )}

            {activeSection === 'notifications' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Notifications" description="Show notifications for download events">
                  <Toggle checked={p.notificationsEnabled} onChange={v => updatePreference('notificationsEnabled', v)} />
                </SettingRow>
                <SettingRow label="Sound effects" description="Play sounds on completion and errors">
                  <Toggle checked={p.soundEnabled} onChange={v => updatePreference('soundEnabled', v)} />
                </SettingRow>
                <SettingRow label="Clipboard link detection" description="When Prism regains focus, check the clipboard for a video link and offer a one-click fetch. Off = Prism never reads the clipboard on its own">
                  <Toggle checked={p.clipboardWatchEnabled} onChange={v => updatePreference('clipboardWatchEnabled', v)} />
                </SettingRow>
              </div>
            )}

            {activeSection === 'appearance' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Theme" description="Application color scheme">
                  <Select value={p.theme} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'system', label: 'System' }]} onChange={v => updatePreference('theme', v as any)} />
                </SettingRow>
              </div>
            )}

            {activeSection === 'storage' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Download location" description="Where downloads are saved. Any folder you pick here — including external drives and network shares — is allowed; system folders (Library, AppData, dotfiles) never are">
                  <button
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
              </div>
            )}

            {activeSection === 'updates' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Auto-update" description="Automatically check and install updates on launch">
                  <Toggle checked={p.autoUpdate} onChange={v => updatePreference('autoUpdate', v)} />
                </SettingRow>
                <SettingRow label="Check for updates" description={
                  updateState === 'available' ? `Version ${updateVersion} is available` :
                  updateState === 'up-to-date' ? 'You are on the latest version' :
                  updateState === 'error' ? `Could not check for updates${updateError ? ` — ${updateError}` : ''}` :
                  undefined
                }>
                  <div className="flex items-center gap-2">
                    {updateState === 'available' && (
                      <button
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
                  description={engineVersion ? `yt-dlp ${engineVersion} — update when sites stop working` : 'Update the yt-dlp engine when sites stop working'}
                >
                  <button
                    disabled={engineUpdating}
                    onClick={async () => {
                      setEngineUpdating(true);
                      try {
                        const v = await service.updateEngine();
                        setEngineVersion(v);
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
              </div>
            )}

            {activeSection === 'diagnostics' && (
              <div className="divide-y divide-border/30">
                <SettingRow label="Log level" description="Verbosity of diagnostic logs">
                  <Select value={p.logLevel} options={[{ value: 'error', label: 'Error' }, { value: 'warn', label: 'Warning' }, { value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }]} onChange={v => updatePreference('logLevel', v as any)} />
                </SettingRow>
                <SettingRow label="Crash reporting" description="Send anonymous crash reports to help fix bugs. Off by default; no personal data or download history is included">
                  <Toggle checked={p.crashReportingEnabled} onChange={v => updatePreference('crashReportingEnabled', v)} />
                </SettingRow>
                <SettingRow label="Export logs">
                  <button
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
            )}

            {activeSection === 'legal' && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                  Prism is a general-purpose video download utility. Users are responsible for ensuring they have the right to download any content. Do not use Prism to circumvent DRM or access restrictions.
                </p>
                <div className="divide-y divide-border/30">
                  <button onClick={() => navigate('/privacy')} className="w-full">
                    <SettingRow label="Privacy Policy">
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    </SettingRow>
                  </button>
                  <button onClick={() => navigate('/terms')} className="w-full">
                    <SettingRow label="Terms of Service">
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    </SettingRow>
                  </button>
                  <button onClick={() => navigate('/licenses')} className="w-full">
                    <SettingRow label="Open Source Licenses">
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                    </SettingRow>
                  </button>
                </div>
              </div>
            )}
          </Panel>

          <div className="mt-4 flex justify-end">
            <button
              onClick={() => setConfirmReset(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive transition-colors active:scale-[0.97]"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>

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
