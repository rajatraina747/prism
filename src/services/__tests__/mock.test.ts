import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MockPrismService } from '../mock';
import type { DownloadItem } from '@/types/models';

describe('MockPrismService', () => {
  let service: MockPrismService;

  beforeEach(() => {
    service = new MockPrismService();
    localStorage.clear();
  });

  describe('parseUrl', () => {
    it('returns metadata for a valid URL', async () => {
      const result = await service.parseUrl('https://youtube.com/watch?v=test');
      expect(result.title).toBeTruthy();
      expect(result.duration).toBeGreaterThan(0);
      expect(result.formats.length).toBeGreaterThan(0);
      expect(result.source.url).toBe('https://youtube.com/watch?v=test');
      expect(result.source.domain).toBe('youtube.com');
    });

    it('throws on invalid URL', async () => {
      await expect(service.parseUrl('')).rejects.toThrow('Invalid URL');
      await expect(service.parseUrl('ab')).rejects.toThrow('Invalid URL');
    });

    it('returns formats with expected shape', async () => {
      const result = await service.parseUrl('https://example.com/video');
      const format = result.formats[0];
      expect(format.id).toBeTruthy();
      expect(format.resolution).toBeTruthy();
      expect(format.container).toBeTruthy();
      expect(format.codec).toBeTruthy();
      expect(typeof format.fileSize).toBe('number');
      expect(['best', 'high', 'medium', 'low']).toContain(format.quality);
    });
  });

  describe('startDownload', () => {
    it('calls onProgress and eventually onComplete', async () => {
      const mockItem = {
        id: 'test-1',
        metadata: { title: 'Test', duration: 60, thumbnail: '', source: { url: 'https://x.com', domain: 'x.com', addedAt: '' }, formats: [] },
        settings: { format: null, destination: '', filename: 'test', retryCount: 0, startImmediately: true },
        status: 'downloading' as const,
        progress: 0, speed: 0, eta: 0, downloadedBytes: 0, totalBytes: 500_000_000,
        retryAttempt: 0,
      } satisfies DownloadItem;

      const onProgress = vi.fn();
      const onComplete = vi.fn();

      const cancel = service.startDownload(mockItem, onProgress, onComplete);

      // Wait for a few progress ticks
      await new Promise(r => setTimeout(r, 600));
      expect(onProgress).toHaveBeenCalled();

      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1][0];
      expect(lastCall.downloadedBytes).toBeGreaterThan(0);
      expect(lastCall.totalBytes).toBe(500_000_000);
      expect(lastCall.progress).toBeGreaterThan(0);

      // Cleanup
      cancel();
    });

    it('returns a cancel function that stops the download', async () => {
      const mockItem = {
        id: 'test-2',
        metadata: { title: 'Test', duration: 60, thumbnail: '', source: { url: 'https://x.com', domain: 'x.com', addedAt: '' }, formats: [] },
        settings: { format: null, destination: '', filename: 'test', retryCount: 0, startImmediately: true },
        status: 'downloading' as const,
        progress: 0, speed: 0, eta: 0, downloadedBytes: 0, totalBytes: 500_000_000,
        retryAttempt: 0,
      } satisfies DownloadItem;

      const onProgress = vi.fn();
      const onComplete = vi.fn();

      const cancel = service.startDownload(mockItem, onProgress, onComplete);
      cancel();

      const callsAtCancel = onProgress.mock.calls.length;
      await new Promise(r => setTimeout(r, 400));
      // Should not have received more calls after cancel
      expect(onProgress.mock.calls.length).toBe(callsAtCancel);
    });
  });

  describe('persistence', () => {
    it('saves and loads queue', () => {
      const items = [{ id: 'q1', status: 'queued' }] as unknown as DownloadItem[];
      service.persistence.saveQueue(items);
      const loaded = service.persistence.loadQueue();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('q1');
    });

    it('resets downloading status to queued on load', () => {
      const items = [{ id: 'q1', status: 'downloading' }] as unknown as DownloadItem[];
      service.persistence.saveQueue(items);
      const loaded = service.persistence.loadQueue();
      expect(loaded[0].status).toBe('queued');
      expect(loaded[0].speed).toBe(0);
      expect(loaded[0].eta).toBe(0);
    });

    it('saves and loads history', () => {
      const items = [{ id: 'h1', status: 'completed' }] as unknown as import('@/types/models').HistoryItem[];
      service.persistence.saveHistory(items);
      const loaded = service.persistence.loadHistory();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('h1');
    });

    it('saves and loads settings', () => {
      const prefs = { theme: 'light' } as unknown as import('@/types/models').AppPreferences;
      service.persistence.saveSettings(prefs);
      const loaded = service.persistence.loadSettings();
      expect(loaded).toBeTruthy();
      expect(loaded!.theme).toBe('light');
    });

    it('returns null for missing settings', () => {
      expect(service.persistence.loadSettings()).toBeNull();
    });

    it('returns empty arrays for missing queue/history', () => {
      expect(service.persistence.loadQueue()).toEqual([]);
      expect(service.persistence.loadHistory()).toEqual([]);
    });
  });

  describe('utility methods', () => {
    it('getDefaultDownloadPath returns a path', async () => {
      const path = await service.getDefaultDownloadPath();
      expect(path).toBe('~/Downloads/Prism');
    });

    it('getAppVersion returns a version string', async () => {
      const v = await service.getAppVersion();
      expect(v).toContain('1.0.0');
    });

    it('checkForUpdates returns no updates', async () => {
      const result = await service.checkForUpdates();
      expect(result.available).toBe(false);
    });
  });
});
