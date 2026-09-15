import { describe, it, expect, vi } from 'vitest';
import { render as rtlRender, screen, fireEvent } from '@testing-library/react';
import { StaticServiceProvider } from '@/services/ServiceProvider';
import { MockPrismService } from '@/services/mock';
import { QueueTable } from '../queue/QueueTable';
import type { DownloadItem } from '@/types/models';

// QueueTable rows use the service (copy-link) — wrap renders in the provider.
const mockService = new MockPrismService();
const render = (ui: React.ReactElement) =>
  rtlRender(<StaticServiceProvider service={mockService}>{ui}</StaticServiceProvider>);

function makeItem(overrides: Partial<DownloadItem> = {}): DownloadItem {
  return {
    id: 'item-1',
    metadata: {
      title: 'Test Video',
      duration: 120,
      thumbnail: 'https://example.com/thumb.jpg',
      source: { url: 'https://example.com', domain: 'example.com', addedAt: '' },
      formats: [],
    },
    settings: {
      format: { id: 'f1', label: '1080p', resolution: '1080p', container: 'mp4', codec: 'H.264', fileSize: 100_000, quality: 'high' },
      destination: '/downloads',
      filename: 'test',
      retryCount: 3,
      startImmediately: true,
    },
    status: 'queued',
    progress: 0,
    speed: 0,
    eta: 0,
    downloadedBytes: 0,
    totalBytes: 100_000_000,
    retryAttempt: 0,
    ...overrides,
  };
}

describe('QueueTable', () => {
  const defaultProps = {
    onPause: vi.fn(),
    onResume: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onRemove: vi.fn(),
  };

  it('renders items with their titles', () => {
    render(<QueueTable items={[makeItem()]} {...defaultProps} />);
    expect(screen.getByText('Test Video')).toBeTruthy();
  });

  it('shows Pause button for downloading items', () => {
    render(<QueueTable items={[makeItem({ status: 'downloading', progress: 50 })]} {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
  });

  it('shows Resume button for paused items', () => {
    render(<QueueTable items={[makeItem({ status: 'paused', progress: 30 })]} {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });

  it('shows Retry button for failed items', () => {
    render(<QueueTable items={[makeItem({
      status: 'failed',
      error: { code: 'ERR', message: 'Network error', category: 'network', timestamp: '' },
    })]} {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows Cancel button for queued items', () => {
    render(<QueueTable items={[makeItem({ status: 'queued' })]} {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  });

  it('shows Remove button for completed items', () => {
    render(<QueueTable items={[makeItem({ status: 'completed' })]} {...defaultProps} />);
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });

  it('calls onPause when Pause is clicked', () => {
    const onPause = vi.fn();
    render(<QueueTable items={[makeItem({ status: 'downloading', progress: 50 })]} {...defaultProps} onPause={onPause} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(onPause).toHaveBeenCalledWith('item-1');
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<QueueTable items={[makeItem({ status: 'queued' })]} {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledWith('item-1');
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(<QueueTable items={[makeItem({
      status: 'failed',
      error: { code: 'ERR', message: 'err', category: 'network', timestamp: '' },
    })]} {...defaultProps} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledWith('item-1');
  });

  it('explains a sign-in failure and offers the cookies fix on the row', () => {
    render(<QueueTable items={[makeItem({
      status: 'failed',
      error: {
        code: 'ERR',
        message: "yt-dlp error: ERROR: [youtube] abc123: Sign in to confirm you're not a bot",
        category: 'auth',
        timestamp: '',
      },
    })]} {...defaultProps} />);
    expect(screen.getByText(/needs you to be signed in/)).toBeTruthy();
    // The engine's line, without the yt-dlp/extractor prefixes.
    expect(screen.getByText("Sign in to confirm you're not a bot")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set browser cookies' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('renders multiple items', () => {
    const items = [
      makeItem({ id: 'a', metadata: { ...makeItem().metadata, title: 'Video A' } }),
      makeItem({ id: 'b', metadata: { ...makeItem().metadata, title: 'Video B' } }),
    ];
    render(<QueueTable items={items} {...defaultProps} />);
    expect(screen.getByText('Video A')).toBeTruthy();
    expect(screen.getByText('Video B')).toBeTruthy();
  });

  it('displays status badge', () => {
    render(<QueueTable items={[makeItem({ status: 'downloading', progress: 25 })]} {...defaultProps} />);
    expect(screen.getByText('Downloading')).toBeTruthy();
  });
});

describe('QueueTable — torrents', () => {
  const props = { onPause: vi.fn(), onResume: vi.fn(), onCancel: vi.fn(), onRetry: vi.fn(), onRemove: vi.fn() };

  it('shows "searching for peers" with the elapsed time and never a failure', () => {
    render(<QueueTable {...props} items={[makeItem({ kind: 'torrent', status: 'downloading', peers: 0, peersSeen: 0, peersConnecting: 0, peerlessSecs: 420 })]} />);
    expect(screen.getByText(/searching for peers · 7m/)).toBeInTheDocument();
  });

  it('shows "size pending" instead of 0 B for a torrent without metadata', () => {
    render(<QueueTable {...props} items={[makeItem({ kind: 'torrent', status: 'downloading', totalBytes: 0 })]} />);
    expect(screen.getByText('size pending')).toBeInTheDocument();
    expect(screen.queryByText('0 B / 0 B')).not.toBeInTheDocument();
  });

  it('renders the pieces map and upload speed for a live torrent', () => {
    render(<QueueTable {...props} items={[makeItem({ kind: 'torrent', status: 'downloading', uploadSpeed: 2048, pieces: [255, 0, 128] })]} />);
    expect(screen.getByRole('img', { name: /downloaded pieces map/i })).toBeInTheDocument();
    expect(screen.getByText(/↑ 2 KB\/s/)).toBeInTheDocument();
  });

  it('offers Update tracker for live torrents only, and calls it', () => {
    const onReannounce = vi.fn();
    render(<QueueTable {...props} onReannounce={onReannounce} items={[
      makeItem({ id: 'live', kind: 'torrent', status: 'downloading' }),
      makeItem({ id: 'http', status: 'downloading' }),
      makeItem({ id: 'paused', kind: 'torrent', status: 'paused' }),
    ]} />);
    const buttons = screen.getAllByRole('button', { name: 'Update tracker' });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]);
    expect(onReannounce).toHaveBeenCalledWith('live');
  });

  it('selects on click and opens details on double-click', () => {
    const onSelect = vi.fn();
    const onOpenDetails = vi.fn();
    render(<QueueTable {...props} onSelect={onSelect} onOpenDetails={onOpenDetails} selectedIds={new Set(['item-1'])} items={[makeItem({ status: 'downloading' })]} />);
    const row = screen.getByRole('listitem');
    expect(row).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(row, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('item-1', { shift: true, meta: false });
    fireEvent.doubleClick(row);
    expect(onOpenDetails).toHaveBeenCalledWith('item-1');
  });
});
