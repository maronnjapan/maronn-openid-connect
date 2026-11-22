/**
 * The pure parts of the code page (code/index.html): its URL hash
 * (`#apps/hono/src/oidc-provider/endpoints/token/pipeline.ts:L40-L120`), the
 * tree of the files of the roots, and the quick open (Ctrl/⌘ + P) over the
 * files and the functions. Nothing here touches the DOM.
 */
import type { CodeIndex } from '../types';
import { frameName, type CodeLocation } from '../lib/links';

/** A place the hash names: a file of the repository and, maybe, a line or a range of lines. */
export interface CodeHashPlace {
  path: string;
  line?: number;
  end?: number;
}

/** Read the hash of the code page; undefined when it names no file. */
export function parseCodeHash(hash: string): CodeHashPlace | undefined {
  const raw = hash.replace(/^#/, '');
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    // A malformed escape (`%E0%A4%A`) is read as it is, and names a file the map does not have.
  }
  if (text === '') return undefined;
  const match = /^(.*?)(?::L(\d+)(?:-L(\d+))?)?$/.exec(text);
  const path = match?.[1] ?? text;
  if (path === '') return undefined;
  const line = match?.[2] === undefined ? undefined : Number(match[2]);
  const end = match?.[3] === undefined ? undefined : Number(match[3]);
  return { path, ...(line === undefined ? {} : { line }), ...(end === undefined || line === undefined || end <= line ? {} : { end }) };
}

/** The hash of a place (the path keeps its slashes, so the URL reads as the path). */
export function codeHash(place: CodeHashPlace): string {
  const path = place.path.split('/').map(encodeURIComponent).join('/');
  return place.line === undefined ? path : `${path}:L${place.line}${place.end === undefined ? '' : `-L${place.end}`}`;
}

/** What the page shows for a place: the file, the lines of its frame (if it is one) and the line to show. */
export interface ShownPlace {
  file: string;
  path: string;
  range?: [number, number];
  focus?: { line: number; column?: number; length?: number };
}

/** The file of a place of the code (a frame opens its file at its lines), or undefined when the map has no such file. */
export function shownOf(index: CodeIndex, location: CodeLocation): ShownPlace | undefined {
  const frame = index.frames[location.id];
  const file = frame?.source?.file ?? location.id;
  const source = index.sources[file];
  if (source === undefined) return undefined;
  const range: [number, number] | undefined = frame?.source !== undefined ? [frame.source.start, frame.source.end] : location.line !== undefined && location.end !== undefined ? [location.line, location.end] : undefined;
  const line = location.line ?? range?.[0];
  return {
    file,
    path: source.path,
    ...(range === undefined ? {} : { range }),
    ...(line === undefined ? {} : { focus: { line, ...(location.column === undefined ? {} : { column: location.column }), ...(location.length === undefined ? {} : { length: location.length }) } }),
  };
}

/** The place a hash names, as a place of the code: the file, at the line (a range of lines to mark); undefined when the map has no such file. */
export function locationOfHash(index: CodeIndex, place: CodeHashPlace): CodeLocation | undefined {
  const file = Object.entries(index.sources).find(([, source]) => source.path === place.path)?.[0];
  if (file === undefined) return undefined;
  return { id: file, ...(place.line === undefined ? {} : { line: place.line }), ...(place.line !== undefined && place.end !== undefined ? { end: place.end } : {}) };
}

/** The hash of what the page shows: the file, and the line the reader is at (a name followed), else the lines of the frame. */
export function hashOf(shown: ShownPlace): string {
  const named = shown.focus !== undefined && shown.focus.line !== shown.range?.[0];
  return codeHash({ path: shown.path, ...(named ? { line: shown.focus?.line as number } : shown.range !== undefined ? { line: shown.range[0], end: shown.range[1] } : {}) });
}

/** A directory of the tree of the files: its subdirectories and files, sorted by name. */
export interface FileDirectory {
  /** The path of the directory; a chain of directories with one subdirectory and no file is one entry (`packages/core/src`). */
  path: string;
  name: string;
  directories: FileDirectory[];
  files: Array<{ id: string; name: string; path: string }>;
}

/** The tree of the files of the map, folding a directory that holds only one directory into it (as an editor's explorer does). */
export function fileTree(index: CodeIndex): FileDirectory {
  const root: FileDirectory = { path: '', name: '', directories: [], files: [] };
  for (const [id, source] of Object.entries(index.sources)) {
    const parts = source.path.split('/');
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const path = directory.path === '' ? part : `${directory.path}/${part}`;
      let next = directory.directories.find((candidate) => candidate.path === path);
      if (next === undefined) {
        next = { path, name: part, directories: [], files: [] };
        directory.directories.push(next);
      }
      directory = next;
    }
    directory.files.push({ id, name: parts[parts.length - 1] ?? source.path, path: source.path });
  }
  /** Sort a directory and fold its chains of single subdirectories. */
  const tidy = (directory: FileDirectory): FileDirectory => {
    let current = directory;
    while (current !== root && current.files.length === 0 && current.directories.length === 1) {
      const only = current.directories[0] as FileDirectory;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    return {
      ...current,
      directories: current.directories.map(tidy).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
      files: [...current.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  };
  return tidy(root);
}

/** A result of the quick open: a file, or a function (or endpoint body) to open at its lines. */
export interface CodeResult {
  kind: 'file' | 'frame';
  label: string;
  detail: string;
  location: CodeLocation;
}

/**
 * The files and the functions whose name has the text typed (case aside),
 * best first: a name that is the text, then one that starts with it, then
 * one that has it; files by their name, then by their path.
 */
export function searchCode(index: CodeIndex, query: string, limit = 30): CodeResult[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];
  const scored: Array<{ score: number; result: CodeResult }> = [];
  /** How well a name has the text: 0 the same, 1 at its start, 2 inside it; undefined without it. */
  const rank = (name: string): number | undefined => {
    const lower = name.toLowerCase();
    if (lower === needle) return 0;
    if (lower.startsWith(needle)) return 1;
    return lower.includes(needle) ? 2 : undefined;
  };
  for (const [id, frame] of Object.entries(index.frames)) {
    const score = rank(frame.name);
    if (score === undefined || frame.source === undefined) continue;
    scored.push({ score, result: { kind: 'frame', label: frameName(frame), detail: `${index.sources[frame.source.file]?.path ?? frame.source.file}:${frame.source.start}`, location: { id } } });
  }
  for (const [id, source] of Object.entries(index.sources)) {
    const name = source.path.slice(source.path.lastIndexOf('/') + 1);
    const byName = rank(name);
    const score = byName ?? (source.path.toLowerCase().includes(needle) ? 3 : undefined);
    if (score === undefined) continue;
    scored.push({ score: score + 0.5, result: { kind: 'file', label: name, detail: source.path, location: { id } } });
  }
  scored.sort((a, b) => a.score - b.score || a.result.label.length - b.result.label.length || (a.result.detail < b.result.detail ? -1 : 1));
  return scored.slice(0, limit).map((entry) => entry.result);
}
