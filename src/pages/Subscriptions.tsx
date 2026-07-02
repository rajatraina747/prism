import React, { useState, useCallback } from 'react';
import { useSubscriptions } from '@/stores/SubscriptionsProvider';
import { EmptyState } from '@/components/common';
import { Rss, RefreshCw, Trash2, Music, Video, Loader2, AlertTriangle, Pause, Play } from 'lucide-react';

function formatRelative(iso?: string): string {
  if (!iso) return 'never';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Subscriptions() {
  const { items, addSubscription, removeSubscription, toggleSubscription, setAudioOnly, checkNow, checking } = useSubscriptions();
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const handleAdd = useCallback(async () => {
    const trimmed = url.trim();
    if (!trimmed || adding) return;
    setAdding(true);
    setAddError(null);
    try {
      await addSubscription(trimmed);
      setUrl('');
    } catch (e) {
      setAddError(typeof e === 'string' ? e : e instanceof Error ? e.message : 'Could not parse this URL as a channel or playlist');
    } finally {
      setAdding(false);
    }
  }, [url, adding, addSubscription]);

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h2 className="page-title">Subscriptions</h2>
          <p className="page-subtitle">
            {items.length === 0
              ? 'Watch channels and playlists — new videos download automatically'
              : `${items.length} subscription${items.length !== 1 ? 's' : ''} · new videos are queued automatically`}
          </p>
        </div>
        {items.length > 0 && (
          <button
            onClick={() => checkNow()}
            disabled={checking}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50"
          >
            {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            {checking ? 'Checking…' : 'Check All Now'}
          </button>
        )}
      </div>

      {/* Add form */}
      <div className="glass-strong rounded-xl p-3.5 mb-4">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="Paste a channel or playlist URL to subscribe"
            className="flex-1 bg-secondary/50 border border-border/50 rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-primary/50"
            disabled={adding}
          />
          <button
            onClick={handleAdd}
            disabled={adding || !url.trim()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-50"
          >
            {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rss className="w-3 h-3" />}
            {adding ? 'Adding…' : 'Subscribe'}
          </button>
        </div>
        {addError && (
          <p className="mt-2 text-[11px] text-destructive">{addError}</p>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground/70">
          Only videos published after you subscribe are downloaded — the existing catalog is marked as seen.
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Rss}
          title="No subscriptions yet"
          description="Subscribe to a channel or playlist and Prism will check it periodically, queueing anything new."
        />
      ) : (
        <div className="space-y-1.5">
          {items.map((sub, i) => (
            <div
              key={sub.id}
              className="glass-strong rounded-xl p-3.5 animate-fade-in"
              style={{ animationDelay: `${i * 50}ms` }}
            >
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${sub.enabled ? 'bg-primary/10' : 'bg-secondary'}`}>
                  <Rss className={`w-4 h-4 ${sub.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className={`text-xs font-medium truncate ${sub.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {sub.title}
                  </h4>
                  <p className="text-[10px] text-muted-foreground/70 truncate">{sub.url}</p>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span>Checked {formatRelative(sub.lastCheckedAt)}</span>
                    <span>·</span>
                    <span>{sub.audioOnly ? 'Audio only' : 'Video'}</span>
                    {!sub.enabled && (<><span>·</span><span>Paused</span></>)}
                  </div>
                  {sub.lastError && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-destructive">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span className="truncate">{sub.lastError}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setAudioOnly(sub.id, !sub.audioOnly)}
                    title={sub.audioOnly ? 'Switch to video downloads' : 'Switch to audio-only downloads'}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    {sub.audioOnly ? <Music className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => checkNow(sub.id)}
                    disabled={checking}
                    title="Check now"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95] disabled:opacity-50"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => toggleSubscription(sub.id)}
                    title={sub.enabled ? 'Pause subscription' : 'Resume subscription'}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    {sub.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => removeSubscription(sub.id)}
                    title="Unsubscribe"
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-destructive transition-colors active:scale-[0.95]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
