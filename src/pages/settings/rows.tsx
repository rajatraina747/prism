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
import { DisabledReason } from '@/components/common/DisabledReason';
import { t } from '@/i18n';

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
        toast.error(client === 'qbittorrent' ? t('settings.importTorrents.noneQbit') : t('settings.importTorrents.noneTransmission'));
        return;
      }
      toast.success(t('settings.importTorrents.added', { count: items.length, client: label }), {
        description: [
          t('settings.importTorrents.startHint'),
          already > 0 ? t('settings.importTorrents.already', { count: already }) : '',
          result.skipped > 0 ? t('settings.importTorrents.skipped', { count: result.skipped }) : '',
        ].filter(Boolean).join(' '),
        duration: 10000,
      });
    } catch (e) {
      toast.error(t('settings.importTorrents.failed', { client: label, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const button = 'px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50';
  return (
    <SettingRow label={t('settings.importTorrents.label')} description={t('settings.importTorrents.description')}>
      <div className="flex items-center gap-2">
        <DisabledReason reason={busy ? t('settings.importTorrents.busy') : null}>
          <button type="button" disabled={busy} onClick={() => importFrom('qbittorrent', 'qBittorrent')} className={button}>{t('settings.importTorrents.qbit')}</button>
        </DisabledReason>
        <DisabledReason reason={busy ? t('settings.importTorrents.busy') : null}>
          <button type="button" disabled={busy} onClick={() => importFrom('transmission', 'Transmission')} className={button}>{t('settings.importTorrents.transmission')}</button>
        </DisabledReason>
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
      toast.success(t('settings.restartEngine.done'));
    } catch (e) {
      toast.error(t('settings.restartEngine.failed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingRow label={t('settings.restartEngine.label')} description={t('settings.restartEngine.description')}>
      <DisabledReason reason={busy ? t('settings.restartEngine.busy') : null}>
        <button
          type="button"
          disabled={busy}
          onClick={() => void restart()}
          className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50"
        >
          {busy ? t('settings.restartEngine.restarting') : t('settings.restartEngine.button')}
        </button>
      </DisabledReason>
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
        toast.success(t('settings.backup.saved', { entries: t('settings.backup.entries', { count: history.length }), subscriptions: t('settings.backup.subscriptions', { count: subscriptions.length }) }));
      }
    } catch (e) {
      toast.error(t('settings.backup.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
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
      toast.error(t('settings.backup.readFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const summary = pending ? describeImport(pending, { history, subscriptions }) : null;
  const applyBackup = () => {
    if (!pending) return;
    importSettings(pending.settings);
    importHistory(pending.history);
    importSubscriptions(pending.subscriptions);
    setPending(null);
    toast.success(t('settings.backup.imported'));
  };

  return (
    <>
      <SettingRow label={t('settings.backup.label')} description={t('settings.backup.description')}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportBackup}
            className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            {t('settings.backup.export')}
          </button>
          <button
            type="button"
            onClick={chooseBackup}
            className="px-2.5 py-1.5 rounded-md bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97]"
          >
            {t('settings.backup.import')}
          </button>
        </div>
      </SettingRow>
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={open => { if (!open) setPending(null); }}
        title={t('settings.backup.confirmTitle')}
        description={summary ? [
          summary.settings ? t('settings.backup.replacesSettings') : '',
          t('settings.backup.willAdd', { entries: t('settings.backup.newEntries', { count: summary.newLibraryEntries }), subscriptions: t('settings.backup.newSubscriptions', { count: summary.newSubscriptions }) }),
        ].filter(Boolean).join(' ') : ''}
        confirmLabel={t('settings.backup.confirm')}
        onConfirm={applyBackup}
      />
    </>
  );
}

