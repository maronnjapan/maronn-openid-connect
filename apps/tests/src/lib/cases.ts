/**
 * The cases of an endpoint on the page: the ways a request takes through it
 * (tests/cases/<hash>.json, written by packages/test-catalog cases.ts), and
 * what the tests say about one of them, so a reader can judge a case
 * without reading every test of the endpoint.
 *
 * A case names the steps it runs. For each of those steps the page counts
 * its unit tests (正常系, 異常系, 境界値) and the failures that can come up
 * in it, each with how surely a test expects it (Verdict). A failure case
 * also names the tests that expect its error. Nothing here touches the DOM
 * or fetches.
 */
import type { EndpointCase, FailureTests, OutlineEndpoint, OutlineStep, TestEntry } from '@maronn-openid-connect/test-catalog/model';
import { endpointRef, entriesOf, sortForList, stepTests, type Db } from './data';

/**
 * How surely the tests speak for a failure: `direct` (a test of the function
 * that throws it expects this error), `code` (only other tests of the
 * endpoint expect the same error, which another cause may give), `nearby`
 * (the function that throws it has failure tests whose error could not be
 * read), `none`.
 */
export type Verdict = 'direct' | 'code' | 'nearby' | 'none';

export const VERDICTS: readonly Verdict[] = ['direct', 'code', 'nearby', 'none'];

/** The mark and the words of a verdict: never a color alone. */
export const VERDICT_MARKS: Record<Verdict, string> = { direct: '✓', code: '△', nearby: '△', none: '✗' };
export const VERDICT_LABELS: Record<Verdict, string> = {
  direct: '確認あり',
  code: '同じエラーのテストのみ',
  nearby: '異常系テストのみ',
  none: 'テストなし',
};
export const VERDICT_NOTES: Record<Verdict, string> = {
  direct: 'このエラーを投げる関数のテストが、このエラーを期待している',
  code: 'エンドポイントのほかのテストが同じエラーを期待している（原因が別のこともある）',
  nearby: 'このエラーを投げる関数に異常系のテストはあるが、どのエラーを期待するかは読み取れない',
  none: 'このエラーを期待するテストが見つからない',
};

/** How surely the tests speak for a failure (see Verdict). */
export function verdictOf(tests: FailureTests | undefined): Verdict {
  if (tests === undefined) return 'none';
  if (tests.direct.length > 0) return 'direct';
  if (tests.byCode.length > 0) return 'code';
  return tests.nearby.length > 0 ? 'nearby' : 'none';
}

/** The name of a case as plain text: the code marks left out. */
export function caseName(item: Pick<EndpointCase, 'name'>): string {
  return item.name.replace(/`/g, '');
}

/** The name of a failure case in a list under its error: the function that throws it. */
export function failureName(item: EndpointCase): string {
  return item.failure === undefined ? caseName(item) : `${item.failure.name} から`;
}

/** The cases in the groups the page lists them in: the ways into the steps, the ways the endpoint ends, and the failures by what fails, in the order each first appears. */
export interface CaseGroups {
  steps: EndpointCase[];
  exits: EndpointCase[];
  failures: Array<{ error: string; cases: EndpointCase[] }>;
}

export function caseGroups(cases: readonly EndpointCase[]): CaseGroups {
  const groups: CaseGroups = { steps: [], exits: [], failures: [] };
  for (const item of cases) {
    if (item.failure !== undefined) {
      const error = item.failure.error;
      let group = groups.failures.find((candidate) => candidate.error === error);
      if (group === undefined) {
        group = { error, cases: [] };
        groups.failures.push(group);
      }
      group.cases.push(item);
    } else if (item.kind === 'step') groups.steps.push(item);
    else groups.exits.push(item);
  }
  return groups;
}

/** How many failures have each verdict. */
export type VerdictCounts = Record<Verdict, number>;

export function countVerdicts(cases: readonly EndpointCase[]): VerdictCounts {
  const counts: VerdictCounts = { direct: 0, code: 0, nearby: 0, none: 0 };
  for (const item of cases) if (item.failure !== undefined) counts[verdictOf(item.tests)] += 1;
  return counts;
}

/** The unit tests of a step by what they expect. */
export interface UnitCounts {
  total: number;
  success: number;
  failure: number;
  boundary: number;
}

export function unitCounts(tests: readonly TestEntry[]): UnitCounts {
  return {
    total: tests.length,
    success: tests.filter((test) => test.outcome === 'success').length,
    failure: tests.filter((test) => test.outcome === 'failure').length,
    boundary: tests.filter((test) => test.aspects.includes('boundary')).length,
  };
}

/** What the tests say about one step of an endpoint, for a case or for every case. */
export interface StepCheck {
  step: OutlineStep;
  /** Its place on the way of the case, from 1; undefined for a step the case does not run. */
  order?: number;
  unit: UnitCounts;
  /** The failures that can come up in the step: the failure cases that name it. */
  failures: EndpointCase[];
  verdicts: VerdictCounts;
}

/**
 * The checks of the steps of an endpoint in the order of its outline: with a
 * case, each step it runs has its place on the way; without one, every step
 * is on.
 */
export function stepChecks(db: Db, endpoint: OutlineEndpoint, cases: readonly EndpointCase[], chosen?: EndpointCase): StepCheck[] {
  return endpoint.steps.map((step) => {
    const failures = cases.filter((item) => item.failure?.step === step.id);
    const at = chosen === undefined ? -1 : chosen.steps.indexOf(step.id);
    return { step, ...(at === -1 ? {} : { order: at + 1 }), unit: unitCounts(stepTests(db, endpoint.key, step)), failures, verdicts: countVerdicts(failures) };
  });
}

/** The steps of a case in the order it runs them, each with its check; a step the outline does not have is left out. */
export function pathChecks(checks: readonly StepCheck[], chosen: EndpointCase): StepCheck[] {
  return chosen.steps.flatMap((id) => {
    const check = checks.find((candidate) => candidate.step.id === id);
    return check === undefined ? [] : [check];
  });
}

/** What the page says about a case, or about the endpoint when no case is chosen (see summarize). */
export interface CaseSummary {
  /** The steps it runs, and those of them without a unit test. */
  steps: number;
  untested: OutlineStep[];
  /** The unit tests of those steps. */
  unit: UnitCounts;
  /** The failures that can come up in those steps, by verdict; for a failure case, its own failure alone. */
  failures: number;
  verdicts: VerdictCounts;
  /** The API and E2E tests of the endpoint (not narrowed to the case: the tests do not say which way they take). */
  api: { success: number; failure: number };
  e2e: { success: number; failure: number };
}

/** The API and E2E tests of an endpoint: those among its own tests that are no unit test. */
export function requestTests(db: Db, key: string): TestEntry[] {
  return sortForList(entriesOf(db, endpointRef(db, key)?.tests ?? []).filter((test) => test.kind === 'api' || test.kind === 'e2e'));
}

/** Summarize the checks of the steps a case runs (every step without a case), with the API and E2E tests of the endpoint. */
export function summarize(db: Db, endpoint: OutlineEndpoint, checks: readonly StepCheck[], chosen?: EndpointCase): CaseSummary {
  const on = chosen === undefined ? checks : pathChecks(checks, chosen);
  const unit: UnitCounts = { total: 0, success: 0, failure: 0, boundary: 0 };
  const verdicts: VerdictCounts = { direct: 0, code: 0, nearby: 0, none: 0 };
  for (const check of on) {
    unit.total += check.unit.total;
    unit.success += check.unit.success;
    unit.failure += check.unit.failure;
    unit.boundary += check.unit.boundary;
    for (const verdict of VERDICTS) verdicts[verdict] += check.verdicts[verdict];
  }
  // A failure case is about its own failure: the others of its steps are other cases.
  const own = chosen?.failure === undefined ? undefined : verdictOf(chosen.tests);
  const requests = requestTests(db, endpoint.key);
  const count = (kind: 'api' | 'e2e') => ({
    success: requests.filter((test) => test.kind === kind && test.outcome === 'success').length,
    failure: requests.filter((test) => test.kind === kind && test.outcome === 'failure').length,
  });
  return {
    steps: on.length,
    untested: on.filter((check) => check.unit.total === 0).map((check) => check.step),
    unit,
    failures: own === undefined ? VERDICTS.reduce((sum, verdict) => sum + verdicts[verdict], 0) : 1,
    verdicts: own === undefined ? verdicts : { direct: 0, code: 0, nearby: 0, none: 0, [own]: 1 },
    api: count('api'),
    e2e: count('e2e'),
  };
}

/**
 * The tests the list shows for a case, each once: for a failure, the tests
 * that expect its error and the unit tests of the step it comes up in; for
 * any other case, the unit tests of the steps it runs and the API and E2E
 * tests of the endpoint.
 */
export function caseTests(db: Db, endpoint: OutlineEndpoint, chosen: EndpointCase): TestEntry[] {
  const ids = new Set<string>();
  const add = (tests: readonly TestEntry[]) => {
    for (const test of tests) ids.add(test.id);
  };
  const stepOf = (id: string | undefined) => endpoint.steps.find((step) => step.id === id);
  if (chosen.failure !== undefined) {
    for (const id of [...(chosen.tests?.direct ?? []), ...(chosen.tests?.byCode ?? []), ...(chosen.tests?.nearby ?? [])]) ids.add(id);
    const step = stepOf(chosen.failure.step);
    if (step !== undefined) add(stepTests(db, endpoint.key, step));
  } else {
    for (const id of chosen.steps) {
      const step = stepOf(id);
      if (step !== undefined) add(stepTests(db, endpoint.key, step));
    }
    add(requestTests(db, endpoint.key));
  }
  return sortForList(entriesOf(db, [...ids]));
}

/** How a case ends, in words. */
export function endWords(item: Pick<EndpointCase, 'end' | 'failure'>): string {
  if (item.end === 'escapes') return `失敗がエンドポイントの外へ出る${item.failure === undefined ? '' : `（${item.failure.error}）`}`;
  if (item.end === 'error-response') return `失敗を受け取り、エラーで応答して終わる${item.failure === undefined ? '' : `（${item.failure.error}）`}`;
  return '応答して終わる';
}

/** How long the playback of a case stays on a step, in milliseconds. */
export const STEP_MS = 1100;
