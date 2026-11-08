import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { DisabledReason } from '../common/DisabledReason';

describe('DisabledReason', () => {
  it('stays out of the way while the button can be used', () => {
    const { container } = render(<DisabledReason reason={null}><button>Go</button></DisabledReason>);
    expect(container.querySelector('span')).not.toHaveAttribute('tabindex');
  });

  it('shows the reason to someone tabbing to a disabled button', async () => {
    const { container } = render(<DisabledReason reason="Paste a link first"><button disabled>Go</button></DisabledReason>);
    const wrapper = container.querySelector('span') as HTMLElement;
    expect(wrapper).toHaveAttribute('tabindex', '0');
    act(() => wrapper.focus());
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Paste a link first'));
  });

  it('keeps the same button when it becomes available', () => {
    const { rerender } = render(<DisabledReason reason="Wait"><button disabled>Go</button></DisabledReason>);
    const before = screen.getByRole('button');
    rerender(<DisabledReason reason={null}><button>Go</button></DisabledReason>);
    expect(screen.getByRole('button')).toBe(before);
  });
});
