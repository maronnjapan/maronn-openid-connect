import { useEffect, useMemo, useState } from 'react';
import type { FlowTree, FrameChange, FrameFile, MapData, Selection } from '../types';
import { entryOf } from '../lib/trace';

/** The frame files fetched so far, by url, shared by every screen (a file never changes for its url). */
const cache = new Map<string, Promise<FrameFile>>();

/** Fetch the file of a frame once. */
export function fetchFrame(url: string): Promise<FrameFile> {
  let pending = cache.get(url);
  if (pending === undefined) {
    pending = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return (await response.json()) as FrameFile;
    });
    pending.catch(() => cache.delete(url));
    cache.set(url, pending);
  }
  return pending;
}

export interface Frames {
  trees: Map<string, FlowTree>;
  changes: Map<string, FrameChange>;
  selections: Map<string, Selection[]>;
  /** The frames whose file could not be read, with why. */
  failed: Map<string, string>;
}

/** The files of some frames (functions and endpoint bodies, by id), read as they are needed. */
export function useFrames(data: MapData, ids: readonly string[]): Frames {
  const [loaded, setLoaded] = useState<Map<string, FrameFile>>(() => new Map());
  const [failed, setFailed] = useState<Map<string, string>>(() => new Map());
  const key = [...new Set(ids)].sort().join('\n');
  useEffect(() => {
    let live = true;
    for (const id of key === '' ? [] : key.split('\n')) {
      if (loaded.has(id)) continue;
      const url = entryOf(data, id)?.frame;
      if (url === undefined || url === '') continue;
      fetchFrame(url)
        .then((file) => {
          if (live) setLoaded((current) => (current.has(id) ? current : new Map(current).set(id, file)));
        })
        .catch((error: unknown) => {
          if (live) setFailed((current) => new Map(current).set(id, error instanceof Error ? error.message : String(error)));
        });
    }
    return () => {
      live = false;
    };
  }, [data, key, loaded]);
  return useMemo(() => {
    const trees = new Map<string, FlowTree>();
    const changes = new Map<string, FrameChange>();
    const selections = new Map<string, Selection[]>();
    for (const [id, file] of loaded) {
      trees.set(id, file.tree);
      selections.set(id, file.selections);
      if (file.change !== undefined) changes.set(id, file.change);
    }
    return { trees, changes, selections, failed };
  }, [loaded, failed]);
}
