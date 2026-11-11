import React from 'react';
import { useService } from '@/services/ServiceProvider';
import { formatSpeed } from '@/services/utils';
import type { SessionStats } from '@/types/models';
import { ArrowDown, ArrowUp, Users, Globe, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Live torrent-engine numbers, qBittorrent-status-bar style. Renders nothing
 * until the engine has started (no torrent added yet). */
export function SessionFooter({ hasTorrents }: { hasTorrents: boolean }) {
  const { t } = useTranslation();
  const service = useService();
  const [stats, setStats] = React.useState<SessionStats | null>(null);

  React.useEffect(() => {
    if (!hasTorrents) return;
    return service.onSessionStats(setStats);
  }, [service, hasTorrents]);

  if (!hasTorrents || !stats) return null;

  const port = stats.listenPort ? t('queue.session.port', { port: stats.listenPort }) : t('queue.session.noPort');
  const flags = [
    stats.upnp ? t('queue.session.upnpOn') : t('queue.session.upnpOff'),
    stats.dht ? t('queue.session.dhtNodes', { count: stats.dhtNodes }) : t('queue.session.dhtOff'),
    stats.utp ? t('queue.session.utpOn') : null,
  ].filter(Boolean).join(t('common.separator'));

  return (
    <footer
      aria-label={t('queue.session.label')}
      className="mt-3 flex items-center gap-4 px-3 py-2 rounded-lg bg-secondary/30 border border-border/20 text-xs text-muted-foreground tabular-nums"
    >
      <span className="flex items-center gap-1" title={t('queue.session.down')}>
        <ArrowDown className="w-3 h-3 text-primary" /> {formatSpeed(stats.downloadBps)}
      </span>
      <span className="flex items-center gap-1" title={t('queue.session.up')}>
        <ArrowUp className="w-3 h-3 text-success" /> {formatSpeed(stats.uploadBps)}
      </span>
      <span className="flex items-center gap-1" title={t('queue.session.peersTitle', { seen: stats.peersSeen, connecting: stats.peersConnecting })}>
        <Users className="w-3 h-3" /> {t('queue.session.peers', { count: stats.peersLive })}
      </span>
      <span className="flex items-center gap-1" title={t('queue.session.dhtTitle')}>
        <Globe className="w-3 h-3" /> {flags}
      </span>
      <span className="flex items-center gap-1 ml-auto" title={t('queue.session.incoming')}>
        <Radio className="w-3 h-3" /> {port}
      </span>
    </footer>
  );
}
