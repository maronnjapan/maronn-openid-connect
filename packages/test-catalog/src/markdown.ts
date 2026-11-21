/**
 * The diff of the tests in Markdown, for the comment of the map on a pull
 * request (changes.md): the changes whose related tests did not change, which
 * fail the check, at the top (untestedMarkdown), and the rest folded in
 * `<details>` after the changes of the code (testsMarkdown). The frame of the
 * words is Japanese like the rest of the comment; the names and the
 * expectations of the tests stay English, a changed expectation said by the
 * words that changed (changedWords).
 *
 * The folded section holds, in order: the number of cases before and after;
 * the changes whose note says why their tests did not change; for each
 * endpoint the changes reach, the tests added and changed and the changed
 * functions with what happened to their tests; the changed functions whose
 * tests changed elsewhere; the new failures no test expects; the tests
 * removed and renamed. The results and the coverage are Codecov's comment.
 */
import type { FrameChangeEntry, MapData } from '@maronn-openid-connect/map-analysis';
import type { AspectTable } from './aspects.js';
import type { Assertion, TestDiff, TestKind } from './model.js';

const KIND_WORDS: Record<TestKind, string> = { unit: 'ユニット', api: 'API', e2e: 'E2E', tool: 'ツール' };
const OUTCOME_WORDS: Record<string, string> = { success: '正常系', failure: '異常系' };
/** At most this many lines in a list; the rest are counted. */
const LIMIT = 20;

/** A table cell: one line, its pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/** A signed count (`+3`, `-1`, `±0`). */
function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `${value}` : '±0';
}

/** The name of a changed frame as the comment says it. */
function frameWords(entry: Pick<FrameChangeEntry, 'name' | 'body' | 'package' | 'module'> | undefined, id: string): string {
  if (entry === undefined) return `\`${id}\``;
  return entry.body === true ? `\`${entry.name}\`（エンドポイントの処理）` : `\`${entry.name}()\`（${entry.package} ${entry.module}）`;
}

/** A test in the comment: its title, kind, outcome and aspects (and the rows of an outline). */
function testWords(card: TestDiff['cards'][string] | undefined, id: string, labels: ReadonlyMap<string, string>): string {
  if (card === undefined) return `\`${id}\``;
  const facts = [KIND_WORDS[card.kind], OUTCOME_WORDS[card.outcome], ...card.aspects.map((aspect) => labels.get(aspect) ?? aspect), ...(card.examples === undefined ? [] : [`${card.examples} 行`])].filter((fact): fact is string => fact !== undefined);
  return `${card.title}（${facts.join(', ')}）`;
}

/** Tests in the comment, the rows of an outline as one line under its name with the number of its rows. */
function testLines(ids: readonly string[], diff: TestDiff, labels: ReadonlyMap<string, string>): string[] {
  const seen = new Map<string, { id: string; rows: number }>();
  const order: string[] = [];
  for (const id of ids) {
    const card = diff.cards[id];
    const outline = card !== undefined && card.source.form === 'feature' && card.path.length > 1 ? `${card.source.file}\u0000${card.path.join('\u0000')}` : id;
    const known = seen.get(outline);
    if (known === undefined) {
      seen.set(outline, { id, rows: 1 });
      order.push(outline);
    } else known.rows += 1;
  }
  return order.map((key) => {
    const { id, rows } = seen.get(key) as { id: string; rows: number };
    const card = diff.cards[id];
    if (card === undefined || key === id) return `- ${testWords(card === undefined ? undefined : { ...card, examples: undefined } as TestDiff['cards'][string], id, labels)}`;
    return `- ${testWords({ ...card, title: card.path[card.path.length - 1] as string, examples: rows } as TestDiff['cards'][string], id, labels)}`;
  });
}

/** The lines of a list, at most LIMIT, the rest counted. */
function listed(lines: readonly string[]): string[] {
  return lines.length <= LIMIT ? [...lines] : [...lines.slice(0, LIMIT), `- ほか ${lines.length - LIMIT} 件は、テストの画面（地図の \`/tests/\` の「この PR のテスト」）で見てください。`];
}

/** A text with its code spans closed: an odd backtick left open would run into the rest of the line. */
function closed(text: string): string {
  return (text.match(/`/g) ?? []).length % 2 === 0 ? text : `${text}\``;
}

/** The words of a text with where each starts and ends: a run of letters, digits, `_` and `$`, or one other character that is not a space. */
function wordsOf(text: string): Array<{ word: string; start: number; end: number }> {
  return [...text.matchAll(/[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu)].map((match) => ({ word: match[0], start: match.index, end: match.index + match[0].length }));
}

/** What changed from one text to another by its words (the longest common subsequence): each run of changed words as `~~before~~ → after`, `~~before~~` or `+after`. */
function wordChanges(before: string, after: string): string[] {
  const a = wordsOf(before);
  const b = wordsOf(after);
  const common: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) common[i]![j] = a[i]!.word === b[j]!.word ? common[i + 1]![j + 1]! + 1 : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  }
  const changes: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i]!.word === b[j]!.word) {
      i += 1;
      j += 1;
      continue;
    }
    const [fromA, fromB] = [i, j];
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i]!.word === b[j]!.word)) {
      if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) i += 1;
      else j += 1;
    }
    const removed = i > fromA ? closed(cell(before.slice(a[fromA]!.start, a[i - 1]!.end))) : '';
    const added = j > fromB ? closed(cell(after.slice(b[fromB]!.start, b[j - 1]!.end))) : '';
    changes.push(removed === '' ? `+${added}` : added === '' ? `~~${removed}~~` : `~~${removed}~~ → ${added}`);
  }
  return changes;
}

/**
 * The words that changed between the expectations a test removed and those
 * it added (TestDiff.modified): a removed and an added expectation of the same
 * phrase, or of the same value and matcher, are one changed expectation, said
 * by its changed words (`~~400~~ → 401`); the others are said whole, a removed
 * one struck out and an added one after `+`.
 */
export function changedWords(removed: readonly Assertion[], added: readonly Assertion[]): string[] {
  const rest = [...added];
  const changes: string[] = [];
  for (const before of removed) {
    const index = rest.findIndex((after) => (before.phrase !== undefined && before.phrase === after.phrase) || (before.actual === after.actual && before.matcher === after.matcher));
    const after = index === -1 ? undefined : rest.splice(index, 1)[0];
    changes.push(...(after === undefined ? [`~~${closed(cell(before.text))}~~`] : wordChanges(before.text, after.text)));
  }
  return [...changes, ...rest.map((after) => `+${closed(cell(after.text))}`)];
}

/**
 * The changes whose related tests did not change and whose note gives no
 * reason not to (the check of the map fails on them), for the top of the
 * comment: '' when there are none.
 */
export function untestedMarkdown(diff: TestDiff, data: MapData): string {
  const entries = new Map((data.changes?.frames ?? []).map((entry) => [entry.id, entry]));
  const untouched = diff.frames.filter((frame) => frame.untouched && frame.reason === undefined);
  if (untouched.length === 0) return '';
  const lines = [`### 関連するテストに変更の無い実装の変更（${untouched.length}、CI を落とす）`, ''];
  lines.push(
    ...listed(
      untouched.map((frame) => {
        const entry = entries.get(frame.frame);
        const summary = entry?.summary[0] === undefined ? '' : `（${cell(entry.summary[0])}）`;
        return `- ${frameWords(entry, frame.frame)}${summary}: 関連するテスト ${frame.related.length} 件、変更なし`;
      }),
    ),
  );
  lines.push('', `テストを足すか変えるか、変えないのが妥当なら、変更メモのその関数の節に \`テストを変えない理由: …\` の行を書いてください（\`pnpm --filter @maronn-openid-connect/map changes:draft\` が書く場所を空けます）。`);
  return `${lines.join('\n')}\n`;
}

/** The folded section (see the module comment). */
export function testsMarkdown(diff: TestDiff, data: MapData, aspects: AspectTable): string {
  const labels = new Map(aspects.aspects.map((rule) => [rule.id, rule.label]));
  const entries = new Map((data.changes?.frames ?? []).map((entry) => [entry.id, entry]));
  const summary = `テスト ${diff.counts.before.toLocaleString('en-US')} → ${diff.counts.after.toLocaleString('en-US')}（追加 ${diff.added.length} · 変更 ${diff.modified.length} · 名前の変更 ${diff.renamed.length} · 削除 ${diff.removed.length}）`;
  const lines: string[] = [`<details><summary>${summary}</summary>`, ''];
  const kinds = Object.entries(diff.counts.byKind)
    .map(([kind, [before, after]]) => [kind as TestKind, after - before] as const)
    .filter(([, delta]) => delta !== 0)
    .map(([kind, delta]) => `${KIND_WORDS[kind] ?? kind} ${signed(delta)}`);
  lines.push(`テストケース: ${signed(diff.counts.after - diff.counts.before)}${kinds.length === 0 ? '' : `  ${kinds.join('、')}`}`);

  const reasoned = diff.frames.filter((frame) => frame.untouched && frame.reason !== undefined);
  if (reasoned.length > 0) {
    lines.push('', `**テストを変えない理由が書かれた変更（${reasoned.length}）**`, '');
    lines.push(...listed(reasoned.map((frame) => `- ${frameWords(entries.get(frame.frame), frame.frame)}: 関連するテスト ${frame.related.length} 件。「${cell(frame.reason?.text ?? '')}」`)));
  }

  // By endpoint: the tests added and changed for it, and the changed functions that reach it with their tests of it.
  const endpointName = (key: string) => {
    const [source, id] = key.split(':') as [string, string];
    const endpoint = data.flows[source]?.endpoints.find((candidate) => candidate.id === id);
    return endpoint === undefined ? id : `${endpoint.methods.join(' | ')} ${endpoint.path}`;
  };
  // A renamed test is a changed one in the comment, not an added one.
  const changed = new Set([...diff.modified.map((change) => change.id), ...diff.renamed.map(([, after]) => after)]);
  const groups = new Map<string, { keys: Set<string>; added: string[]; changed: string[] }>();
  for (const id of [...diff.added, ...diff.renamed.map(([, after]) => after), ...diff.modified.map((change) => change.id)]) {
    for (const key of diff.cards[id]?.endpoints ?? []) {
      const name = endpointName(key);
      const group = groups.get(name) ?? { keys: new Set<string>(), added: [], changed: [] };
      group.keys.add(key);
      const list = changed.has(id) ? group.changed : group.added;
      if (!list.includes(id)) list.push(id);
      groups.set(name, group);
    }
  }
  /** The words of what happened to the tests of a changed frame: by kind, added and changed. */
  const touchedWords = (ids: readonly string[]) => {
    const counts = new Map<string, { added: number; changed: number }>();
    for (const test of ids) {
      const card = diff.cards[test];
      const word = card === undefined ? 'テスト' : KIND_WORDS[card.kind];
      const known = counts.get(word) ?? { added: 0, changed: 0 };
      if (changed.has(test)) known.changed += 1;
      else known.added += 1;
      counts.set(word, known);
    }
    return [...counts].map(([word, count]) => [count.added > 0 ? `${word} 追加 ${count.added}` : '', count.changed > 0 ? `${word} 変更 ${count.changed}` : ''].filter((part) => part !== '').join('、'));
  };
  for (const [name, group] of [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const sources = [...group.keys].map((key) => key.split(':')[0] as string).sort();
    lines.push('', `**変更対象: ${name}（${[...new Set(sources)].join(', ')}）**`);
    if (group.added.length > 0) lines.push('', '追加されたテスト:', ...listed(testLines(group.added, diff, labels)));
    if (group.changed.length > 0) {
      lines.push(
        '',
        '変更されたテスト:',
        ...listed(
          group.changed.map((id) => {
            const change = diff.modified.find((candidate) => candidate.id === id);
            const words = change?.assertions === undefined ? [] : changedWords(change.assertions.removed, change.assertions.added);
            const pair = words.length === 0 ? '' : `（期待 ${words.slice(0, 4).join('、')}${words.length > 4 ? ` ほか ${words.length - 4}` : ''}）`;
            const before = diff.renamed.find(([, after]) => after === id)?.[0];
            const renamed = before === undefined ? '' : `（名前の変更: ${diff.cards[before]?.title ?? before} から）`;
            return `- ${testWords(diff.cards[id], id, labels)}${renamed}${pair}`;
          }),
        ),
      );
    }
    // The changed functions that reach it, with their touched tests of this endpoint (and their unit tests).
    const frames = diff.frames
      .filter((frame) => (entries.get(frame.frame)?.reach ?? []).some((way) => group.keys.has(`${way.source}:${way.endpoint}`)))
      .map((frame) => ({ frame, own: frame.touched.filter((id) => (diff.cards[id]?.endpoints ?? []).length === 0 || (diff.cards[id]?.endpoints ?? []).some((key) => group.keys.has(key))) }))
      .filter(({ own }) => own.length > 0);
    if (frames.length > 0) lines.push('', '関連する変更関数:', ...listed(frames.map(({ frame, own }) => `- ${frameWords(entries.get(frame.frame), frame.frame)}: ${touchedWords(own).join('、')}`)));
  }
  // The changed functions whose tests changed outside the groups (unit tests only, or tests of no endpoint).
  const grouped = new Set([...groups.values()].flatMap((group) => [...group.keys]));
  const elsewhere = diff.frames.filter((frame) => frame.touched.length > 0 && !(entries.get(frame.frame)?.reach ?? []).some((way) => grouped.has(`${way.source}:${way.endpoint}`)));
  if (elsewhere.length > 0) lines.push('', '**テストを足すか変えた変更関数**', '', ...listed(elsewhere.map((frame) => `- ${frameWords(entries.get(frame.frame), frame.frame)}: ${touchedWords(frame.touched).join('、')}`)));

  const failures = diff.frames.flatMap((frame) => frame.failuresWithoutTest.map((failure) => `- ${failure}（${frameWords(entries.get(frame.frame), frame.frame)} から）`));
  if (failures.length > 0) lines.push('', '**新しく外へ出る失敗を期待するテストが無いもの**', '', ...listed(failures));
  if (diff.removed.length > 0) lines.push('', `**削除されたテスト（${diff.removed.length}）**`, '', ...listed(testLines(diff.removed, diff, labels)));
  if (diff.renamed.length > 0) lines.push('', `**名前を変えたテスト（${diff.renamed.length}）**`, '', ...listed(diff.renamed.map(([before, after]) => `- ${diff.cards[before]?.title ?? before} → ${diff.cards[after]?.title ?? after}`)));
  lines.push('', '</details>');
  return `${lines.join('\n')}\n`;
}
