/**
 * The change notes of a pull request (apps/map/changes/*.md, see the README
 * there): what its author says about why the frames it changed changed.
 *
 * A note is plain Markdown: a `#` title, the text before the first `##`
 * heading about the whole pull request, and a section a `##` heading, which
 * names the functions (or endpoints) it is about. A heading names them by
 * name (`## verifyClientSecret`), narrowed by the root when a name is not
 * enough (`## core:verifyClientSecret`), or by id in an HTML comment at its
 * end (`## verifyClientSecret <!-- core:client-auth.ts#verifyClientSecret -->`),
 * which is what the draft writes (`## token <!-- endpoint:token -->` for the
 * handler of an endpoint).
 *
 * What changed and where it takes effect the map computes; a note says why.
 * So a section counts as an explanation when it has any text besides HTML
 * comments, and nothing else about its text is checked.
 */
import type { ChangeNoteText, FrameChangeEntry } from './model.js';

/** Where the change notes are, from the root of the repository. */
export const NOTES_DIRECTORY = 'apps/map/changes';

/** Whether a path of the repository is a change note: a Markdown file under NOTES_DIRECTORY other than its README. */
export function isNote(path: string): boolean {
  return path.startsWith(`${NOTES_DIRECTORY}/`) && path.endsWith('.md') && !/(^|\/)readme\.md$/i.test(path);
}

export interface NoteSection {
  heading: string;
  /** What the heading names: ids from its HTML comment, else the names of its text. */
  references: string[];
  /** Whether the references are ids (from the HTML comment): they name one frame each. */
  byId: boolean;
  /** The text of the section, its HTML comments left out. */
  text: string;
}

export interface ParsedNote {
  title?: string;
  summary: string;
  sections: NoteSection[];
}

/** Lines joined, without the blank lines at the start and the end. */
function trimLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && (lines[start] as string).trim() === '') start += 1;
  while (end > start && (lines[end - 1] as string).trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/** A text without its HTML comments (the draft's automatic summary and reach). */
export function withoutComments(text: string): string {
  return trimLines(text.replace(/<!--[\s\S]*?-->/g, '').split('\n'));
}

/**
 * The names a heading names: separated by commas, each a name
 * (`verifyClientSecret`), a name in its root (`core:verifyClientSecret`) or
 * an id; backticks, the `()` after a name and the words after it are left out.
 */
export function referencesOf(heading: string): string[] {
  return heading
    .split(/[,、，]/)
    .map((part) => /^[^\s()（）]+/.exec(part.replace(/`/g, '').trim())?.[0] ?? '')
    .filter((part) => part !== '');
}

/** Read a note (see the module comment); a heading inside a fenced code block is text. */
export function parseNote(text: string): ParsedNote {
  const note: ParsedNote = { summary: '', sections: [] };
  const summary: string[] = [];
  const sections: Array<{ heading: string; lines: string[] }> = [];
  let section: { heading: string; lines: string[] } | undefined;
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = { heading: heading[1] as string, lines: [] };
      sections.push(section);
      continue;
    }
    if (section !== undefined) {
      section.lines.push(line);
      continue;
    }
    const title = fenced ? null : /^#\s+(.*?)\s*#*\s*$/.exec(line);
    if (title && note.title === undefined && summary.every((before) => before.trim() === '')) {
      note.title = title[1] as string;
      continue;
    }
    summary.push(line);
  }
  note.summary = withoutComments(summary.join('\n'));
  note.sections = sections.map(({ heading, lines }) => {
    const ids = [...heading.matchAll(/<!--\s*([^>]*?)\s*-->/g)].flatMap((match) => (match[1] as string).split(/[\s,]+/)).filter((id) => /[:#]/.test(id));
    const visible = heading.replace(/<!--[\s\S]*?-->/g, '').trim();
    return { heading: visible, references: ids.length > 0 ? ids : referencesOf(visible), byId: ids.length > 0, text: withoutComments(lines.join('\n')) };
  });
  return note;
}

/** What a reference can name: a changed frame, or a function of the catalog (a note that explains a function it did not change). */
export interface Named {
  id: string;
  name: string;
  package: string;
  module: string;
}

/**
 * The entries a reference names: the one with that id; else those with that
 * name, narrowed to a root by `root:` and to a module by `module#` (the whole
 * module, or its end after a `/`).
 */
export function resolveReference<T extends Named>(reference: string, entries: readonly T[]): T[] {
  const exact = entries.filter((entry) => entry.id === reference);
  if (exact.length > 0) return exact;
  const hash = reference.lastIndexOf('#');
  const qualifier = hash === -1 ? reference : reference.slice(0, hash);
  const name = hash === -1 ? reference : reference.slice(hash + 1);
  const colon = qualifier.indexOf(':');
  const root = colon === -1 ? undefined : qualifier.slice(0, colon);
  const bareName = hash === -1 ? (colon === -1 ? name : name.slice(colon + 1)) : name;
  const module = hash === -1 ? undefined : colon === -1 ? qualifier : qualifier.slice(colon + 1);
  return entries.filter(
    (entry) =>
      entry.name === bareName &&
      (root === undefined || entry.package === root) &&
      (module === undefined || entry.module === module || entry.module.endsWith(`/${module}`)),
  );
}

export interface AttachResult {
  /** The sections none of whose references name anything: text about the whole pull request (背景, for one). */
  unmatched: Array<{ file: string; heading: string; text: string }>;
  /** The references that look like the name of a function and named nothing. */
  unknown: Array<{ file: string; reference: string }>;
  /** The bare names that named more than one changed frame. */
  ambiguous: Array<{ file: string; reference: string; matches: string[] }>;
}

/**
 * Give each changed frame the sections that name it. A reference names the
 * changed frames it matches; matching none, the functions of the catalog it
 * matches, which join the changes as `noted` (`noted` makes the entry).
 */
export function attachNotes(
  frames: FrameChangeEntry[],
  notes: ReadonlyArray<ParsedNote & { file: string }>,
  catalog: readonly Named[],
  noted: (named: Named) => FrameChangeEntry,
): AttachResult {
  const result: AttachResult = { unmatched: [], unknown: [], ambiguous: [] };
  for (const note of notes) {
    for (const section of note.sections) {
      let matched = false;
      for (const reference of section.references) {
        let targets = resolveReference(reference, frames);
        if (targets.length > 1 && !section.byId && !reference.includes('#')) result.ambiguous.push({ file: note.file, reference, matches: targets.map((target) => target.id) });
        if (targets.length === 0) {
          targets = resolveReference(reference, catalog).map((named) => {
            const entry = noted(named);
            frames.push(entry);
            return entry;
          });
        }
        if (targets.length === 0) {
          if (/^[A-Za-z_$]/.test(reference)) result.unknown.push({ file: note.file, reference });
          continue;
        }
        matched = true;
        for (const target of targets) {
          const text: ChangeNoteText = { file: note.file, heading: section.heading, text: section.text };
          target.notes ??= [];
          if (!target.notes.some((existing) => existing.file === text.file && existing.text === text.text)) target.notes.push(text);
        }
      }
      if (!matched) result.unmatched.push({ file: note.file, heading: section.heading, text: section.text });
    }
  }
  for (const frame of frames) {
    const words = (frame.notes ?? []).map((note) => note.text).filter((text) => text.trim() !== '');
    frame.documented = words.length > 0;
    const line = words[0]?.trim().split('\n')[0]?.trim();
    if (line !== undefined && line !== '') frame.noteLine = line;
    else delete frame.noteLine;
  }
  return result;
}

/** The heading of a frame in a draft: its name, and its id in an HTML comment. */
export function draftHeading(frame: Pick<FrameChangeEntry, 'id' | 'name'>): string {
  return `## ${frame.name} <!-- ${frame.id} -->`;
}

/**
 * The sections of a draft of a note for the frames that need one: each a
 * heading with the frame's id, what the map computed (the summary of the
 * diff and the endpoints it reaches) in HTML comments, and an empty line for
 * the author to say why.
 */
export function draftSections(frames: ReadonlyArray<Pick<FrameChangeEntry, 'id' | 'name' | 'summary' | 'reach'>>): string {
  const sections = frames.map((frame) => {
    const summary = frame.summary.length === 0 ? '変更あり' : frame.summary.slice(0, 6).join(' / ');
    const endpoints = [...new Set(frame.reach.map((way) => `${way.source}:${way.endpoint}`))];
    return [
      draftHeading(frame),
      '',
      `<!-- 自動要約: ${summary.replace(/-->/g, '- ->')} -->`,
      `<!-- 届く先: ${endpoints.length === 0 ? 'なし' : endpoints.join(', ')} -->`,
      '<!-- なぜ変えたか、何に気をつけるかを書く（何を変えたかとどこに効くかは地図が出す） -->',
      '',
    ].join('\n');
  });
  return sections.join('\n');
}
