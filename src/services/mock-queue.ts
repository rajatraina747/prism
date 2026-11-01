import type { AppPreferences, DownloadError, DownloadItem, HistoryItem, WhenDoneAction } from '@/types/models';
import { DEFAULT_PREFERENCES } from '@/types/models';
import type { RemoteQueue } from './types';
import type { MockPrismService } from './mock';
import type { ArchivedEntry, QueueNotice, QueuePatch } from '@/stores/remote-queue';
import { queueReducer, type QueueAction } from '@/stores/queue-reducer';
import { itemsToStart } from '@/stores/slots';
import { scheduleGate, itemStartBlocked } from '@/stores/schedule';
import { autoRetryDelayMs } from '@/stores/retry';
import { evaluateWhenDone, IDLE_WHEN_DONE, WHEN_DONE_COUNTDOWN_SECONDS, type WhenDoneState } from '@/stores/completion';
import { overallProgress } from '@/stores/progress';
import { migrateSettings } from '@/stores/settings-migrations';
import { classifyError, errorText } from './errors';

type Handlers = Parameters<RemoteQueue['subscribe']>[0];

/** How long a finished item stays in the queue before it moves to the Library. */
const ARCHIVE_AFTER_MS = 300;

/** The Library row for a finished queue item. */
export function historyEntryFor(i: DownloadItem): HistoryItem {
  return {
    id: i.id,
    metadata: i.metadata,
    settings: i.settings,
    status: i.status as 'completed' | 'failed' | 'canceled',
    completedAt: i.completedAt || new Date().toISOString(),
    fileSize: i.status === 'completed' ? i.totalBytes : i.downloadedBytes,
    totalBytes: i.totalBytes > 0 ? i.totalBytes : undefined,
    filePath: i.filePath,
    error: i.error,
    // A torrent's files (names relative to the destination), capped.
    files: i.kind === 'torrent' && i.status === 'completed' && i.files?.length
      ? i.files.slice(0, 500).map(({ name, size }) => ({ name, size }))
      : undefined,
    actualHeight: i.actualHeight,
    outputFolder: i.outputFolder,
  };
}

const isTerminal = (i: DownloadItem) => i.status === 'completed' || i.status === 'failed' || i.status === 'canceled';

/**
 * The web demo's queue, behind the same interface as Rust's (queue.rs). The
 * page used to run a second queue engine of its own for the demo — auto-start,
 * slots, retries, archiving, "when done" — beside the Rust one, and the two
 * drifted (REVIEW 2026-09-28 A-1). Now the page has one path, and this is the
 * demo's stand-in for Rust: the same pure rules (queue-reducer, slots, retry,
 * schedule, completion), the mock engine's simulated downloads, and the same
 * events Rust sends.
 */
export class MockQueue implements RemoteQueue {
  private items: DownloadItem[];
  private seq = 0;
  private handlers = new Set<Handlers>();
  private running = new Map<string, () => void>();
  private archiveTimer: ReturnType<typeof setTimeout> | null = null;
  private whenDone: WhenDoneState = IDLE_WHEN_DONE;
  private whenDoneTimer: ReturnType<typeof setTimeout> | null = null;
  private minuteTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private service: MockPrismService) {
    this.items = service.persistence.loadQueue()
      // Nothing is running after a reload: what was, waits to start again.
      .map(i => (i.status === 'downloading' ? { ...i, status: 'queued' as const } : i));
  }

  private settings(): AppPreferences {
    return { ...DEFAULT_PREFERENCES, ...migrateSettings(this.service.persistence.loadSettings()) };
  }

  // ── Changing the queue, and telling the page ──

  private apply(action: QueueAction): void {
    const before = this.items;
    const after = queueReducer(before, action);
    if (after === before) return;
    this.items = after;
    this.publish(before, after, action.type === 'reorder' || action.type === 'add');
    this.afterChange();
  }

  private publish(before: DownloadItem[], after: DownloadItem[], orderMoved: boolean): void {
    const was = new Map(before.map(i => [i.id, i]));
    const now = new Set(after.map(i => i.id));
    const patch: QueuePatch = {
      seq: ++this.seq,
      items: after.filter(i => was.get(i.id) !== i),
      removed: before.filter(i => !now.has(i.id)).map(i => i.id),
      ...(orderMoved ? { order: after.map(i => i.id) } : {}),
    };
    this.service.persistence.saveQueue(after);
    for (const h of this.handlers) h.changed(patch);
  }

  private notice(n: QueueNotice): void {
    for (const h of this.handlers) h.notice(n);
  }

  private afterChange(): void {
    this.scheduleArchive();
    this.checkWhenDone();
    const overall = overallProgress(this.items);
    void this.service.setProgress(overall?.percent ?? null, overall?.paused ?? false).catch(() => {});
    this.tick();
  }

  // ── Starting ──

  private tick(): void {
    const settings = this.settings();
    const now = new Date();
    const gate = scheduleGate(settings, now);
    if (gate.blockStarts) return;
    const toStart = itemsToStart(
      this.items,
      { transfers: settings.maxConcurrentDownloads, torrents: settings.maxConcurrentTorrents },
      now,
      i => !this.running.has(i.id) && !itemStartBlocked(i, now),
    );
    for (const item of toStart) this.start(item, gate.speedLimitOverrideBytes);
  }

  private start(item: DownloadItem, speedOverride: number | null | undefined): void {
    this.running.set(item.id, () => {});
    this.apply({ type: 'markStarted', id: item.id, startedAt: new Date().toISOString() });
    const run = speedOverride ? { ...item, settings: { ...item.settings, speedLimit: speedOverride } } : item;
    const stop = this.service.startDownload(
      run,
      ({ seeding, ...data }) => this.apply({ type: 'progress', id: item.id, data, seeding }),
      (success, error, filePath, fileSize, actualHeight, outputFolder) => {
        this.running.delete(item.id);
        if (success) {
          this.apply({ type: 'completed', id: item.id, completedAt: new Date().toISOString(), filePath, fileSize, actualHeight, outputFolder });
          this.notice({ kind: 'completed', id: item.id, title: item.metadata.title });
          const requested = parseInt(item.settings.format?.resolution ?? '', 10);
          if (actualHeight && requested && actualHeight < requested) {
            this.notice({ kind: 'quality', id: item.id, title: item.metadata.title, requested, actual: actualHeight });
          }
          return;
        }
        const { message, detail, engineCode } = errorText(error);
        const { category, suggestion } = classifyError(message, engineCode);
        const current = this.items.find(i => i.id === item.id);
        const delay = autoRetryDelayMs(current?.retryAttempt ?? 0, this.settings().defaultRetryCount, category, engineCode, message);
        if (delay !== null) {
          setTimeout(() => this.apply({ type: 'requeueForRetry', id: item.id }), delay);
          return;
        }
        const err: DownloadError = {
          code: 'DOWNLOAD_FAILED', message, category, timestamp: new Date().toISOString(), suggestion,
          ...(engineCode ? { engineCode } : {}),
          ...(detail ? { detail } : {}),
        };
        this.apply({ type: 'failed', id: item.id, error: err });
        this.notice({ kind: 'failed', id: item.id, title: item.metadata.title, message, engineCode });
      },
    );
    if (this.running.has(item.id)) this.running.set(item.id, stop);
  }

  private stop(id: string): void {
    this.running.get(id)?.();
    this.running.delete(id);
  }

  // ── Finishing ──

  private scheduleArchive(): void {
    if (this.archiveTimer || !this.items.some(isTerminal)) return;
    this.archiveTimer = setTimeout(() => {
      this.archiveTimer = null;
      const done = this.items.filter(isTerminal);
      if (done.length === 0) return;
      const entries: ArchivedEntry[] = done.map(item => ({ history: historyEntryFor(item), item, stage: 'final' }));
      for (const h of this.handlers) h.archived(entries);
      this.apply({ type: 'removeMany', ids: done.map(d => d.id) });
    }, ARCHIVE_AFTER_MS);
  }

  private checkWhenDone(): void {
    const settings = this.settings();
    const { state, start } = evaluateWhenDone(this.whenDone, this.items, settings);
    if (this.whenDone.armed && state.wasBusy && this.whenDoneTimer) {
      clearTimeout(this.whenDoneTimer);
      this.whenDoneTimer = null;
      for (const h of this.handlers) h.whenDoneCalledOff?.();
    }
    this.whenDone = state;
    if (!start) return;
    const action: WhenDoneAction = settings.whenDoneAction;
    if (this.whenDoneTimer) clearTimeout(this.whenDoneTimer);
    this.whenDoneTimer = setTimeout(() => {
      this.whenDoneTimer = null;
      void this.service.whenDone(action).catch(() => {});
    }, WHEN_DONE_COUNTDOWN_SECONDS * 1000);
    for (const h of this.handlers) h.whenDone({ action, seconds: WHEN_DONE_COUNTDOWN_SECONDS });
  }

  // ── RemoteQueue ──

  async snapshot() {
    return { items: this.items, seq: this.seq };
  }

  async add(item: DownloadItem) {
    this.apply({ type: 'add', item });
  }

  async remove(id: string) {
    this.stop(id);
    this.apply({ type: 'remove', id });
  }

  async pause(id: string) {
    this.stop(id);
    this.apply({ type: 'pause', id });
  }

  async resume(id: string) {
    this.apply({ type: 'resume', id });
  }

  async cancel(id: string) {
    this.stop(id);
    this.apply({ type: 'cancel', id });
  }

  async retry(id: string) {
    this.stop(id);
    this.apply({ type: 'retry', id });
  }

  async pauseAll() {
    for (const i of this.items) if (i.status === 'downloading' || i.status === 'seeding') this.stop(i.id);
    this.apply({ type: 'pauseAll' });
  }

  async resumeAll() {
    for (const i of this.items.filter(x => x.status === 'paused')) this.apply({ type: 'resume', id: i.id });
  }

  async clearCompleted() {
    this.apply({ type: 'clearCompleted' });
  }

  async reorder(from: number, to: number) {
    this.apply({ type: 'reorder', from, to });
  }

  async setSettings(id: string, settings: DownloadItem['settings'], onlyIf?: DownloadItem['status']) {
    const item = this.items.find(i => i.id === id);
    if (!item || (onlyIf && item.status !== onlyIf)) return false;
    const before = this.items;
    this.items = before.map(i => (i.id === id ? { ...i, settings } : i));
    this.publish(before, this.items, false);
    this.afterChange();
    return true;
  }

  async updateTorrentFiles(id: string, files: number[]) {
    await this.service.updateTorrentFiles(id, files);
    this.apply({ type: 'setSelectedFiles', id, files });
  }

  async removeWithData(id: string) {
    this.stop(id);
    this.apply({ type: 'remove', id });
    await this.service.removeTorrentData(id);
  }

  async restartTorrentEngine() {
    return this.service.restartTorrentEngine();
  }

  async cancelWhenDone() {
    if (this.whenDoneTimer) clearTimeout(this.whenDoneTimer);
    this.whenDoneTimer = null;
  }

  subscribe(handlers: Handlers) {
    this.handlers.add(handlers);
    // Quiet hours open and close with the clock, not with a change: look
    // again every minute while anyone is listening.
    this.minuteTimer ??= setInterval(() => this.tick(), 60_000);
    queueMicrotask(() => this.tick());
    return () => {
      this.handlers.delete(handlers);
      if (this.handlers.size === 0 && this.minuteTimer) {
        clearInterval(this.minuteTimer);
        this.minuteTimer = null;
      }
    };
  }
}
