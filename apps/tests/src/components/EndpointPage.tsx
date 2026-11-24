/**
 * An endpoint: its steps as a timeline with the unit tests of each, and its
 * tests beside them in three sections (E2E, API, unit), each row saying what
 * it tests. Choosing a step narrows the list to the step's unit tests;
 * choosing it again shows them all. The functions it reaches below its steps
 * are folded under 「ほかの関数」, where one can be chosen the same way. The
 * code of the endpoint and of each step (its function, or its block of the
 * Route Handler) opens in the panel.
 *
 * The case panel generates requests for supported client goals. It also
 * lets readers inspect and replay the implementation's decision paths.
 *
 * In the build of a pull request the head has a chip of how many of its
 * tests the pull request added, changed and removed (which keeps only those
 * in the list), a step has a dot with how many of its unit tests it
 * touched, and the lists have the tests it removed from the endpoint, the
 * step or the function among the others.
 */
import type { EndpointCase, EndpointCases, OutlineEndpoint, OutlineStep, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { requestScenariosFor } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { endWords, STEP_MS, stepChecks, type StepCheck } from '../lib/cases';
import { countsOf, endpointRemoved, endpointTests, framesRemoved, healthOf, otherFunctions, stepCount, stepFrames, stepTests, unitTestsOf, type Db } from '../lib/data';
import { formatCount } from '../lib/format';
import { prCounts, type RemovedTest } from '../lib/pr';
import { MAIN_KINDS, type View } from '../lib/route';
import { stepHasCode } from '../lib/targets';
import { NARROW_QUERY, useApp, useJson, useTitle } from './app-context';
import { CasePanel, VerdictCountsLine } from './CasePanel';
import { CodeButton, SOURCE_NAMES } from './CodeRefs';
import { FeatureBadge } from './FeatureBadge';
import { kindParts } from './Home';
import { PrChangesButton, PrDot } from './PrMarks';
import { TestList } from './TestList';
import { Legend, PartsBar, Segmented, SourceSwitch, Words } from './ui';

/** How many of the other functions show before 「すべて表示」. */
const FIRST_OTHERS = 10;
const NO_DECISION_PATHS: readonly EndpointCase[] = [];

/** The tests the list is narrowed to, their name, and the functions they are of: a step's, or another function's; with the unit tests of them a pull request removed. */
function selection(db: Db, endpoint: OutlineEndpoint, view: View): { label: string; tests: TestEntry[]; frames: string[]; removed: RemovedTest[] } | undefined {
  if (view.step !== undefined) {
    const step = endpoint.steps.find((candidate) => candidate.id === view.step);
    if (step === undefined) return undefined;
    const frames = stepFrames(step);
    return { label: step.label, tests: stepTests(db, endpoint.key, step), frames, removed: framesRemoved(db, frames) };
  }
  if (view.fn !== undefined) return { label: db.functions[view.fn]?.name ?? view.fn, tests: unitTestsOf(db, endpoint.key, view.fn), frames: [view.fn], removed: framesRemoved(db, [view.fn]) };
  return undefined;
}

/** Whether the window is a phone's, where the list is under the steps and a choice scrolls to it. */
function narrow(): boolean {
  try {
    return window.matchMedia(NARROW_QUERY).matches;
  } catch {
    return false;
  }
}

/** Where a step is on the way of the case chosen: on it or not, and what the playback has done with it. */
type StepWay = 'on' | 'off' | 'played' | 'playing';

function Step({ db, endpoint, step, index, selected, onPick, codes, way, rail, itemRef }: { db: Db; endpoint: OutlineEndpoint; step: OutlineStep; index: number; selected: boolean; onPick: () => void; codes: boolean; way?: StepWay; rail?: boolean; itemRef?: (element: HTMLLIElement | null) => void }) {
  const count = stepCount(db, endpoint.key, step);
  const code = stepHasCode(db, step);
  const removed = db.pr === undefined ? [] : framesRemoved(db, stepFrames(step));
  const changes = db.pr === undefined ? undefined : prCounts(db.pr, stepTests(db, endpoint.key, step).map((test) => test.id), removed);
  const content = (
    <>
      <span className="step-no num">{index + 1}</span>
      <span className="step-label">{step.label}<FeatureBadge id={step.feature ?? endpoint.feature} /></span>
      {/* In the build of a pull request a column for the dot on every step, so the pills line up. */}
      {changes !== undefined && (
        <span className="step-pr">
          <PrDot counts={changes} />
        </span>
      )}
      {count > 0 ? <span className="pill num">ユニット {formatCount(count)}</span> : <span className="pill pill-none">テストなし</span>}
    </>
  );
  const button = `step-button${changes === undefined ? '' : ' step-button-pr'}`;
  return (
    <li ref={itemRef} className={`step${selected ? ' step-on' : ''}${way === undefined ? '' : ` step-way-${way}`}${rail === true ? ' step-rail' : ''}`} aria-current={way === 'playing' ? 'step' : undefined}>
      {count > 0 || removed.length > 0 ? (
        <button type="button" className={button} aria-pressed={selected} onClick={onPick}>
          {content}
        </button>
      ) : (
        <div className={`${button} step-static`}>{content}</div>
      )}
      {code ? (
        <CodeButton target={{ kind: 'step', key: endpoint.key, step: step.id }} label={`「${step.label}」のコードを見る`} className="step-code" />
      ) : (
        codes && <span className="step-code step-code-none" aria-hidden="true" />
      )}
    </li>
  );
}

/** The playback of a case on the timeline: the step of its way it is at (by index), whether it runs on its own, and how to move it. */
interface CasePlay {
  at: number | null;
  on: boolean;
  start: () => void;
  stop: () => void;
}

function Flow({ db, endpoint, view, onPick, chosen, checks, play }: { db: Db; endpoint: OutlineEndpoint; view: View; onPick: (next: Partial<View>) => void; chosen?: EndpointCase | undefined; checks?: readonly StepCheck[]; play?: CasePlay }) {
  const others = otherFunctions(db, endpoint);
  // The way of the case chosen on the timeline: the steps it runs, in the order it reaches them, and the token at the step the playback shows.
  const way = chosen?.steps.filter((id) => endpoint.steps.some((step) => step.id === id)) ?? [];
  const places = endpoint.steps.map((step) => way.indexOf(step.id));
  const first = places.findIndex((place) => place !== -1);
  const last = places.reduce((found, place, index) => (place === -1 ? found : index), -1);
  const at = play?.at ?? null;
  const playingId = at === null ? undefined : way[at];
  const items = useRef(new Map<string, HTMLLIElement>());
  const [token, setToken] = useState<number | null>(null);
  useLayoutEffect(() => {
    const item = playingId === undefined ? undefined : items.current.get(playingId);
    setToken(item === undefined ? null : item.offsetTop + item.offsetHeight / 2);
    // The step the request reaches comes into view, without a jump of the page.
    item?.scrollIntoView({ block: 'nearest', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [playingId]);
  const now = playingId === undefined ? undefined : checks?.find((check) => check.step.id === playingId);
  const wayOf = (index: number): StepWay | undefined => {
    if (chosen === undefined) return undefined;
    const place = places[index] ?? -1;
    if (place === -1) return 'off';
    if (at === null) return 'on';
    return place === at ? 'playing' : place < at ? 'played' : 'on';
  };
  // The steps keep a column for the button of their code when any step has code, so the pills line up.
  const codes = endpoint.steps.some((step) => stepHasCode(db, step));
  const [showOthers, setShowOthers] = useState(view.fn !== undefined);
  const chosenOther = others.findIndex((fn) => fn.id === view.fn);
  const [allOthers, setAllOthers] = useState(chosenOther >= FIRST_OTHERS);
  const shownOthers = allOthers ? others : others.slice(0, FIRST_OTHERS);

  return (
    <aside className="flow" aria-labelledby="flow-title">
      <h2 id="flow-title" className="side-title">
        処理の流れ
      </h2>
      {chosen !== undefined && play !== undefined && (
        <div className="way-bar">
          <button type="button" className="way-play" aria-pressed={play.on} disabled={way.length === 0} onClick={() => (play.on ? play.stop() : play.start())}>
            {play.on ? '⏸ 止める' : at !== null && at >= way.length - 1 ? '↻ もう一度再生' : '▶ 道筋を再生'}
          </button>
          <p className="way-now" aria-live="polite">
            {now === undefined || at === null ? (
              <>
                通るステップ <strong className="num">{formatCount(way.length)}</strong> 個・<Words text={endWords(chosen)} />
              </>
            ) : (
              <>
                <span className="num">
                  {at + 1} / {way.length}
                </span>{' '}
                <strong>{now.step.label}</strong>
                <span className="way-now-tests">
                  {now.unit.total === 0 ? 'ユニットテストなし' : `ユニット ${formatCount(now.unit.total)}（正常 ${formatCount(now.unit.success)}・異常 ${formatCount(now.unit.failure)}）`}
                  {now.failures.length > 0 && (
                    <>
                      ・出る失敗 {formatCount(now.failures.length)} <VerdictCountsLine counts={now.verdicts} />
                    </>
                  )}
                </span>
              </>
            )}
          </p>
        </div>
      )}
      <ol className={`timeline${chosen === undefined ? '' : ' timeline-way'}`}>
        {endpoint.steps.map((step, index) => {
          const selected = view.step === step.id;
          return (
            <Step
              key={step.id}
              db={db}
              endpoint={endpoint}
              step={step}
              index={index}
              selected={selected}
              codes={codes}
              way={wayOf(index)}
              rail={chosen !== undefined && index >= first && index < last}
              itemRef={(element) => {
                if (element === null) items.current.delete(step.id);
                else items.current.set(step.id, element);
              }}
              onPick={() => onPick(selected ? {} : { step: step.id })}
            />
          );
        })}
        {token !== null && <li className={`way-token${chosen?.end === 'response' ? '' : ' way-token-error'}`} style={{ top: token }} aria-hidden="true" />}
      </ol>
      {chosen !== undefined && (
        <p className={`way-end way-end-${chosen.end}${at !== null && at >= way.length - 1 ? ' way-end-reached' : ''}`}>
          <span aria-hidden="true">{chosen.end === 'response' ? '■' : '✕'}</span> <Words text={endWords(chosen)} />
        </p>
      )}
      {others.length > 0 && (
        <div className="others">
          <button type="button" className="others-toggle" aria-expanded={showOthers} onClick={() => setShowOthers(!showOthers)}>
            <span className="chevron" aria-hidden="true">
              {showOthers ? '▾' : '▸'}
            </span>
            ほかの関数
            <span className="muted num">{formatCount(others.length)}</span>
          </button>
          {showOthers && (
            <>
              <p className="others-note">ステップより下で届く関数です。選ぶとその関数のユニットテストを表示します。</p>
              <ul className="other-list">
                {shownOthers.map((fn) => {
                  const selected = view.fn === fn.id;
                  return (
                    <li key={fn.id}>
                      <button type="button" className={selected ? 'other other-on' : 'other'} aria-pressed={selected} title={fn.module === '' ? fn.id : fn.module} onClick={() => onPick(selected ? {} : { fn: fn.id })}>
                        <span className="other-name mono">{fn.name}</span>
                        <span className="other-count num">{formatCount(fn.count)}</span>
                        {selected && fn.module !== '' && <span className="other-module">{fn.module}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {others.length > FIRST_OTHERS && (
                <button type="button" className="text-button" aria-expanded={allOthers} onClick={() => setAllOthers(!allOthers)}>
                  {allOthers ? `テストの多い ${FIRST_OTHERS} 件だけ表示` : `すべて表示（${formatCount(others.length)}）`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </aside>
  );
}

export function EndpointPage() {
  const { db, view, go } = useApp();
  const key = `${view.source}:${view.endpoint}`;
  const endpoint = db.byEndpoint.get(key);
  const own = useMemo(() => (endpoint === undefined ? [] : endpointTests(db, endpoint)), [db, endpoint]);
  const gone = useMemo(() => (endpoint === undefined ? [] : endpointRemoved(db, endpoint)), [db, endpoint]);
  const counts = useMemo(() => countsOf(own), [own]);
  const availableFeatures = db.features.length === 0 ? undefined : db.features.map((feature) => feature.id);
  const scenarios = endpoint === undefined ? [] : requestScenariosFor(endpoint.id, availableFeatures, endpoint.source);
  const scenario = scenarios.find((item) => item.id === view.case);
  // Read the code-derived paths only while the case view is open.
  const casesUrl = db.index.cases?.[key];
  const loaded = useJson<EndpointCases>(view.cases === true ? casesUrl : undefined);
  const cases = loaded === undefined || loaded instanceof Error ? NO_DECISION_PATHS : loaded.cases;
  const chosen = cases.find((item) => item.id === view.case);
  const checks = useMemo(() => (endpoint === undefined ? [] : stepChecks(db, endpoint, cases, chosen)), [db, endpoint, cases, chosen]);
  const hasCases = scenarios.length > 0 || casesUrl !== undefined;
  // The playback of the case chosen: the step of its way the token is at, and whether it moves on its own. It belongs to its case:
  // choosing another case (or another endpoint) starts from nothing, whatever the playback of the one before was doing.
  const playOf = `${key}:${view.case ?? ''}`;
  const [played, setPlayed] = useState<{ of: string; at: number | null; on: boolean }>({ of: playOf, at: null, on: false });
  const play = played.of === playOf ? played : { of: playOf, at: null, on: false };
  const waySteps = chosen === undefined || endpoint === undefined ? 0 : chosen.steps.filter((id) => endpoint.steps.some((step) => step.id === id)).length;
  useEffect(() => {
    if (!play.on) return undefined;
    if (play.at !== null && play.at >= waySteps - 1) {
      setPlayed({ of: playOf, at: play.at, on: false });
      return undefined;
    }
    const next = play.at === null ? 0 : play.at + 1;
    const timer = window.setTimeout(() => setPlayed({ of: playOf, at: next, on: true }), play.at === null ? 0 : STEP_MS);
    return () => window.clearTimeout(timer);
  }, [play.on, play.at, playOf, waySteps]);
  // A choice on a phone scrolls to the list, which is under the steps there.
  const scrollToList = useRef(false);
  useEffect(() => {
    if (!scrollToList.current) return;
    scrollToList.current = false;
    document.querySelector('.endpoint-list')?.scrollIntoView({ block: 'start' });
  }, [view.step, view.fn]);
  useTitle(endpoint === undefined ? undefined : `${endpoint.label}（${endpoint.source === 'hono' ? 'Hono' : 'Next.js'}）`);
  if (endpoint === undefined) {
    return (
      <div className="page">
        <p className="note">
          エンドポイント {key} はありません。<a href="#/">ホームへ</a>
        </p>
      </div>
    );
  }
  const picked = selection(db, endpoint, view);
  const health = healthOf(counts.results);
  const parts = kindParts(counts);
  const pick = (next: Partial<View>) => {
    const base: View = { ...view };
    delete base.step;
    delete base.fn;
    delete base.test;
    delete base.code;
    delete base.kind;
    scrollToList.current = narrow();
    go({ ...base, ...next }, { replace: true });
  };
  /** Show the plain list or the cases; a case chosen (or none) keeps the cases. */
  const showCases = (on: boolean, id?: string) => {
    const base: View = { ...view };
    delete base.step;
    delete base.fn;
    delete base.test;
    delete base.code;
    delete base.kind;
    delete base.outcome;
    delete base.case;
    delete base.cases;
    go({ ...base, ...(on ? { cases: true } : {}), ...(id === undefined ? {} : { case: id }) }, { replace: view.cases === true && on });
  };
  const playing = chosen === undefined || play.at === null ? undefined : chosen.steps.filter((id) => endpoint.steps.some((step) => step.id === id))[play.at];
  const narrowedList =
    picked === undefined ? undefined : (
      <TestList
        tests={picked.tests}
        removed={picked.removed}
        fixedKind
        sections={MAIN_KINDS}
        target={{ current: endpoint.id, known: picked.frames }}
        title={
          <span className="filter-chip">
            <span>「{picked.label}」のユニットテスト</span>
            <button type="button" aria-label="絞り込みを外す" onClick={() => pick({})}>
              ×
            </button>
          </span>
        }
      />
    );

  return (
    <div className="page endpoint">
      <nav className="crumbs" aria-label="パンくず">
        <a href="#/">ホーム</a>
        <span aria-hidden="true">›</span>
        <span>{endpoint.group.label}</span>
      </nav>
      <header className="endpoint-head">
        <h1>{endpoint.label}</h1>
        <FeatureBadge id={endpoint.feature} link />
        <p className="endpoint-path">
          <span className="method">{endpoint.methods.join(' · ')}</span> {endpoint.path}
          {endpoint.code !== undefined && (
            <CodeButton target={{ kind: 'endpoint', key: endpoint.key }} label={`${endpoint.label}（${SOURCE_NAMES[endpoint.source]}）のコードを見る`} text="コード" className="endpoint-code" />
          )}
          {/* The map is the page beside this one (apps/map): its flow view plays a request through this endpoint on its diagram. */}
          <a className="endpoint-map" href={`../#${endpoint.source}--${encodeURIComponent(endpoint.id)};p`} title="地図で、このエンドポイントの処理の流れを図の上で再生する">
            地図でフローを再生
          </a>
        </p>
        {endpoint.summary !== undefined && (
          <p className="summary" title={endpoint.summary}>
            <Words text={endpoint.summary} />
          </p>
        )}
        <div className="endpoint-stats">
          <span className="stat-total">
            テスト <strong className="num">{formatCount(counts.total)}</strong>
          </span>
          <PartsBar parts={parts} className="bar-inline" />
          <Legend parts={parts} counts />
          <span className={`health-text health-text-${health}`}>
            <span aria-hidden="true">{health === 'failed' ? '✗' : health === 'passed' ? '✓' : '–'}</span>
            {health === 'failed' ? `${formatCount(counts.results.failed ?? 0)} 件失敗` : health === 'passed' ? 'すべて成功' : '結果なし'}
          </span>
        </div>
        <SourceSwitch place="body" />
        {/* The changes of the pull request on a line of their own, never beside the result; choosing it keeps them in the list, which it brings into view. */}
        {db.pr !== undefined && <PrChangesButton counts={prCounts(db.pr, own.map((test) => test.id), gone)} list=".endpoint-list" />}
      </header>
      <div className="endpoint-body">
        <Flow
          key={key}
          db={db}
          endpoint={endpoint}
          view={view}
          onPick={pick}
          chosen={view.cases === true ? chosen : undefined}
          checks={checks}
          play={{ at: play.at, on: play.on, start: () => setPlayed({ of: playOf, at: play.at !== null && play.at >= waySteps - 1 ? null : play.at, on: waySteps > 0 }), stop: () => setPlayed({ of: playOf, at: play.at, on: false }) }}
        />
        <section className="endpoint-list" aria-label="テスト">
          {hasCases && (
            <div className="list-mode">
              <Segmented
                label="右の欄に出すもの"
                options={[
                  { value: 'list', label: 'テスト一覧' },
                  { value: 'cases', label: scenarios.length > 0 ? 'ケースで確かめる' : '実装の道筋' },
                ]}
                value={view.cases === true ? 'cases' : 'list'}
                onChange={(value) => showCases(value === 'cases')}
              />
              {view.cases !== true && scenarios.length > 0 && <span className="list-mode-note">目的を選ぶとリクエストと期待する応答を表示します</span>}
            </div>
          )}
          {view.cases === true && hasCases ? (
            <CasePanel
              endpoint={endpoint}
              scenarios={scenarios}
              scenario={scenario}
              tests={own}
              cases={cases}
              traceState={loaded instanceof Error ? loaded : casesUrl !== undefined && loaded === undefined ? 'loading' : undefined}
              chosen={chosen}
              checks={checks}
              playing={playing}
              onChoose={(id) => showCases(true, id)}
              onStep={(id) => pick(view.step === id ? {} : { step: id })}
              narrowed={narrowedList}
            />
          ) : (
          <TestList
            tests={picked === undefined ? own : picked.tests}
            removed={picked === undefined ? gone : picked.removed}
            fixedKind={picked !== undefined}
            sections={MAIN_KINDS}
            target={picked === undefined ? { current: endpoint.id } : { current: endpoint.id, known: picked.frames }}
            title={
              picked === undefined ? (
                <span>テスト</span>
              ) : (
                <span className="filter-chip">
                  <span>「{picked.label}」のユニットテスト</span>
                  <button type="button" aria-label="絞り込みを外す" onClick={() => pick({})}>
                    ×
                  </button>
                </span>
              )
            }
            empty={picked === undefined ? 'このエンドポイントのテストはありません' : undefined}
          />
          )}
        </section>
      </div>
    </div>
  );
}
