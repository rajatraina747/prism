import { describe, it, expect, beforeEach, vi } from 'vitest';
import { diagnostics } from '../diagnostics';

beforeEach(() => {
  diagnostics.clear();
});

describe('diagnostics', () => {
  it('logs entries and retrieves them', () => {
    diagnostics.log('info', 'Test message');
    const logs = diagnostics.getLogs();
    expect(logs).toHaveLength(1);
    expect(logs[0].level).toBe('info');
    expect(logs[0].message).toBe('Test message');
    expect(logs[0].id).toBeTruthy();
    expect(logs[0].timestamp).toBeTruthy();
  });

  it('supports all log levels', () => {
    // Suppress console.error for the error-level test
    vi.spyOn(console, 'error').mockImplementation(() => {});
    diagnostics.setLogLevel('debug');

    diagnostics.log('info', 'info msg');
    diagnostics.log('warn', 'warn msg');
    diagnostics.log('error', 'error msg');
    diagnostics.log('debug', 'debug msg');

    const logs = diagnostics.getLogs();
    expect(logs).toHaveLength(4);
    expect(logs.map(l => l.level)).toEqual(['info', 'warn', 'error', 'debug']);
  });

  it('stores optional context', () => {
    diagnostics.log('info', 'with context', { key: 'value' });
    const logs = diagnostics.getLogs();
    expect(logs[0].context).toEqual({ key: 'value' });
  });

  it('returns a copy of logs (not the internal array)', () => {
    diagnostics.log('info', 'first');
    const logs1 = diagnostics.getLogs();
    diagnostics.log('info', 'second');
    const logs2 = diagnostics.getLogs();
    expect(logs1).toHaveLength(1);
    expect(logs2).toHaveLength(2);
  });

  it('clears all logs', () => {
    diagnostics.log('info', 'a');
    diagnostics.log('info', 'b');
    expect(diagnostics.getLogs()).toHaveLength(2);
    diagnostics.clear();
    expect(diagnostics.getLogs()).toHaveLength(0);
  });

  it('rotates at 500 entries', () => {
    for (let i = 0; i < 510; i++) {
      diagnostics.log('info', `msg-${i}`);
    }
    const logs = diagnostics.getLogs();
    expect(logs).toHaveLength(500);
    // Oldest entries should have been shifted off
    expect(logs[0].message).toBe('msg-10');
    expect(logs[499].message).toBe('msg-509');
  });

  it('calls console.error for error-level logs', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    diagnostics.log('error', 'something broke', { detail: 'test' });
    expect(spy).toHaveBeenCalledWith('[Prism] something broke', { detail: 'test' });
    spy.mockRestore();
  });
});
