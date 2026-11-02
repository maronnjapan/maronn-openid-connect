/**
 * The changes of a pull request, for its map: which functions of the function
 * catalog it adds, rewrites, moves, documents or removes, the lines it
 * changes in each, and what its author wrote about them in a change note
 * (apps/map/changes/*.md, see the README there).
 *
 * The map is built from the working tree, so the changes are those of the
 * working tree since the commit it forked from the base (`git merge-base
 * <base> HEAD`): a pull request shows what it changes, not what its base
 * branch did since. In CI the working tree is the merge commit of the pull
 * request, so the changes are what merging it changes.
 *
 * A changed file is compared function by function, with the declarations the
 * catalog reads (packages/cli/src/extract/functions.ts): a function whose
 * lines did not change is not changed, even when the lines around it moved.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

/** Where the change notes are, from the root of the repository. */
export const NOTES_DIRECTORY = 'apps/map/changes';

/** The order the kinds of a change are listed in. */
export const KIND_ORDER = ['added', 'modified', 'moved', 'docs', 'removed', 'noted'];

/** The kinds in words, as the badges of the map say them. */
export const KIND_WORDS = {
  added: '追加',
  modified: '変更',
  moved: '移動',
  docs: 'JSDoc だけ変更',
  removed: '削除',
  noted: 'メモだけ',
};

/** The lines of context a hunk keeps around the lines it changes. */
const CONTEXT = 3;

/** Beyond this many cells, the lines between the common start and end of two texts are taken as all removed and all added. */
const MAX_DIFF_CELLS = 4_000_000;

/** Code-unit order, the same on every platform and locale. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Run git in the repository and return what it printed; throws with its error output when it fails. */
function git(repositoryRoot, args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${result.status ?? result.signal}): ${result.stderr}`);
  return result.stdout;
}

/**
 * The roots of the function catalog as directories of the repository, from
 * extract.json: a library takes every file of its directory, a source the
 * entries of its directory its `include` names. The directories of
 * extract.json are relative to the CLI package, `packageDirectory`
 * (packages/cli).
 */
export function catalogRoots(definition, packageDirectory) {
  const roots = [];
  for (const [name, library] of Object.entries(definition.libraries ?? {})) {
    roots.push({ name, directory: posix.join(packageDirectory, library.directory), exclude: library.exclude.map((pattern) => new RegExp(pattern)) });
  }
  for (const [name, source] of Object.entries(definition.sources ?? {})) {
    roots.push({
      name,
      directory: posix.join(packageDirectory, source.directory),
      include: source.include,
      exclude: source.exclude.map((pattern) => new RegExp(pattern)),
    });
  }
  return roots;
}

/** The root and the module (the path under the root, as in the id of a card) of a path of the repository; undefined for a file the catalog does not read. */
export function moduleOf(roots, path) {
  if (!/\.tsx?$/.test(path)) return undefined;
  for (const root of roots) {
    if (!path.startsWith(`${root.directory}/`)) continue;
    const module = path.slice(root.directory.length + 1);
    if (root.include !== undefined && !root.include.some((entry) => module === entry || module.startsWith(`${entry}/`))) continue;
    if (root.exclude.some((pattern) => pattern.test(module))) continue;
    return { root: root.name, module };
  }
  return undefined;
}

/** Whether a path of the repository is a change note: a Markdown file under NOTES_DIRECTORY other than its README. */
export function isNote(path) {
  return path.startsWith(`${NOTES_DIRECTORY}/`) && path.endsWith('.md') && !/(^|\/)readme\.md$/i.test(path);
}

/**
 * The files `git diff --name-status -z --find-renames` lists, each with its
 * path before and after: no `before` for an added file, no `after` for a
 * deleted one, both for a renamed one. A copy counts as an added file.
 */
export function parseNameStatus(output) {
  const fields = output.split('\0');
  const files = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? '';
    if (status === '') {
      index += 1;
      continue;
    }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const [before, after] = [fields[index + 1], fields[index + 2]];
      files.push(letter === 'R' ? { status: letter, before, after } : { status: 'A', after });
      index += 3;
      continue;
    }
    const path = fields[index + 1];
    if (letter === 'A') files.push({ status: letter, after: path });
    else if (letter === 'D') files.push({ status: letter, before: path });
    else files.push({ status: letter, before: path, after: path });
    index += 2;
  }
  return files;
}

/**
 * The functions the catalog reads from one file, by name: the id, the line
 * and the summary of the card, the line its text starts at (its JSDoc, else
 * its declaration), and the lines of the JSDoc (empty without one) and of the
 * declaration with its body. `analyze` is analyzeFunctions of the CLI.
 */
export function functionsOfFile(analyze, root, module, text) {
  const project = analyze([{ name: root, files: new Map([[module, text]]) }]);
  const lines = text.split('\n');
  const functions = new Map();
  for (const card of Object.values(project.catalog.functions)) {
    const span = project.spanOf(card.id);
    if (span === undefined) continue;
    const from = span.doc ?? span.start;
    functions.set(card.name, {
      id: card.id,
      name: card.name,
      line: card.line,
      summary: card.summary,
      from,
      doc: lines.slice(from - 1, span.start - 1),
      code: lines.slice(span.start - 1, span.end),
    });
  }
  return functions;
}

/**
 * The lines of two texts matched up, as the operations that turn the first
 * into the second: ` ` keeps a line (`a` and `b` its indexes in each), `-`
 * removes line `a` of the first, `+` adds line `b` of the second. The longest
 * common subsequence of the lines between their common start and end.
 */
export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const ops = [];
  for (let index = 0; index < start; index += 1) ops.push({ op: ' ', a: index, b: index });
  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_DIFF_CELLS) {
    for (let i = start; i < endA; i += 1) ops.push({ op: '-', a: i });
    for (let j = start; j < endB; j += 1) ops.push({ op: '+', b: j });
  } else {
    // common[i * width + j]: the length of the longest common subsequence of a[start + i..endA) and b[start + j..endB).
    const width = m + 1;
    const common = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        common[i * width + j] =
          a[start + i] === b[start + j]
            ? (common[(i + 1) * width + j + 1] ?? 0) + 1
            : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) {
        ops.push({ op: ' ', a: start + i, b: start + j });
        i += 1;
        j += 1;
      } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) {
        ops.push({ op: '-', a: start + i });
        i += 1;
      } else {
        ops.push({ op: '+', b: start + j });
        j += 1;
      }
    }
    for (; i < n; i += 1) ops.push({ op: '-', a: start + i });
    for (; j < m; j += 1) ops.push({ op: '+', b: start + j });
  }
  for (let offset = 0; offset < a.length - endA; offset += 1) ops.push({ op: ' ', a: endA + offset, b: endB + offset });
  return ops;
}

/**
 * The operations of diffLines in hunks, each with up to `context` kept lines
 * around its changes, written as the lines of a unified diff (` `, `-` or `+`
 * and the text) from a line of the base (`base`) and of the head (`head`);
 * and the lines of the head the diff adds. `baseLine` and `headLine` are the
 * lines the two texts start at.
 */
export function hunksOf(ops, a, b, baseLine, headLine, context = CONTEXT) {
  const added = [];
  const ranges = [];
  ops.forEach((op, index) => {
    if (op.op === ' ') return;
    if (op.op === '+') added.push(headLine + op.b);
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  });
  const hunks = ranges.map(({ from, to }) => {
    let base = baseLine;
    let head = headLine;
    for (const op of ops.slice(0, from)) {
      if (op.op !== '+') base += 1;
      if (op.op !== '-') head += 1;
    }
    return { base, head, lines: ops.slice(from, to + 1).map((op) => `${op.op}${op.op === '+' ? b[op.b] : a[op.a]}`) };
  });
  return { hunks, added };
}

/** The entry of a function in the changes. */
function entryOf(root, module, fn, kind) {
  return { id: fn.id, name: fn.name, package: root, module, line: fn.line, kind };
}

/** Whether two lists of lines are the same. */
function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * The change of a function found before and after (in the same file, a
 * renamed one, or another file it moved to): modified when its code changed,
 * else moved when its file changed, else docs when only its JSDoc changed;
 * undefined when nothing changed. A change of the text carries its hunks and
 * the lines of the head it adds.
 */
function changeOf(root, before, after) {
  const code = !sameLines(before.fn.code, after.fn.code);
  const doc = !sameLines(before.fn.doc, after.fn.doc);
  const moved = before.module !== after.module;
  if (!code && !doc && !moved) return undefined;
  const change = entryOf(root, after.module, after.fn, code ? 'modified' : moved ? 'moved' : 'docs');
  if (moved) change.from = before.module;
  if (code || doc) {
    const a = [...before.fn.doc, ...before.fn.code];
    const b = [...after.fn.doc, ...after.fn.code];
    const { hunks, added } = hunksOf(diffLines(a, b), a, b, before.fn.from, after.fn.from);
    change.changedLines = added;
    change.hunks = hunks;
  }
  return change;
}

/**
 * The functions a set of changed files adds, changes or removes, sorted by
 * id. Each pair is one file before and after (`before` absent for an added
 * file, `after` for a deleted one; the modules differ for a renamed one),
 * with the functions of each side (functionsOfFile). A function is matched
 * by its name within its file; one that leaves a file and arrives in another
 * file of the same root under the same name, the only one of that name to do
 * so, moved there.
 */
export function compareFiles(pairs) {
  const changes = [];
  const added = [];
  const removed = [];
  for (const { root, before, after } of pairs) {
    for (const fn of after?.functions.values() ?? []) {
      const old = before?.functions.get(fn.name);
      if (old === undefined) {
        added.push({ root, module: after.module, fn });
        continue;
      }
      const change = changeOf(root, { module: before.module, fn: old }, { module: after.module, fn });
      if (change !== undefined) changes.push(change);
    }
    for (const fn of before?.functions.values() ?? []) {
      if (after?.functions.has(fn.name) !== true) removed.push({ root, module: before.module, fn });
    }
  }
  const keyOf = (item) => `${item.root}:${item.fn.name}`;
  const count = (list, key) => list.filter((item) => keyOf(item) === key).length;
  const moved = new Set();
  for (const item of added) {
    const key = keyOf(item);
    const from = count(added, key) === 1 && count(removed, key) === 1 ? removed.find((candidate) => keyOf(candidate) === key) : undefined;
    if (from === undefined) {
      changes.push(entryOf(item.root, item.module, item.fn, 'added'));
      continue;
    }
    moved.add(from);
    changes.push(changeOf(item.root, from, item));
  }
  for (const item of removed) {
    if (!moved.has(item)) changes.push({ ...entryOf(item.root, item.module, item.fn, 'removed'), summary: item.fn.summary });
  }
  return changes.sort((a, b) => compare(a.id, b.id));
}

/** Lines joined, without the blank lines at the start and the end. */
function trimLines(lines) {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end).join('\n');
}

/**
 * The functions a heading of a change note names: separated by commas, each
 * a name (`verifyClientSecret`), a name in its root (`core:verifyClientSecret`)
 * or an id (`core:client-auth.ts#verifyClientSecret`); backticks, the `()`
 * after a name and the words after it are left out.
 */
export function referencesOf(heading) {
  return heading
    .split(/[,、，]/)
    .map((part) => /^[^\s()（）]+/.exec(part.replace(/`/g, '').trim())?.[0] ?? '')
    .filter((part) => part !== '');
}

/**
 * A change note (see changes/README.md): its title (a `#` heading before
 * anything else, optional), the text before its first `##` heading, which
 * says what the pull request does, and a section per `##` heading, which
 * names functions (referencesOf) and says how they changed. A heading inside
 * a fenced code block is text.
 */
export function parseNote(text) {
  const note = {};
  const summary = [];
  const sections = [];
  let section;
  let fenced = false;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const heading = fenced ? null : /^##\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = { heading: heading[1], lines: [] };
      sections.push(section);
      continue;
    }
    if (section !== undefined) {
      section.lines.push(line);
      continue;
    }
    const title = fenced ? null : /^#\s+(.*?)\s*#*\s*$/.exec(line);
    if (title && note.title === undefined && summary.every((before) => before.trim() === '')) {
      note.title = title[1];
      continue;
    }
    summary.push(line);
  }
  note.summary = trimLines(summary);
  note.sections = sections.map(({ heading, lines }) => ({ heading, references: referencesOf(heading), text: trimLines(lines) }));
  return note;
}

/**
 * The cards a reference of a note names (see referencesOf): the one with that
 * id, else those with that name, narrowed to a root by `root:`, and to a
 * module by `module#` (the whole module, or its end after a `/`).
 */
export function resolveReference(reference, cards) {
  const hash = reference.lastIndexOf('#');
  const qualifier = hash === -1 ? reference : reference.slice(0, hash);
  const name = hash === -1 ? reference : reference.slice(hash + 1);
  if (hash !== -1) {
    const exact = cards.filter((card) => card.id === reference);
    if (exact.length > 0) return exact;
  }
  const colon = qualifier.indexOf(':');
  const root = colon === -1 ? undefined : qualifier.slice(0, colon);
  const bareName = hash === -1 ? (colon === -1 ? name : name.slice(colon + 1)) : name;
  const module = hash === -1 ? undefined : colon === -1 ? qualifier : qualifier.slice(colon + 1);
  return cards.filter(
    (card) =>
      card.name === bareName &&
      (root === undefined || card.package === root) &&
      (module === undefined || card.module === module || card.module.endsWith(`/${module}`)),
  );
}

/**
 * Give each changed function the sections of the notes that name it. A
 * reference names the functions the pull request changed that it matches;
 * matching none, the functions of the catalog it matches, which join the
 * changes as `noted` (a note explains them, their code did not change).
 * Returns the sections none of whose references match a function (a section
 * of the text, such as 背景), and the references that look like the name of
 * a function (they start with a letter of a name) and matched nothing.
 */
export function attachNotes(functions, notes, cards) {
  const unmatched = [];
  const unknown = [];
  for (const note of notes) {
    for (const section of note.sections) {
      let matched = false;
      for (const reference of section.references) {
        let targets = resolveReference(reference, functions);
        if (targets.length === 0) {
          targets = resolveReference(reference, cards).map((card) => {
            const entry = { id: card.id, name: card.name, package: card.package, module: card.module, line: card.line, kind: 'noted' };
            functions.push(entry);
            return entry;
          });
        }
        if (targets.length === 0) {
          if (/^[A-Za-z_$]/.test(reference)) unknown.push({ file: note.file, reference });
          continue;
        }
        matched = true;
        for (const target of targets) {
          target.notes ??= [];
          if (!target.notes.some((existing) => existing.file === note.file && existing.text === section.text)) target.notes.push({ file: note.file, text: section.text });
        }
      }
      if (!matched) unmatched.push({ file: note.file, heading: section.heading, text: section.text });
    }
  }
  functions.sort((a, b) => compare(a.id, b.id));
  return { unmatched, unknown };
}

/**
 * The changes of the working tree since it forked from `base` (see the
 * module comment), with the change notes the diff adds or edits attached.
 *
 * @param {object} options
 * @param {string} options.repositoryRoot the root of the git repository
 * @param {string} options.base a revision git knows (origin/main, a commit)
 * @param {Array} options.roots the roots of the catalog (catalogRoots)
 * @param {Function} options.analyze analyzeFunctions of the CLI
 * @param {Array} options.cards the cards of the catalog of the working tree, for the notes that name a function the diff does not change
 * @param {object} [options.pullRequest] the number, title and URL of the pull request the map is built for
 */
export function collectChanges({ repositoryRoot, base, roots, analyze, cards, pullRequest }) {
  const run = (args) => git(repositoryRoot, args);
  const forkPoint = run(['merge-base', base, 'HEAD']).trim();
  const head = run(['rev-parse', 'HEAD']).trim();
  const files = [
    ...parseNameStatus(run(['diff', '--name-status', '-z', '--find-renames', '--no-color', '--no-ext-diff', forkPoint])),
    ...run(['ls-files', '--others', '--exclude-standard', '-z'])
      .split('\0')
      .filter((path) => path !== '')
      .map((path) => ({ status: 'A', after: path })),
  ];
  const pairs = [];
  const notes = [];
  let otherFiles = 0;
  for (const file of files) {
    if (file.after !== undefined && isNote(file.after)) {
      notes.push({ file: file.after, ...parseNote(readFileSync(join(repositoryRoot, file.after), 'utf8')) });
      continue;
    }
    const before = file.before === undefined ? undefined : moduleOf(roots, file.before);
    const after = file.after === undefined ? undefined : moduleOf(roots, file.after);
    if (before === undefined && after === undefined) {
      if (file.before === undefined || !isNote(file.before)) otherFiles += 1;
      continue;
    }
    const sides = {
      before: before && { module: before.module, functions: functionsOfFile(analyze, before.root, before.module, run(['show', `${forkPoint}:${file.before}`])) },
      after: after && { module: after.module, functions: functionsOfFile(analyze, after.root, after.module, readFileSync(join(repositoryRoot, file.after), 'utf8')) },
    };
    if (before !== undefined && after !== undefined && before.root !== after.root) {
      pairs.push({ root: before.root, before: sides.before }, { root: after.root, after: sides.after });
    } else {
      pairs.push({ root: (after ?? before).root, ...sides });
    }
  }
  const functions = compareFiles(pairs);
  notes.sort((a, b) => compare(a.file, b.file));
  const { unmatched, unknown } = attachNotes(functions, notes, cards);
  const changes = {
    base: { ref: base, commit: forkPoint },
    head: { commit: head, dirty: run(['status', '--porcelain']).trim() !== '' },
    notes: notes.map(({ file, title, summary }) => (title === undefined ? { file, summary } : { file, title, summary })),
    functions,
    unmatched,
    otherFiles,
  };
  if (pullRequest !== undefined) changes.pullRequest = pullRequest;
  return { changes, unknown };
}

/** The pull request the map is built for, from MAP_PR, MAP_PR_TITLE and MAP_PR_URL; undefined without a number. */
export function pullRequestOf(env) {
  const number = Number(env.MAP_PR);
  if (!Number.isInteger(number) || number <= 0) return undefined;
  const pullRequest = { number };
  if (env.MAP_PR_TITLE) pullRequest.title = env.MAP_PR_TITLE;
  if (env.MAP_PR_URL) pullRequest.url = env.MAP_PR_URL;
  return pullRequest;
}

/** The first paragraph of a text on one line, cut to `limit` characters. */
function firstParagraph(text, limit) {
  const paragraph = (text.split(/\n\s*\n/)[0] ?? '').replace(/\s*\n\s*/g, ' ').trim();
  return [...paragraph].length <= limit ? paragraph : `${[...paragraph].slice(0, limit - 1).join('')}…`;
}

/** A text for a cell of a Markdown table: no line breaks, no `|` that ends the cell. */
function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');
}

/**
 * The changes in Markdown, for the comment on the pull request and the
 * summary of the run: the counts by kind, what the notes say the pull request
 * does, and the first `limit` functions with the first paragraph of what the
 * notes say about each. A function whose JSDoc alone changed and that no note
 * explains is only counted, so a pull request that rewrites many JSDoc
 * blocks does not bury the changes of code.
 */
export function changesMarkdown(changes, { limit = 30 } = {}) {
  const lines = [];
  const counts = KIND_ORDER.map((kind) => [kind, changes.functions.filter((change) => change.kind === kind).length]).filter(([, count]) => count > 0);
  lines.push(`### このPRで変わった関数（${changes.functions.filter((change) => change.kind !== 'noted').length}）`, '');
  lines.push(counts.length > 0 ? counts.map(([kind, count]) => `${KIND_WORDS[kind]} ${count}`).join(' · ') : '地図に載る関数（関数カタログ）の変更はありません。');
  for (const note of changes.notes) {
    const title = note.title === undefined ? '' : `**${note.title}** `;
    const summary = note.summary === '' ? '' : firstParagraph(note.summary, 300);
    lines.push('', `> ${title}${summary}`.trimEnd(), `> — \`${note.file}\``);
  }
  if (changes.notes.length === 0) {
    lines.push('', `変更メモ（\`${NOTES_DIRECTORY}/*.md\`）がありません。どの関数をどう変えたかを書くと、地図とこのコメントに表示されます。`);
  }
  const ordered = [...changes.functions].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || compare(a.id, b.id));
  const listed = ordered.filter((change) => change.kind !== 'docs' || (change.notes?.length ?? 0) > 0);
  if (listed.length > 0) {
    lines.push('', '| | 関数 | 場所 | 説明 |', '|---|---|---|---|');
    for (const change of listed.slice(0, limit)) {
      const note = change.notes?.map((entry) => entry.text).join('\n\n');
      const text = note === undefined || note === '' ? '（説明なし）' : firstParagraph(note, 160);
      lines.push(`| ${KIND_WORDS[change.kind]} | \`${change.name}()\` | ${cell(`${change.package} ${change.module}`)} | ${cell(text)} |`);
    }
    if (listed.length > limit) lines.push('', `ほか ${listed.length - limit} 個は地図で見てください。`);
  }
  const folded = ordered.length - listed.length;
  if (folded > 0) lines.push('', `説明のない、JSDoc だけ変えた関数 ${folded} 個は表に入れていません（地図の「このPRの変更」にあります）。`);
  return `${lines.join('\n')}\n`;
}
