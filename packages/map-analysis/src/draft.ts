/**
 * The draft of a change note: the sections a pull request's note still
 * lacks, for the frames its diff changes (computed from MAP_BASE as the map
 * of the pull request is). Each section is the heading the map matches (the
 * name, and the id in an HTML comment), what the map computed in HTML
 * comments, and an empty place for why.
 *
 * The draft goes into the note the pull request already adds, after its last
 * section, or into a new note named after the branch. A section the author
 * deletes again leaves the change unexplained, and the check of the map says
 * so.
 *
 * With `tests` (packages/test-catalog gives it), a frame the diff of the
 * tests fails on gets its related tests and an empty `テストを変えない理由:`
 * line: in its new section, or in a section of its own after the one it has.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { escapingFailures } from './failures.js';
import { collectChanges, git, type ChangeResult } from './changes.js';
import type { FrameChangeEntry } from './model.js';
import { draftSections, draftTestSections, NOTES_DIRECTORY, type DraftTests } from './notes.js';
import { readRepository, type Repository } from './repository.js';

export interface DraftOptions {
  repository: string;
  base: string;
  /** The note to write to, from the root of the repository; by default the note the diff adds, or one named after the branch. */
  file?: string;
  cliDist?: string;
  /** The frames whose related tests the pull request does not touch and that give no reason, with those tests (see the module comment). */
  tests?: (context: { repository: Repository; changes: ChangeResult }) => Promise<ReadonlyMap<string, DraftTests>> | ReadonlyMap<string, DraftTests>;
}

export interface DraftResult {
  /** The note written, from the root of the repository; undefined when every change has a section already. */
  file?: string;
  /** The frames the draft adds a section for. */
  sections: FrameChangeEntry[];
  /** The frames the draft adds the place of a reason for the tests to. */
  tests: FrameChangeEntry[];
}

/** A file name from a branch name: `claude/apps-map` → `apps-map`. */
export function noteName(branch: string): string {
  const last = branch.split('/').filter((part) => part !== '').pop() ?? 'changes';
  return `${last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'changes'}.md`;
}

/** Write the draft (see the module comment). */
export async function writeDraft(options: DraftOptions): Promise<DraftResult> {
  const repository = await readRepository(options.repository, options.cliDist);
  const trees = new Map([...repository.head.trees].map(([id, built]) => [id, built.tree]));
  const result = collectChanges({ repository, base: options.base, failures: escapingFailures(trees) });
  const { changes } = result;
  const tests = (await options.tests?.({ repository, changes: result })) ?? new Map<string, DraftTests>();
  // Every change of code without a section; the ones the check requires first.
  const sections = changes.frames
    .filter((entry) => (entry.kind === 'added' || entry.kind === 'modified') && (entry.notes ?? []).length === 0)
    .sort((a, b) => Number(b.required) - Number(a.required));
  // The changes with a section that still need a reason for their tests.
  const reasons = changes.frames.filter((entry) => tests.has(entry.id) && (entry.notes ?? []).length > 0 && entry.testReason === undefined);
  if (sections.length === 0 && reasons.length === 0) return { sections, tests: reasons };
  const existing = changes.notes[0]?.file;
  const file = options.file ?? existing ?? join(NOTES_DIRECTORY, noteName(git(options.repository, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()));
  const path = join(options.repository, file);
  const body = [sections.length === 0 ? '' : draftSections(sections, tests), reasons.length === 0 ? '' : draftTestSections(reasons, tests)].filter((part) => part !== '').join('\n');
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, `${text.replace(/\s*$/, '')}\n\n${body}`);
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `# （この PR のタイトル）\n\n<!-- この PR で何をするか、なぜするかを書く -->\n\n${body}`);
  }
  return { file, sections, tests: [...sections.filter((entry) => tests.has(entry.id)), ...reasons] };
}
