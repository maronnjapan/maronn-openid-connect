import { useEffect, useState } from 'react';
import type { HistoryData } from '../types';

/** The history files fetched so far, by url (a file never changes for its url). */
const cache = new Map<string, Promise<HistoryData>>();

/** Fetch the history of main once. */
function fetchHistory(url: string): Promise<HistoryData> {
  let pending = cache.get(url);
  if (pending === undefined) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return (await response.json()) as HistoryData;
    });
    pending.catch(() => cache.delete(url));
    cache.set(url, pending);
  }
  return pending;
}

/** The history of main (MapData.history), read when a screen needs it: undefined while it loads or when the map has none, an Error when it cannot be read. */
export function useHistory(url: string | undefined): HistoryData | Error | undefined {
  const [loaded, setLoaded] = useState<{ url: string; value: HistoryData | Error } | undefined>(undefined);
  useEffect(() => {
    if (url === undefined) return;
    let live = true;
    fetchHistory(url)
      .then((value) => {
        if (live) setLoaded({ url, value });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ url, value: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => {
      live = false;
    };
  }, [url]);
  return loaded !== undefined && loaded.url === url ? loaded.value : undefined;
}
