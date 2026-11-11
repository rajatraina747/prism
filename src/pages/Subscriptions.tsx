import React, { useState, useCallback } from 'react';
import { useSubscriptions } from '@/stores/SubscriptionsProvider';
import { EmptyState } from '@/components/common';
import { toast } from 'sonner';
import { useSettings } from '@/stores/AppProvider';
import { useService } from '@/services/ServiceProvider';
import { QUALITY_CHOICES, type DefaultQuality, type Subscription } from '@/types/models';
import { Rss, RefreshCw, Trash2, Music, Video, Loader2, AlertTriangle, Pause, Play, SlidersHorizontal, FolderOpen } from 'lucide-react';
import { DisabledReason } from '@/components/common/DisabledReason';
import { t } from '@/i18n';

/** A comma-separated list of words, edited as plain text.
 *
 * The text is kept locally while typing and only committed on blur, so a
 * half-typed rule never briefly becomes the live filter — and an empty box
 * clears the rule rather than storing one empty word. */
function KeywordField({ label, placeholder, words, onChange }: {
  label: string;
  placeholder: string;
  words?: string[];
  onChange: (words: string[]) => void;
}) {
  const joined = (words ?? []).join(', ');
  const [draft, setDraft] = useState(joined);
  React.useEffect(() => { setDraft(joined); }, [joined]);
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        type="text"
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => onChange(draft.split(',').map(w => w.trim()).filter(Boolean))}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
        placeholder={placeholder}
        spellCheck={false}
        className="mt-0.5 w-full px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none focus:border-primary/50 placeholder:text-muted-foreground"
      />
    </label>
  );
}

const selectClass = 'mt-0.5 w-full px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-foreground outline-none cursor-pointer';
const optionLabelClass = 'text-xs uppercase tracking-wider text-muted-foreground';

/** One subscription's own settings. Each starts out following the app's. */
function SubscriptionOptions({ sub, onChange }: {
  sub: Subscription;
  onChange: (patch: Partial<Subscription>) => void;
}) {
  const { preferences } = useSettings();
  const service = useService();
  const category = preferences.categories.find(c => c.id === sub.categoryId);
  const folder = sub.destination || category?.destination.trim() || preferences.defaultSaveFolder;
  // Only channels go through yt-dlp's quality choice; a feed's enclosures are
  // single files. Audio-only has no video quality to choose.
  const showQuality = (sub.type ?? 'channel') === 'channel' && !sub.audioOnly;

  const chooseFolder = async () => {
    const dir = await service.pickDirectory().catch(() => null);
    if (dir) onChange({ destination: dir });
  };

  return (
    <div className="mt-2 space-y-1.5" onClick={e => e.stopPropagation()}>
      <div className="grid grid-cols-2 gap-2">
        {showQuality && (
          <label className="block">
            <span className={optionLabelClass}>{t('add.batch.quality')}</span>
            <select
              value={sub.quality ?? 'best'}
              onChange={e => {
                const quality = e.target.value as DefaultQuality;
                onChange({ quality: quality === 'best' ? undefined : quality });
              }}
              className={selectClass}
            >
              {QUALITY_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </label>
        )}
        {preferences.categories.length > 0 && (
          <label className="block">
            <span className={optionLabelClass}>{t('details.category')}</span>
            <select
              value={category?.id ?? ''}
              onChange={e => onChange({ categoryId: e.target.value || undefined })}
              className={selectClass}
            >
              <option value="">{t('subscriptions.sortAuto')}</option>
              {preferences.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
      </div>
      <div>
        <span className={optionLabelClass}>{t('subscriptions.saveTo')}</span>
        <div className="mt-0.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void chooseFolder()}
            title={t('subscriptions.page.chooseAFolderForThis')}
            className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1 rounded-md bg-input border border-border/40 text-xs text-muted-foreground hover:bg-secondary transition-colors"
          >
            <FolderOpen className="w-3 h-3 shrink-0" />
            <span className="truncate">{folder}</span>
          </button>
          {sub.destination && (
            <button
              type="button"
              onClick={() => onChange({ destination: undefined })}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('subscriptions.useDefault')}
            </button>
          )}
        </div>
      </div>
      <KeywordField
        label={t('subscriptions.page.onlyDownloadTitlesContaining')}
        placeholder={t('subscriptions.page.reviewEpisodeLeaveEmptyFor')}
        words={sub.includeKeywords}
        onChange={words => onChange({ includeKeywords: words })}
      />
      <KeywordField
        label={t('subscriptions.page.neverDownloadTitlesContaining')}
        placeholder={t('subscriptions.page.trailerShorts')}
        words={sub.excludeKeywords}
        onChange={words => onChange({ excludeKeywords: words })}
      />
      <p className="text-xs text-muted-foreground/80">
        {t('subscriptions.optionsNote')}
      </p>
    </div>
  );
}

/** What a row's summary line says about its options, when they're set. */
function optionSummary(sub: Subscription, categoryName?: string): string[] {
  const quality = !sub.audioOnly && (sub.type ?? 'channel') === 'channel' && sub.quality;
  return [
    ...(quality ? [quality] : []),
    ...(categoryName ? [categoryName] : []),
    ...(sub.destination ? [t('subscriptions.to', { folder: sub.destination.split(/[/\\]/).filter(Boolean).pop() ?? sub.destination })] : []),
  ];
}

function formatRelative(iso?: string): string {
  if (!iso) return t('subscriptions.relative.never');
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return t('subscriptions.relative.now');
  if (mins < 60) return t('subscriptions.relative.minutes', { n: mins });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t('subscriptions.relative.hours', { n: hours });
  return t('subscriptions.relative.days', { n: Math.floor(hours / 24) });
}

export default function Subscriptions() {
  const { items, addSubscription, removeSubscription, restoreSubscription, toggleSubscription, setAudioOnly, updateSubscription, checkNow, checking } = useSubscriptions();
  const { preferences } = useSettings();
  // Which row has its options open, if any — one at a time keeps the list tidy.
  const [editingOptions, setEditingOptions] = useState<string | null>(null);

  // Per-item destructive action → undo toast rather than a confirm dialog.
  const unsubscribeWithUndo = useCallback((sub: (typeof items)[number]) => {
    removeSubscription(sub.id);
    toast(t('subscriptions.unsubscribed', { title: sub.title }), {
      action: { label: t('subscriptions.page.undo'), onClick: () => restoreSubscription(sub) },
      duration: 6000,
    });
  }, [removeSubscription, restoreSubscription]);
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
      setAddError(typeof e === 'string' ? e : e instanceof Error ? e.message : t('subscriptions.unreadable'));
    } finally {
      setAdding(false);
    }
  }, [url, adding, addSubscription]);

  return (
    <div className="page-container">
      <div className="flex items-center justify-between page-header">
        <div>
          <h1 className="page-title">{t('shell.nav.subscriptions')}</h1>
          <p className="page-subtitle">
            {items.length === 0
              ? 'Watch channels and playlists — new videos download automatically'
              : `${items.length} subscription${items.length !== 1 ? 's' : ''} · new videos are queued automatically`}
          </p>
        </div>
        {items.length > 0 && (
          <DisabledReason reason={checking ? t('subscriptions.checkRunning') : null}>
            <button
              onClick={() => checkNow()}
              disabled={checking}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary text-xs font-medium text-secondary-foreground hover:bg-secondary/80 transition-colors active:scale-[0.97] disabled:opacity-50"
            >
              {checking ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              {checking ? t('about.update.checking') : t('subscriptions.checkAll')}
            </button>
          </DisabledReason>
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
            placeholder={t('subscriptions.page.pasteAChannelPlaylistOr')}
            className="flex-1 bg-secondary/50 border border-border/50 rounded-lg px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
            disabled={adding}
          />
          <DisabledReason reason={adding ? t('subscriptions.alreadyAdding') : !url.trim() ? t('subscriptions.pasteFirst') : null}>
            <button
              onClick={handleAdd}
              disabled={adding || !url.trim()}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors active:scale-[0.97] disabled:opacity-50"
            >
              {adding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Rss className="w-3 h-3" />}
              {adding ? t('subscriptions.adding') : t('subscriptions.subscribe')}
            </button>
          </DisabledReason>
        </div>
        {addError && (
          <p className="mt-2 text-xs text-destructive">{addError}</p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          {t('subscriptions.onlyNew')}
        </p>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={Rss}
          title={t('subscriptions.page.noSubscriptionsYet')}
          description={t('subscriptions.page.subscribeToAChannelOr')}
        />
      ) : (
        <div className="space-y-1.5">
          {items.map((sub, i) => (
            <div
              key={sub.id}
              className="surface-row rounded-xl p-3.5 animate-fade-in"
              style={{ animationDelay: `${Math.min(i, 10) * 50}ms` }}
            >
              <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${sub.enabled ? 'bg-primary/10' : 'bg-secondary'}`}>
                  <Rss className={`w-4 h-4 ${sub.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <h4 className={`text-xs font-medium truncate ${sub.enabled ? 'text-foreground' : 'text-muted-foreground'}`}>
                    {sub.title}
                  </h4>
                  <p className="text-xs text-muted-foreground truncate">{sub.url}</p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <span>{t('subscriptions.checked', { when: formatRelative(sub.lastCheckedAt) })}</span>
                    <span>·</span>
                    <span>{sub.audioOnly ? t('add.batch.audioOnly') : t('add.batch.video')}</span>
                    {!sub.enabled && (<><span>·</span><span>{t('common.status.paused')}</span></>)}
                    {(sub.includeKeywords?.length || sub.excludeKeywords?.length) ? (
                      <><span>·</span><span>{t('subscriptions.filtered')}</span></>
                    ) : null}
                    {optionSummary(sub, preferences.categories.find(c => c.id === sub.categoryId)?.name).map(text => (
                      <React.Fragment key={text}><span>·</span><span className="truncate">{text}</span></React.Fragment>
                    ))}
                  </div>
                  {editingOptions === sub.id && (
                    <SubscriptionOptions sub={sub} onChange={patch => updateSubscription(sub.id, patch)} />
                  )}
                  {sub.lastError && (
                    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-destructive">
                      <AlertTriangle className="w-3 h-3 shrink-0" />
                      <span className="truncate">{sub.lastError}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setAudioOnly(sub.id, !sub.audioOnly)}
                    title={sub.audioOnly ? t('subscriptions.toVideo') : t('subscriptions.toAudio')}
                    aria-label={sub.audioOnly ? t('subscriptions.toVideo') : t('subscriptions.toAudio')}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    {sub.audioOnly ? <Music className="w-3.5 h-3.5" /> : <Video className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => setEditingOptions(id => (id === sub.id ? null : sub.id))}
                    title={t('subscriptions.page.downloadOptions')}
                    aria-label={t('subscriptions.page.downloadOptions')}
                    aria-expanded={editingOptions === sub.id}
                    className={`p-1.5 rounded-md hover:bg-secondary transition-colors active:scale-[0.95] ${
                      editingOptions === sub.id ? 'text-foreground bg-secondary' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </button>
                  <DisabledReason reason={checking ? t('subscriptions.checkRunning') : null}>
                    <button
                      onClick={() => checkNow(sub.id)}
                      disabled={checking}
                      title={t('subscriptions.page.checkNow')}
                      aria-label={t('subscriptions.page.checkNow')}
                      className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95] disabled:opacity-50"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                    </button>
                  </DisabledReason>
                  <button
                    onClick={() => toggleSubscription(sub.id)}
                    title={sub.enabled ? t('subscriptions.pause') : t('subscriptions.resume')}
                    aria-label={sub.enabled ? t('subscriptions.pause') : t('subscriptions.resume')}
                    className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors active:scale-[0.95]"
                  >
                    {sub.enabled ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <button
                    onClick={() => unsubscribeWithUndo(sub)}
                    title={t('subscriptions.page.unsubscribe')}
                    aria-label={t('subscriptions.page.unsubscribe')}
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
