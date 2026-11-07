/**
 * The pure parts of the tests on the map (docs/design-test-catalog.md §3–5):
 * what the テスト tab, the outline, the sidebar, the list of the tests and the
 * page of a pull request say about the tests of packages/test-catalog. The
 * frame of the words is Japanese; the names, the steps and the expectations
 * of the tests are English, with their Japanese when the reader chose 日本語
 * and a translation exists. Nothing here touches the DOM.
 */
import type {
  Assertion,
  Evidence,
  FeatureStep,
  FlowEndpoint,
  FrameTestsRef,
  Gap,
  MapData,
  MapFeature,
  RequestShape,
  Subject,
  TestCase,
  TestCounts,
  TestDiff,
  TestEntry,
  TestKind,
  TestOutcome,
  TestsIndex,
  TestStatus,
  TreeNode,
} from '../types';
import { featureKey } from './model';
import { nodesBelow, sourceOf, stepCall } from './trace';
import { splitPre } from './words';

/** The language the reader reads the tests in: their English, or its Japanese where there is one. */
export type TestLanguage = 'en' | 'ja';

/** The kinds of the tests in words, in the order the page lists them. */
export const KIND_WORDS: Readonly<Record<TestKind, string>> = { api: 'API', e2e: 'E2E', unit: 'ユニット', tool: 'ツール' };
export const KIND_ORDER: readonly TestKind[] = ['api', 'e2e', 'unit', 'tool'];
export const OUTCOME_WORDS: Readonly<Record<TestOutcome, string>> = { success: '正常系', failure: '異常系', unknown: '期待結果が読めない' };
export const EVIDENCE_WORDS: Readonly<Record<Evidence, string>> = { static: '静的', coverage: '到達', declared: '宣言' };
export const STATUS_WORDS: Readonly<Record<TestStatus | 'none', string>> = { passed: '成功', failed: '失敗', skipped: 'スキップ', none: '結果なし' };

/** How a test came to be about a subject, in words. */
export const HOW_WORDS: Readonly<Record<Subject['how'], string>> = {
  describe: 'describe が名指す',
  call: '期待の中で呼ぶ',
  declared: '宣言',
  coverage: '実行で到達',
  request: 'リクエストを送る',
};

/** The key of an endpoint of a framework among the endpoints of the tests: `hono:token` (Express and Fastify are Hono's), `nextjs:token`. */
export function endpointKey(framework: string, endpoint: string): string {
  return `${sourceOf(framework)}:${endpoint}`;
}

/** A signed count (`+3`, `-1`, `±0`). */
export function signed(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `${value}` : '±0';
}

/** The kinds of a set of tests in words: `テスト 212（API 41 / E2E 23 / ユニット 148）`. */
export function kindsWords(counts: TestCounts, head = 'テスト'): string {
  const kinds = KIND_ORDER.filter((kind) => (counts.kinds[kind] ?? 0) > 0).map((kind) => `${KIND_WORDS[kind]} ${counts.kinds[kind] ?? 0}`);
  return `${head} ${counts.total}${kinds.length === 0 ? '' : `（${kinds.join(' / ')}）`}`;
}

/** What a set of tests expects and the aspects they check: `正常系 61 / 異常系 149 / 境界値 4 / 認証 23`, the aspects in the order of their labels. */
export function outcomeWords(counts: TestCounts, labels: Readonly<Record<string, string>>): string {
  const outcomes = (['success', 'failure'] as const).map((outcome) => `${OUTCOME_WORDS[outcome]} ${counts.outcomes[outcome] ?? 0}`);
  const order = Object.keys(labels);
  const aspects = Object.entries(counts.aspects)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => rank(order, a) - rank(order, b))
    .map(([aspect, count]) => `${labels[aspect] ?? aspect} ${count}`);
  return [...outcomes, ...aspects].join(' / ');
}

function rank(order: readonly string[], item: string): number {
  const at = order.indexOf(item);
  return at === -1 ? order.length : at;
}

/** How the subjects of a set of tests were found: `根拠: 静的 212、到達 198`. */
export function evidenceWords(counts: TestCounts): string {
  const parts = (['static', 'coverage', 'declared'] as const).filter((evidence) => (counts.evidence[evidence] ?? 0) > 0).map((evidence) => `${EVIDENCE_WORDS[evidence]} ${counts.evidence[evidence] ?? 0}`);
  return `根拠: ${parts.length === 0 ? 'なし' : parts.join('、')}`;
}

/** The latest result of a set of tests: none run, all that ran passed, or some failed. */
export interface Latest {
  state: 'none' | 'passed' | 'failed';
  /** `実行結果なし`, `全て成功`, `成功 40、スキップ 1`, `失敗 2（成功 38）`. */
  words: string;
  failed: number;
}

/** The latest result of a set of tests (see Latest). */
export function latestOf(counts: Pick<TestCounts, 'results'>): Latest {
  const passed = counts.results.passed ?? 0;
  const failed = counts.results.failed ?? 0;
  const skipped = counts.results.skipped ?? 0;
  if (passed + failed + skipped === 0) return { state: 'none', words: '実行結果なし', failed: 0 };
  if (failed > 0) return { state: 'failed', words: `失敗 ${failed}（成功 ${passed}${skipped > 0 ? `、スキップ ${skipped}` : ''}）`, failed };
  return { state: 'passed', words: skipped > 0 ? `成功 ${passed}、スキップ ${skipped}` : '全て成功', failed: 0 };
}

/** The mark of the result of one test: `✓` (grey), `✗ 失敗` (red), `スキップ`, `—` without a result. */
export function statusMark(status: TestStatus | undefined): { text: string; tone: 'passed' | 'failed' | 'skipped' | 'none'; title: string } {
  if (status === 'passed') return { text: '✓', tone: 'passed', title: '最新の実行で成功' };
  if (status === 'failed') return { text: '✗ 失敗', tone: 'failed', title: '最新の実行で失敗' };
  if (status === 'skipped') return { text: 'スキップ', tone: 'skipped', title: '最新の実行でスキップ' };
  return { text: '—', tone: 'none', title: '実行結果なし' };
}

/** The badge of an outline row whose call or step is a function with tests: `ユニット 9`, `（境界値 1）`, `到達 38`, the split in its tooltip. */
export interface RowTests {
  unit: string;
  /** The boundary tests among them, a phone's line drops it. */
  detail?: string;
  /** The tests that reached it, when the run was measured. */
  reach?: string;
  title: string;
}

/** The badge of a row (see RowTests), or undefined for a function no unit test names and no test reached. */
export function testBadge(ref: FrameTestsRef | undefined, measured: boolean): RowTests | undefined {
  if (ref === undefined || (ref.unit === 0 && (!measured || ref.reached === 0))) return undefined;
  const split = `正常 ${ref.success} / 異常 ${ref.failure}${ref.boundary > 0 ? ` / 境界値 ${ref.boundary}` : ''}`;
  return {
    unit: `ユニット ${ref.unit}`,
    ...(ref.boundary > 0 ? { detail: `（境界値 ${ref.boundary}）` } : {}),
    ...(measured ? { reach: `到達 ${ref.reached}` } : {}),
    title: `この関数を describe が名指すユニットテスト ${ref.unit}（${split}）${measured ? `、最新の実行で到達したテスト ${ref.reached}` : ''}、関連するテスト ${ref.related}`,
  };
}

// ---- the language of the tests

/** A text of a test as the page shows it: its words, their language, and whether the reader asked for Japanese and it has none. */
export interface TestText {
  text: string;
  lang: TestLanguage;
  untranslated: boolean;
}

function pick(english: string, japanese: string | undefined, language: TestLanguage): TestText {
  if (language === 'ja' && japanese !== undefined && japanese !== '') return { text: japanese, lang: 'ja', untranslated: false };
  return { text: english, lang: 'en', untranslated: language === 'ja' };
}

/** The name of a test (a card, an entry of the index or of the diff) in the language chosen. */
export function titleText(test: { title: string; ja?: string | { title?: string } | undefined }, language: TestLanguage): TestText {
  return pick(test.title, typeof test.ja === 'string' ? test.ja : test.ja?.title, language);
}

/** An expectation in the language chosen. */
export function assertionText(assertion: Pick<Assertion, 'text' | 'ja'>, language: TestLanguage): TestText {
  return pick(assertion.text, assertion.ja, language);
}

/** A step of a scenario in the language chosen (its keyword apart, see keywordText). */
export function stepText(step: Pick<FeatureStep, 'text' | 'ja'>, language: TestLanguage): TestText {
  return pick(step.text, step.ja, language);
}

/** The Japanese keywords of Gherkin, one for each English keyword, as the catalog fixes them (packages/test-catalog vocabulary.ts japaneseKeyword). */
const JAPANESE_KEYWORDS: Readonly<Record<string, string>> = {
  Feature: '機能',
  Background: '背景',
  Scenario: 'シナリオ',
  Example: 'シナリオ',
  'Scenario Outline': 'シナリオアウトライン',
  'Scenario Template': 'シナリオアウトライン',
  Examples: '例',
  Rule: 'ルール',
  Given: '前提',
  When: 'もし',
  Then: 'ならば',
  And: 'かつ',
  But: 'しかし',
};

/** The Japanese of an English keyword of Gherkin (`Given ` → `前提`); the keyword as it is (trimmed) when it has none (`*`). */
export function japaneseKeyword(keyword: string): string {
  const english = keyword.trim();
  return JAPANESE_KEYWORDS[english] ?? english;
}

/** A keyword of a scenario in the language chosen, trimmed. */
export function keywordText(keyword: string, language: TestLanguage): string {
  return language === 'ja' ? japaneseKeyword(keyword) : keyword.trim();
}

// ---- requests, routes and expectations

/** A request of a test in words: `POST /token grant_type, code（client_secret_basic）`. */
export function requestWords(request: Pick<RequestShape, 'method' | 'path' | 'params' | 'auth'>): string {
  const params = request.params ?? [];
  return `${request.method} ${request.path}${params.length === 0 ? '' : ` ${params.join(', ')}`}${request.auth === undefined ? '' : `（${request.auth}）`}`;
}

/** What an API test sends to an endpoint: its requests to it (all of them when none names it), each method with the keys of its body or query and how it authenticates. */
export function inputOf(test: Pick<TestCase, 'requests'>, endpoint: string | undefined): Array<{ method: string; params: string[]; auth?: string }> {
  const requests = test.requests ?? [];
  const own = endpoint === undefined ? [] : requests.filter((request) => request.endpoint === endpoint);
  return (own.length > 0 ? own : requests).map((request) => ({ method: request.method, params: request.params ?? [], ...(request.auth === undefined ? {} : { auth: request.auth }) }));
}

/** One stop of the way a test goes through the OP: the path of the endpoint (or as written), and the status a measured run saw. */
export interface RouteStop {
  label: string;
  endpoint?: string;
  status?: number;
  error?: string;
}

/**
 * The endpoints a test goes through in order: those a measured run saw it
 * request against the source (`reach.requests`), else the requests its code
 * shows. A stop named by an endpoint takes the endpoint's path; the same stop
 * twice in a row (a GET and the POST of a form) is one, with the error status
 * either saw.
 */
export function routeOf(test: Pick<TestCase, 'requests' | 'reach'>, endpoints: readonly Pick<FlowEndpoint, 'id' | 'path'>[], source: string): RouteStop[] {
  const reach = (test.reach ?? []).find((entry) => entry.target === source) ?? (test.reach ?? []).find((entry) => entry.target === undefined);
  const raw: RouteStop[] =
    reach?.requests !== undefined && reach.requests.length > 0
      ? reach.requests.map((request) => ({ label: request.path, ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }), status: request.status, ...(request.error === undefined ? {} : { error: request.error }) }))
      : (test.requests ?? []).map((request) => ({ label: request.path, ...(request.endpoint === undefined ? {} : { endpoint: request.endpoint }) }));
  const stops: RouteStop[] = [];
  for (const stop of raw) {
    const path = stop.endpoint === undefined ? undefined : endpoints.find((endpoint) => endpoint.id === stop.endpoint)?.path;
    const next = path === undefined ? stop : { ...stop, label: path };
    const last = stops[stops.length - 1];
    if (last !== undefined && last.label === next.label) {
      if (failing(next.status) && !failing(last.status)) stops[stops.length - 1] = next;
      continue;
    }
    stops.push(next);
  }
  return stops;
}

/** Whether a status a run saw is an error (4xx, 5xx). */
function failing(status: number | undefined): boolean {
  return status !== undefined && status >= 400;
}

/** A route in words: `/authorize → /login → /token（401）`, a stop's status only when it is an error. */
export function routeWords(stops: readonly RouteStop[]): string {
  return stops.map((stop) => `${stop.label}${failing(stop.status) ? `（${stop.status}）` : ''}`).join(' → ');
}

/** The files of some tests in words: `apps/hono/src/x.test.ts`, `apps/hono/src/x.test.ts ほか 5 ファイル`. */
export function filesWords(files: readonly string[]): string {
  const unique = [...new Set(files)].sort();
  if (unique.length === 0) return '';
  return unique.length === 1 ? (unique[0] as string) : `${unique[0] as string} ほか ${unique.length - 1} ファイル`;
}

/** A card as the index lists it (the shape of TestEntry), so a row and a drawer read either. */
export function entryOfCard(test: TestCase): TestEntry {
  const reached = test.reach === undefined ? undefined : new Set(test.reach.flatMap((reach) => reach.functions)).size;
  return {
    id: test.id,
    kind: test.kind,
    root: test.root,
    title: test.title,
    ...(test.ja?.title === undefined ? {} : { ja: test.ja.title }),
    file: test.source.file,
    lines: test.source.lines,
    form: test.source.form,
    path: test.path,
    outcome: test.outcome,
    aspects: test.aspects,
    subjects: test.subjects,
    evidence: test.evidence,
    ...(test.targets === undefined ? {} : { targets: test.targets }),
    ...(test.skipped === true ? { skipped: true } : {}),
    ...(test.result === undefined ? {} : { result: test.result.status }),
    ...(reached === undefined ? {} : { reached }),
  };
}

/**
 * Where the card of an entry of the index is: the cards of its file
 * (TestEntry.card); for an index without them, the file of the cards of a
 * function it names (its own frame first), else of an endpoint it requests;
 * undefined for a test about nothing the map holds (its entry and its source
 * are all there is).
 */
export function cardUrlOf(index: Pick<TestsIndex, 'frames' | 'endpoints'>, entry: Pick<TestEntry, 'subjects' | 'kind'> & { card?: string }): string | undefined {
  if (entry.card !== undefined) return entry.card;
  const functions = entry.subjects.filter((subject) => subject.kind === 'function');
  const named = functions.find((subject) => subject.how === 'describe' || subject.how === 'declared') ?? functions[0];
  const frame = named === undefined ? undefined : index.frames[named.id];
  if (frame !== undefined && (entry.kind !== 'api' && entry.kind !== 'e2e')) return frame.url;
  for (const subject of entry.subjects) {
    if (subject.kind !== 'endpoint') continue;
    const endpoint = index.endpoints[`${subject.source}:${subject.id}`];
    if (endpoint !== undefined) return endpoint.url;
  }
  return frame?.url;
}

// ---- what the テスト tab speaks of

/**
 * The function a node of the outline is about for the tests: the function
 * it calls, the call its row stands for (a condition or a return of a call),
 * the one call of a step, or the function of an endpoint's step (Hono's
 * steps; `stepFunction`); undefined for any other node.
 */
export function testedFunction(node: TreeNode, enabled: ReadonlySet<string> | undefined, hasFrame: (id: string) => boolean, stepFunction?: (step: string) => string | undefined): string | undefined {
  if (node.kind === 'call') return node.target?.kind === 'function' ? node.target.id : undefined;
  if (node.kind === 'block') {
    const only = stepCall(node, enabled, hasFrame);
    if (only?.target?.kind === 'function') return only.target.id;
    return node.step === undefined ? undefined : stepFunction?.(node.step.id);
  }
  const call = splitPre(node).call;
  return call?.target?.kind === 'function' ? call.target.id : undefined;
}

/** What the テスト tab speaks of: the endpoint, a frame (a function, a body), or a step that is no one function (Next.js), by the functions it calls. */
export type TabSubject = { kind: 'endpoint' } | { kind: 'frame'; id: string } | { kind: 'step'; step: string; label: string; functions: string[] };

/**
 * What the テスト tab speaks of (design §4 「行を選ぶと、テストのタブはその関数について述べる」):
 * the function of the row selected (see testedFunction), a step of the root
 * by the functions it calls, else the frame the diagram shows; the root of
 * an endpoint is the endpoint, its tests whole.
 */
export function tabSubject(options: {
  rootId: string;
  /** The root is an endpoint's (its trace starts from it). */
  endpoint: boolean;
  /** The frame the diagram shows. */
  frameId: string;
  selected: { frame: string; node: TreeNode; frameId: string } | null;
  enabled: ReadonlySet<string> | undefined;
  hasFrame: (id: string) => boolean;
  /** The function of a step of the endpoint, by step id. */
  stepFunction?: (step: string) => string | undefined;
}): TabSubject {
  const { rootId, endpoint, frameId, selected, enabled, hasFrame, stepFunction } = options;
  const of = (id: string): TabSubject => (endpoint && id === rootId ? { kind: 'endpoint' } : { kind: 'frame', id });
  if (selected !== null) {
    const root = selected.frame === '';
    const id = testedFunction(selected.node, enabled, hasFrame, root ? stepFunction : undefined);
    if (id !== undefined) return of(id);
    const step = selected.node.kind === 'block' ? selected.node.step : undefined;
    if (step !== undefined) {
      const functions = [...new Set(nodesBelow(selected.node.branches?.[0]?.nodes ?? [], enabled).flatMap((node) => (node.kind === 'call' && node.target?.kind === 'function' ? [node.target.id] : [])))];
      if (functions.length > 0) return { kind: 'step', step: step.id, label: step.label, functions };
    }
    return of(selected.frameId);
  }
  return of(frameId);
}

// ---- the cards of a frame

/** The tests of a frame split as its tab lists them: the unit tests whose describe names it (or that declare it), then the other tests related to it by kind. */
export function frameGroups(tests: readonly TestCase[], id: string): { unit: TestCase[]; others: Array<{ kind: TestKind; tests: TestCase[] }> } {
  const unit = tests.filter((test) => test.kind === 'unit' && test.subjects.some((subject) => subject.kind === 'function' && subject.id === id && (subject.how === 'describe' || subject.how === 'declared')));
  const rest = tests.filter((test) => !unit.includes(test));
  const others = KIND_ORDER.map((kind) => ({ kind, tests: rest.filter((test) => test.kind === kind) })).filter((group) => group.tests.length > 0);
  return { unit, others };
}

/** How a test relates to a frame, in words: `describe が名指す`, `期待の中で呼ぶ`, `実行で到達`. */
export function relationWords(test: Pick<TestCase, 'subjects' | 'reach'>, id: string): string {
  const hows = [...new Set(test.subjects.filter((subject) => subject.kind === 'function' && subject.id === id).map((subject) => HOW_WORDS[subject.how]))];
  if (hows.length === 0 && (test.reach ?? []).some((reach) => reach.functions.includes(id))) hows.push(HOW_WORDS.coverage);
  return hows.join('、');
}

// ---- gaps

/** The kinds of the gaps in the order the page lists them, with their headings. */
export const GAP_KINDS: ReadonlyArray<{ kind: Gap['kind']; heading: string }> = [
  { kind: 'failure-untested', heading: '外へ出る失敗を検証するテストが無い' },
  { kind: 'aspect-missing', heading: '求める観点のテストが無い' },
  { kind: 'step-unreached', heading: 'どのテストも通らないステップ' },
  { kind: 'feature-without-e2e', heading: 'E2E のテストが通らない機能' },
  { kind: 'no-unit-test', heading: 'ユニットテストが無い関数' },
];

/** Some gaps by kind, in the order of GAP_KINDS; a kind without a gap is left out. */
export function groupGaps<T extends Gap>(gaps: readonly T[]): Array<{ kind: Gap['kind']; heading: string; gaps: T[] }> {
  return GAP_KINDS.map(({ kind, heading }) => ({ kind, heading, gaps: gaps.filter((gap) => gap.kind === kind) })).filter((group) => group.gaps.length > 0);
}

/** The gaps of the index for a source: those of its endpoints, a function without a unit test that one of its endpoints reaches, and the features'. */
export function sourceGaps(gaps: TestsIndex['gaps'], source: string): TestsIndex['gaps'] {
  return gaps.filter((gap) => {
    if (gap.endpoints !== undefined) return gap.endpoints.some((key) => key.startsWith(`${source}:`));
    if (gap.source !== undefined) return gap.source === source;
    return true;
  });
}

// ---- the list of the tests

/** The cases whose subject, outcome or aspect the rules could not read (the rules of the counts of TestsIndex.unknown). */
export function unknownCases(tests: readonly TestEntry[]): { subject: TestEntry[]; outcome: TestEntry[]; aspect: TestEntry[] } {
  return {
    subject: tests.filter((test) => (test.kind === 'unit' || test.kind === 'api') && test.subjects.length === 0),
    outcome: tests.filter((test) => test.kind !== 'tool' && test.outcome === 'unknown'),
    aspect: tests.filter((test) => test.kind !== 'tool' && test.aspects.length === 0),
  };
}

/** Whether some texts match what the reader typed: every word of it in one of them, case aside. */
export function matchesQuery(query: string, ...texts: ReadonlyArray<string | undefined>): boolean {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '');
  if (words.length === 0) return true;
  const haystack = texts.filter((text): text is string => text !== undefined).join('\n').toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** A feature on the list of the tests: the endpoints it adds (with their tests), the steps it adds (with their functions), and how many E2E tests go through its endpoints. */
export interface FeatureTests {
  feature: MapFeature;
  endpoints: Array<{ endpoint: FlowEndpoint; key: string }>;
  steps: Array<{ endpoint: FlowEndpoint; step: string; label: string; functionId?: string }>;
  e2e: number;
  gap?: Gap;
}

/** The features with what the tests say of them (see FeatureTests), for the endpoints of a framework; a feature that adds neither an endpoint nor a step is left out. */
export function featureTests(index: Pick<TestsIndex, 'tests' | 'gaps'>, features: readonly MapFeature[], endpoints: readonly FlowEndpoint[], framework: string): FeatureTests[] {
  const source = sourceOf(framework);
  const found: FeatureTests[] = [];
  for (const feature of features) {
    const key = featureKey(feature.id);
    const own = endpoints.filter((endpoint) => feature.endpoints.includes(endpoint.id)).map((endpoint) => ({ endpoint, key: endpointKey(framework, endpoint.id) }));
    const steps = endpoints.flatMap((endpoint) => endpoint.steps.filter((step) => step.feature === key || step.feature === feature.id).map((step) => ({ endpoint, step: step.id, label: step.label, ...(step.functionId === undefined ? {} : { functionId: step.functionId }) })));
    if (own.length === 0 && steps.length === 0) continue;
    const e2e = index.tests.filter((test) => test.kind === 'e2e' && test.subjects.some((subject) => subject.kind === 'endpoint' && subject.source === source && feature.endpoints.includes(subject.id))).length;
    const gap = index.gaps.find((candidate) => candidate.kind === 'feature-without-e2e' && candidate.feature === feature.id);
    found.push({ feature, endpoints: own, steps, e2e, ...(gap === undefined ? {} : { gap }) });
  }
  return found;
}

// ---- the diff of a pull request

/** The counts of the cases before and after by kind, in the page's order: those that changed, or every kind. */
export function diffKinds(diff: Pick<TestDiff, 'counts'>): Array<{ kind: string; label: string; before: number; after: number }> {
  const kinds = Object.keys(diff.counts.byKind).sort((a, b) => rank(KIND_ORDER, a) - rank(KIND_ORDER, b));
  return kinds.map((kind) => {
    const [before, after] = diff.counts.byKind[kind] ?? [0, 0];
    return { kind, label: KIND_WORDS[kind as TestKind] ?? kind, before, after };
  });
}

/** What changed in a set (the aspects, the errors of the related tests of a changed frame): the items it gained and lost. */
export function setChange(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((item) => !before.includes(item)), removed: before.filter((item) => !after.includes(item)) };
}

/** The endpoints of a source whose number of tests the pull request changed: `[key, before, after]`. */
export function endpointDiffs(diff: Pick<TestDiff, 'counts'>, source: string): Array<{ key: string; endpoint: string; before: number; after: number }> {
  return Object.entries(diff.counts.byEndpoint)
    .filter(([key, [before, after]]) => key.startsWith(`${source}:`) && before !== after)
    .map(([key, [before, after]]) => ({ key, endpoint: key.slice(key.indexOf(':') + 1), before, after }));
}

/** The name of a frame for the tests: `name()` for a function, the body's name, else the id's last part. */
export function frameName(data: Pick<MapData, 'functions' | 'bodies'>, id: string): string {
  const fn = data.functions[id];
  if (fn !== undefined) return `${fn.name}()`;
  return data.bodies[id]?.name ?? id.slice(id.indexOf('#') + 1);
}
