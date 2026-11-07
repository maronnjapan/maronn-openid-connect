import { useMemo, useState, type ReactNode } from 'react';
import type { FlowEndpoint, Gap, MapData, TestEntry, TestsIndex } from '../types';
import {
  EVIDENCE_WORDS,
  KIND_ORDER,
  KIND_WORDS,
  OUTCOME_WORDS,
  STATUS_WORDS,
  endpointKey,
  featureTests,
  frameName,
  kindsWords,
  latestOf,
  matchesQuery,
  sourceGaps,
  testBadge,
  titleText,
  unknownCases,
} from '../lib/tests';
import { sourceOf } from '../lib/trace';
import { GapList, LanguageSwitch, OutcomeChips, ResultMark, TestDrawer, TestWords } from './TestParts';
import { useTestLanguage, type Loaded } from './useTests';

export interface TestsScreenProps {
  data: MapData;
  index: Loaded<TestsIndex>;
  framework: string;
  /** Open an endpoint or a function on its テスト tab. */
  onOpenEndpoint: (id: string) => void;
  onOpenFunction: (id: string) => void;
}

/** How many rows a long list shows at first, and how many more each press shows. */
const PAGE = 100;

/** A folded list that draws its rows only once opened, a page at a time (the cases without an aspect are thousands). */
function LazyList<T>({ summary, items, render, open: initiallyOpen = false }: { summary: ReactNode; items: readonly T[]; render: (item: T) => ReactNode; open?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const [shown, setShown] = useState(PAGE);
  return (
    <details className="tests-lazy" open={initiallyOpen} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>{summary}</summary>
      {open ? (
        <>
          <ul className="test-list">{items.slice(0, shown).map(render)}</ul>
          {items.length > shown ? (
            <button type="button" className="link small" onClick={() => setShown(shown + PAGE)}>
              さらに {Math.min(PAGE, items.length - shown)} 件（残り {items.length - shown}）
            </button>
          ) : null}
        </>
      ) : null}
    </details>
  );
}

/** A count among others, with its label: `API 166`. */
function Count({ label, value, danger = false }: { label: string; value: number; danger?: boolean }) {
  return (
    <span className={`tests-count${danger ? ' danger' : ''}`}>
      {label} <strong>{value}</strong>
    </span>
  );
}

/**
 * The list of the tests (design §4 「一覧のページ」, `#<framework>--tests`):
 * the counts of every test by kind, outcome, aspect and evidence; the tests
 * of each endpoint of the framework's source and of each feature; the gaps
 * of the rules; the cases the rules could not read; and the phrases without
 * Japanese. One field narrows every list by its text; a row opens its
 * endpoint or function on the テスト tab, or a test's card.
 */
export function TestsScreen({ data, index, framework, onOpenEndpoint, onOpenFunction }: TestsScreenProps) {
  const [query, setQuery] = useState('');
  const [language, setLanguage] = useTestLanguage();
  const [open, setOpen] = useState<TestEntry | null>(null);
  const source = sourceOf(framework);
  const endpoints: readonly FlowEndpoint[] = data.flows[framework]?.endpoints ?? [];
  const value = index.state === 'ready' ? index.value : undefined;
  const unknown = useMemo(() => (value === undefined ? undefined : unknownCases(value.tests)), [value]);
  const features = useMemo(() => (value === undefined ? [] : featureTests(value, data.features, endpoints, framework)), [value, data.features, endpoints, framework]);
  const gaps = useMemo(() => (value === undefined ? [] : sourceGaps(value.gaps, source)), [value, source]);
  const found = useMemo(() => (value === undefined || query.trim() === '' ? [] : value.tests.filter((test) => matchesQuery(query, test.title, test.ja, test.file, test.path.join(' ')))), [value, query]);

  const header = (
    <header className="screen-head">
      <div className="title-row">
        <h2>テスト</h2>
        {data.tests !== undefined ? <span className="chip">{data.tests.count} 件</span> : null}
        {value !== undefined ? <span className={`chip latest latest-${latestOf(value.counts).state}`}>最新: {latestOf(value.counts).words}</span> : null}
        {value?.run !== undefined ? <span className="chip mono">{[value.run.ref, value.run.commit?.slice(0, 7)].filter((part) => part !== undefined && part !== '').join(' ')}</span> : null}
      </div>
      <p className="lead">テストのカタログを、関数カタログとエンドポイントに結び付けた一覧です。エンドポイントごとの数と不足は {framework} の構成（{source} の実装）について数えます。</p>
      <div className="tests-filter">
        <label className="wiring-search">
          名前・ファイル・関数・エンドポイントで絞る <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" />
        </label>
        <LanguageSwitch language={language} onLanguage={setLanguage} />
      </div>
    </header>
  );
  if (value === undefined || unknown === undefined) {
    return (
      <section className="screen changes-screen" aria-label="テスト">
        {header}
        <p className="empty">{index.state === 'none' ? 'この地図にはテストのデータがありません。' : index.state === 'failed' ? `テストのデータを読み込めませんでした: ${index.message}` : 'テストを読み込んでいます…'}</p>
      </section>
    );
  }
  const labels = value.aspectLabels;
  const counts = value.counts;
  const latest = latestOf(counts);
  const shownEndpoints = endpoints.filter((endpoint) => matchesQuery(query, endpoint.label, endpoint.path, endpoint.id));
  const shownFeatures = features.filter((row) => matchesQuery(query, row.feature.id, row.feature.summary, ...row.endpoints.map((item) => item.endpoint.path), ...row.steps.map((item) => item.step)));
  const shownGaps = gaps.filter((gap) => matchesQuery(query, gap.text, gap.frame, gap.error, gap.endpoint, gap.feature, gap.frame === undefined ? undefined : frameName(data, gap.frame)));
  const narrow = (tests: readonly TestEntry[]) => tests.filter((test) => matchesQuery(query, test.title, test.ja, test.file, test.path.join(' ')));
  const phrases = value.untranslated.filter((phrase) => matchesQuery(query, phrase));
  const endpointButton = (key: string) => {
    const [own, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (own !== source) return null;
    const endpoint = endpoints.find((candidate) => candidate.id === id);
    return (
      <button key={key} type="button" className="link mono small" onClick={() => onOpenEndpoint(id)}>
        {endpoint === undefined ? id : endpoint.path}
      </button>
    );
  };
  const endpointsOf = (gap: Gap & { endpoints?: string[]; endpoint?: string }) => {
    const keys = gap.endpoints ?? (gap.endpoint === undefined ? [] : [`${source}:${gap.endpoint}`]);
    const own = keys.filter((key) => key.startsWith(`${source}:`));
    if (own.length === 0) return null;
    return (
      <span className="muted">
        ← {own.slice(0, 8).map((key, at) => (
          <span key={key}>
            {at > 0 ? '、' : ''}
            {endpointButton(key)}
          </span>
        ))}
        {own.length > 8 ? ` ほか ${own.length - 8}` : ''}
      </span>
    );
  };
  const entryRow = (test: TestEntry) => (
    <li key={test.id} className="test-row">
      <div className="test-row-head">
        <span className="kind">{KIND_WORDS[test.kind]}</span>
        <button type="button" className="test-open" onClick={() => setOpen(test)} title="このテストの札とソースを開く">
          <TestWords text={titleText(test, language)} />
        </button>
        <OutcomeChips test={test} labels={labels} />
        <ResultMark status={test.result} />
      </div>
      <p className="where mono">
        {test.file}:{test.lines[0]}
        {test.path.length > 0 ? <span lang="en"> · {test.path.join(' › ')}</span> : null}
      </p>
    </li>
  );

  return (
    <section className="screen changes-screen tests-screen" aria-label="テスト">
      {header}
      <div className="work tests-work">
        <div className="changes-body">
          <section className="tests-overview" aria-label="数">
            <h3>数</h3>
            <dl className="facts">
              <div className="fact">
                <dt>種類</dt>
                <dd>
                  {KIND_ORDER.map((kind) => (
                    <Count key={kind} label={KIND_WORDS[kind]} value={counts.kinds[kind] ?? 0} />
                  ))}
                </dd>
              </div>
              <div className="fact">
                <dt>期待</dt>
                <dd>
                  {(['success', 'failure', 'unknown'] as const).map((outcome) => (
                    <Count key={outcome} label={OUTCOME_WORDS[outcome]} value={counts.outcomes[outcome] ?? 0} />
                  ))}
                </dd>
              </div>
              <div className="fact">
                <dt>観点</dt>
                <dd>
                  {Object.keys(labels).map((aspect) => (
                    <Count key={aspect} label={labels[aspect] ?? aspect} value={counts.aspects[aspect] ?? 0} />
                  ))}
                  <span className="muted">（求める観点: {value.requiredAspects.map((aspect) => labels[aspect] ?? aspect).join('、') || 'なし'}）</span>
                </dd>
              </div>
              <div className="fact">
                <dt>根拠</dt>
                <dd>
                  {(['static', 'coverage', 'declared'] as const).map((evidence) => (
                    <Count key={evidence} label={EVIDENCE_WORDS[evidence]} value={counts.evidence[evidence] ?? 0} />
                  ))}
                  {!value.measured ? <span className="muted">（到達の記録なし）</span> : null}
                </dd>
              </div>
              <div className="fact">
                <dt>最新</dt>
                <dd>
                  {(['passed', 'failed', 'skipped', 'none'] as const).map((status) => (
                    <Count key={status} label={STATUS_WORDS[status]} value={counts.results[status] ?? 0} danger={status === 'failed' && (counts.results.failed ?? 0) > 0} />
                  ))}
                  <span className={`latest latest-${latest.state}`}>{latest.words}</span>
                </dd>
              </div>
            </dl>
          </section>

          {query.trim() !== '' ? (
            <section aria-label="合うテスト">
              <LazyList summary={<h3>名前・ファイルが合うテスト（{found.length}）</h3>} items={found} render={entryRow} open />
            </section>
          ) : null}

          <section aria-label="エンドポイントごと">
            <h3>
              エンドポイントごと（{source}）
            </h3>
            <div className="tests-table-wrap">
              <table className="tests-table tests-endpoints">
                <thead>
                  <tr>
                    <th scope="col">エンドポイント</th>
                    <th scope="col">テスト</th>
                    <th scope="col">API</th>
                    <th scope="col">E2E</th>
                    <th scope="col">ユニット</th>
                    <th scope="col">正常系</th>
                    <th scope="col">異常系</th>
                    <th scope="col">不足</th>
                    <th scope="col">最新</th>
                  </tr>
                </thead>
                <tbody>
                  {shownEndpoints.map((endpoint) => {
                    const ref = value.endpoints[endpointKey(framework, endpoint.id)];
                    const result = ref === undefined ? undefined : latestOf(ref.counts);
                    return (
                      <tr key={endpoint.id}>
                        <td>
                          <button type="button" className="link" onClick={() => onOpenEndpoint(endpoint.id)} title={ref === undefined ? undefined : kindsWords(ref.counts)}>
                            {endpoint.label}
                          </button>
                          <span className="route mono"> {endpoint.methods.join(' | ')} {endpoint.path}</span>
                        </td>
                        <td className="num">{ref?.counts.total ?? 0}</td>
                        <td className="num">{ref?.counts.kinds.api ?? 0}</td>
                        <td className="num">{ref?.counts.kinds.e2e ?? 0}</td>
                        <td className="num">{ref?.counts.kinds.unit ?? 0}</td>
                        <td className="num">{ref?.counts.outcomes.success ?? 0}</td>
                        <td className="num">{ref?.counts.outcomes.failure ?? 0}</td>
                        <td className="num">{ref?.gaps ?? 0}</td>
                        <td className={`latest latest-${result?.state ?? 'none'}`}>{result?.words ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-label="機能ごと">
            <h3>機能ごと（{shownFeatures.length}）</h3>
            <p className="note">機能が足すエンドポイントのテストと、機能が足すステップの関数のユニットテストです。E2E はその機能のエンドポイントを通るテストの数です。</p>
            <ul className="change-list">
              {shownFeatures.map((row) => (
                <li key={row.feature.id} className="change-row">
                  <div className="change-row-head">
                    <span className="mono">{row.feature.id}</span>
                    <span className="muted">{row.feature.summary}</span>
                    {row.endpoints.length > 0 ? <span className="chip">E2E {row.e2e}</span> : null}
                    {row.gap !== undefined ? <span className="badge badge-required">{row.gap.text}</span> : null}
                  </div>
                  {row.endpoints.length > 0 ? (
                    <p className="tests-feature-line">
                      エンドポイント:{' '}
                      {row.endpoints.map((item, at) => (
                        <span key={item.key}>
                          {at > 0 ? '、' : ''}
                          <button type="button" className="link mono" onClick={() => onOpenEndpoint(item.endpoint.id)}>
                            {item.endpoint.path}
                          </button>{' '}
                          <span className="muted">{value.endpoints[item.key] === undefined ? 'テストなし' : kindsWords(value.endpoints[item.key]?.counts ?? { total: 0, kinds: {}, outcomes: {}, aspects: {}, evidence: {}, results: {} })}</span>
                        </span>
                      ))}
                    </p>
                  ) : null}
                  {row.steps.length > 0 ? (
                    <p className="tests-feature-line">
                      ステップ:{' '}
                      {row.steps.map((item, at) => {
                        const badge = item.functionId === undefined ? undefined : testBadge(value.frames[item.functionId], value.measured);
                        return (
                          <span key={`${item.endpoint.id}/${item.step}`}>
                            {at > 0 ? '、' : ''}
                            {item.functionId !== undefined && data.functions[item.functionId] !== undefined ? (
                              <button type="button" className="link" onClick={() => onOpenFunction(item.functionId as string)}>
                                {item.label}
                              </button>
                            ) : (
                              item.label
                            )}{' '}
                            <span className="muted">
                              （{item.endpoint.path}、{item.functionId === undefined ? '関数なし' : (badge?.unit ?? 'ユニットなし')}）
                            </span>
                          </span>
                        );
                      })}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="不足">
            <h3>不足（{shownGaps.length}）</h3>
            <p className="note">不足は推論ではなく規則で求めます。ユニットテストが無い関数は一度だけ挙げ、そこへ届くエンドポイントを添えます。</p>
            <GapList data={data} gaps={shownGaps} onOpenFunction={onOpenFunction} endpointsOf={endpointsOf} open={query.trim() !== ''} />
          </section>

          <section aria-label="規則で読めなかったテスト">
            <h3>規則で読めなかったテスト</h3>
            <p className="note">テストを書き直さずに読むため、規則で読めないものはここに挙げます。宣言（<code>// @subject</code>、<code>// @aspect</code>）を足すか、観点の表（<code>tests/catalog/aspects.yaml</code>）を直すと読めるようになります。</p>
            <LazyList summary={`対象不明（${narrow(unknown.subject).length}）`} items={narrow(unknown.subject)} render={entryRow} />
            <LazyList summary={`期待結果が読めない（${narrow(unknown.outcome).length}）`} items={narrow(unknown.outcome)} render={entryRow} />
            <LazyList summary={`観点なし（${narrow(unknown.aspect).length}）`} items={narrow(unknown.aspect)} render={entryRow} />
          </section>

          <section aria-label="日本語の訳が無い言い回し">
            <h3>日本語の訳が無い言い回し（{phrases.length}）</h3>
            <p className="note">
              訳の表（<code>tests/steps/ja.yaml</code>）に無い言い回しは英語のまま出します。訳の欠けは CI を落としません。
            </p>
            <LazyList
              summary="言い回しの一覧"
              items={phrases}
              render={(phrase) => (
                <li key={phrase} className="mono phrase" lang="en">
                  {phrase}
                </li>
              )}
            />
          </section>
        </div>
      </div>
      {open !== null ? (
        <TestDrawer
          data={data}
          index={value}
          framework={framework}
          entry={open}
          language={language}
          onLanguage={setLanguage}
          onClose={() => setOpen(null)}
          onOpenFunction={onOpenFunction}
          onOpenEndpoint={onOpenEndpoint}
        />
      ) : null}
    </section>
  );
}
