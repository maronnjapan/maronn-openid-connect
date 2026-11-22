import { useEffect, useState } from 'react';
import type { HistoryData, HistoryDetail } from '../types';

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

/** The diff files of the changes fetched so far, by url. */
const details = new Map<string, Promise<HistoryDetail>>();

/** The diff of the provider's code of a change (HistoryEntry.detail), read when its page opens: undefined while it loads or when the change has none. */
export function useHistoryDetail(url: string | undefined): HistoryDetail | Error | undefined {
  const [loaded, setLoaded] = useState<{ url: string; value: HistoryDetail | Error } | undefined>(undefined);
  useEffect(() => {
    if (url === undefined) return;
    let live = true;
    let pending = details.get(url);
    if (pending === undefined) {
      pending = fetch(url).then(async (response) => {
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        return (await response.json()) as HistoryDetail;
      });
      pending.catch(() => details.delete(url));
      details.set(url, pending);
    }
    pending
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
