/**
 * Following the code as in an editor: the names of a source with a link
 * (SourceDocument.links, written by packages/map-analysis symbols.ts), where
 * a link goes (a function of the catalog opens as that function, any other
 * declaration as its file at its line), the places that use a declaration,
 * and the back / forward history of the places the reader went to. Nothing
 * here touches the DOM.
 */
import type { CodeIndex, LinkKind, LinkTarget, SourceDocument } from '../types';

export { codeIndexOf } from '@maronn-openid-connect/map-analysis/code-index';

/** A name of a line with a link: its column (0-based), its length and the index of its target. */
export interface LineLink {
  column: number;
  length: number;
  target: number;
}

/** The names with a link of each line (1-based), in the order of their columns. */
export function linksByLine(links: SourceDocument['links']): Map<number, LineLink[]> {
  const lines = new Map<number, LineLink[]>();
  const refs = links?.refs ?? [];
  for (let index = 0; index + 3 < refs.length; index += 4) {
    const line = refs[index] as number;
    const list = lines.get(line) ?? [];
    list.push({ column: refs[index + 1] as number, length: refs[index + 2] as number, target: refs[index + 3] as number });
    lines.set(line, list);
  }
  for (const list of lines.values()) list.sort((a, b) => a.column - b.column);
  return lines;
}

/** A piece of a line with its color. */
export interface Piece {
  content: string;
  color?: string;
}

/** A run of pieces of a line: a name with a link (its target), or code without one. */
export interface Segment {
  link?: LineLink;
  pieces: Piece[];
}

/**
 * Cut the colored tokens of a line where its names with a link start and
 * end, so each name is one segment however the highlighter split it (a
 * module specifier is three tokens: the quotes and the text). A link that
 * does not fit the line (a file changed after the build) is left out.
 */
export function segmentsOf(tokens: readonly Piece[], links: readonly LineLink[] = []): Segment[] {
  const length = tokens.reduce((sum, token) => sum + token.content.length, 0);
  const fitting: LineLink[] = [];
  for (const link of links) {
    const previous = fitting[fitting.length - 1];
    if (link.length > 0 && link.column + link.length <= length && (previous === undefined || link.column >= previous.column + previous.length)) fitting.push(link);
  }
  const cuts = fitting.flatMap((link) => [link.column, link.column + link.length]);
  const segments: Segment[] = [];
  let at = 0;
  for (const token of tokens) {
    let start = 0;
    while (start < token.content.length) {
      // The piece runs to the end of the token or to the next place a name starts or ends.
      let end = token.content.length;
      for (const cut of cuts) if (cut > at + start && cut < at + end) end = cut - at;
      const column = at + start;
      const link = fitting.find((candidate) => column >= candidate.column && column < candidate.column + candidate.length);
      const piece: Piece = { content: token.content.slice(start, end), ...(token.color === undefined ? {} : { color: token.color }) };
      const last = segments[segments.length - 1];
      if (last !== undefined && last.link === link) last.pieces.push(piece);
      else segments.push(link === undefined ? { pieces: [piece] } : { link, pieces: [piece] });
      start = end;
    }
    at += token.content.length;
  }
  return segments;
}

/** A place in the code the reader is at: a frame (a function or an endpoint body) or a file, and a name in it. */
export interface CodeLocation {
  /** A frame id (`core:a.ts#f`, `endpoint:token`) or a source file id (`core:a.ts`). */
  id: string;
  /** The line (1-based) and column (0-based) of the name to show, and its length. */
  line?: number;
  column?: number;
  length?: number;
  /** For a frame, the whole file of it instead of its lines. */
  whole?: boolean;
  /** The last line of a range of lines to mark from `line` (a link to some lines of a file). */
  end?: number;
}

/** The name of a frame as the page writes it: `name()` for a function, the route for an endpoint body. */
export function frameName(frame: CodeIndex['frames'][string]): string {
  return frame.kind === 'function' ? `${frame.name}()` : frame.name;
}

/** Where a link goes: a function of the catalog opens as that function, anything else as its file. */
export function locationOf(index: CodeIndex, target: LinkTarget): CodeLocation {
  const id = target.function !== undefined && index.frames[target.function] !== undefined ? target.function : target.file;
  return { id, line: target.line, column: target.column, length: target.kind === 'module' ? 0 : target.name.length };
}

/** The places the reader went to, and where among them the reader is. */
export interface CodeHistory {
  entries: CodeLocation[];
  index: number;
}

/** A history that starts at a place. */
export function startAt(location: CodeLocation): CodeHistory {
  return { entries: [location], index: 0 };
}

/** The place the reader is at. */
export function currentOf(history: CodeHistory): CodeLocation {
  return history.entries[history.index] as CodeLocation;
}

/** Go to a place: the places ahead are dropped, as in a browser. */
export function visit(history: CodeHistory, location: CodeLocation): CodeHistory {
  const current = currentOf(history);
  if (current.id === location.id && current.line === location.line && current.column === location.column && current.whole === location.whole && current.end === location.end) return history;
  const entries = [...history.entries.slice(0, history.index + 1), location];
  return { entries, index: entries.length - 1 };
}

/** Change the place the reader is at without a new step (the whole file of a frame, or its lines again). */
export function replace(history: CodeHistory, location: CodeLocation): CodeHistory {
  const entries = [...history.entries];
  entries[history.index] = location;
  return { entries, index: history.index };
}

/** A step back or forward, when there is one. */
export function step(history: CodeHistory, by: -1 | 1): CodeHistory {
  const index = history.index + by;
  return index < 0 || index >= history.entries.length ? history : { entries: history.entries, index };
}

/** A frame of the map whose lines hold a line of a file: the innermost one, so a use is named by the function it is in. */
export function frameAt(index: CodeIndex, file: string, line: number): { id: string; name: string } | undefined {
  let best: { id: string; name: string; size: number } | undefined;
  for (const [id, frame] of Object.entries(index.frames)) {
    const source = frame.source;
    if (source === undefined || source.file !== file || line < source.start || line > source.end) continue;
    const size = source.end - source.start;
    if (best === undefined || size < best.size) best = { id, name: frameName(frame), size };
  }
  return best === undefined ? undefined : { id: best.id, name: best.name };
}

/** A place that uses a declaration, named for the reader. */
export interface UsePlace {
  location: CodeLocation;
  /** The function (or endpoint body) it is in, else the file's name (an import, a module's top level). */
  label: string;
  path: string;
  line: number;
}

/** The places that use the declaration whose name is at a line and column of a file, in the order of the files and lines. */
export function usesOf(index: CodeIndex, document: SourceDocument | undefined, line: number, column: number): UsePlace[] {
  const uses = document?.uses?.[`${line}:${column}`] ?? [];
  return uses
    .map(([file, at, from]) => {
      const frame = frameAt(index, file, at);
      const path = index.sources[file]?.path ?? file;
      return { location: { id: frame?.id ?? file, line: at, column: from }, label: frame?.name ?? `${path.slice(path.lastIndexOf('/') + 1)}（関数の外）`, path, line: at };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}

/** What a kind of declaration is called on the page. */
export const LINK_KIND_WORDS: Record<LinkKind, string> = {
  function: '関数',
  method: 'メソッド',
  property: 'プロパティ',
  interface: 'インターフェース',
  type: '型',
  class: 'クラス',
  enum: '列挙',
  'enum-member': '列挙の値',
  variable: '変数',
  parameter: '引数',
  'type-parameter': '型引数',
  module: 'モジュール',
  other: '宣言',
};

/** A list the reader asked for beside the code: the places that use a declaration, or the implementations of a member. */
export interface Peek {
  title: string;
  items: Array<{ label: string; where: string; location: CodeLocation }>;
  /** What to say when the list is empty. */
  empty: string;
}

/** The implementations of the member of an interface a link goes to, as places of the code; undefined for any other link. */
export function implementationsOf(index: CodeIndex, target: LinkTarget): Peek | undefined {
  const member = target.member === undefined ? undefined : index.members[target.member];
  if (member === undefined) return undefined;
  return {
    title: `${member.type}.${member.member} の実装`,
    empty: '地図の中に実装はありません。',
    items: (member.implementedBy ?? []).map((id) => {
      const frame = index.frames[id];
      const source = frame?.source;
      return { label: frame === undefined ? id : frameName(frame), where: source === undefined ? id : `${index.sources[source.file]?.path ?? source.file}:${source.start}`, location: { id } };
    }),
  };
}

/**
 * The list to show when the reader follows a declaration's own name: the
 * implementations of a member that has some, else the places that use it.
 */
export function peekOf(index: CodeIndex, document: SourceDocument | undefined, target: LinkTarget, at: { line: number; column: number }): Peek {
  const implementations = implementationsOf(index, target);
  if (implementations !== undefined && implementations.items.length > 0) return implementations;
  const uses = usesOf(index, document, at.line, at.column);
  return { title: `${LINK_KIND_WORDS[target.kind]} ${target.name} を使う場所（${uses.length}）`, empty: '地図の根の中で、ほかに使う場所はありません。', items: uses.map((use) => ({ label: use.label, where: `${use.path}:${use.line}`, location: use.location })) };
}
