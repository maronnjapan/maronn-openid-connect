/** The known callees of some code, and the path kept while reading their definitions. */
import type { OutlineFunction } from '@maronn-openid-connect/test-catalog/model';
import type { Db } from './data';

/** The functions an item calls, once each in the order of the code; older outlines have no calls. */
export function calledFunctions(db: Db, ids: readonly string[] = []): OutlineFunction[] {
  return [...new Set(ids)].flatMap((id) => {
    const fn = db.functions[id];
    return fn === undefined ? [] : [fn];
  });
}

/** Follow a call, or return to its earlier occurrence when the calls form a cycle. */
export function followCall(path: readonly string[], id: string, root?: string): string[] {
  if (id === root) return [];
  const previous = path.indexOf(id);
  return previous === -1 ? [...path, id] : path.slice(0, previous + 1);
}
