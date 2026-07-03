import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { diagnostics } from '@/services/diagnostics';
import { formatReleaseNotes } from '@/services';
import { Panel } from '@/components/common';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  FolderOpen, Download, Gauge, Bell, Palette, HardDrive,
  RefreshCw, Bug, Shield, ChevronRight, Loader2,
} from 'lucide-react';

function SettingRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-2.5 min-h-[40px]">
      <div className="flex-1 min-w-0 mr-4">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && <p className="text-[10px] text-muted-foreground mt-0.5">{description}</p>}
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
  return (
    <input
      type="number"
      value={value}
      onChange={e => onChange(Number(e.target.value))}
      min={min}
      max={max}
      className="w-16 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none tabular-nums text-right"
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
  const [engineVersion, setEngineVersion] = React.useState<string | null>(null);
  const [engineUpdating, setEngineUpdating] = React.useState(false);

  React.useEffect(() => {
    if (activeSection !== 'updates') return;
    service.getEngineVersion().then(setEngineVersion).catch(() => setEngineVersion(null));
  }, [activeSection, service]);

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
                    <span className="text-[10px] text-muted-foreground">MB/s</span>
                  </div>
                </SettingRow>
                <SettingRow label="Subscription check interval" description="How often to check subscribed channels and playlists for new videos">
                  <div className="flex items-center gap-1.5">
                    <NumberInput value={p.subscriptionCheckIntervalMinutes} onChange={v => updatePreference('subscriptionCheckIntervalMinutes', Math.max(5, Math.min(1440, v)))} min={5} max={1440} />
                    <span className="text-[10px] text-muted-foreground">min</span>
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
                        <span className="text-[10px] text-muted-foreground">to</span>
                        <NumberInput value={p.scheduleEndHour} onChange={v => updatePreference('scheduleEndHour', Math.max(0, Math.min(23, v)))} min={0} max={23} />
                        <span className="text-[10px] text-muted-foreground">h</span>
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
                          <span className="text-[10px] text-muted-foreground">MB/s</span>
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
                <SettingRow label="Download location" description="Primary storage path for downloads">
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
                  updateState === 'error' ? 'Could not reach update server' :
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
                    <p className="text-[10px] text-muted-foreground font-medium mb-1">Release Notes</p>
                    <p className="text-[10px] text-muted-foreground/70 whitespace-pre-line">{formatReleaseNotes(updateNotes)}</p>
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
              onClick={resetToDefaults}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive transition-colors active:scale-[0.97]"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
