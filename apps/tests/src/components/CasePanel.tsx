/**
 * The cases of an endpoint beside its steps: the ways a request takes
 * through it (the way into a step, each way it ends, each failure), and what
 * the tests say about the one chosen, so a reader can judge whether a case
 * is covered without reading every test of the endpoint.
 *
 * - With no case chosen: what the tests say about the endpoint as a whole,
 *   and the cases to choose from, the failures grouped by what fails with a
 *   mark of how surely a test expects each.
 * - With a case: first the case as a request going through the endpoint
 *   (CaseFlow: an example request, the steps it goes through, the result),
 *   then what the tests say about it (テストの確認状況): its verdicts (the
 *   unit tests of the steps it runs, the failures that can come up on its
 *   way, the API and E2E tests of the endpoint, how it ends), a table of
 *   its steps, and its tests. A failure lists the tests that expect its
 *   error, those of the function that throws it apart from the others.
 *
 * A case some recorded request took shows a one-line preview of the first
 * in the list (`POST /token · grant_type=refresh_token → 200`).
 *
 * Every verdict is a mark and words, never a color alone, and says the rule
 * it comes from (lib/cases.ts).
 */
import type { EndpointCase, OutlineEndpoint, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { useState, type ReactNode } from 'react';
import {
  caseGroups,
  caseName,
  caseTests,
  endWords,
  failureName,
  pathChecks,
  summarize,
  VERDICT_LABELS,
  VERDICT_MARKS,
  VERDICT_NOTES,
  VERDICTS,
  verdictOf,
  type CaseSummary,
  type StepCheck,
  type Verdict,
  type VerdictCounts,
} from '../lib/cases';
import { entriesOf, sortForList } from '../lib/data';
import { previewOf } from '../lib/exchange';
import { formatCount } from '../lib/format';
import { useApp } from './app-context';
import { CaseFlow } from './CaseFlow';
import { FeatureBadge } from './FeatureBadge';
import { Rows, rowOf, TestList } from './TestList';
import { Words } from './ui';

/** How many tests of a group of a failure show before 「すべて表示」. */
const FIRST_TESTS = 8;

/** The mark of a verdict with its words for a screen reader and on hover. */
export function VerdictMark({ verdict }: { verdict: Verdict }) {
  return (
    <span className={`verdict verdict-${verdict}`} role="img" aria-label={VERDICT_LABELS[verdict]} title={`${VERDICT_LABELS[verdict]}: ${VERDICT_NOTES[verdict]}`}>
      {VERDICT_MARKS[verdict]}
    </span>
  );
}

/**
 * How many failures have each verdict, as marks with counts: ✓ the ones a
 * test of the function that throws them expects, △ the ones only weaker
 * evidence speaks for (the same error elsewhere, or a failure test whose
 * error was not read: the title tells the two apart), ✗ the ones no test
 * expects; a mark with none is left out.
 */
export function VerdictCountsLine({ counts }: { counts: VerdictCounts }) {
  const weak = counts.code + counts.nearby;
  const parts: Array<{ verdict: Verdict; count: number; words: string }> = [
    { verdict: 'direct', count: counts.direct, words: `${VERDICT_LABELS.direct}: ${VERDICT_NOTES.direct}` },
    { verdict: 'code', count: weak, words: `${VERDICT_LABELS.code} ${formatCount(counts.code)}・${VERDICT_LABELS.nearby} ${formatCount(counts.nearby)}` },
    { verdict: 'none', count: counts.none, words: `${VERDICT_LABELS.none}: ${VERDICT_NOTES.none}` },
  ];
  const shown = parts.filter((part) => part.count > 0);
  if (shown.length === 0) return <span className="muted">なし</span>;
  return (
    <span className="verdict-counts">
      {shown.map((part) => (
        <span key={part.verdict} className={`verdict-count verdict-${part.verdict}`} title={part.words}>
          <span aria-hidden="true">{VERDICT_MARKS[part.verdict]}</span>
          <span className="visually-hidden">{part.words}</span>
          <span className="num">{formatCount(part.count)}</span>
        </span>
      ))}
    </span>
  );
}

/** The worst verdict among some counts: what a line about them is marked with. */
function worst(counts: VerdictCounts): Verdict {
  if (counts.none > 0) return 'none';
  if (counts.nearby > 0) return 'nearby';
  return counts.code > 0 ? 'code' : 'direct';
}

/** One line of the verdicts of a case: a mark, what it says, and a note under it. */
function Line({ mark, tone, children, note }: { mark: string; tone: 'good' | 'warn' | 'bad' | 'plain'; children: ReactNode; note?: ReactNode }) {
  return (
    <li className={`check-line check-${tone}`}>
      <span className="check-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="check-text">
        {children}
        {note !== undefined && <span className="check-note">{note}</span>}
      </span>
    </li>
  );
}

/** What the tests say about a case, or about the whole endpoint, a line a rule. */
function Verdicts({ summary, chosen }: { summary: CaseSummary; chosen: EndpointCase | undefined }) {
  const { steps, untested, unit, failures, verdicts, api, e2e } = summary;
  const requests = api.success + api.failure + e2e.success + e2e.failure;
  const own = chosen?.failure === undefined ? undefined : verdictOf(chosen.tests);
  const direct = chosen?.tests?.direct.length ?? 0;
  const byCode = chosen?.tests?.byCode.length ?? 0;
  const nearby = chosen?.tests?.nearby.length ?? 0;
  const failureTone = failures === 0 ? 'plain' : verdicts.none > 0 ? 'bad' : verdicts.code + verdicts.nearby > 0 ? 'warn' : 'good';
  return (
    <ul className="check-lines">
      {own !== undefined ? (
        <Line
          mark={VERDICT_MARKS[own]}
          tone={own === 'direct' ? 'good' : own === 'none' ? 'bad' : 'warn'}
          note={
            own === 'none'
              ? 'テストが期待するエラー（エラーコード、エラーのクラス）に、この失敗が見つかりません。'
              : `投げる関数のテスト ${formatCount(direct)} 件・同じエラーを期待するほかのテスト ${formatCount(byCode)} 件${nearby > 0 ? `・投げる関数の異常系テスト ${formatCount(nearby)} 件` : ''}`
          }
        >
          この失敗を確かめるテスト: <strong>{VERDICT_LABELS[own]}</strong>
        </Line>
      ) : null}
      <Line
        mark={steps === 0 ? '–' : untested.length === 0 ? '✓' : '△'}
        tone={steps === 0 ? 'plain' : untested.length === 0 ? 'good' : 'warn'}
        note={
          <>
            ユニットテスト {formatCount(unit.total)} 件（正常系 {formatCount(unit.success)}・異常系 {formatCount(unit.failure)}・境界値 {formatCount(unit.boundary)}）
            {untested.length > 0 && <>。テストなし: {untested.map((step) => step.label).join('、')}</>}
          </>
        }
      >
        {chosen === undefined ? 'ステップ' : '通るステップ'} <strong className="num">{formatCount(steps)}</strong> 個のうち <strong className="num">{formatCount(steps - untested.length)}</strong> 個にユニットテストがあります
      </Line>
      {own === undefined ? (
        <Line mark={failures === 0 ? '–' : VERDICT_MARKS[worst(verdicts)]} tone={failureTone} note={failures === 0 ? undefined : <VerdictLegend counts={verdicts} />}>
          {failures === 0 ? (
            <>{chosen === undefined ? 'このエンドポイント' : 'この道筋'}のステップから外へ出る失敗は、地図からは読み取れません</>
          ) : (
            <>
              {chosen === undefined ? 'このエンドポイント' : 'この道筋'}で起こり得る失敗 <strong className="num">{formatCount(failures)}</strong> 種のうち <strong className="num">{formatCount(verdicts.direct)}</strong> 種を、投げる関数のテストが確かめています
            </>
          )}
        </Line>
      ) : null}
      <Line
        mark={requests === 0 ? '✗' : '✓'}
        tone={requests === 0 ? 'bad' : 'good'}
        note={requests === 0 ? undefined : 'テストがどの道筋を通るかはコードから読み取れないので、E2E と API のテストはケースごとに分けていません。'}
      >
        {requests === 0 ? (
          'このエンドポイントにリクエストする E2E・API テストがありません'
        ) : (
          <>
            エンドポイントにリクエストするテスト: E2E <strong className="num">{formatCount(e2e.success + e2e.failure)}</strong> 件（正常系 {formatCount(e2e.success)}・異常系 {formatCount(e2e.failure)}）、API <strong className="num">{formatCount(api.success + api.failure)}</strong> 件（正常系 {formatCount(api.success)}・異常系 {formatCount(api.failure)}）
          </>
        )}
      </Line>
      {chosen !== undefined ? (
        <Line mark={chosen.end === 'response' ? '■' : '✕'} tone="plain">
          終わり方: <Words text={endWords(chosen)} />
        </Line>
      ) : null}
    </ul>
  );
}

/** The counts of the verdicts in words, for the note of a line. */
function VerdictLegend({ counts }: { counts: VerdictCounts }) {
  return (
    <span className="verdict-legend">
      {VERDICTS.filter((verdict) => counts[verdict] > 0).map((verdict) => (
        <span key={verdict} className={`verdict-count verdict-${verdict}`} title={VERDICT_NOTES[verdict]}>
          <span aria-hidden="true">{VERDICT_MARKS[verdict]}</span> {VERDICT_LABELS[verdict]} <span className="num">{formatCount(counts[verdict])}</span>
        </span>
      ))}
    </span>
  );
}

/** The first request a recorded run sent that took a case, in one line, with how many did; nothing for a case none took. */
function ExamplePreview({ item }: { item: EndpointCase }) {
  const first = item.examples?.[0];
  if (first === undefined) return null;
  const count = item.exampleCount ?? item.examples?.length ?? 1;
  return (
    <span className="case-preview">
      <span className="visually-hidden">リクエストの例: </span>
      <span className="case-preview-request">{previewOf(first)}</span>
      {count > 1 && <span className="case-preview-count">・この道筋を通ったリクエスト {formatCount(count)} 件</span>}
    </span>
  );
}

/** The failures that can come up in a step, each with its verdict; choosing one shows that case. */
function StepFailures({ failures, onChoose }: { failures: readonly EndpointCase[]; onChoose: (id: string) => void }) {
  return (
    <ul className="step-failures">
      {failures.map((item) => {
        const verdict = verdictOf(item.tests);
        return (
          <li key={item.id}>
            <button type="button" className="failure-row" onClick={() => onChoose(item.id)} title="このケースを見る">
              <VerdictMark verdict={verdict} />
              <code className="failure-error">{item.failure?.error ?? caseName(item)}</code>
              <span className="failure-from">{failureName(item)}</span>
              <span className="failure-verdict">{VERDICT_LABELS[verdict]}</span>
              <ExamplePreview item={item} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The steps a case runs (every step without a case), a row a step: its unit tests by what they expect, and the failures that can come up in it. */
function StepTable({ endpoint, rows, playing, onStep, onChoose }: { endpoint: OutlineEndpoint; rows: readonly StepCheck[]; playing: string | undefined; onStep: (id: string) => void; onChoose: (id: string) => void }) {
  const { view } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return null;
  return (
    <div className="check-table-wrap">
      <table className="check-table">
        <thead>
          <tr>
            <th scope="col" className="check-no">
              #
            </th>
            <th scope="col">ステップ</th>
            <th scope="col" className="check-unit">
              ユニットテスト
            </th>
            <th scope="col" className="check-failures">
              出る失敗
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const total = row.failures.length;
            const expanded = open === row.step.id;
            return (
              <tr key={row.step.id} className={`${view.step === row.step.id ? 'check-row-on' : ''}${playing === row.step.id ? ' check-row-playing' : ''}`}>
                <td className="check-no num">{row.order ?? index + 1}</td>
                <td>
                  <span className="check-step">
                    {row.step.label}
                    <FeatureBadge id={row.step.feature ?? endpoint.feature} />
                  </span>
                  {expanded && <StepFailures failures={row.failures} onChoose={onChoose} />}
                </td>
                <td className="check-unit">
                  {row.unit.total === 0 ? (
                    <span className="pill pill-none">テストなし</span>
                  ) : (
                    <button type="button" className="check-cell" aria-pressed={view.step === row.step.id} onClick={() => onStep(row.step.id)} title="このステップのユニットテストだけを一覧に出す">
                      <strong className="num">{formatCount(row.unit.total)}</strong>
                      <span className="check-split">
                        正常 {formatCount(row.unit.success)}・異常 {formatCount(row.unit.failure)}
                        {row.unit.boundary > 0 ? `・境界 ${formatCount(row.unit.boundary)}` : ''}
                      </span>
                    </button>
                  )}
                </td>
                <td className="check-failures">
                  {total === 0 ? (
                    <span className="muted">–</span>
                  ) : (
                    <button type="button" className="check-cell" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : row.step.id)} title="このステップで起こり得る失敗を並べる">
                      <strong className="num">{formatCount(total)}</strong>
                      <VerdictCountsLine counts={row.verdicts} />
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Some tests of a failure under a heading that says why they are listed, the first few until the reader asks for all. */
function EvidenceTests({ title, note, tests, current }: { title: string; note: string; tests: readonly TestEntry[]; current: string }) {
  const [all, setAll] = useState(false);
  if (tests.length === 0) return null;
  const shown = all ? tests : tests.slice(0, FIRST_TESTS);
  return (
    <section className="evidence" aria-label={title}>
      <h3 className="evidence-title">
        {title} <span className="muted num">{formatCount(tests.length)}</span>
      </h3>
      <p className="evidence-note">{note}</p>
      <Rows rows={shown.map(rowOf)} target={{ current }} />
      {tests.length > FIRST_TESTS && (
        <button type="button" className="text-button" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? `最初の ${FIRST_TESTS} 件だけ表示` : `すべて表示（${formatCount(tests.length)}）`}
        </button>
      )}
    </section>
  );
}

/** The cases to choose from: the ways into the steps and the ways the endpoint ends as rows, the failures grouped by what fails. */
function CaseList({ cases, onChoose }: { cases: readonly EndpointCase[]; onChoose: (id: string) => void }) {
  const groups = caseGroups(cases);
  const [open, setOpen] = useState<string | null>(null);
  const row = (item: EndpointCase) => (
    <li key={item.id}>
      <button type="button" className="case-row" onClick={() => onChoose(item.id)}>
        <span className="case-name">
          <Words text={item.name} />
        </span>
        <span className="case-meta">
          ステップ {formatCount(item.steps.length)}・{item.end === 'response' ? '応答' : item.end === 'escapes' ? '失敗が外へ' : 'エラー応答'}
        </span>
        <ExamplePreview item={item} />
      </button>
    </li>
  );
  return (
    <div className="case-list">
      {groups.steps.length > 0 && (
        <section aria-label="ステップへ進む道筋">
          <h3 className="case-group">ステップへ進む道筋</h3>
          <ul className="case-rows">{groups.steps.map(row)}</ul>
        </section>
      )}
      {groups.exits.length > 0 && (
        <section aria-label="終わり方">
          <h3 className="case-group">終わり方</h3>
          <ul className="case-rows">{groups.exits.map(row)}</ul>
        </section>
      )}
      {groups.failures.length > 0 && (
        <section aria-label="失敗で終わる">
          <h3 className="case-group">
            失敗で終わる <span className="muted num">{formatCount(groups.failures.reduce((sum, group) => sum + group.cases.length, 0))}</span>
          </h3>
          <ul className="case-rows">
            {groups.failures.map((group) => {
              const counts: VerdictCounts = { direct: 0, code: 0, nearby: 0, none: 0 };
              for (const item of group.cases) counts[verdictOf(item.tests)] += 1;
              const expanded = open === group.error;
              return (
                <li key={group.error}>
                  <button type="button" className="case-row case-failure" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : group.error)}>
                    <span className="chevron" aria-hidden="true">
                      {expanded ? '▾' : '▸'}
                    </span>
                    <code className="failure-error">{group.error}</code>
                    <span className="case-meta">投げる場所 {formatCount(group.cases.length)}</span>
                    <VerdictCountsLine counts={counts} />
                  </button>
                  {expanded && <StepFailures failures={group.cases} onChoose={onChoose} />}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

/** What the case panel shows and what it tells the page (see the module comment). */
export interface CasePanelProps {
  endpoint: OutlineEndpoint;
  cases: readonly EndpointCase[];
  chosen: EndpointCase | undefined;
  /** The checks of every step of the endpoint (lib/cases stepChecks), with the place of each on the way of the case chosen. */
  checks: readonly StepCheck[];
  /** The step the playback of the case is at, by id. */
  playing: string | undefined;
  onChoose: (id: string | undefined) => void;
  /** Narrow the list to the unit tests of a step, or back. */
  onStep: (id: string) => void;
  /** The list of the tests of a step the reader narrowed to, in place of the case's own. */
  narrowed: ReactNode | undefined;
}

/** The cases of an endpoint and what the tests say about the one chosen (see the module comment). */
export function CasePanel({ endpoint, cases, chosen, checks, playing, onChoose, onStep, narrowed }: CasePanelProps) {
  const { db } = useApp();
  const summary = summarize(db, endpoint, checks, chosen);
  const groups = caseGroups(cases);
  const rows = chosen === undefined ? checks : pathChecks(checks, chosen);
  const of = (ids: readonly string[] | undefined) => sortForList(entriesOf(db, ids ?? []));
  return (
    <div className="case-panel">
      <div className="case-head">
        <label className="case-pick">
          <span className="case-pick-label">ケース</span>
          <select value={chosen?.id ?? ''} onChange={(event) => onChoose(event.target.value === '' ? undefined : event.target.value)} aria-label="確かめるケース">
            <option value="">エンドポイント全体（ケースを選ぶ）</option>
            {groups.steps.length > 0 && (
              <optgroup label="ステップへ進む道筋">
                {groups.steps.map((item) => (
                  <option key={item.id} value={item.id}>
                    {caseName(item)}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.exits.length > 0 && (
              <optgroup label="終わり方">
                {groups.exits.map((item) => (
                  <option key={item.id} value={item.id}>
                    {caseName(item)}
                  </option>
                ))}
              </optgroup>
            )}
            {groups.failures.map((group) => (
              <optgroup key={group.error} label={`失敗: ${group.error}`}>
                {group.cases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {VERDICT_MARKS[verdictOf(item.tests)]} {failureName(item)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {chosen !== undefined && (
          <button type="button" className="text-button" onClick={() => onChoose(undefined)}>
            ケースの一覧に戻る
          </button>
        )}
      </div>

      {chosen !== undefined && <CaseFlow key={chosen.id} endpoint={endpoint} cases={cases} chosen={chosen} playing={playing} />}

      <section className="check" aria-label="確認状況">
        <h2 className="check-title">{chosen === undefined ? 'エンドポイント全体の確認状況' : 'テストの確認状況'}</h2>
        <Verdicts summary={summary} chosen={chosen} />
      </section>

      {chosen === undefined ? (
        <>
          <section aria-label="ケースの一覧">
            <h2 className="check-title">ケースを選んで確かめる</h2>
            <p className="evidence-note">リクエストが通る道筋ごとに、リクエストの例・通るステップ・結果と、そのテスト・起こり得る失敗を確かめられます。左の「処理の流れ」で道筋を再生できます。</p>
            <CaseList cases={cases} onChoose={onChoose} />
          </section>
          <section aria-label="ステップごとの確認">
            <h2 className="check-title">ステップごとの確認</h2>
            <StepTable endpoint={endpoint} rows={rows} playing={playing} onStep={onStep} onChoose={onChoose} />
          </section>
          {narrowed}
        </>
      ) : (
        <>
          <section aria-label="通るステップのテスト">
            <h2 className="check-title">通るステップのテスト</h2>
            <StepTable endpoint={endpoint} rows={rows} playing={playing} onStep={onStep} onChoose={onChoose} />
          </section>
          {narrowed ??
            (chosen.failure !== undefined ? (
              <>
                <EvidenceTests title="この失敗を期待する、投げる関数のテスト" note={`${chosen.failure.name} を対象にするテスト（名指す、呼ぶ、計測した実行で到達する）のうち、${chosen.failure.code ?? chosen.failure.error} を期待するもの。`} tests={of(chosen.tests?.direct)} current={endpoint.id} />
                <EvidenceTests title="同じエラーを期待する、ほかのテスト" note="このエンドポイントのテストのうち、同じエラーを期待するもの。同じエラーは別の原因でも返るので、この失敗を確かめているとは限りません。" tests={of(chosen.tests?.byCode)} current={endpoint.id} />
                <EvidenceTests title="投げる関数の異常系テスト" note="期待するエラーをコードから読み取れなかった、投げる関数の異常系テスト。" tests={of(chosen.tests?.nearby)} current={endpoint.id} />
                {verdictOf(chosen.tests) === 'none' && <p className="note list-empty">この失敗を期待するテストは見つかりませんでした。</p>}
              </>
            ) : (
              <TestList tests={caseTests(db, endpoint, chosen)} sections={['e2e', 'api', 'unit']} target={{ current: endpoint.id }} title={<span>このケースのテスト（通るステップのユニットテストと、エンドポイントの E2E・API テスト）</span>} />
            ))}
        </>
      )}
    </div>
  );
}
