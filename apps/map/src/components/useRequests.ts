import { useEffect, useState } from 'react';
import type { MapData, RootRequests } from '../types';

/** The request files fetched so far, by url (a file never changes for its url). */
const cache = new Map<string, Promise<RootRequests>>();

/** Fetch what the cases do at a root once; a file of another version of the data than the page reads is none. */
function fetchRequests(url: string): Promise<RootRequests> {
  let pending = cache.get(url);
  if (pending === undefined) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const requests = (await response.json()) as RootRequests;
      if (requests.version !== 4) throw new Error(`地図のデータが古い形です（version ${String(requests.version)}）。地図のデータを作り直してください。`);
      return requests;
    });
    pending.catch(() => cache.delete(url));
    cache.set(url, pending);
  }
  return pending;
}

/** What the map has of the cases of a root: loading, none, what they do, or why it could not be read. */
export type RootRequestsState = { kind: 'loading' } | { kind: 'none' } | { kind: 'ready'; requests: RootRequests } | { kind: 'failed'; message: string };

/**
 * What the request cases do at a root (MapData.requests): the ways each
 * case's request took when the build ran it on the live OP, and for each
 * way the cases that take it. Read when the flow view first needs it; none
 * when the build ran no case on the live OP, or none at this root.
 */
export function useRootRequests(data: MapData, root: string): RootRequestsState {
  const url = data.requests?.[root];
  const [loaded, setLoaded] = useState<{ url: string; state: RootRequestsState } | undefined>(undefined);
  useEffect(() => {
    if (url === undefined) return undefined;
    let live = true;
    fetchRequests(url)
      .then((requests) => {
        if (live) setLoaded({ url, state: { kind: 'ready', requests } });
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ url, state: { kind: 'failed', message: error instanceof Error ? error.message : String(error) } });
      });
    return () => {
      live = false;
    };
  }, [url]);
  if (url === undefined) return { kind: 'none' };
  return loaded?.url === url ? loaded.state : { kind: 'loading' };
}
