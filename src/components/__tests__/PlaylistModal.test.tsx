import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlaylistModal, PRESELECT_LIMIT } from '../media-details/PlaylistModal';
import type { PlaylistInfo } from '@/types/models';

function list(n: number): PlaylistInfo {
  return {
    title: `List of ${n}`,
    entries: Array.from({ length: n }, (_, i) => ({ url: `https://example.com/v/${i}`, title: `Video ${i}`, duration: 60, thumbnail: '' })),
  };
}

function open(playlist: PlaylistInfo) {
  render(<PlaylistModal open onClose={vi.fn()} playlist={playlist} onQueueSelected={vi.fn()} />);
}

// Windows test run 2026-09-26: a channel's 1,212 uploads opened all ticked,
// so one click queued every one of them.
describe('PlaylistModal selection', () => {
  it('opens a playlist with every entry ticked', () => {
    open(list(3));
    expect(screen.getByText('Select all (3/3)')).toBeTruthy();
  });

  it('opens a long list with nothing ticked and nothing to queue yet', () => {
    const n = PRESELECT_LIMIT + 1;
    open(list(n));
    expect(screen.getByText(`Select all (0/${n})`)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Queue 0 Videos/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});
