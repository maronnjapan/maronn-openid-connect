import { useMemo, useState, type ReactNode } from 'react';
import type { DiffHunk, FrameChangeEntry, MapData, Reach, TestDiff, TestEntry, TestsIndex } from '../types';
import { allHunks, catchWords, changeName, groupChanges, markOf, narrowing, wayGroups, wayLabel, type ChangeIndex } from '../lib/changes';
import { locationOf } from '../lib/model';
import { KIND_WORDS, OUTCOME_WORDS, diffKinds, endpointDiffs, setChange, signed, titleText } from '../lib/tests';
import { entryOf, sourceOf } from '../lib/trace';
import { Badge, ChangeNotes, ChangeSummary, DiffView, Inline, NoteText } from './ChangeParts';
import { TestDrawer, TestWords } from './TestParts';
import { fetchFrame } from './useFrames';
import { useTestDiff, useTestLanguage } from './useTests';

export interface ChangesScreenProps {
  data: MapData;
  index: ChangeIndex;
  framework: string;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint: (id: string) => void;
  /** Open the trace of an endpoint along a way to a change: its frames open and its sides chosen. */
  onOpenWay: (way: Reach) => void;
  /** The index of the tests, once read: the names of the related tests and their cards. */
  tests?: TestsIndex | undefined;
}

/** What the rows of the changes read of the diff of the tests (tests/diff.json). */
interface TestContext {
  diff: TestDiff | undefined;
  /** The diff is still being read. */
  loading: boolean;
  /** The changes whose related tests did not change, without a reason (MapChanges.untested): the check fails on them. */
  untested: ReadonlySet<string>;
  /** The entries of the index by id, for the names of the related tests. */
  entries: ReadonlyMap<string, TestEntry>;
  /** Open the card of a test of the index. */
  onOpen: (entry: TestEntry) => void;
}

/** What changed of a test, in words. */
const WHAT_WORDS: Record<TestDiff['modified'][number]['what'][number], string> = { title: '名前', assertions: '期待', subjects: '対象', requests: 'リクエスト', body: '本体' };

/** A test the diff names, by its card in the diff (its name in English), opening its card of the index when the index has it. */
function DiffTest({ id, diff, context, children }: { id: string; diff: TestDiff; context: TestContext; children?: ReactNode }) {
  const card = diff.cards[id];
  const entry = context.entries.get(id);
  const title = titleText({ title: card?.title ?? id }, 'en');
  return (
    <li className="test-row">
      <div className="test-row-head">
        {card !== undefined ? <span className="kind">{KIND_WORDS[card.kind]}</span> : null}
        {entry !== undefined ? (
          <button type="button" className="test-open" onClick={() => context.onOpen(entry)} title="このテストの札とソースを開く">
            <TestWords text={title} />
          </button>
        ) : (
          <TestWords text={title} />
        )}
        {card !== undefined && card.outcome !== 'unknown' ? <span className="chip">{OUTCOME_WORDS[card.outcome]}</span> : null}
        {card?.examples !== undefined ? <span className="chip">{card.examples} 行</span> : null}
      </div>
      {card !== undefined ? (
        <p className="where mono">
          {card.source.file}:{card.source.lines[0]}
        </p>
      ) : null}
      {children}
    </li>
  );
}

/** A set of words a changed frame's tests gained and lost: `+境界値 −認証`. */
function setWords(change: { added: readonly string[]; removed: readonly string[] }, word: (item: string) => string): string {
  return [...change.added.map((item) => `+${word(item)}`), ...change.removed.map((item) => `−${word(item)}`)].join(' ');
}

/**
 * The tests of a changed frame (design §5): how many relate to it and which
 * of them the pull request added or changed, whether the check fails on it
 * or its note says why its tests stay, the new failures no test expects, and
 * how the outcomes, aspects and errors its tests check changed.
 */
function RelatedTests({ entry, context, labels }: { entry: FrameChangeEntry; context: TestContext; labels: Readonly<Record<string, string>> }) {
  const frame = context.diff?.frames.find((candidate) => candidate.frame === entry.id);
  const untested = context.untested.has(entry.id);
  if (frame === undefined && !untested && entry.testReason === undefined) {
    return context.loading && (entry.kind === 'added' || entry.kind === 'modified') ? <p className="note">関連するテストを読み込んでいます…</p> : null;
  }
  const word = (key: 'outcomes' | 'aspects' | 'errors') => (item: string) => (key === 'outcomes' ? (OUTCOME_WORDS[item as 'success'] ?? item) : key === 'aspects' ? (labels[item] ?? item) : item);
  const moved =
    frame === undefined
      ? []
      : (
          [
            ['期待', 'outcomes'],
            ['観点', 'aspects'],
            ['期待するエラー', 'errors'],
          ] as const
        )
          .map(([label, key]) => ({ label, words: setWords(setChange(frame.before[key], frame.after[key]), word(key)) }))
          .filter((change) => change.words !== '');
  return (
    <section className="related-tests">
      <h4>関連するテスト</h4>
      {frame !== undefined ? (
        <p className="note">
          関連するテスト {frame.related.length} 件 · このPRで足した・変えたもの {frame.touched.length} 件
        </p>
      ) : null}
      {untested ? (
        <p className="untested-line">
          <span className="badge badge-required">テスト未変更</span> この変更に関連するテストを、このPRは足しも変えもしていません。理由の行が無いので、地図の検査が落ちます。
        </p>
      ) : null}
      {entry.testReason !== undefined ? (
        <p className="reason-line">
          テストを変えない理由: 「<Inline text={entry.testReason.text} />」 <span className="where mono">{entry.testReason.note}</span>
        </p>
      ) : null}
      {frame !== undefined && context.diff !== undefined && frame.touched.length > 0 ? (
        <ul className="test-list">
          {frame.touched.map((id) => (
            <DiffTest key={id} id={id} diff={context.diff as TestDiff} context={context} />
          ))}
        </ul>
      ) : null}
      {frame !== undefined && frame.failuresWithoutTest.length > 0 ? (
        <p className="note">
          新しく外へ出る失敗で、期待するテストが無いもの:{' '}
          {frame.failuresWithoutTest.map((error, at) => (
            <span key={error}>
              {at > 0 ? '、' : ''}
              <code>{error}</code>
            </span>
          ))}
        </p>
      ) : null}
      {moved.length > 0 ? <p className="note">関連するテストの保証範囲の変化: {moved.map((change) => `${change.label} ${change.words}`).join(' · ')}</p> : null}
      {frame !== undefined && frame.related.length > 0 ? (
        <details>
          <summary>関連するテストの一覧（{frame.related.length}）</summary>
          <ul className="plain related-list">
            {frame.related.slice(0, 80).map((id) => {
              const test = context.entries.get(id);
              return (
                <li key={id}>
                  {test === undefined ? (
                    <span className="mono">{id}</span>
                  ) : (
                    <button type="button" className="link" onClick={() => context.onOpen(test)}>
                      <TestWords text={titleText(test, 'en')} />
                    </button>
                  )}
                </li>
              );
            })}
            {frame.related.length > 80 ? <li className="muted">ほか {frame.related.length - 80} 件</li> : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The section テスト of the page (design §5 地図が出すもの): the cases before
 * and after by kind, the endpoints whose tests changed in number, the tests
 * added, changed, renamed and removed (their names in English), the changed
 * frames with their related tests, and the new failures no test expects.
 * The results and the coverage are Codecov's comment.
 */
function PrTests({ data, framework, context, onOpenEndpoint, onOpenFunction }: { data: MapData; framework: string; context: TestContext; onOpenEndpoint: (id: string) => void; onOpenFunction: (id: string) => void }) {
  const { diff } = context;
  if (diff === undefined) {
    return (
      <section className="pr-tests" aria-label="テスト">
        <h3>テスト</h3>
        <p className="note">{context.loading ? 'テストの差分を読み込んでいます…' : 'この地図にはテストの差分がありません。'}</p>
      </section>
    );
  }
  const kinds = diffKinds(diff);
  const moved = kinds.filter((row) => row.before !== row.after);
  const source = sourceOf(framework);
  const endpoints = data.flows[framework]?.endpoints ?? [];
  const byEndpoint = endpointDiffs(diff, source);
  const failures = diff.frames.flatMap((frame) => frame.failuresWithoutTest.map((error) => ({ error, frame: frame.frame })));
  const list = (heading: string, ids: readonly string[], extra?: (id: string) => ReactNode) =>
    ids.length === 0 ? null : (
      <details className="tests-lazy" open={ids.length <= 20}>
        <summary>
          {heading}（{ids.length}）
        </summary>
        <ul className="test-list">
          {ids.map((id) => (
            <DiffTest key={id} id={id} diff={diff} context={context}>
              {extra?.(id)}
            </DiffTest>
          ))}
        </ul>
      </details>
    );
  return (
    <section className="pr-tests" aria-label="テスト">
      <h3>テスト</h3>
      <p>
        テストケース: {diff.counts.before.toLocaleString('en-US')} → {diff.counts.after.toLocaleString('en-US')}（{signed(diff.counts.after - diff.counts.before)}）
        {moved.length > 0 ? `  ${moved.map((row) => `${row.label} ${signed(row.after - row.before)}`).join('、')}` : ''}
      </p>
      <p className="note">{kinds.map((row) => `${row.label} ${row.before} → ${row.after}`).join(' · ')}</p>
      <p className="note">
        追加 {diff.added.length} · 変更 {diff.modified.length} · 名前の変更 {diff.renamed.length} · 削除 {diff.removed.length}
      </p>
      {byEndpoint.length > 0 ? (
        <p className="note">
          テストの数が変わったエンドポイント（{source}）:{' '}
          {byEndpoint.map((row, at) => {
            const endpoint = endpoints.find((candidate) => candidate.id === row.endpoint);
            return (
              <span key={row.key}>
                {at > 0 ? '、' : ''}
                <button type="button" className="link mono" onClick={() => onOpenEndpoint(row.endpoint)}>
                  {endpoint?.path ?? row.endpoint}
                </button>{' '}
                {row.before} → {row.after}（{signed(row.after - row.before)}）
              </span>
            );
          })}
        </p>
      ) : null}
      {list('追加したテスト', diff.added)}
      {list(
        '変えたテスト',
        diff.modified.map((change) => change.id),
        (id) => {
          const change = diff.modified.find((candidate) => candidate.id === id);
          if (change === undefined) return null;
          return (
            <div className="test-change">
              <p className="note">変えたところ: {change.what.map((what) => WHAT_WORDS[what]).join('、')}</p>
              {change.assertions !== undefined ? (
                <ul className="plain exprs">
                  {change.assertions.removed.map((assertion, at) => (
                    <li key={`r${at}`} lang="en">
                      <del>{assertion.text}</del>
                    </li>
                  ))}
                  {change.assertions.added.map((assertion, at) => (
                    <li key={`a${at}`} lang="en">
                      <ins>{assertion.text}</ins>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        },
      )}
      {diff.renamed.length > 0 ? (
        <details className="tests-lazy" open={diff.renamed.length <= 20}>
          <summary>名前を変えたテスト（{diff.renamed.length}）</summary>
          <ul className="plain">
            {diff.renamed.map(([before, after]) => (
              <li key={`${before}>${after}`} lang="en">
                <del>{diff.cards[before]?.title ?? before}</del> → {diff.cards[after]?.title ?? after}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {list('消したテスト', diff.removed)}
      {diff.frames.length > 0 ? (
        <section aria-label="変えた関数ごとの関連するテスト">
          <h4>変えた関数ごとの関連するテスト（{diff.frames.length}）</h4>
          <ul className="plain pr-test-frames">
            {diff.frames.map((frame) => {
              const card = data.functions[frame.frame];
              const name = card !== undefined ? `${card.name}()` : (data.bodies[frame.frame]?.name ?? frame.frame);
              return (
                <li key={frame.frame}>
                  {card !== undefined ? (
                    <button type="button" className="link mono" onClick={() => onOpenFunction(frame.frame)}>
                      {name}
                    </button>
                  ) : (
                    <span className="mono">{name}</span>
                  )}
                  : 関連するテスト {frame.related.length} 件、このPRで足した・変えたもの {frame.touched.length} 件
                  {frame.untouched ? frame.reason !== undefined ? '（テストを変えない理由あり）' : <> <span className="badge badge-required">テスト未変更</span></> : null}
                  {frame.failuresWithoutTest.length > 0 ? <span className="muted">（期待するテストが無い新しい失敗 {frame.failuresWithoutTest.length}）</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      {failures.length > 0 ? (
        <section aria-label="新しく外へ出る失敗を期待するテストが無いもの">
          <h4>新しく外へ出る失敗を期待するテストが無いもの（{failures.length}）</h4>
          <ul className="plain">
            {failures.map((failure) => (
              <li key={`${failure.frame}/${failure.error}`}>
                <code>{failure.error}</code> <span className="muted">（{data.functions[failure.frame]?.name ?? failure.frame} から）</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="note">テストの結果とカバレッジの変化は Codecov のコメントにあります。</p>
    </section>
  );
}

/** The revision the changes are compared with: its name and its commit, or the commit alone when the name is the commit. */
function baseOf(base: { ref: string; commit: string }): string {
  const commit = base.commit.slice(0, 7);
  return base.commit.startsWith(base.ref) ? commit : `${base.ref}（${commit}）`;
}

/** The diff of a frame, read from its file when the reader opens it. */
function LazyDiff({ data, id }: { data: MapData; id: string }) {
  const [hunks, setHunks] = useState<DiffHunk[] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const url = entryOf(data, id)?.frame;
  return (
    <details
      className="change-diff"
      onToggle={(event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open || hunks !== undefined || url === undefined || url === '') return;
        fetchFrame(url)
          .then((file) => setHunks(allHunks(file.change)))
          .catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
      }}
    >
      <summary>差分を見る</summary>
      {failed !== undefined ? <p className="note">読み込めませんでした: {failed}</p> : hunks === undefined ? <p className="note">読み込んでいます…</p> : <DiffView hunks={hunks} />}
    </details>
  );
}

/**
 * The ways a change reaches the endpoints: each a button that opens the
 * trace along it, saying where a new failure of the change is caught on it.
 * A frame changed in more than one place lists its ways under each change
 * (Reach.label), so the ways to two changes do not read the same.
 */
function Ways({ data, entry, framework, onOpenWay }: { data: MapData; entry: FrameChangeEntry; framework: string; onOpenWay: (way: Reach) => void }) {
  if (entry.reach.length === 0) {
    if (entry.body === true) return <p className="note">エンドポイントの処理そのものです。</p>;
    return <p className="note">{(entry.untraceableCallers ?? []).length > 0 ? `型で引ける呼び出しからは、どのエンドポイントにも届きません（上の追えない呼び出し ${(entry.untraceableCallers ?? []).length} 箇所からは届くかもしれません）。` : '型で辿れる経路ではエンドポイントへの到達を確認できません。登録や初期化は「追えない配線」でも確認できます。'}</p>;
  }
  const ordered = [...entry.reach].sort((a, b) => Number(!a.frameworks.includes(framework)) - Number(!b.frameworks.includes(framework)));
  const groups = wayGroups(ordered);
  const list = (ways: readonly Reach[]) => (
    <ul className="ways">
      {ways.map((way, index) => {
        const flow = data.flows[way.frameworks.includes(framework) ? framework : (way.frameworks[0] as string)];
        const endpoint = flow?.endpoints.find((candidate) => candidate.id === way.endpoint);
        const step = endpoint?.steps.find((candidate) => candidate.id === way.step);
        const via = wayLabel(data, entry, way);
        const caught = catchWords(way);
        return (
          <li key={index}>
            <button type="button" className="row" onClick={() => onOpenWay(way)}>
              <span className="row-title">
                {endpoint?.label ?? way.endpoint}
                {step !== undefined ? ` › ${step.label}` : ''} › {via.join(' › ')}
              </span>
              <span className="row-text">
                {way.source === 'hono' ? 'Hono・Express・Fastify' : 'Next.js'}
                {Object.keys(way.decisions).length > 0 ? ` · 決定 ${Object.keys(way.decisions).length} 個を選んで開く` : ''}
                {way.features.length > 0 ? ` · 要る機能: ${way.features.join('、')}` : ''}
              </span>
              {caught !== undefined ? (
                <span className={`row-text${way.escapes === true ? ' escapes' : ''}`}>
                  <Inline text={caught} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
  if (groups.length === 1) return list(groups[0]?.ways ?? []);
  return (
    <div className="way-groups">
      {groups.map((group, index) => (
        <section key={index} className="way-group">
          <p className="way-label">
            {group.label !== undefined ? <Inline text={group.label} /> : group.ways.every((way) => (way.through ?? []).length > 0) ? '変えたところのどれにも届く道筋（インターフェースのメンバーの呼び出しを通る）' : '変えたところのどれにも届く道筋'}（{group.ways.length} 本）
          </p>
          {list(group.ways)}
        </section>
      ))}
    </div>
  );
}

/** One changed frame: its badge and name, where it is, the diff in words, the notes, the diff, the ways it reaches the endpoints, and its related tests. */
function ChangeRow({ data, entry, framework, onOpenFunction, onOpenWay, testing, labels = {} }: { data: MapData; entry: FrameChangeEntry; framework: string; onOpenFunction: (id: string) => void; onOpenWay: (way: Reach) => void; testing?: TestContext | undefined; labels?: Readonly<Record<string, string>> }) {
  const name = changeName(data, entry);
  const opens = entry.kind !== 'removed' && entry.body !== true && data.functions[entry.id] !== undefined;
  return (
    <li className="change-row">
      <div className="change-row-head">
        <Badge mark={markOf(entry.kind)} />
        {opens ? (
          <button type="button" className="link mono" onClick={() => onOpenFunction(entry.id)}>
            {name}
          </button>
        ) : (
          <span className="mono">{name}</span>
        )}
        <span className="muted mono where-inline">{locationOf(entry)}</span>
        {entry.from !== undefined ? <span className="muted">（{entry.from} から移した）</span> : null}
        {entry.required && !entry.documented ? <span className="badge badge-required">説明なし</span> : null}
        {testing?.untested.has(entry.id) === true ? <span className="badge badge-required">テスト未変更</span> : null}
      </div>
      <ChangeSummary change={entry} data={data} framework={framework} onOpenFunction={onOpenFunction} />
      <ChangeNotes change={entry} />
      {entry.kind === 'modified' || entry.kind === 'added' || entry.kind === 'docs' ? <LazyDiff data={data} id={entry.id} /> : null}
      {entry.kind === 'modified' || entry.kind === 'added' ? (
        <section>
          <h4>届く経路</h4>
          <Ways data={data} entry={entry} framework={framework} onOpenWay={onOpenWay} />
        </section>
      ) : null}
      {testing !== undefined ? <RelatedTests entry={entry} context={testing} labels={labels} /> : null}
    </li>
  );
}

/**
 * The changes of the pull request, the way into its review: first the
 * changes that need a note and have none, then what its notes say it does,
 * then every changed frame with the diff in words, its notes, its diff and
 * the ways it reaches the endpoints (each opens the trace along it).
 */
export function ChangesScreen({ data, index, framework, onOpenFunction, onOpenEndpoint, onOpenWay, tests }: ChangesScreenProps) {
  const { changes } = index;
  const loadedDiff = useTestDiff(data);
  const [language, setLanguage] = useTestLanguage();
  const [open, setOpen] = useState<TestEntry | null>(null);
  const entries = useMemo(() => new Map((tests?.tests ?? []).map((test) => [test.id, test])), [tests]);
  const untestedIds = useMemo(() => new Set(changes.untested ?? []), [changes.untested]);
  // The map of a pull request with tests: the diff of the tests (read after the page), the changes the check of the tests fails on.
  const testing: TestContext | undefined =
    data.tests === undefined ? undefined : { diff: loadedDiff.state === 'ready' ? loadedDiff.value : undefined, loading: loadedDiff.state === 'loading', untested: untestedIds, entries, onOpen: setOpen };
  const labels = tests?.aspectLabels ?? {};
  const untested = (changes.untested ?? []).map((id) => changes.frames.find((entry) => entry.id === id)).filter((entry): entry is FrameChangeEntry => entry !== undefined);
  const reasoned = changes.frames.filter((entry) => entry.testReason !== undefined);
  const groups = groupChanges(changes);
  const missing = changes.frames.filter((entry) => (entry.kind === 'added' || entry.kind === 'modified') && !entry.documented);
  const counted = changes.frames.filter((entry) => entry.kind !== 'noted').length;
  const pullRequest = changes.pullRequest;
  const endpoints = new Map<string, number>();
  for (const entry of changes.frames) for (const way of entry.reach) if (way.frameworks.includes(framework)) endpoints.set(way.endpoint, (endpoints.get(way.endpoint) ?? 0) + 1);
  const flow = data.flows[framework];
  const outsideWiring = (data.wiring ?? []).filter((entry) => changes.outside.some((file) => file.file === entry.file && file.lines.some((line) => line >= entry.lines[0] && line <= entry.lines[1])));
  return (
    <section className="screen changes-screen" aria-label="このPRの変更">
      <header className="screen-head">
        <div className="title-row">
          <h2>このPRの変更</h2>
          {pullRequest !== undefined ? (
            pullRequest.url !== undefined ? (
              <a className="chip" href={pullRequest.url} target="_blank" rel="noreferrer">
                #{pullRequest.number}
              </a>
            ) : (
              <span className="chip">#{pullRequest.number}</span>
            )
          ) : null}
          <span className="chip mono" title={changes.base.commit}>
            {baseOf(changes.base)} からの差分{changes.head.dirty ? '・未コミットの変更を含む' : ''}
          </span>
        </div>
        {pullRequest?.title !== undefined ? <p className="lead">{pullRequest.title}</p> : null}
        <p className="note">
          変えた関数とエンドポイントの処理 {counted} 個 · テストのファイルの変更 {changes.testFiles ?? 0} 個{data.tests !== undefined ? '（下の「テスト」）' : ''} · テストでもなく地図にも載らないファイルの変更 {changes.otherFiles} 個 · 何を変えたかとどこに効くかは地図が計算し、なぜ変えたかは変更メモ（<code>apps/map/changes/*.md</code>）が書きます
        </p>
      </header>
      <div className="work changes-work">
        <div className="changes-body">
          {missing.length > 0 ? (
            <section className="undocumented" aria-label="説明の無い変更">
              <h3>説明の無い変更（{missing.length}）</h3>
              <p className="note">
                {changes.undocumented.length > 0
                  ? `このうち ${changes.undocumented.length} 個はエンドポイントに届く変更かエンドポイントの処理の変更で、変更メモに説明が要ります（無いと地図の検査が落ちます）。雛形は pnpm --filter @maronn-openid-connect/map changes:draft で書けます。`
                  : 'どれもエンドポイントに届かないので、検査は落ちません。'}
              </p>
              <ul className="change-list">
                {missing.map((entry) => (
                  <ChangeRow key={entry.id} data={data} entry={entry} framework={framework} onOpenFunction={onOpenFunction} onOpenWay={onOpenWay} testing={testing} labels={labels} />
                ))}
              </ul>

            </section>
          ) : null}
          {untested.length > 0 ? (
            <section className="undocumented untested" aria-label="関連するテストに変更の無い実装の変更">
              <h3>関連するテストに変更の無い実装の変更（{untested.length}）</h3>
              <p className="note">
                エンドポイントに届く実装の変更で、関連するテストをこのPRが足しも変えもしていないものです（地図の検査が落ちます）。テストを足すか変えるか、変えないのが妥当なら、変更メモのその関数の節に <code>テストを変えない理由: …</code> の行を書いてください。書く場所は <code>pnpm --filter @maronn-openid-connect/map changes:draft</code> が空けます。
              </p>
              <ul className="change-list">
                {untested.map((entry) => (
                  <ChangeRow key={entry.id} data={data} entry={entry} framework={framework} onOpenFunction={onOpenFunction} onOpenWay={onOpenWay} testing={testing} labels={labels} />
                ))}
              </ul>
            </section>
          ) : null}
          {reasoned.length > 0 ? (
            <section className="pr-reasons" aria-label="テストを変えない理由が書かれた変更">
              <h3>テストを変えない理由が書かれた変更（{reasoned.length}）</h3>
              <ul className="change-list">
                {reasoned.map((entry) => {
                  const frame = testing?.diff?.frames.find((candidate) => candidate.frame === entry.id);
                  return (
                    <li key={entry.id} className="change-row">
                      <div className="change-row-head">
                        <Badge mark={markOf(entry.kind)} />
                        {data.functions[entry.id] !== undefined ? (
                          <button type="button" className="link mono" onClick={() => onOpenFunction(entry.id)}>
                            {changeName(data, entry)}
                          </button>
                        ) : (
                          <span className="mono">{changeName(data, entry)}</span>
                        )}
                        {frame !== undefined ? <span className="muted">関連するテスト {frame.related.length} 件</span> : null}
                      </div>
                      <p className="reason-line">
                        「<Inline text={entry.testReason?.text ?? ''} />」 <span className="where mono">{entry.testReason?.note}</span>
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
          ) : null}
          <section className="pr-notes" aria-label="変更メモ">
            <h3>変更メモ</h3>
            {changes.notes.length > 0 ? (
              changes.notes.map((note) => (
                <article key={note.file} className="pr-note">
                  {note.title !== undefined ? <h4>{note.title}</h4> : null}
                  {note.summary !== '' ? <NoteText text={note.summary} /> : null}
                  <p className="where mono">{note.file}</p>
                </article>
              ))
            ) : (
              <p className="note">このPRには変更メモがありません。なぜ変えたかを書くと、ここと各関数のページに表示されます（書き方は apps/map/changes/README.md）。</p>
            )}
            {changes.unmatched.map((section, at) => (
              <article key={`${section.file}/${at}`} className="pr-note">
                <h4>{section.heading}</h4>
                <NoteText text={section.text} />
              </article>
            ))}
            {changes.ambiguous.map((warning) => {
              const { roots, ids } = narrowing(warning.reference, warning.matches);
              return (
                <div key={`${warning.file}/${warning.reference}`} className="note ambiguous">
                  <p>
                    見出し <code>{warning.reference}</code>（{warning.file}）は {warning.matches.length} 個の変更に当たります。
                    {roots.length > 0 ? (
                      <>
                        ルートを付けるか（
                        {roots.map((root, index) => (
                          <span key={root}>
                            {index > 0 ? '、' : ''}
                            <code>{root}</code>
                          </span>
                        ))}
                        ）、
                      </>
                    ) : null}
                    見出しに <code>{'<!-- id -->'}</code> で次の id のどれかを書いて絞り込んでください。
                  </p>
                  <ul className="plain">
                    {ids.map((id) => (
                      <li key={id}>
                        <code>{id}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </section>
          {groups.length === 0 ? <p className="note">地図に載る関数とエンドポイントの処理は変えていません。</p> : null}
          {groups.map((group) => (
            <details key={group.kind} className="change-group" open={group.frames.length <= 40}>
              <summary>
                <h3>
                  {group.heading}（{group.frames.length}）
                </h3>
              </summary>
              <ul className="change-list">
                {group.frames.map((entry) => (
                  <ChangeRow key={entry.id} data={data} entry={entry} framework={framework} onOpenFunction={onOpenFunction} onOpenWay={onOpenWay} testing={testing} labels={labels} />
                ))}
              </ul>
            </details>
          ))}
          {changes.outside.length > 0 ? (
            <section>
              <h3>関数の外の変更</h3>
              <p className="note">import、型、定数、起動時の初期化など、どのフレームにも属さない行です。</p>
              <ul className="plain">
                {changes.outside.map((file) => (
                  <li key={file.file} className="mono">
                    {file.file}: {file.lines.length} 行
                  </li>
                ))}
              </ul>
              {outsideWiring.length > 0 ? (
                <details>
                  <summary>変更した行の追えない配線（{outsideWiring.length}）</summary>
                  <ul className="change-list">
                    {outsideWiring.map((entry) => <li className="change-row" key={entry.id}><span className="mono">{data.sources[entry.file]?.path ?? entry.file}:{entry.lines[0]}</span><code>{entry.code}</code><p className="note">追えない理由: {entry.why}</p></li>)}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
          {testing !== undefined ? <PrTests data={data} framework={framework} context={testing} onOpenEndpoint={onOpenEndpoint} onOpenFunction={onOpenFunction} /> : null}
        </div>
        <aside className="side-panel" aria-label="変更が届くエンドポイント">
          <h3>変更が届くエンドポイント（{framework}）</h3>
          {endpoints.size === 0 ? <p className="note">このPRの変更は、このフレームワークのどのエンドポイントにも届きません。</p> : null}
          <ul className="links">
            {[...endpoints].map(([id, count]) => {
              const endpoint = flow?.endpoints.find((candidate) => candidate.id === id);
              return (
                <li key={id}>
                  <button type="button" className="row" onClick={() => onOpenEndpoint(id)}>
                    <span className="route mono">
                      {endpoint?.methods.join(' | ')} {endpoint?.path}
                    </span>
                    <span className="row-title">
                      <Badge mark={markOf('inside')} /> {endpoint?.label ?? id}
                    </span>
                    <span className="row-text">経路 {count} 本</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>
      </div>
      {open !== null && tests !== undefined ? (
        <TestDrawer data={data} index={tests} framework={framework} entry={open} language={language} onLanguage={setLanguage} onClose={() => setOpen(null)} onOpenFunction={onOpenFunction} onOpenEndpoint={onOpenEndpoint} />
      ) : null}
    </section>
  );
}
