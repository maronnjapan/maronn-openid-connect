import { useEffect, useState } from 'react';
import type { MapData, RootRequests } from '../types';

/** The request files fetched so far, by url (a file never changes for its url). */
const cache = new Map<string, Promise<RootRequests>>();

/** Fetch the requests of a root once. */
function fetchRequests(url: string): Promise<RootRequests> {
  let pending = cache.get(url);
  if (pending === undefined) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return (await response.json()) as RootRequests;
    });
    pending.catch(() => cache.delete(url));
    cache.set(url, pending);
  }
  return pending;
}

/** What the map has of the requests of a root: loading, none, the requests, or why they could not be read. */
export type RootRequestsState = { kind: 'loading' } | { kind: 'none' } | { kind: 'ready'; requests: RootRequests } | { kind: 'failed'; message: string };

/**
 * The requests the OP of the map took the ways of a root with
 * (MapData.requests), read when the flow view first needs them: none when
 * the build ran no request on the OP of the map, or none took a way of this
 * root.
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
