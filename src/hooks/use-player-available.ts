import { useEffect, useState } from 'react';

/** Whether this build can run the embedded player. macOS and Windows release
 * builds bundle libmpv; Linux and some dev builds don't, so ask the backend
 * rather than assuming. Always false in the web demo. */
export function usePlayerAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    import('@tauri-apps/api/core')
      .then(({ isTauri, invoke }) => (isTauri() ? invoke<boolean>('player_available') : false))
      .then(setAvailable)
      .catch(() => {});
  }, []);
  return available;
}
