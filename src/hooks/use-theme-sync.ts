import { useEffect } from 'react';
import { useSettings } from '@/stores/AppProvider';
import { applyTheme } from '@/lib/theme';

/** Applies the Theme setting to the page. Call once, in AppShell. */
export function useThemeSync() {
  const { preferences } = useSettings();
  useEffect(() => {
    applyTheme(preferences.theme);
  }, [preferences.theme]);
}
