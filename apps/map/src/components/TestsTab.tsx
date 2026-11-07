import { useMemo, useState } from 'react';
import type { FlowEndpoint, MapData, TestCase, TestEntry, TestsIndex, TreeNode } from '../types';
import {
  KIND_WORDS,
  OUTCOME_WORDS,
  assertionText,
  endpointKey,
  entryOfCard,
  evidenceWords,
  filesWords,
  frameGroups,
  frameName,
  inputOf,
  kindsWords,
  latestOf,
  outcomeWords,
  relationWords,
  resultTargets,
  routeOf,
  routeWords,
  tabSubject,
  testBadge,
  titleText,
  type TestLanguage,
} from '../lib/tests';
import { entryOf, sourceOf } from '../lib/trace';
import { locationOf } from '../lib/model';
import { GapList, LanguageSwitch, OutcomeChips, ResultMark, TestDrawer, TestRow, TestWords } from './TestParts';
import { useFrameTests, useTestLanguage, type Loaded } from './useTests';

/** The row the reader selected in the outline, as the pane hands it to a tab. */
export interface TabSelection {
  frame: string;
  node: TreeNode;
  frameId: string;
}

export interface TestsTabProps {
  data: MapData;
  index: Loaded<TestsIndex>;
  framework: string;
  /** The endpoint of an endpoint screen: its root speaks of the endpoint's tests whole. */
  endpoint?: FlowEndpoint | undefined;
  rootId: string;
  /** The frame the diagram shows. */
  frameId: string;
  selected: TabSelection | null;
  enabled: ReadonlySet<string>;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint?: ((id: string) => void) | undefined;
}

/** What the rows of the tab hand up: the test to open, as its card. */
type Open = (test: TestCase) => void;

/** What every part of the tab reads. */
interface Context {
  data: MapData;
  index: TestsIndex;
  framework: string;
  language: TestLanguage;
  labels: Readonly<Record<string, string>>;
  onOpen: Open;
  onOpenFunction: (id: string) => void;
}

/** The first expectations of a test in the language chosen, the rest counted. */
function Expectations({ test, language }: { test: TestCase; language: TestLanguage }) {
  if (test.assertions.length === 0) return <span className="muted">読める期待なし</span>;
  return (
    <ul className="plain test-expect">
      {test.assertions.slice(0, 3).map((assertion, at) => (
        <li key={at}>
          <TestWords text={assertionText(assertion, language)} />
        </li>
      ))}
      {test.assertions.length > 3 ? <li className="muted">ほか {test.assertions.length - 3}</li> : null}
    </ul>
  );
}

/** The API tests of an endpoint as a table (design §4): what each sends, what it expects, its aspects and its latest result. */
function ApiTable({ tests, endpoint, context }: { tests: readonly TestCase[]; endpoint: string; context: Context }) {
  const { language, labels, onOpen } = context;
  return (
    <div className="tests-table-wrap">
      <table className="tests-table tests-api">
        <thead>
          <tr>
            <th scope="col">入力</th>
            <th scope="col">期待</th>
            <th scope="col">観点</th>
            <th scope="col">最新</th>
          </tr>
        </thead>
        <tbody>
          {tests.map((test) => (
            <tr key={test.id}>
              <td>
                <button type="button" className="test-open" onClick={() => onOpen(test)} title="このテストの札とソースを開く">
                  <TestWords text={titleText(test, language)} />
                </button>
                {inputOf(test, endpoint).map((input, at) => (
                  <span key={at} className="test-input mono">
                    {input.method} {input.params.length === 0 ? '' : input.params.join(', ')}
                    {input.auth !== undefined ? <span className="chip">{input.auth}</span> : null}
                  </span>
                ))}
              </td>
              <td>
                <Expectations test={test} language={language} />
              </td>
              <td>
                <OutcomeChips test={test} labels={labels} />
              </td>
              <td>
                <ResultMark status={test.result?.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The E2E tests through an endpoint: the endpoints each goes through, and its result on each target. */
function E2eList({ tests, endpoints, source, context }: { tests: readonly TestCase[]; endpoints: readonly FlowEndpoint[]; source: string; context: Context }) {
  const { language, labels, onOpen } = context;
  return (
    <ul className="test-list">
      {tests.map((test) => (
        <TestRow key={test.id} test={test} language={language} labels={labels} onOpen={onOpen}>
          <p className="test-route mono">{routeWords(routeOf(test, endpoints, source)) || '通るエンドポイントを読めませんでした'}</p>
          {resultTargets(test).length > 0 ? (
            <p className="result-targets">
              {resultTargets(test).map(({ target, status }) => (
                <ResultMark key={target} status={status} target={target} />
              ))}
            </p>
          ) : null}
        </TestRow>
      ))}
    </ul>
  );
}

/** The unit tests of a frame, read from its file when the reader opens them: those of an endpoint by id, else those whose describe names it. */
function UnitTests({ id, ids, context }: { id: string; ids?: readonly string[] | undefined; context: Context }) {
  const { index, language, labels, onOpen } = context;
  const loaded = useFrameTests(index.frames[id]?.url);
  if (loaded.state === 'loading') return <p className="note">読み込んでいます…</p>;
  if (loaded.state === 'failed') return <p className="note">読み込めませんでした: {loaded.message}</p>;
  if (loaded.state !== 'ready') return <p className="note">この関数のテストはカタログにありません。</p>;
  const tests = ids === undefined ? frameGroups(loaded.value.tests, id).unit : loaded.value.tests.filter((test) => ids.includes(test.id));
  return (
    <ul className="test-list">
      {tests.map((test) => (
        <TestRow key={test.id} test={test} language={language} labels={labels} onOpen={onOpen}>
          <Expectations test={test} language={language} />
        </TestRow>
      ))}
    </ul>
  );
}

/** A function on a list of the tab: its name, its unit tests (and the tests that reached it), its tests on demand. */
function UnitGroup({ id, ids, context }: { id: string; ids?: readonly string[] | undefined; context: Context }) {
  const { data, index, onOpenFunction } = context;
  const [open, setOpen] = useState(false);
  const badge = testBadge(index.frames[id], index.measured);
  const entry = entryOf(data, id);
  return (
    <li className="unit-group">
      <details onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>
          <span className="mono">{frameName(data, id)}</span>{' '}
          <span className="tests-badge" title={badge?.title}>
            {badge === undefined ? 'ユニットなし' : `${badge.unit}${badge.detail ?? ''}${badge.reach === undefined ? '' : ` ${badge.reach}`}`}
          </span>{' '}
          {entry !== undefined ? <span className="muted mono where-inline">{locationOf(entry)}</span> : null}
        </summary>
        {open ? (
          <>
            {data.functions[id] !== undefined ? (
              <button type="button" className="link small" onClick={() => onOpenFunction(id)}>
                {frameName(data, id)} のページを開く
              </button>
            ) : null}
            <UnitTests id={id} ids={ids} context={context} />
          </>
        ) : null}
      </details>
    </li>
  );
}

/** The tests of an endpoint whole (design §4 テストのタブ): the counts, the gaps, the API tests, the E2E tests through it, and the unit tests of the functions it reaches. */
function EndpointTests({ endpoint, context }: { endpoint: FlowEndpoint; context: Context }) {
  const { data, index, framework, labels } = context;
  const key = endpointKey(framework, endpoint.id);
  const ref = index.endpoints[key];
  const loaded = useFrameTests(ref?.url);
  const endpoints = data.flows[framework]?.endpoints ?? [];
  const units = useMemo(() => (loaded.state === 'ready' ? Object.entries(loaded.value.units ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : []), [loaded]);
  if (ref === undefined) return <p className="note">このエンドポイントのテストはカタログにありません。</p>;
  const latest = latestOf(ref.counts);
  const file = loaded.state === 'ready' ? loaded.value : undefined;
  const api = (file?.tests ?? []).filter((test) => test.kind === 'api');
  const e2e = (file?.tests ?? []).filter((test) => test.kind === 'e2e');
  const run = index.run === undefined ? '' : [index.run.ref, index.run.commit?.slice(0, 7)].filter((part) => part !== undefined && part !== '').join(' ');
  return (
    <div className="tests-frame">
      <section className="tests-head" aria-label="このエンドポイントのテスト">
        <h4>
          <span className="mono">
            {endpoint.methods.join(' | ')} {endpoint.path}
          </span>{' '}
          <span className="muted">（{sourceOf(framework)}）</span>
        </h4>
        <p className="tests-counts">
          {kindsWords(ref.counts)}{' '}
          <span className={`latest latest-${latest.state}`} title={run === '' ? undefined : `実行: ${run}`}>
            最新: {latest.words}
          </span>
        </p>
        <p className="note">
          {outcomeWords(ref.counts, labels)} · {evidenceWords(ref.counts)}
        </p>
      </section>
      {loaded.state === 'loading' ? <p className="note">テストの札を読み込んでいます…</p> : null}
      {loaded.state === 'failed' ? <p className="note">テストの札を読み込めませんでした: {loaded.message}</p> : null}
      {file !== undefined ? (
        <>
          <section className="tests-section" aria-label="不足">
            <h4>不足（{file.gaps.length}）</h4>
            <GapList data={data} gaps={file.gaps} onOpenFunction={context.onOpenFunction} />
          </section>
          <section className="tests-section" aria-label="API テスト">
            <h4>
              API テスト（{api.length}）{api.length > 0 ? <span className="where mono"> {filesWords(api.map((test) => test.source.file))}</span> : null}
            </h4>
            {api.length === 0 ? <p className="note">このエンドポイントへリクエストを送る API テストはありません。</p> : <ApiTable tests={api} endpoint={endpoint.id} context={context} />}
          </section>
          <section className="tests-section" aria-label="E2E">
            <h4>E2E（このエンドポイントを通るテスト {e2e.length}）</h4>
            {e2e.length === 0 ? <p className="note">このエンドポイントを通る E2E のテストはありません。</p> : <E2eList tests={e2e} endpoints={endpoints} source={sourceOf(framework)} context={context} />}
          </section>
          <section className="tests-section" aria-label="ユニットテスト">
            <h4>
              ユニットテスト（このエンドポイントが届く関数 {units.length} 個、{ref.counts.kinds.unit ?? 0} 件）
            </h4>
            <p className="note">関数を開くと、そのユニットテストを読み込みます。アウトラインの行を選ぶと、このタブはその関数について述べます。</p>
            <ul className="unit-groups">
              {units.map(([id, ids]) => (
                <UnitGroup key={id} id={id} ids={ids} context={context} />
              ))}
            </ul>
          </section>
        </>
      ) : null}
    </div>
  );
}

/** The tests of one frame (a function, a body): its counts, its gaps, the unit tests that name it, and the other tests related to it by kind. */
function FrameTestsView({ id, rootId, context }: { id: string; rootId: string; context: Context }) {
  const { data, index, language, labels, onOpen, onOpenFunction } = context;
  const ref = index.frames[id];
  const loaded = useFrameTests(ref?.url);
  const badge = testBadge(ref, index.measured);
  const groups = loaded.state === 'ready' ? frameGroups(loaded.value.tests, id) : undefined;
  return (
    <div className="tests-frame">
      <section className="tests-head" aria-label="この関数のテスト">
        <h4>
          <span className="mono">{frameName(data, id)}</span>
          {id !== rootId && data.functions[id] !== undefined ? (
            <>
              {' '}
              <button type="button" className="link small" onClick={() => onOpenFunction(id)}>
                この関数のページを開く
              </button>
            </>
          ) : null}
        </h4>
        {ref === undefined ? (
          <p className="note">この{data.functions[id] !== undefined ? '関数' : 'フレーム'}に関連するテストは、カタログにありません。</p>
        ) : (
          <>
            <p className="tests-counts" title={badge?.title}>
              ユニット {ref.unit}（{OUTCOME_WORDS.success} {ref.success} / {OUTCOME_WORDS.failure} {ref.failure}
              {ref.boundary > 0 ? ` / ${labels.boundary ?? '境界値'} ${ref.boundary}` : ''}）{index.measured ? ` · 到達 ${ref.reached}` : ''} · 関連するテスト {ref.related}
            </p>
            <p className="note">ユニットは、トップレベルの describe がこの関数を名指すテストです。関連するテストは、期待の中でこの関数を呼ぶものと、実行で到達したものを含みます。</p>
          </>
        )}
      </section>
      {loaded.state === 'loading' ? <p className="note">テストの札を読み込んでいます…</p> : null}
      {loaded.state === 'failed' ? <p className="note">テストの札を読み込めませんでした: {loaded.message}</p> : null}
      {loaded.state === 'ready' && groups !== undefined ? (
        <>
          <section className="tests-section" aria-label="不足">
            <h4>不足（{loaded.value.gaps.length}）</h4>
            <GapList data={data} gaps={loaded.value.gaps} onOpenFunction={onOpenFunction} open />
          </section>
          <section className="tests-section" aria-label="ユニットテスト">
            <h4>ユニットテスト（{groups.unit.length}）</h4>
            {groups.unit.length === 0 ? (
              <p className="note">describe がこの関数を名指すユニットテストはありません。</p>
            ) : (
              <ul className="test-list">
                {groups.unit.map((test) => (
                  <TestRow key={test.id} test={test} language={language} labels={labels} onOpen={onOpen}>
                    <Expectations test={test} language={language} />
                  </TestRow>
                ))}
              </ul>
            )}
          </section>
          {groups.others.map((group) => (
            <section key={group.kind} className="tests-section" aria-label={`ほかの${KIND_WORDS[group.kind]}テスト`}>
              <h4>
                ほかに関連する{KIND_WORDS[group.kind]}テスト（{group.tests.length}）
              </h4>
              <ul className="test-list">
                {group.tests.map((test) => (
                  <TestRow key={test.id} test={test} language={language} labels={labels} onOpen={onOpen}>
                    <p className="note">
                      {relationWords(test, id)} · <span className="mono">{test.source.file}</span>
                    </p>
                  </TestRow>
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** A step that is no one function (a block of a Route Handler): the tests of each function it calls. */
function StepTests({ label, functions, context }: { label: string; functions: readonly string[]; context: Context }) {
  return (
    <div className="tests-frame">
      <section className="tests-head" aria-label="このステップのテスト">
        <h4>ステップ: {label}</h4>
        <p className="note">このステップは一つの関数ではないので、中で呼ぶ関数 {functions.length} 個のユニットテストを並べます。</p>
      </section>
      <ul className="unit-groups">
        {functions.map((id) => (
          <UnitGroup key={id} id={id} context={context} />
        ))}
      </ul>
    </div>
  );
}

/**
 * The テスト tab of the pane beside a trace (design §4): for the root of an
 * endpoint, the endpoint's tests whole; for the row the reader selected in
 * the outline, the tests of its function; else the tests of the frame the
 * diagram shows. The switch above reads the names, the steps and the
 * expectations of the tests in English or in their Japanese, kept for this
 * browser; a row opens the card of its test and its source.
 */
export function TestsTab({ data, index, framework, endpoint, rootId, frameId, selected, enabled, onOpenFunction, onOpenEndpoint }: TestsTabProps) {
  const [language, setLanguage] = useTestLanguage();
  const [open, setOpen] = useState<{ entry: TestEntry; card: TestCase } | null>(null);
  const hasFrame = useMemo(() => (id: string) => (entryOf(data, id)?.frame ?? '') !== '', [data]);
  if (index.state === 'none') return <p className="note">この地図にはテストのデータがありません。</p>;
  if (index.state === 'loading') return <p className="note">テストを読み込んでいます…</p>;
  if (index.state === 'failed') return <p className="note">テストのデータを読み込めませんでした: {index.message}</p>;
  const subject = tabSubject({
    rootId,
    endpoint: endpoint !== undefined,
    frameId,
    selected,
    enabled,
    hasFrame,
    ...(endpoint === undefined ? {} : { stepFunction: (step: string) => endpoint.steps.find((candidate) => candidate.id === step)?.functionId }),
  });
  const context: Context = { data, index: index.value, framework, language, labels: index.value.aspectLabels, onOpen: (test) => setOpen({ entry: entryOfCard(test), card: test }), onOpenFunction };
  return (
    <div className="tests-tab">
      <div className="tests-tools">
        <LanguageSwitch language={language} onLanguage={setLanguage} />
        <span className="note">{language === 'ja' ? '訳の無い記述は英語のまま出し、EN の印を付けます。' : 'テストの名前、手順、期待は英語で書かれています。'}</span>
      </div>
      {subject.kind === 'endpoint' && endpoint !== undefined ? (
        <EndpointTests endpoint={endpoint} context={context} />
      ) : subject.kind === 'step' ? (
        <StepTests label={subject.label} functions={subject.functions} context={context} />
      ) : (
        <FrameTestsView id={subject.kind === 'frame' ? subject.id : frameId} rootId={rootId} context={context} />
      )}
      {open !== null ? (
        <TestDrawer
          data={data}
          index={index.value}
          framework={framework}
          entry={open.entry}
          card={open.card}
          language={language}
          onLanguage={setLanguage}
          onClose={() => setOpen(null)}
          onOpenFunction={onOpenFunction}
          onOpenEndpoint={onOpenEndpoint}
        />
      ) : null}
    </div>
  );
}
