import type { DiagnosticsEntry } from '@/types/models';
import { generateId } from './utils';

const LOG_PRIORITY: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const logs: DiagnosticsEntry[] = [];
let minLevel: DiagnosticsEntry['level'] = 'info';

export const diagnostics = {
  setLogLevel(level: DiagnosticsEntry['level']) {
    minLevel = level;
  },
  log(level: DiagnosticsEntry['level'], message: string, context?: Record<string, unknown>) {
    if ((LOG_PRIORITY[level] ?? 0) < (LOG_PRIORITY[minLevel] ?? 0)) return;
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
