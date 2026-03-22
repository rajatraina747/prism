import type { DiagnosticsEntry } from '@/types/models';
import { generateId } from './utils';

const logs: DiagnosticsEntry[] = [];

export const diagnostics = {
  log(level: DiagnosticsEntry['level'], message: string, context?: Record<string, unknown>) {
    const entry: DiagnosticsEntry = {
      id: generateId(),
      level,
      message,
      timestamp: new Date().toISOString(),
      context,
    };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    if (level === 'error') console.error(`[Prism] ${message}`, context);
  },
  getLogs(): DiagnosticsEntry[] {
    return [...logs];
  },
  clear() {
    logs.length = 0;
  },
};
