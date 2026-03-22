import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge, ProgressBar, EmptyState, Panel } from '../common';
import { AlertCircle } from 'lucide-react';

describe('StatusBadge', () => {
  it('renders all statuses with correct labels', () => {
    const statuses = [
      { status: 'queued' as const, label: 'Queued' },
      { status: 'parsing' as const, label: 'Parsing' },
      { status: 'ready' as const, label: 'Ready' },
      { status: 'downloading' as const, label: 'Downloading' },
      { status: 'paused' as const, label: 'Paused' },
      { status: 'completed' as const, label: 'Completed' },
      { status: 'failed' as const, label: 'Failed' },
      { status: 'canceled' as const, label: 'Canceled' },
    ];

    for (const { status, label } of statuses) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeTruthy();
      unmount();
    }
  });
});

describe('ProgressBar', () => {
  it('renders with correct width style', () => {
    const { container } = render(<ProgressBar value={50} />);
    const bar = container.querySelector('[style]') as HTMLElement;
    expect(bar?.style.width).toBe('50%');
  });

  it('clamps value between 0 and 100', () => {
    const { container: c1 } = render(<ProgressBar value={-10} />);
    const bar1 = c1.querySelector('[style]') as HTMLElement;
    expect(bar1?.style.width).toBe('0%');

    const { container: c2 } = render(<ProgressBar value={150} />);
    const bar2 = c2.querySelector('[style]') as HTMLElement;
    expect(bar2?.style.width).toBe('100%');
  });
});

describe('EmptyState', () => {
  it('renders title and description', () => {
    render(<EmptyState icon={AlertCircle} title="Nothing here" description="Try adding something" />);
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByText('Try adding something')).toBeTruthy();
  });

  it('renders optional action', () => {
    render(<EmptyState icon={AlertCircle} title="Empty" description="desc" action={<button>Do it</button>} />);
    expect(screen.getByText('Do it')).toBeTruthy();
  });
});

describe('Panel', () => {
  it('renders children', () => {
    render(<Panel>Hello World</Panel>);
    expect(screen.getByText('Hello World')).toBeTruthy();
  });

  it('renders title when provided', () => {
    render(<Panel title="My Panel">Content</Panel>);
    expect(screen.getByText('My Panel')).toBeTruthy();
    expect(screen.getByText('Content')).toBeTruthy();
  });

  it('renders action when provided', () => {
    render(<Panel title="Panel" action={<button>Act</button>}>Body</Panel>);
    expect(screen.getByText('Act')).toBeTruthy();
  });
});
