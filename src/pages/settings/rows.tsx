// Settings rows that do something themselves: import torrents from another
// client, restart the torrent engine, back up and restore.
import React from 'react';
import { useSettings, useHistory, useQueue, useQueueActions } from '@/stores/AppProvider';
import { importedTorrentItems } from '@/stores/torrent-item';
import { useSubscriptions } from '@/stores/SubscriptionsProvider';
import { buildBackup, parseBackup, describeImport, type PrismBackup } from '@/stores/backup';
import { useService } from '@/services/ServiceProvider';
import { ConfirmDialog } from '@/components/common';
import { toast } from 'sonner';
import { SettingRow } from './controls';

export function ClientImportRow() {
  const service = useService();
  const { preferences } = useSettings();
  const { items: queue, addToQueue } = useQueue();
  const [busy, setBusy] = React.useState(false);

  const importFrom = async (client: 'qbittorrent' | 'transmission', label: string) => {
    setBusy(true);
    try {
      const result = await service.importTorrentClient(client);
      if (!result) return;
      const items = importedTorrentItems(result.torrents, queue, preferences.defaultSaveFolder);
      items.forEach(addToQueue);
      const already = result.torrents.length - items.length;
      if (result.torrents.length === 0) {
        toast.error(`No torrents found there. Pick ${client === 'qbittorrent' ? "qBittorrent's BT_backup folder" : "Transmission's folder with torrents and resume in it"}.`);
        return;
      }
      toast.success(`Added ${items.length} ${items.length === 1 ? 'torrent' : 'torrents'} from ${label}, paused`, {
        description: [
          'Start them in Transfers: each checks the files it already has before downloading anything.',
          already > 0 ? `${already} ${already === 1 ? 'was' : 'were'} already in Prism.` : '',
          result.skipped > 0 ? `${result.skipped} ${result.skipped === 1 ? "file wasn't a torrent" : "files weren't torrents"}.` : '',
        ].filter(Boolean).join(' '),
        duration: 10000,
      });
    } catch (e) {
      toast.error(`Couldn't import from ${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const button = 'px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50';
  return (
    <SettingRow label="Import torrents" description="Add the torrents from qBittorrent or Transmission, pointed at the files they already downloaded. Quit the other app first">
      <div className="flex items-center gap-2">
        <button type="button" disabled={busy} onClick={() => importFrom('qbittorrent', 'qBittorrent')} className={button}>qBittorrent…</button>
        <button type="button" disabled={busy} onClick={() => importFrom('transmission', 'Transmission')} className={button}>Transmission…</button>
      </div>
    </SettingRow>
  );
}

/** Apply the engine settings now rather than at the next launch. */
export function RestartTorrentEngineRow() {
  const { restartTorrentEngine } = useQueueActions();
  const [busy, setBusy] = React.useState(false);
  const restart = async () => {
    setBusy(true);
    try {
      await restartTorrentEngine();
      toast.success('Torrent engine restarted with these settings');
    } catch (e) {
      toast.error(`Couldn't restart the torrent engine: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label="Apply now" description="Restart the torrent engine with the settings above. Running torrents pause for a moment and carry on, without checking their files again">
      <button
        type="button"
        disabled={busy}
        onClick={() => void restart()}
        className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50"
      >
        {busy ? 'Restarting…' : 'Restart engine'}
      </button>
    </SettingRow>
  );
}

/** Export and import settings, Library and subscriptions (stores/backup.ts). */
export function BackupRow() {
  const service = useService();
  const { preferences, importSettings } = useSettings();
  const { items: history, importHistory } = useHistory();
  const { items: subscriptions, importSubscriptions } = useSubscriptions();
  const [pending, setPending] = React.useState<PrismBackup | null>(null);

  const exportBackup = async () => {
    try {
      const appVersion = await service.getAppVersion().catch(() => '');
      const backup = buildBackup({ settings: preferences, history, subscriptions, appVersion });
      const day = new Date().toISOString().slice(0, 10);
      if (await service.saveBackup(JSON.stringify(backup, null, 2), `prism-backup-${day}.json`)) {
        toast.success(`Backed up ${history.length} Library ${history.length === 1 ? 'entry' : 'entries'} and ${subscriptions.length} ${subscriptions.length === 1 ? 'subscription' : 'subscriptions'}`);
      }
    } catch (e) {
      toast.error(`Couldn't save the backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const chooseBackup = async () => {
    try {
      const text = await service.openBackup();
      if (text === null) return;
      const parsed = parseBackup(text);
      if (!parsed.ok) {
        toast.error(parsed.error);
        return;
      }
      setPending(parsed.backup);
    } catch (e) {
      toast.error(`Couldn't read the backup: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const summary = pending ? describeImport(pending, { history, subscriptions }) : null;
  const applyBackup = () => {
    if (!pending) return;
    importSettings(pending.settings);
    importHistory(pending.history);
    importSubscriptions(pending.subscriptions);
    setPending(null);
    toast.success('Backup imported');
  };

  return (
    <>
      <SettingRow label="Back up settings and Library" description="Save your settings, Library and subscriptions to a file, or bring them in from one. Download and watch folders stay as they are on this computer">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportBackup}
            className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            Export…
          </button>
          <button
            type="button"
            onClick={chooseBackup}
            className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            Import…
          </button>
        </div>
      </SettingRow>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={open => { if (!open) setPending(null); }}
        title="Import this backup?"
        description={summary ? [
          summary.settings ? 'Your settings will be replaced by the backup\'s, except your download and watch folders.' : '',
          `${summary.newLibraryEntries} new Library ${summary.newLibraryEntries === 1 ? 'entry' : 'entries'} and ${summary.newSubscriptions} new ${summary.newSubscriptions === 1 ? 'subscription' : 'subscriptions'} will be added; nothing already here is removed.`,
        ].filter(Boolean).join(' ') : ''}
        confirmLabel="Import"
        onConfirm={applyBackup}
      />
    </>
  );
}

