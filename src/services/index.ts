// Service abstraction
export type { IPrismService, ProgressCallback, CompletionCallback, UpdateCheckResult } from './types';
export { MockPrismService } from './mock';
export { ServiceProvider, useService } from './ServiceProvider';

// Utilities (pure functions — no service dependency)
export { generateId, formatBytes, formatDuration, formatSpeed, formatEta } from './utils';

// Diagnostics singleton
export { diagnostics } from './diagnostics';
