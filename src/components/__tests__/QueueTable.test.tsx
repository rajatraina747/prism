import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueueTable } from '../queue/QueueTable';
import type { DownloadItem } from '@/types/models';

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
      priority: 'normal',
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
    expect(screen.getByTitle('Pause')).toBeTruthy();
  });

  it('shows Resume button for paused items', () => {
    render(<QueueTable items={[makeItem({ status: 'paused', progress: 30 })]} {...defaultProps} />);
    expect(screen.getByTitle('Resume')).toBeTruthy();
  });

  it('shows Retry button for failed items', () => {
    render(<QueueTable items={[makeItem({
      status: 'failed',
      error: { code: 'ERR', message: 'Network error', category: 'network', timestamp: '' },
    })]} {...defaultProps} />);
    expect(screen.getByTitle('Retry')).toBeTruthy();
  });

  it('shows Cancel button for queued items', () => {
    render(<QueueTable items={[makeItem({ status: 'queued' })]} {...defaultProps} />);
    expect(screen.getByTitle('Cancel')).toBeTruthy();
  });

  it('shows Remove button for completed items', () => {
    render(<QueueTable items={[makeItem({ status: 'completed' })]} {...defaultProps} />);
    expect(screen.getByTitle('Remove')).toBeTruthy();
  });

  it('calls onPause when Pause is clicked', () => {
    const onPause = vi.fn();
    render(<QueueTable items={[makeItem({ status: 'downloading', progress: 50 })]} {...defaultProps} onPause={onPause} />);
    fireEvent.click(screen.getByTitle('Pause'));
    expect(onPause).toHaveBeenCalledWith('item-1');
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(<QueueTable items={[makeItem({ status: 'queued' })]} {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByTitle('Cancel'));
    expect(onCancel).toHaveBeenCalledWith('item-1');
  });

  it('calls onRetry when Retry is clicked', () => {
    const onRetry = vi.fn();
    render(<QueueTable items={[makeItem({
      status: 'failed',
      error: { code: 'ERR', message: 'err', category: 'network', timestamp: '' },
    })]} {...defaultProps} onRetry={onRetry} />);
    fireEvent.click(screen.getByTitle('Retry'));
    expect(onRetry).toHaveBeenCalledWith('item-1');
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
