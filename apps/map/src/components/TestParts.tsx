import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FlowEndpoint, Gap, MapData, TestCase, TestEntry, TestsIndex, TestStatus } from '../types';
import {
  EVIDENCE_WORDS,
  HOW_WORDS,
  KIND_WORDS,
  OUTCOME_WORDS,
  STATUS_WORDS,
  assertionText,
  cardUrlOf,
  frameName,
  groupGaps,
  keywordText,
  requestWords,
  routeOf,
  routeWords,
  statusMark,
  stepText,
  titleText,
  type TestLanguage,
  type TestText,
} from '../lib/tests';
import { sourceLines } from '../lib/source';
import { sourceOf } from '../lib/trace';
import { Inline } from './ChangeParts';
import { DetailDrawer } from './DetailDrawer';
import { Chips, Facts } from './Parts';
import { useFrameTests, useTestSource } from './useTests';

/** The switch of the language of the tests: their English, or its Japanese where there is one. */
export function LanguageSwitch({ language, onLanguage }: { language: TestLanguage; onLanguage: (next: TestLanguage) => void }) {
  return (
    <span className="seg tests-language" role="group" aria-label="テストの記述の言語">
      {(['en', 'ja'] as const).map((value) => (
        <button key={value} type="button" aria-pressed={language === value} onClick={() => onLanguage(value)} lang={value}>
          {value === 'en' ? 'English' : '日本語'}
        </button>
      ))}
    </span>
  );
}

/** A text of a test in its language; English shown where Japanese was asked for carries the mark EN. */
export function TestWords({ text }: { text: TestText }) {
  return (
    <span lang={text.lang} className={`test-words${text.untranslated ? ' untranslated' : ''}`}>
      {text.untranslated ? (
        <span className="en-mark" title="日本語の訳がありません（英語のまま）" aria-label="英語（訳なし）">
          EN
        </span>
      ) : null}
      <Inline text={text.text} />
    </span>
  );
}

/** The mark of the result of a test in the latest run: grey, red only for a failure. */
export function ResultMark({ status, target }: { status: TestStatus | undefined; target?: string }) {
  const mark = statusMark(status);
  return (
    <span className={`result result-${mark.tone}`} title={target === undefined ? mark.title : `${target}: ${mark.title}`}>
      {mark.text}
      {target !== undefined ? <span className="result-target"> {target}</span> : null}
    </span>
  );
}

/** What a test expects and checks, as short labels: 正常系 / 異常系, its aspects. */
export function OutcomeChips({ test, labels }: { test: Pick<TestEntry, 'outcome' | 'aspects' | 'skipped'>; labels: Readonly<Record<string, string>> }) {
  return (
    <span className="test-chips">
      {test.outcome !== 'unknown' ? <span className="chip">{OUTCOME_WORDS[test.outcome]}</span> : null}
      {test.aspects.map((aspect) => (
        <span key={aspect} className="chip">
          {labels[aspect] ?? aspect}
        </span>
      ))}
      {test.skipped === true ? <span className="chip">skip</span> : null}
    </span>
  );
}

/** A test in a list: its name (which opens its card), what it expects and checks, its latest result, and what the list adds. */
export function TestRow({ test, language, labels, onOpen, kind = false, children }: { test: TestCase; language: TestLanguage; labels: Readonly<Record<string, string>>; onOpen: (test: TestCase) => void; kind?: boolean; children?: ReactNode }) {
  return (
    <li className="test-row">
      <div className="test-row-head">
        {kind ? <span className="kind">{KIND_WORDS[test.kind]}</span> : null}
        <button type="button" className="test-open" onClick={() => onOpen(test)} title="このテストの札とソースを開く">
          <TestWords text={titleText(test, language)} />
        </button>
        <OutcomeChips test={test} labels={labels} />
        <ResultMark status={test.result?.status} />
      </div>
      {children}
    </li>
  );
}

/** The lines of a test of the code (or of its feature file) in the text of the file, its lines on a ground of their own and scrolled to. */
export function TestSourceView({ index, file, lines, marks = [] }: { index: TestsIndex; file: string; lines: readonly [number, number]; marks?: readonly number[] }) {
  const loaded = useTestSource(index.sources[file]);
  const [whole, setWhole] = useState(true);
  const code = useRef<HTMLPreElement>(null);
  const text = loaded.state === 'ready' ? loaded.value.text : undefined;
  const shown = useMemo(() => (text === undefined ? [] : sourceLines(text, whole ? undefined : lines[0], whole ? undefined : lines[1])), [text, whole, lines]);
  useEffect(() => {
    const first = code.current?.querySelector<HTMLElement>('.source-line.hit');
    first?.scrollIntoView({ block: 'center' });
  }, [shown]);
  if (index.sources[file] === undefined) return <p className="empty">このテストのファイルの本文は地図のデータに含まれていません。</p>;
  if (loaded.state === 'failed') return <p className="empty" role="alert">ソースを読み込めませんでした: {loaded.message}</p>;
  if (text === undefined) return <p className="empty" role="status">ソースを読み込んでいます…</p>;
  return (
    <div className="test-source">
      <div className="code-location">
        <p className="where mono">
          {file}:{lines[0]}–{lines[1]}
        </p>
        <button type="button" className="link" onClick={() => setWhole(!whole)}>
          {whole ? 'このテストの行だけを見る' : 'ファイル全体を見る'}
        </button>
      </div>
      <pre ref={code} className="source-code test-source-code" tabIndex={0} aria-label={`${file} のソース`}>
        <code>
          {shown.map((line) => (
            <span key={line.number} className={`source-line${line.number >= lines[0] && line.number <= lines[1] ? ' hit' : ''}${marks.includes(line.number) ? ' expect' : ''}`}>
              <span className="source-line-number" aria-hidden="true">
                {line.number}
              </span>
              <span>
                {line.text}
                {'\n'}
              </span>
            </span>
          ))}
        </code>
      </pre>
      <p className="note">テストのファイルはハイライトせずに出します。このテストの行に地を付け、期待（expect と Then）の行に印を付けています。</p>
    </div>
  );
}

/** The steps of a scenario as Gherkin, the keywords and the steps in the language chosen, each data table under its step. */
export function ScenarioSteps({ steps, language }: { steps: NonNullable<TestCase['steps']>; language: TestLanguage }) {
  return (
    <ol className="scenario-steps">
      {steps.map((step) => (
        <li key={step.line} className={`scenario-step step-${step.type}`}>
          <span className="step-keyword" lang={language}>
            {keywordText(step.keyword, language)}
          </span>{' '}
          <TestWords text={stepText(step, language)} />
          {step.table !== undefined ? (
            <table className="step-table mono">
              <tbody>
                {step.table.map((row, at) => (
                  <tr key={at}>
                    {row.map((cell, column) => (at === 0 ? <th key={column}>{cell}</th> : <td key={column}>{cell}</td>))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** What a test is about, each subject a link to its page where the map has one. */
function Subjects({ data, test, framework, endpoints, onOpenFunction, onOpenEndpoint }: { data: MapData; test: TestEntry; framework: string; endpoints: readonly FlowEndpoint[]; onOpenFunction: (id: string) => void; onOpenEndpoint?: ((id: string) => void) | undefined }) {
  if (test.subjects.length === 0) return <span className="muted">対象不明（規則で読めませんでした）</span>;
  const source = sourceOf(framework);
  return (
    <ul className="plain test-subjects">
      {test.subjects.map((subject, at) => {
        if (subject.kind === 'endpoint') {
          const endpoint = endpoints.find((candidate) => candidate.id === subject.id);
          const name = endpoint === undefined ? subject.id : `${endpoint.methods.join(' | ')} ${endpoint.path}`;
          return (
            <li key={at}>
              {subject.source === source && endpoint !== undefined && onOpenEndpoint !== undefined ? (
                <button type="button" className="link mono" onClick={() => onOpenEndpoint(subject.id)}>
                  {name}
                </button>
              ) : (
                <span className="mono">{name}</span>
              )}{' '}
              <span className="muted">（{subject.source}、{HOW_WORDS[subject.how]}）</span>
            </li>
          );
        }
        return (
          <li key={at}>
            {data.functions[subject.id] !== undefined ? (
              <button type="button" className="link mono" onClick={() => onOpenFunction(subject.id)}>
                {frameName(data, subject.id)}
              </button>
            ) : (
              <span className="mono">{frameName(data, subject.id)}</span>
            )}{' '}
            <span className="muted">（{HOW_WORDS[subject.how]}）</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The facts of a card: what it is about, the specification, what it expects, the requests, the steps, the evidence, the result and the reach. */
function CardFacts({ data, framework, endpoints, entry, card, language, onOpenFunction, onOpenEndpoint }: { data: MapData; framework: string; endpoints: readonly FlowEndpoint[]; entry: TestEntry; card: TestCase | undefined; language: TestLanguage; onOpenFunction: (id: string) => void; onOpenEndpoint?: ((id: string) => void) | undefined }) {
  const source = sourceOf(framework);
  const route = card === undefined ? [] : routeOf(card, endpoints, source);
  return (
    <Facts
      rows={[
        ['対象', <Subjects data={data} test={entry} framework={framework} endpoints={endpoints} onOpenFunction={onOpenFunction} onOpenEndpoint={onOpenEndpoint} />],
        card !== undefined && card.spec.length > 0 && ['仕様', <Chips items={card.spec} />],
        card !== undefined && [
          '期待結果',
          card.assertions.length === 0 ? (
            <span className="muted">読める期待がありません</span>
          ) : (
            <ul className="plain test-assertions">
              {card.assertions.map((assertion, at) => (
                <li key={at}>
                  <TestWords text={assertionText(assertion, language)} /> <span className="muted mono">{assertion.line} 行目</span>
                </li>
              ))}
            </ul>
          ),
        ],
        card?.errors !== undefined && card.errors.length > 0 && ['期待するエラー', <Chips items={card.errors} mono />],
        card?.requests !== undefined && card.requests.length > 0 && [
          'リクエスト',
          <ul className="plain mono test-requests">
            {card.requests.map((request, at) => (
              <li key={at}>{requestWords(request)}</li>
            ))}
          </ul>,
        ],
        card?.steps !== undefined && card.steps.length > 0 && ['手順', <ScenarioSteps steps={card.steps} language={language} />],
        entry.targets !== undefined && entry.targets.length > 0 && ['実行先', <Chips items={entry.targets} />],
        ['根拠', entry.evidence.length === 0 ? <span className="muted">なし</span> : entry.evidence.map((evidence) => EVIDENCE_WORDS[evidence]).join('、')],
        [
          '結果',
          card?.result === undefined ? (
            <span className="muted">{entry.result === undefined ? '実行結果なし' : STATUS_WORDS[entry.result]}</span>
          ) : (
            <ul className="plain">
              {Object.entries(card.result.targets).map(([target, result]) => (
                <li key={target}>
                  <ResultMark status={result.status} /> {target === '' ? 'Vitest' : target}（{STATUS_WORDS[result.status]}、{Math.round(result.duration)} ms{result.attempts > 1 ? `、${result.attempts} 回目` : ''}）
                </li>
              ))}
            </ul>
          ),
        ],
        card?.reach !== undefined && [
          '到達',
          <ul className="plain">
            {card.reach.map((reach, at) => (
              <li key={at}>
                {reach.target === undefined ? '' : `${reach.target}: `}関数 {reach.functions.length} 個
                {reach.requests !== undefined && reach.requests.length > 0 ? <span className="mono">（{routeWords(routeOf({ reach: [reach] }, endpoints, reach.target ?? source))}）</span> : null}
                {reach.functions.length > 0 ? (
                  <details>
                    <summary>到達した関数</summary>
                    <ul className="plain">
                      {reach.functions.slice(0, 60).map((id) => (
                        <li key={id}>
                          {data.functions[id] !== undefined ? (
                            <button type="button" className="link mono" onClick={() => onOpenFunction(id)}>
                              {frameName(data, id)}
                            </button>
                          ) : (
                            <span className="mono">{frameName(data, id)}</span>
                          )}
                        </li>
                      ))}
                      {reach.functions.length > 60 ? <li className="muted">ほか {reach.functions.length - 60} 個</li> : null}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>,
        ],
        // The way through the OP as the code shows it; a measured run says it under 到達.
        route.length > 0 && entry.kind === 'e2e' && card?.reach === undefined && ['通るエンドポイント', <span className="mono">{routeWords(route)}</span>],
      ]}
    />
  );
}

/**
 * The card of a test (design §4 「行を押すと、そのテストの札…と、そのテストのソースを開く」):
 * its facts, and its source with its lines marked. An entry of the index
 * reads its card from the file of the frame or the endpoint it is about; a
 * test about nothing the map holds has its entry and its source only.
 */
export function TestDrawer({ data, index, framework, entry, card, language, onLanguage, onClose, onOpenFunction, onOpenEndpoint }: {
  data: MapData;
  index: TestsIndex;
  framework: string;
  entry: TestEntry;
  card?: TestCase | undefined;
  language: TestLanguage;
  onLanguage: (next: TestLanguage) => void;
  onClose: () => void;
  onOpenFunction: (id: string) => void;
  onOpenEndpoint?: ((id: string) => void) | undefined;
}) {
  const [view, setView] = useState<'card' | 'source'>('card');
  const url = card === undefined ? cardUrlOf(index, entry) : undefined;
  const loaded = useFrameTests(url);
  const found = card ?? (loaded.state === 'ready' ? loaded.value.tests.find((test) => test.id === entry.id) : undefined);
  const endpoints = data.flows[framework]?.endpoints ?? [];
  const leave = (open: () => void) => {
    onClose();
    open();
  };
  return (
    <DetailDrawer title="テスト" className="test-drawer" closeLabel="テストを閉じる" onClose={onClose}>
      <header className="test-drawer-head">
        <h4 className="test-title">
          <TestWords text={titleText(found ?? entry, language)} />
        </h4>
        <p className="test-path" lang="en">
          {entry.path.join(' › ')}
        </p>
        <div className="facts-row">
          <span className="kind">{KIND_WORDS[entry.kind]}</span>
          <OutcomeChips test={entry} labels={index.aspectLabels} />
          {entry.outcome === 'unknown' ? <span className="chip">期待結果が読めない</span> : null}
          {entry.kind !== 'tool' && entry.aspects.length === 0 ? <span className="chip">観点なし</span> : null}
          <ResultMark status={found?.result?.status ?? entry.result} />
        </div>
        <div className="test-drawer-tools">
          <span className="seg" role="group" aria-label="札とソース">
            <button type="button" aria-pressed={view === 'card'} onClick={() => setView('card')}>
              札
            </button>
            <button type="button" aria-pressed={view === 'source'} onClick={() => setView('source')}>
              ソース
            </button>
          </span>
          <LanguageSwitch language={language} onLanguage={onLanguage} />
          <span className="where mono">
            {entry.file}:{entry.lines[0]}–{entry.lines[1]}
          </span>
        </div>
      </header>
      {view === 'source' ? (
        <TestSourceView index={index} file={entry.file} lines={entry.lines} marks={[...(found?.assertions ?? []).map((assertion) => assertion.line), ...(found?.steps ?? []).filter((step) => step.type === 'outcome').map((step) => step.line)]} />
      ) : (
        <>
          {url !== undefined && loaded.state === 'loading' ? <p className="note">札を読み込んでいます…</p> : null}
          {loaded.state === 'failed' ? <p className="note">札を読み込めませんでした: {loaded.message}</p> : null}
          {found === undefined && loaded.state !== 'loading' ? <p className="note">このテストの札（期待結果、リクエスト）は、地図が持つ関数とエンドポイントのどれにも結び付かないため、索引の内容だけを出します。</p> : null}
          <CardFacts
            data={data}
            framework={framework}
            endpoints={endpoints}
            entry={entry}
            card={found}
            language={language}
            onOpenFunction={(id) => leave(() => onOpenFunction(id))}
            onOpenEndpoint={onOpenEndpoint === undefined ? undefined : (id) => leave(() => onOpenEndpoint(id))}
          />
        </>
      )}
    </DetailDrawer>
  );
}

/** A frame named on a list: its page when it is a function the map holds. */
export function FrameLink({ data, id, onOpenFunction }: { data: MapData; id: string; onOpenFunction: (id: string) => void }) {
  return data.functions[id] !== undefined ? (
    <button type="button" className="link mono" onClick={() => onOpenFunction(id)}>
      {frameName(data, id)}
    </button>
  ) : (
    <span className="mono">{frameName(data, id)}</span>
  );
}

/**
 * The gaps of the rules (design §4 不足の規則), by kind: the failures no test
 * expects, the aspects missing, the steps no test went through, the
 * features no E2E test goes through, and the functions without a unit test
 * folded (a function once, with the endpoints that reach it on the list).
 */
export function GapList({ data, gaps, onOpenFunction, endpointsOf, open = false }: {
  data: MapData;
  gaps: ReadonlyArray<Gap & { endpoints?: string[]; source?: string; endpoint?: string }>;
  onOpenFunction: (id: string) => void;
  /** The endpoints a gap of the list of the tests is about, as the page names them. */
  endpointsOf?: (gap: Gap & { endpoints?: string[]; source?: string; endpoint?: string }) => ReactNode;
  /** The functions without a unit test unfolded. */
  open?: boolean;
}) {
  const groups = groupGaps(gaps);
  if (groups.length === 0) return <p className="note">不足の規則に当たるものはありません。</p>;
  const item = (gap: Gap & { endpoints?: string[]; source?: string; endpoint?: string }, at: number) => (
    <li key={at}>
      {gap.kind === 'no-unit-test' && gap.frame !== undefined ? (
        <>
          <FrameLink data={data} id={gap.frame} onOpenFunction={onOpenFunction} />
          {gap.reached !== undefined ? <span className="muted">（到達するテスト {gap.reached}）</span> : null}
        </>
      ) : gap.kind === 'failure-untested' && gap.error !== undefined ? (
        <>
          <code>{gap.error}</code>
          {gap.frame !== undefined ? (
            <span className="muted">
              {' '}
              （<FrameLink data={data} id={gap.frame} onOpenFunction={onOpenFunction} /> から）
            </span>
          ) : null}
        </>
      ) : (
        <span>{gap.text}</span>
      )}
      {endpointsOf !== undefined ? <span className="gap-where"> {endpointsOf(gap)}</span> : null}
    </li>
  );
  return (
    <div className="gap-groups">
      {groups.map((group) =>
        group.kind === 'no-unit-test' ? (
          <details key={group.kind} className="gap-group" open={open}>
            <summary>
              {group.heading}（{group.gaps.length}）
            </summary>
            <ul className="plain gap-list">{group.gaps.map(item)}</ul>
          </details>
        ) : (
          <section key={group.kind} className="gap-group">
            <h5>
              {group.heading}（{group.gaps.length}）
            </h5>
            <ul className="plain gap-list">{group.gaps.map(item)}</ul>
          </section>
        ),
      )}
    </div>
  );
}
