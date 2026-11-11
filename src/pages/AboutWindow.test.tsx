import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AboutPanel } from './AboutWindow';
import type { UpdateCheckResult } from '@/services/types';

function setup(result: UpdateCheckResult) {
  const service = {
    getAppVersion: vi.fn().mockResolvedValue('2.6.4'),
    checkForUpdates: vi.fn().mockResolvedValue(result),
    openExternal: vi.fn().mockResolvedValue(undefined),
  };
  const showInMain = vi.fn();
  render(<AboutPanel service={service} showInMain={showInMain} />);
  return { service, showInMain };
}

describe('AboutPanel', () => {
  it('shows the one version number', async () => {
    setup({ available: false });
    expect(await screen.findByText('Version 2.6.4')).toBeTruthy();
  });

  it('says so when up to date', async () => {
    setup({ available: false });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText("You're on the latest version")).toBeTruthy();
  });

  it('sends an available update to Settings', async () => {
    const { showInMain } = setup({ available: true, version: '2.7.0' });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Version 2.7.0 is available')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }));
    expect(showInMain).toHaveBeenCalledWith('updates');
  });

  it('offers a retry when the check fails', async () => {
    const { service } = setup({ available: false, error: 'timed out' });
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Try again' });
    expect(service.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('opens licenses in the main window and links in the browser', async () => {
    const { service, showInMain } = setup({ available: false });
    await screen.findByText('Version 2.6.4');
    fireEvent.click(screen.getByRole('button', { name: /Credits/ }));
    expect(showInMain).toHaveBeenCalledWith('licenses');
    fireEvent.click(screen.getByRole('button', { name: 'Report a bug' }));
    expect(service.openExternal).toHaveBeenCalledWith(expect.stringContaining('version=2.6.4'));
  });
});
