import React from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { useEngineStatus, publishEngineInfo } from '@/stores/engine-status';
import { diagnostics } from '@/services/diagnostics';
import { formatReleaseNotes, generateId, isSameFolder } from '@/services';
import { QUALITY_CHOICES, type DownloadCategory } from '@/types/models';
import { Panel, ConfirmDialog, CommitInput } from '@/components/common';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { DAY_NAMES } from '@/stores/schedule';
import { toast } from 'sonner';
import { IS_MAC } from '@/lib/platform';
import { useUpdateInstall, installAppUpdate, formatUpdateProgress } from '@/stores/app-update';
import { FolderOpen, Film, Magnet, Globe, Palette, Shield, ChevronRight, Loader2, AlertTriangle, Search } from 'lucide-react';
import { SettingRow, SettingGroup, Advanced, Toggle, StorageTile, Select, NumberInput, TextInput } from './settings/controls';
import { SettingsQuery } from './settings/query';
import { useFindShortcut } from '@/hooks/use-find-shortcut';
import { ClientImportRow, RestartTorrentEngineRow, BackupRow } from './settings/rows';
import { DisabledReason } from '@/components/common/DisabledReason';
import { t } from '@/i18n';
import { Trans } from 'react-i18next';

/** Five tabs since 2.6 (there were ten). Each holds one or more of the old
 * sections, which keep their own headings, so nothing moved inside them. */
const SECTIONS = [
  { id: 'general', label: t('settings.page.general'), icon: Palette },
  { id: 'downloads', label: t('settings.page.downloads'), icon: Film },
  { id: 'torrents', label: t('settings.page.torrents'), icon: Magnet },
  { id: 'network', label: t('settings.page.network'), icon: Globe },
  { id: 'privacy', label: t('settings.page.privacyAdvanced'), icon: Shield },
] as const;

/** The old sections, the tab each one now lives in, and its heading there. */
const PARTS: Record<string, { tab: string; title: string }> = {
  appearance: { tab: 'general', title: t('settings.page.appearance') },
  notifications: { tab: 'general', title: t('settings.page.notifications') },
  updates: { tab: 'general', title: t('settings.page.updates') },
  video: { tab: 'downloads', title: t('settings.page.video') },
  speed: { tab: 'downloads', title: t('settings.page.speedSchedule') },
  storage: { tab: 'downloads', title: t('settings.page.storage') },
  bittorrent: { tab: 'torrents', title: t('settings.page.torrents') },
  network: { tab: 'network', title: t('settings.page.network') },
  diagnostics: { tab: 'privacy', title: t('settings.page.diagnostics') },
  legal: { tab: 'privacy', title: t('settings.page.aboutLegal') },
};

/** Old links (?section=video, ?section=updates, pre-1.9 ids) still land. */
const SECTION_ALIASES: Record<string, string> = {
  downloads: 'downloads', queue: 'downloads',
  ...Object.fromEntries(Object.entries(PARTS).map(([old, { tab }]) => [old, tab])),
};

function resolveSection(requested: string | null): string | null {
  if (!requested) return null;
  const id = SECTIONS.some(s => s.id === requested) ? requested : SECTION_ALIASES[requested];
  return id && SECTIONS.some(s => s.id === id) ? id : null;
}

/** Torrent limits are stored in KB/s (what the engine takes); every speed is
 * shown in MB/s so the three limits read the same. */
const kbpsToMbps = (kbps: number) => Math.round((kbps / 1024) * 100) / 100;
const mbpsToKbps = (mbps: number) => Math.round(mbps * 1024);

const HELP = {
  cookies: [t('settings.help.cookies.term'), t('settings.help.cookies.text')],
  container: [t('settings.help.container.term'), t('settings.help.container.text')],
  sponsorblock: [t('settings.help.sponsorblock.term'), t('settings.help.sponsorblock.text')],
  ratio: [t('settings.help.ratio.term'), t('settings.help.ratio.text')],
  trackers: [t('settings.help.trackers.term'), t('settings.help.trackers.text')],
  dht: [t('settings.help.dht.term'), t('settings.help.dht.text')],
  lsd: [t('settings.help.lsd.term'), t('settings.help.lsd.text')],
  utp: [t('settings.help.utp.term'), t('settings.help.utp.text')],
  upnp: [t('settings.help.upnp.term'), t('settings.help.upnp.text')],
  blocklist: [t('settings.help.blocklist.term'), t('settings.help.blocklist.text')],
  proxy: [t('settings.help.proxy.term'), t('settings.help.proxy.text')],
  ipv4: [t('settings.help.ipv4.term'), t('settings.help.ipv4.text')],
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
  const [activeSection, setActiveSection] = React.useState<string>(requestedSection ?? 'general');
  const [query, setQuery] = React.useState('');
  const searchRef = React.useRef<HTMLInputElement>(null);
  useFindShortcut(searchRef);
  const searching = query.trim() !== '';
  React.useEffect(() => {
    if (requestedSection) setActiveSection(requestedSection);
  }, [requestedSection]);
  const [pageUpdateState, setUpdateState] = React.useState<'idle' | 'checking' | 'available' | 'installing' | 'up-to-date' | 'error'>('idle');
  // An install outlives this page: leaving Settings and coming back must show
  // it still running, not offer Install again (stores/app-update.ts).
  const updateInstall = useUpdateInstall();
  const updateState = updateInstall.installing ? 'installing' : pageUpdateState;
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
    if (activeSection !== 'downloads' && !searching) return;
    const timer = setTimeout(() => {
      service.previewFilenameTemplate(p.filenameTemplate, SAMPLE_TEMPLATE_VARS)
        .then(text => setTemplatePreview({ ok: true, text }))
        .catch((e: unknown) => setTemplatePreview({
          ok: false,
          text: typeof e === 'string' ? e : e instanceof Error ? e.message : t('settings.page.invalidTemplate'),
        }));
    }, 250);
    return () => clearTimeout(timer);
  }, [activeSection, searching, p.filenameTemplate, service]);

  React.useEffect(() => {
    if (activeSection !== 'general' && !searching) return;
    service.getEngineVersion().then(setEngineVersion).catch(() => setEngineVersion(null));
    service.getEngineInfo().then(publishEngineInfo).catch(() => {});
  }, [activeSection, searching, service]);

  React.useEffect(() => {
    service.ffmpegAvailable().then(setFfmpegOk).catch(() => {});
  }, [service]);

  return (
    <div className="page-container">
      <div className="page-header flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{t('shell.nav.settings')}</h1>
          <p className="page-subtitle">{t('settings.page.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-input border border-border/40 w-72">
          <Search className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setQuery(''); }}
            placeholder={t('settings.page.searchSettings')}
            aria-label={t('settings.page.searchSettings2')}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none min-w-0"
          />
        </div>
      </div>

      <Tabs value={activeSection} onValueChange={setActiveSection} orientation="vertical" className="flex gap-6">
        <TabsList aria-label={t('settings.page.settingsSections')} className={cn(searching && 'opacity-50 pointer-events-none', 'w-44 shrink-0 h-auto flex flex-col items-stretch justify-start gap-0.5 bg-transparent p-0')}>
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
              {s.id === 'general' && engine?.updateAvailable && (
                <span className="ml-auto w-1.5 h-1.5 rounded-full bg-primary" aria-label={t('settings.page.engineUpdateAvailable')} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="flex-1 min-w-0">
          <SettingsQuery.Provider value={query}>
          <Panel className="animate-fade-in" key={searching ? 'search' : activeSection}>
            <TabsContent value="downloads" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.video')}</h2>
              {!ffmpegOk && (
                <div className="flex items-start gap-2.5 px-3 py-2.5 mb-2 rounded-lg bg-warning/10 border border-warning/25">
                  <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-foreground">{t('setup.ffmpeg.notFound')}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <Trans i18nKey="settings.page.ffmpegMissing" components={{ code: <span className="font-mono" /> }} />
                    </p>
                  </div>
                </div>
              )}
              <SettingGroup title={t('settings.page.access')}>
                <SettingRow label={t('settings.page.browserCookies')} help={HELP.cookies} description={t('settings.page.useABrowsersSignIn')}>
                  <Select
                    value={p.cookiesFromBrowser}
                    options={[
                      { value: 'none', label: t('settings.page.off') },
                      { value: 'safari', label: t('settings.page.safari') },
                      { value: 'chrome', label: t('settings.page.chrome') },
                      { value: 'firefox', label: t('settings.page.firefox') },
                      { value: 'edge', label: t('settings.page.edge') },
                      { value: 'brave', label: t('settings.page.brave') },
                    ]}
                    onChange={v => updatePreference('cookiesFromBrowser', v)}
                  />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title={t('settings.page.files')}>
                <SettingRow label={t('settings.page.defaultQuality')} description={t('settings.page.usedForPlaylistsAndBatches')}>
                  <Select
                    value={p.defaultQuality ?? '1080p'}
                    options={QUALITY_CHOICES}
                    onChange={v => updatePreference('defaultQuality', v)}
                  />
                </SettingRow>
                <SettingRow label={t('settings.page.audioFormat')} description={t('settings.page.forAudioOnlyDownloadsMp3')}>
                  <Select
                    value={p.audioFormat}
                    options={[
                      { value: 'mp3', label: t('settings.page.mp3') },
                      { value: 'm4a', label: t('settings.page.m4aAac') },
                      { value: 'opus', label: t('settings.page.opus') },
                    ]}
                    onChange={v => updatePreference('audioFormat', v)}
                  />
                </SettingRow>
                <SettingRow label={t('settings.page.keepOriginalContainer')} help={HELP.container} description={t('settings.page.offEveryVideoBecomesMp4')}>
                  <Toggle checked={p.keepOriginalContainer} onChange={v => updatePreference('keepOriginalContainer', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.makeVideosPlayOnApple')} description={t('settings.page.reEncodesTheFewDownloads')}>
                  <Toggle checked={p.applePlayable ?? IS_MAC} onChange={v => updatePreference('applePlayable', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.sponsorblock')} help={HELP.sponsorblock} description={t('settings.page.markSponsorSegmentsAsChapters')}>
                  <Select
                    value={p.sponsorBlock}
                    options={[
                      { value: 'off', label: t('settings.page.off') },
                      { value: 'mark', label: t('settings.page.markAsChapters') },
                      { value: 'remove', label: t('settings.page.removeSegments') },
                    ]}
                    onChange={v => updatePreference('sponsorBlock', v)}
                  />
                </SettingRow>
              </SettingGroup>
            </TabsContent>

            <TabsContent value="torrents" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.torrents')}</h2>
              <SettingGroup title={t('settings.page.seeding')}>
                <SettingRow label={t('settings.page.whenATorrentFinishes')} description={t('settings.page.howLongToKeepUploading')}>
                  <Select
                    value={p.seedingPolicy}
                    options={[
                      { value: 'stop', label: t('settings.page.stopAt100') },
                      { value: 'ratio', label: t('settings.page.seedToTargetRatio') },
                      { value: 'seed', label: t('settings.page.seedUntilStopped') },
                    ]}
                    onChange={v => updatePreference('seedingPolicy', v)}
                  />
                </SettingRow>
                {p.seedingPolicy === 'ratio' && (
                  <SettingRow label={t('settings.page.targetRatio')} help={HELP.ratio} description={t('settings.page.stopSeedingOnceUploadedDownloaded')}>
                    <NumberInput value={p.seedRatioTarget} onChange={v => updatePreference('seedRatioTarget', v)} min={0.1} max={10} step={0.1} />
                  </SettingRow>
                )}
                {p.seedingPolicy !== 'stop' && (
                  <SettingRow label={t('settings.page.seedTimeLimit')} description={t('settings.page.stopSeedingAfterThisLong')}>
                    <NumberInput value={p.seedTimeLimitMinutes} onChange={v => updatePreference('seedTimeLimitMinutes', v)} min={0} max={525600} unit="min" />
                  </SettingRow>
                )}
              </SettingGroup>
              <SettingGroup title={t('settings.page.findingPeers')}>
                <SettingRow label={t('settings.page.extraTrackers')} help={HELP.trackers} description={t('settings.page.addedToEveryTorrentComma')}>
                  <TextInput value={p.extraTrackers} onChange={v => updatePreference('extraTrackers', v)} placeholder="udp://tracker.example.org:1337/announce" />
                </SettingRow>
                <SettingRow label={t('settings.page.giveUpOnPeerlessTorrents')} description={t('settings.page.minutesWithNoPeersBefore')}>
                  <NumberInput value={p.torrentGiveUpMinutes} onChange={v => updatePreference('torrentGiveUpMinutes', v)} min={0} max={10080} unit="min" />
                </SettingRow>
              </SettingGroup>
              <Advanced>
                <SettingGroup title={t('settings.page.engineAppliesWhenTheEngine')}>
                  <SettingRow label={t('settings.page.dht')} help={HELP.dht} description={p.proxyUrl ? t('settings.page.dhtProxyOff') : t('settings.page.dhtDescription')}>
                    <Toggle checked={p.torrentDht} onChange={v => updatePreference('torrentDht', v)} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.localPeerDiscovery')} help={HELP.lsd} description={t('settings.page.findPeersOnYourOwn')}>
                    <Toggle checked={p.torrentLsd} onChange={v => updatePreference('torrentLsd', v)} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.utpTransport')} help={HELP.utp} description={p.proxyUrl ? t('settings.page.utpProxyOff') : t('settings.page.utpDescription')}>
                    <Toggle checked={p.torrentUtp} onChange={v => updatePreference('torrentUtp', v)} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.upnpPortForwarding')} help={HELP.upnp} description={t('settings.page.fasterSwarmsButItTells')}>
                    <Toggle checked={p.torrentUpnp} onChange={v => updatePreference('torrentUpnp', v)} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.listenPort')} description={t('settings.page.incomingPeerConnectionsAndThe')}>
                    <NumberInput value={p.torrentListenPort} onChange={v => updatePreference('torrentListenPort', v)} min={1024} max={65535} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.maxPeersPerTorrent')} description={t('settings.page.n0EngineDefaultLowerIt')}>
                    <NumberInput value={p.torrentPeerLimit} onChange={v => updatePreference('torrentPeerLimit', v)} min={0} max={10000} />
                  </SettingRow>
                  <SettingRow label={t('settings.page.ipBlocklist')} help={HELP.blocklist} description={t('settings.page.urlOfABlocklistHttps')}>
                    <TextInput value={p.blocklistUrl} onChange={v => updatePreference('blocklistUrl', v)} placeholder="https://example.com/blocklist.p2p.gz" />
                  </SettingRow>
                  <RestartTorrentEngineRow />
                </SettingGroup>
              </Advanced>
              <SettingGroup title={t('settings.page.moveFromAnotherClient')}>
                <ClientImportRow />
              </SettingGroup>
            </TabsContent>

            <TabsContent value="downloads" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.speedSchedule')}</h2>
              <SettingGroup title={t('settings.page.queue')}>
                <SettingRow label={t('settings.page.maxConcurrentDownloads')} description={t('settings.page.videosAndDirectDownloadsRunning')}>
                  <NumberInput value={p.maxConcurrentDownloads} onChange={v => updatePreference('maxConcurrentDownloads', v)} min={1} max={10} />
                </SettingRow>
                <SettingRow label={t('settings.page.maxConcurrentTorrents')} description={t('settings.page.torrentsDownloadingAtTheSame')}>
                  <NumberInput value={p.maxConcurrentTorrents} onChange={v => updatePreference('maxConcurrentTorrents', v)} min={1} max={20} />
                </SettingRow>
                <SettingRow label={t('settings.page.keepRunningWhenTheWindow')} description={t('settings.page.downloadsCarryOnInThe')}>
                  <Toggle checked={p.closeToTray} onChange={v => updatePreference('closeToTray', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.retriesOnFailure')} description={t('settings.page.automaticRetriesAfterADropped')}>
                  <NumberInput value={p.defaultRetryCount} onChange={v => updatePreference('defaultRetryCount', v)} min={0} max={10} />
                </SettingRow>
                <SettingRow label={t('settings.page.subscriptionCheckInterval')} description={t('settings.page.howOftenSubscribedChannelsAnd')}>
                  <NumberInput value={p.subscriptionCheckIntervalMinutes} onChange={v => updatePreference('subscriptionCheckIntervalMinutes', v)} min={5} max={1440} unit="min" />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title={t('settings.page.speedLimits0Unlimited')}>
                <SettingRow label={t('settings.page.videoDownloads')} description={t('settings.page.perDownloadAppliesWhenA')}>
                  <NumberInput value={p.bandwidthLimit} onChange={v => updatePreference('bandwidthLimit', v)} min={0} max={10000} step={0.5} unit="MB/s" />
                </SettingRow>
                <SettingRow label={t('settings.page.torrentDownload')} description={t('settings.page.allTorrentsTogetherAppliesImmediately')}>
                  <NumberInput value={kbpsToMbps(p.torrentDownloadLimitKBps)} onChange={v => updatePreference('torrentDownloadLimitKBps', mbpsToKbps(v))} min={0} max={10000} step={0.1} unit="MB/s" />
                </SettingRow>
                <SettingRow label={t('settings.page.torrentUpload')} description={t('settings.page.allSeedingAndUploadingTogether')}>
                  <NumberInput value={kbpsToMbps(p.torrentUploadLimitKBps)} onChange={v => updatePreference('torrentUploadLimitKBps', mbpsToKbps(v))} min={0} max={10000} step={0.1} unit="MB/s" />
                </SettingRow>
              </SettingGroup>
              <SettingGroup title={t('settings.page.quietHours')}>
                <SettingRow label={t('settings.page.quietHours')} description={t('settings.page.holdOrSlowDownDownloads')}>
                  <Toggle checked={p.scheduleEnabled} onChange={v => updatePreference('scheduleEnabled', v)} />
                </SettingRow>
                {p.scheduleEnabled && (
                  <>
                    <SettingRow label={t('settings.page.from')} description={t('settings.page.hourTheWindowStarts24')}>
                      <NumberInput value={p.scheduleStartHour} onChange={v => updatePreference('scheduleStartHour', v)} min={0} max={23} unit=":00" />
                    </SettingRow>
                    <SettingRow label={t('settings.page.until')} description={t('settings.page.hourTheWindowEndsWraps')}>
                      <NumberInput value={p.scheduleEndHour} onChange={v => updatePreference('scheduleEndHour', v)} min={0} max={23} unit=":00" />
                    </SettingRow>
                    <SettingRow label={t('settings.page.duringQuietHours')} description={t('settings.page.holdNewDownloadsEntirelyOr')}>
                      <Select
                        value={p.scheduleMode}
                        options={[
                          { value: 'limit', label: t('settings.page.slowDown') },
                          { value: 'pause', label: t('settings.page.holdDownloads') },
                        ]}
                        onChange={v => updatePreference('scheduleMode', v)}
                      />
                    </SettingRow>
                    {p.scheduleMode === 'limit' && (
                      <SettingRow label={t('settings.page.quietHoursSpeed')} description={t('settings.page.capForDownloadsStartedAnd')}>
                        <NumberInput value={p.scheduleLimitMBps} onChange={v => updatePreference('scheduleLimitMBps', v)} min={1} max={1000} unit="MB/s" />
                      </SettingRow>
                    )}
                    <SettingRow
                      label={t('settings.page.days')}
                      description={t('settings.page.whichDaysTheWindowApplies')}
                    >
                      <div className="flex items-center gap-1">
                        {DAY_NAMES.map((name, day) => {
                          const chosen = p.scheduleDays?.includes(day) ?? false;
                          return (
                            <button
                              key={name}
                              type="button"
                              aria-pressed={chosen}
                              aria-label={name}
                              title={name}
                              onClick={() => {
                                const current = p.scheduleDays ?? [];
                                const next = chosen
                                  ? current.filter(d => d !== day)
                                  : [...current, day].sort((a, b) => a - b);
                                updatePreference('scheduleDays', next);
                              }}
                              className={cn(
                                'w-7 h-7 rounded-md text-xs font-medium transition-colors',
                                chosen
                                  ? 'bg-primary/15 text-primary'
                                  : 'bg-secondary text-muted-foreground hover:text-secondary-foreground',
                              )}
                            >
                              {name[0]}
                            </button>
                          );
                        })}
                      </div>
                    </SettingRow>
                  </>
                )}
              </SettingGroup>

              <SettingGroup title={t('settings.page.whenADownloadFinishes')}>
                <SettingRow label={t('settings.page.then')} description={t('settings.page.forEveryDownloadUnlessOne')}>
                  <Select
                    value={p.defaultWhenComplete}
                    options={[
                      { value: 'nothing', label: t('settings.page.doNothing') },
                      { value: 'notify', label: t('settings.page.notifyMe') },
                      { value: 'open', label: t('settings.page.openTheFile') },
                      { value: 'reveal', label: t('settings.page.showInFolder') },
                    ]}
                    onChange={v => updatePreference('defaultWhenComplete', v)}
                  />
                </SettingRow>
              </SettingGroup>

              <SettingGroup title={t('settings.page.whenEverythingFinishes')}>
                <SettingRow label={t('settings.page.then')} description={t('settings.page.happensAMinuteAfterThe')}>
                  <Select
                    value={p.whenDoneAction}
                    options={[
                      { value: 'nothing', label: t('settings.page.doNothing') },
                      { value: 'sleep', label: t('settings.page.sleep') },
                      { value: 'shutdown', label: t('settings.page.shutDown') },
                      { value: 'quit', label: t('settings.page.quitPrism') },
                    ]}
                    onChange={v => updatePreference('whenDoneAction', v)}
                  />
                </SettingRow>
                {p.whenDoneAction !== 'nothing' && (
                  <SettingRow label={t('settings.page.seedingTorrents')} description={t('settings.page.uploadingCountsAsWorkSo')}>
                    <Select
                      value={p.whenDoneIgnoresSeeding ? 'ignore' : 'wait'}
                      options={[
                        { value: 'wait', label: t('settings.page.waitForSeeding') },
                        { value: 'ignore', label: t('settings.page.dontWait') },
                      ]}
                      onChange={v => updatePreference('whenDoneIgnoresSeeding', v === 'ignore')}
                    />
                  </SettingRow>
                )}
              </SettingGroup>

              <SettingGroup title={t('settings.page.globalShortcuts')}>
                <SettingRow label={t('settings.page.addFromClipboard')} description={t('settings.page.queuesWhateverLinkIsOn')}>
                  <TextInput
                    value={p.shortcuts.addFromClipboard}
                    onChange={v => updatePreference('shortcuts', { ...p.shortcuts, addFromClipboard: v })}
                    placeholder={t('settings.page.eGCmdorctrlShiftV')}
                  />
                </SettingRow>
                <SettingRow label={t('settings.page.showPrism')} description={t('settings.page.bringsTheWindowToThe')}>
                  <TextInput
                    value={p.shortcuts.showPrism}
                    onChange={v => updatePreference('shortcuts', { ...p.shortcuts, showPrism: v })}
                    placeholder={t('settings.page.eGCmdorctrlShiftP')}
                  />
                </SettingRow>
                <SettingRow label={t('settings.page.pauseEverything')} description={t('settings.page.pausesEveryRunningDownload')}>
                  <TextInput
                    value={p.shortcuts.pauseAll}
                    onChange={v => updatePreference('shortcuts', { ...p.shortcuts, pauseAll: v })}
                    placeholder={t('settings.page.eGCmdorctrlShiftPeriod')}
                  />
                </SettingRow>
              </SettingGroup>
            </TabsContent>

            <TabsContent value="network" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.network')}</h2>
              <SettingGroup title={t('settings.page.connection')}>
                <SettingRow label={t('settings.page.proxy')} help={HELP.proxy} description={t('settings.page.videoAndDirectDownloadsFeeds')}>
                  <TextInput value={p.proxyUrl} onChange={v => updatePreference('proxyUrl', v)} placeholder="socks5h://127.0.0.1:9050" />
                </SettingRow>
                <SettingRow label={t('settings.page.useIpv4Only')} help={HELP.ipv4} description={t('settings.page.forVideoDownloadsAndLink')}>
                  <Toggle checked={p.forceIpv4} onChange={v => updatePreference('forceIpv4', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.identifyAsABrowser')} description={t('settings.page.directDownloadsIntroduceThemselvesAs')}>
                  <Toggle checked={p.browserUserAgent} onChange={v => updatePreference('browserUserAgent', v)} />
                </SettingRow>
              </SettingGroup>
            </TabsContent>

            <TabsContent value="downloads" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.storage')}</h2>
              <StorageTile
                folder={p.defaultSaveFolder}
                load={() => service.storageSummary(p.defaultSaveFolder)}
              />
              <div className="divide-y divide-border/30">
                <SettingRow label={t('settings.page.downloadLocation')} description={t('settings.page.anyFolderYouPickIncluding')}>
                  <button
                    type="button"
                    {...{ 'aria-label': t('settings.page.downloadLocationLabel', { path: p.defaultSaveFolder }) }}
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
                <SettingRow label={t('settings.page.fileNames')} description={t('settings.page.howNewDownloadsAreNamed')}>
                  <div className="flex flex-col items-end gap-1">
                    <input
                      type="text"
                      value={p.filenameTemplate}
                      onChange={e => updatePreference('filenameTemplate', e.target.value)}
                      placeholder="{title}"
                      spellCheck={false}
                      autoComplete="off"
                      aria-label={t('settings.page.fileNameTemplate')}
                      className="w-56 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground"
                    />
                    {templatePreview && (
                      <span
                        className={cn('text-xs max-w-56 truncate', templatePreview.ok ? 'text-muted-foreground' : 'text-destructive')}
                        title={templatePreview.text}
                      >
                        {templatePreview.ok ? `e.g. ${templatePreview.text}.mp4` : templatePreview.text}
                      </span>
                    )}
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.page.moveFinishedDownloads')} description={t('settings.page.takeEachFinishedDownloadOut')}>
                  <Toggle checked={p.moveCompletedEnabled} onChange={v => updatePreference('moveCompletedEnabled', v)} />
                </SettingRow>
                {p.moveCompletedEnabled && (
                  <SettingRow label={t('settings.page.moveThemTo')} description={t('settings.page.whereFinishedDownloadsEndUp')}>
                    <button
                      type="button"
                      {...{ 'aria-label': `Move finished downloads to: ${p.moveCompletedTo || 'not set yet'}. Choose a folder` }}
                      onClick={async () => {
                        const dir = await service.pickDirectory('move');
                        if (dir) updatePreference('moveCompletedTo', dir);
                      }}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      {p.moveCompletedTo || t('settings.page.chooseFolder')}
                    </button>
                  </SettingRow>
                )}
                <SettingRow label={t('settings.page.categories')} description={t('settings.page.sortDownloadsAsTheyArrive')}>
                  <div className="flex flex-col items-end gap-2">
                    {p.categories.map((category, index) => (
                      <div key={category.id} className="flex flex-col items-end gap-1 p-2 rounded-lg bg-input/60 border border-border/40">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={category.name}
                            onChange={e => updateCategory(category.id, { name: e.target.value })}
                            placeholder={t('settings.page.name')}
                            aria-label={t('settings.page.categoryName', { n: index + 1 })}
                            className="w-28 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none"
                          />
                          <CommitInput
                            value={category.domains.join(', ')}
                            onCommit={v => updateCategory(category.id, { domains: v.split(',').map(d => d.trim()).filter(Boolean) })}
                            placeholder="youtube.com"
                            spellCheck={false}
                            aria-label={t('settings.page.categorySites', { n: index + 1 })}
                            className="w-36 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono"
                          />
                          <button
                            type="button"
                            aria-label={t('settings.page.removeCategory', { name: category.name || index + 1 })}
                            onClick={() => updatePreference('categories', p.categories.filter(c => c.id !== category.id))}
                            className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                          >
                            {t('queue.remove')}
                          </button>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            value={category.filenameTemplate}
                            onChange={e => updateCategory(category.id, { filenameTemplate: e.target.value })}
                            placeholder={t('settings.page.fileNamesEGUploader')}
                            spellCheck={false}
                            aria-label={t('settings.page.categoryFileNames', { n: index + 1 })}
                            className="w-44 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none font-mono placeholder:text-muted-foreground"
                          />
                          <button
                            type="button"
                            aria-label={t('settings.page.categoryFolder', { n: index + 1, path: category.destination || t('settings.page.defaultFolder') })}
                            onClick={async () => {
                              const dir = await service.pickDirectory('category');
                              if (dir) updateCategory(category.id, { destination: dir });
                            }}
                            className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors max-w-44"
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
                      {t('settings.page.addCategory')}
                    </button>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.page.labels')} description={t('settings.page.tagsYouPutOnA')}>
                  <div className="flex flex-col items-end gap-1.5">
                    {p.labels.map((label, index) => (
                      <div key={label.id} className="flex items-center gap-1.5">
                        <input
                          type="text"
                          value={label.name}
                          onChange={e => updatePreference('labels', p.labels.map(l => (l.id === label.id ? { ...l, name: e.target.value } : l)))}
                          placeholder={t('settings.page.name')}
                          aria-label={t('settings.page.labelName', { n: index + 1 })}
                          className="w-36 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none"
                        />
                        <button
                          type="button"
                          aria-label={t('settings.page.removeLabel', { name: label.name || index + 1 })}
                          onClick={() => updatePreference('labels', p.labels.filter(l => l.id !== label.id))}
                          className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                        >
                          {t('queue.remove')}
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => updatePreference('labels', [...p.labels, { id: generateId(), name: '' }])}
                      className="px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      {t('settings.page.addLabel')}
                    </button>
                  </div>
                </SettingRow>
                <SettingRow label={t('settings.page.watchFolders')} description={t('settings.page.dropATorrentFileInto')}>
                  <div className="flex flex-col items-end gap-1.5">
                    {p.watchFolders.map(folder => (
                      <div key={folder.path} className="flex items-center gap-1.5">
                        <span className="text-xs text-muted-foreground max-w-48 truncate" title={folder.path}>{folder.path}</span>
                        <button
                          type="button"
                          aria-label={t('settings.page.stopWatching', { path: folder.path })}
                          onClick={() => updatePreference('watchFolders', p.watchFolders.filter(f => f.path !== folder.path))}
                          className="px-2 py-1 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                        >
                          {t('queue.remove')}
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={async () => {
                        const dir = await service.pickDirectory('watch');
                        // Prism's own downloads land there: watching it would
                        // re-add every .torrent or link list it downloads.
                        // Rust skips such a folder too; this says why.
                        if (dir && isSameFolder(dir, p.defaultSaveFolder)) {
                          toast.error(t('settings.page.watchIsDownloads'));
                          return;
                        }
                        if (dir && !p.watchFolders.some(f => f.path === dir)) {
                          updatePreference('watchFolders', [...p.watchFolders, { path: dir, enabled: true }]);
                        }
                      }}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors cursor-pointer"
                    >
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      {t('settings.page.addFolder')}
                    </button>
                  </div>
                </SettingRow>
                <BackupRow />
              </div>
            </TabsContent>

            <TabsContent value="general" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.notifications')}</h2>
              <div className="divide-y divide-border/30">
                <SettingRow label={t('settings.page.notifications')} description={t('settings.page.showNotificationsForDownloadEvents')}>
                  <Toggle checked={p.notificationsEnabled} onChange={v => updatePreference('notificationsEnabled', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.soundEffects')} description={t('settings.page.playASoundWhenA')}>
                  <Toggle checked={p.soundEnabled} onChange={v => updatePreference('soundEnabled', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.clipboardLinkDetection')} description={t('settings.page.whenPrismRegainsFocusCheck')}>
                  <Toggle checked={p.clipboardWatchEnabled} onChange={v => updatePreference('clipboardWatchEnabled', v)} />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="general" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.appearance')}</h2>
              <div className="divide-y divide-border/30">
                <SettingRow label={t('settings.page.theme')} description={t('settings.page.applicationColorScheme')}>
                  <Select
                    value={p.theme}
                    options={[{ value: 'dark', label: t('settings.page.dark') }, { value: 'light', label: t('settings.page.light') }, { value: 'system', label: t('settings.page.system') }]}
                    onChange={v => updatePreference('theme', v)}
                  />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="general" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.updates')}</h2>
              <div className="divide-y divide-border/30">
                <SettingRow label={t('settings.page.autoUpdate')} description={t('settings.page.checkForANewVersion')}>
                  <Toggle checked={p.autoUpdate} onChange={v => updatePreference('autoUpdate', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.checkForUpdates')} description={
                  updateState === 'installing' ? t('settings.page.updateDownloading', { progress: formatUpdateProgress(updateInstall) }) :
                  updateState === 'available' ? t('about.update.availableVersion', { version: updateVersion }) :
                  updateState === 'up-to-date' ? t('settings.page.upToDate') :
                  updateState === 'error' ? (updateError ? t('settings.page.updateErrorDetail', { error: updateError }) : t('settings.page.updateError')) :
                  undefined
                }>
                  <div className="flex items-center gap-2" aria-live="polite">
                    {updateState === 'available' && (
                      <button
                        type="button"
                        onClick={async () => {
                          toast.info(t('settings.page.installing'));
                          try {
                            await installAppUpdate(onProgress => service.installUpdate(onProgress));
                            // relaunch() is called inside installUpdate — if we reach here it didn't restart
                            toast.success(t('settings.page.installed'));
                          } catch (e) {
                            toast.error(t('settings.page.updateFailed', { error: e instanceof Error ? e.message : String(e) }));
                            setUpdateState('available');
                          }
                        }}
                        className="px-3 py-1.5 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97]"
                      >
                        {t('settings.page.installUpdate')}
                      </button>
                    )}
                    <DisabledReason reason={updateState === 'checking' ? t('setup.ffmpeg.busy') : updateState === 'installing' ? t('settings.page.updateInstalling') : null}>
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
                            toast.success(t('settings.page.updateFound', { version: result.version }));
                          } else if (result.error) {
                            setUpdateState('error');
                            toast.error(t('settings.page.updateError'));
                          } else {
                            setUpdateState('up-to-date');
                            toast.success(t('settings.page.upToDate'));
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
                            {t('settings.page.checking')}
                          </span>
                        ) : updateState === 'installing' ? (
                          <span className="flex items-center gap-1.5">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            {formatUpdateProgress(updateInstall)}
                          </span>
                        ) : t('settings.page.checkNow')}
                      </button>
                    </DisabledReason>
                  </div>
                </SettingRow>
                {updateState === 'available' && updateNotes && (
                  <div className="py-2.5">
                    <p className="text-xs text-muted-foreground font-medium mb-1">{t('about.releaseNotes')}</p>
                    <p className="text-xs text-muted-foreground whitespace-pre-line">{formatReleaseNotes(updateNotes)}</p>
                  </div>
                )}
                <SettingRow
                  label={t('settings.page.downloaderEngine')}
                  description={engine?.updateAvailable
                    ? t('settings.page.engineAvailable', { current: engineVersion ?? engine.activeVersion ?? '', latest: engine.latest })
                    : engineVersion ? t('settings.page.engineCurrent', { version: engineVersion }) : t('settings.page.engineHint')}
                >
                  <DisabledReason reason={engineUpdating ? t('settings.page.alreadyUpdating') : null}>
                    <button
                      type="button"
                      disabled={engineUpdating}
                      onClick={async () => {
                        setEngineUpdating(true);
                        try {
                          const v = await service.updateEngine();
                          setEngineVersion(v);
                          service.getEngineInfo().then(publishEngineInfo).catch(() => {});
                          toast.success(t('shell.engineUpdated', { version: v }));
                        } catch (e) {
                          toast.error(t('settings.page.engineFailed', { error: e instanceof Error ? e.message : String(e) }));
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
                          {t('settings.page.updating')}
                        </span>
                      ) : t('settings.page.updateEngine')}
                    </button>
                  </DisabledReason>
                </SettingRow>
                <SettingRow label={t('settings.page.checkForEngineUpdates')} description={t('settings.page.onceADayCompareThe')}>
                  <Toggle checked={p.engineAutoCheck} onChange={v => updatePreference('engineAutoCheck', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.updateTheEngineAutomatically')} description={t('settings.page.installANewerYtDlp')}>
                  <Toggle checked={p.engineAutoUpdate} onChange={v => updatePreference('engineAutoUpdate', v)} />
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="privacy" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.diagnostics')}</h2>
              <div className="divide-y divide-border/30">
                <SettingRow label={t('settings.page.logLevel')} description={t('settings.page.verbosityOfDiagnosticLogs')}>
                  <Select
                    value={p.logLevel}
                    options={[{ value: 'error', label: t('settings.page.error') }, { value: 'warn', label: t('settings.page.warning') }, { value: 'info', label: t('settings.page.info') }, { value: 'debug', label: t('settings.page.debug') }]}
                    onChange={v => updatePreference('logLevel', v)}
                  />
                </SettingRow>
                <SettingRow label={t('settings.page.crashReporting')} description={t('settings.page.sendAnonymousCrashReportsTo')}>
                  <Toggle checked={p.crashReportingEnabled} onChange={v => updatePreference('crashReportingEnabled', v)} />
                </SettingRow>
                <SettingRow label={t('settings.page.forgetPlaybackHistory')} description={t('settings.page.clearWhereYouStoppedIn')}>
                  <button
                    type="button"
                    onClick={() => import('@tauri-apps/api/core')
                      .then(({ isTauri, invoke }) => (isTauri() ? invoke('forget_playback_history') : undefined))
                      .then(() => toast.success(t('settings.page.historyCleared')))
                      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)))}
                    className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                  >
                    {t('settings.page.forget')}
                  </button>
                </SettingRow>
                <SettingRow label={t('settings.page.exportLogs')} description={t('settings.page.saveTheInAppDiagnostic')}>
                  <button
                    type="button"
                    onClick={async () => {
                      await service.exportLogs(diagnostics.getLogs());
                      toast.success(t('settings.page.logsExported'));
                    }}
                    className="px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
                  >
                    {t('settings.page.export')}
                  </button>
                </SettingRow>
              </div>
            </TabsContent>

            <TabsContent value="privacy" forceMount={searching || undefined} className="mt-0 mb-6 last:mb-0 [&:not(:has([data-setting-row]))]:data-[searching=true]:hidden" data-searching={searching}>
              <h2 className="text-sm font-semibold text-foreground mb-2">{t('settings.page.aboutLegal')}</h2>
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground text-pretty leading-relaxed">
                  {t('settings.page.disclaimer')}
                </p>
                <div className="divide-y divide-border/30">
                  {([[t('settings.page.aboutPrism'), '/about'], [t('about.privacy'), '/privacy'], [t('settings.page.terms'), '/terms'], [t('settings.page.licenses'), '/licenses']] as const).map(([label, path]) => (
                    <button key={path} type="button" onClick={() => navigate(path)} className="w-full flex items-center justify-between py-2.5 min-h-[40px] text-left">
                      <span className="text-xs font-medium text-foreground">{label}</span>
                      <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            </TabsContent>
          </Panel>
          </SettingsQuery.Provider>

          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-destructive transition-colors active:scale-[0.97]"
            >
              {t('settings.page.resetDefaults')}
            </button>
          </div>
        </div>
      </Tabs>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t('settings.page.resetAllSettings')}
        description={t('settings.page.everyPreferenceDownloadLocationProxy')}
        confirmLabel={t('settings.page.resetEverything')}
        destructive
        onConfirm={() => { resetToDefaults(); toast.success(t('settings.page.resetDone')); }}
      />
    </div>
  );
}
