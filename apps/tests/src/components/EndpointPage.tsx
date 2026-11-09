/**
 * An endpoint: its steps as a timeline with the unit tests of each, and its
 * tests beside them in three sections (E2E, API, unit), each row saying what
 * it tests. Choosing a step narrows the list to the step's unit tests;
 * choosing it again shows them all. The functions it reaches below its steps
 * are folded under 「ほかの関数」, where one can be chosen the same way. The
 * code of the endpoint and of each step (its function, or its block of the
 * Route Handler) opens in the panel.
 *
 * In the build of a pull request the head has a chip of how many of its
 * tests the pull request added, changed and removed (which keeps only those
 * in the list), a step has a dot with how many of its unit tests it
 * touched, and the lists have the tests it removed from the endpoint, the
 * step or the function among the others.
 */
import type { OutlineEndpoint, OutlineStep, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { useEffect, useMemo, useRef, useState } from 'react';
import { countsOf, endpointRemoved, endpointTests, framesRemoved, healthOf, otherFunctions, stepCount, stepFrames, stepTests, unitTestsOf, type Db } from '../lib/data';
import { formatCount } from '../lib/format';
import { prCounts, type RemovedTest } from '../lib/pr';
import { MAIN_KINDS, type View } from '../lib/route';
import { stepHasCode } from '../lib/targets';
import { NARROW_QUERY, useApp, useTitle } from './app-context';
import { CodeButton, SOURCE_NAMES } from './CodeRefs';
import { FeatureBadge } from './FeatureBadge';
import { kindParts } from './Home';
import { PrChangesButton, PrDot } from './PrMarks';
import { TestList } from './TestList';
import { Legend, PartsBar, SourceSwitch, Words } from './ui';

/** How many of the other functions show before 「すべて表示」. */
const FIRST_OTHERS = 10;

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

function Step({ db, endpoint, step, index, selected, onPick, codes }: { db: Db; endpoint: OutlineEndpoint; step: OutlineStep; index: number; selected: boolean; onPick: () => void; codes: boolean }) {
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
    <li className={selected ? 'step step-on' : 'step'}>
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

function Flow({ db, endpoint, view, onPick }: { db: Db; endpoint: OutlineEndpoint; view: View; onPick: (next: Partial<View>) => void }) {
  const others = otherFunctions(db, endpoint);
  // The steps keep a column for the button of their code when any step has code, so the pills line up.
  const codes = endpoint.steps.some((step) => stepHasCode(db, step));
  const [showOthers, setShowOthers] = useState(view.fn !== undefined);
  const chosen = others.findIndex((fn) => fn.id === view.fn);
  const [allOthers, setAllOthers] = useState(chosen >= FIRST_OTHERS);
  const shownOthers = allOthers ? others : others.slice(0, FIRST_OTHERS);

  return (
    <aside className="flow" aria-labelledby="flow-title">
      <h2 id="flow-title" className="side-title">
        処理の流れ
      </h2>
      <ol className="timeline">
        {endpoint.steps.map((step, index) => {
          const selected = view.step === step.id;
          return <Step key={step.id} db={db} endpoint={endpoint} step={step} index={index} selected={selected} codes={codes} onPick={() => onPick(selected ? {} : { step: step.id })} />;
        })}
      </ol>
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
        <Flow key={key} db={db} endpoint={endpoint} view={view} onPick={pick} />
        <section className="endpoint-list" aria-label="テスト">
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
        </section>
      </div>
    </div>
  );
}
