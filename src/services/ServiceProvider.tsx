import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import type { IPrismService } from './types';
import { MockPrismService } from './mock';

const ServiceContext = createContext<IPrismService | null>(null);

export function useService(): IPrismService {
  const ctx = useContext(ServiceContext);
  if (!ctx) throw new Error('useService must be used within ServiceProvider');
  return ctx;
}

function detectEnvironment(): 'tauri' | 'web' {
  return typeof window !== 'undefined' && '__TAURI__' in window ? 'tauri' : 'web';
}

async function createService(): Promise<IPrismService> {
  let service: IPrismService;
  if (detectEnvironment() === 'tauri') {
    // Dynamic import so the Tauri module is only loaded in desktop builds
    const { TauriPrismService } = await import('./tauri');
    service = new TauriPrismService();
  } else {
    service = new MockPrismService();
  }
  // Preload persistence data before UI renders
  await service.init?.();
  return service;
}

export function ServiceProvider({ children }: { children: ReactNode }) {
  const [service, setService] = useState<IPrismService | null>(null);

  useEffect(() => {
    createService().then(setService);
  }, []);

  if (!service) {
    // Minimal loading state while service initializes
    return (
      <div className="flex h-screen w-full items-center justify-center bg-background">
        <div className="flex items-center gap-3">
          <img src="/logo-nobg.png" alt="Prism" className="w-10 h-10 animate-pulse" />
          <span className="text-sm text-muted-foreground">Loading...</span>
        </div>
      </div>
    );
  }

  return (
    <ServiceContext.Provider value={service}>
      {children}
    </ServiceContext.Provider>
  );
}
