import React from 'react';
import { useService } from '@/services/ServiceProvider';
import { formatSpeed } from '@/services/utils';
import type { SessionStats } from '@/types/models';
import { ArrowDown, ArrowUp, Users, Globe, Radio } from 'lucide-react';

/** Live torrent-engine numbers, qBittorrent-status-bar style. Renders nothing
 * until the engine has started (no torrent added yet). */
export function SessionFooter({ hasTorrents }: { hasTorrents: boolean }) {
  const service = useService();
  const [stats, setStats] = React.useState<SessionStats | null>(null);

  React.useEffect(() => {
    if (!hasTorrents) return;
    return service.onSessionStats(setStats);
  }, [service, hasTorrents]);

  if (!hasTorrents || !stats) return null;

  const port = stats.listenPort ? `Port ${stats.listenPort}` : 'No listen port';
  const flags = [
    stats.upnp ? 'UPnP on' : 'UPnP off',
    stats.dht ? `DHT ${stats.dhtNodes} nodes` : 'DHT off',
    stats.utp ? 'uTP on' : null,
  ].filter(Boolean).join(' · ');

  return (
    <footer
      aria-label="Torrent engine status"
      className="mt-3 flex items-center gap-4 px-3 py-2 rounded-lg bg-secondary/30 border border-border/20 text-[11px] text-muted-foreground tabular-nums"
    >
      <span className="flex items-center gap-1" title="Session download speed">
        <ArrowDown className="w-3 h-3 text-primary" /> {formatSpeed(stats.downloadBps)}
      </span>
      <span className="flex items-center gap-1" title="Session upload speed">
        <ArrowUp className="w-3 h-3 text-success" /> {formatSpeed(stats.uploadBps)}
      </span>
      <span className="flex items-center gap-1" title={`${stats.peersSeen} peers discovered, ${stats.peersConnecting} connecting`}>
        <Users className="w-3 h-3" /> {stats.peersLive} peers
      </span>
      <span className="flex items-center gap-1" title="DHT routing table size">
        <Globe className="w-3 h-3" /> {flags}
      </span>
      <span className="flex items-center gap-1 ml-auto" title="Incoming connections">
        <Radio className="w-3 h-3" /> {port}
      </span>
    </footer>
  );
}
