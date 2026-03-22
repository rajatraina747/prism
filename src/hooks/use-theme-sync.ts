import { useEffect } from 'react';
import { useTheme } from 'next-themes';
import { useSettings } from '@/stores/AppProvider';

/**
 * Syncs the app preferences theme setting with next-themes.
 * Call once in AppShell or a top-level layout component.
 */
export function useThemeSync() {
  const { preferences } = useSettings();
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(preferences.theme);
  }, [preferences.theme, setTheme]);
}
