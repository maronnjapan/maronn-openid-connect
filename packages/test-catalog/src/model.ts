/**
 * The data of the tests on the map (apps/map/docs/design-test-catalog.md):
 * the test catalog, a card a test case, joined to the function catalog of
 * the map by the ids of its functions (`<root>:<module>#<name>`) and endpoint
 * bodies (`endpoint:<id>`), with the results and the reach of a run and, in
 * the map of a pull request, the diff of the tests.
 *
 * The page (apps/map) imports these types as
 * `@maronn-openid-connect/test-catalog/model`, so this module has no code and
 * imports nothing.
 */

/**
 * What kind of test a case is, by where it is and what it does:
 *
 * - `e2e`: a Playwright test of tests/e2e/specs, or a scenario of a feature
 *   file that runs over HTTP (`@http`), against a running OP.
 * - `api`: a test of apps/* that sends a request to the path of an endpoint
 *   (`app.request()`, a Request handed to a Route Handler), or a scenario
 *   that runs in the process (`@hono`, `@nextjs`).
 * - `unit`: a test of packages/* or apps/* whose subject is a function of the
 *   catalog and that sends no request.
 * - `tool`: a test of the CLI, the map, the analysis, the test catalog and
 *   the scripts; listed, never on the map of the endpoints.
 */
export type TestKind = 'unit' | 'api' | 'e2e' | 'tool';

/** Whether a case expects success or failure, read from what it expects. */
export type TestOutcome = 'success' | 'failure' | 'unknown';

/** How the subject of a case was found: declared by its author, read from the code, or measured in a run. */
export type Evidence = 'declared' | 'static' | 'coverage';

/** What a case tests. */
export type Subject =
  | { kind: 'function'; id: string; how: 'describe' | 'call' | 'declared' | 'coverage' }
  | { kind: 'endpoint'; id: string; source: 'hono' | 'nextjs'; how: 'request' | 'declared' | 'coverage' }
  | { kind: 'member'; id: string; how: 'coverage' };

/** One thing a case expects: an `expect(...)` of the code, or a `Then` step of a scenario. */
export interface Assertion {
  /** The value it checks, in words: `response.status`, `error`, `body.scope`. */
  actual: string;
  /** The matcher (`toBe`, `toMatchObject`), or `step` for a `Then` step. */
  matcher: string;
  /** The expected value when it is written as a literal; else absent, and `text` keeps the expression. */
  expected?: unknown;
  negated?: boolean;
  mode?: 'resolves' | 'rejects';
  /** The line it is on. */
  line: number;
  /** The line the page shows, in English: `the HTTP status is 401`. */
  text: string;
  /** The phrase of the translation table `text` matched (`the HTTP status is {int}`), when one did. */
  phrase?: string;
  /** Its Japanese, when the translation table has the phrase: `HTTP ステータスが 401 である`. */
  ja?: string;
}

/** A request a case sends. */
export interface RequestShape {
  /** The endpoint its path matched, by id. */
  endpoint?: string;
  method: string;
  /** The path as written (`/token`, `${TEST_ISSUER}/token` → `/token`). */
  path: string;
  /** The keys of its body or query (`grant_type`, `code`). */
  params?: string[];
  /** How it authenticates the client: `client_secret_basic`, `client_secret_post`, `bearer`. */
  auth?: string;
  line: number;
}

/** A step of a scenario of a feature file. */
export interface FeatureStep {
  /** The keyword as written (`Given `, `And `), and the kind it stands for. */
  keyword: string;
  type: 'context' | 'action' | 'outcome' | 'unknown';
  text: string;
  /** The expression of the step definition it matched (`the HTTP status is {int}`). */
  phrase?: string;
  /** Its Japanese, from the translation table. */
  ja?: string;
  /** Its data table, the header row first. */
  table?: string[][];
  line: number;
}

/** A test case: a test of the code (`it`, `test`) or a scenario (a row of the examples of an outline). */
export interface TestCase {
  /** A stable id (see id.ts): the `@id` tag, the `// @test-id` comment, else a hash of the root, the describe path and the title. */
  id: string;
  kind: TestKind;
  /** The root it belongs to: core, experimental, google-login, hono, nextjs, e2e, features, or the tool (cli, map, map-analysis, test-catalog, test-reach, scripts). */
  root: string;
  source: { file: string; lines: [number, number]; form: 'code' | 'feature' };
  /** The name of the `it`, or of the scenario, in English. */
  title: string;
  /** Its translation (the `// ja:` comment above the `it`, the `ja:` line of a scenario); absent, the page shows the English. */
  ja?: { title?: string };
  /** The `describe` blocks it is in, or the feature (and the outline) of a scenario. */
  path: string[];
  subjects: Subject[];
  requests?: RequestShape[];
  outcome: TestOutcome;
  /** boundary, authentication, authorization, security, ... (aspects.yaml). */
  aspects: string[];
  /** The sections of the specifications it cites: `RFC 6749 §5.2`. */
  spec: string[];
  assertions: Assertion[];
  /** The errors it expects: OAuth error codes (`invalid_client`) and error classes (`TokenError`). */
  errors?: string[];
  /** The steps of a scenario. */
  steps?: FeatureStep[];
  /** Where it runs: the OPs an E2E test or a scenario runs against (hono, nextjs, http). */
  targets?: string[];
  /** How the subjects were found. */
  evidence: Evidence[];
  /** Marked `skip`, `todo` or `fixme` in the code. */
  skipped?: boolean;
  /** A hash of its body (its steps for a scenario), its whitespace aside: the diff of the tests tells a test that changed only there. */
  digest: string;
  /** The result of the latest run, by target ('' for a Vitest test). */
  result?: TestResult;
  /** What it ran in the latest run measured with MARONN_REACH=1, by target. */
  reach?: TestReach[];
}

export type TestStatus = 'passed' | 'failed' | 'skipped';

/** The result of a case in a run: by target, and the worst of them. */
export interface TestResult {
  status: TestStatus;
  /** The result against each target (`hono`, `nextjs`; '' for Vitest). */
  targets: Record<string, { status: TestStatus; duration: number; attempts: number }>;
}

/** What a case ran against one target: the functions and members it reached, and the endpoints it requested in order. */
export interface TestReach {
  target?: string;
  functions: string[];
  members?: string[];
  requests?: Array<{ endpoint?: string; method: string; path: string; status: number; error?: string }>;
}

/** A run of the tests (Vitest and Playwright JSON reports, and the reach of MARONN_REACH=1). */
export interface TestRun {
  run: { ref?: string; commit?: string; at?: string };
  /** By test id. */
  results: Record<string, TestResult>;
}

/**
 * What packages/test-reach writes for a test, one JSON object a line, before
 * the catalog knows the test: the file, the describe path and the title name
 * it the way the catalog does, and the functions it ran are positions in the
 * source files (repository paths, lines from 1) the catalog maps to its ids.
 */
export interface RawReach {
  file: string;
  path: string[];
  title: string;
  target?: string;
  functions: Array<{ file: string; line: number; name?: string }>;
  requests?: Array<{ method: string; url: string; status: number; error?: string }>;
  /** The attempt (a retry of Playwright counts from 1); the catalog keeps the last. */
  retry?: number;
  /** How the attempt ended; a skipped test reached nothing worth keeping. */
  status?: TestStatus;
  /** The tags of the test (Playwright's), which name a scenario of a feature file by its `@id:`. */
  tags?: string[];
}

/** Something the tests do not check that the map can tell (the 不足 rules of the design). */
export interface Gap {
  kind: 'no-unit-test' | 'failure-untested' | 'step-unreached' | 'aspect-missing' | 'feature-without-e2e';
  /** The frame it is about. */
  frame?: string;
  /** For failure-untested: the failure (`TokenError(invalid_target)`). */
  error?: string;
  /** For step-unreached: the step. */
  step?: string;
  /** For aspect-missing: the aspect. */
  aspect?: string;
  /** For feature-without-e2e: the feature (marker id). */
  feature?: string;
  /** How many tests reach it (no-unit-test). */
  reached?: number;
  /** The gap in words, for the page. */
  text: string;
}

/** Counts of a set of cases. */
export interface TestCounts {
  total: number;
  kinds: Partial<Record<TestKind, number>>;
  outcomes: Partial<Record<TestOutcome, number>>;
  aspects: Record<string, number>;
  evidence: Partial<Record<Evidence, number>>;
  /** The results of the latest run: passed, failed, skipped, and the cases without a result. */
  results: Partial<Record<TestStatus | 'none', number>>;
}

/** A case in the index (tests.json): its card without what it expects and its steps. */
export interface TestEntry {
  id: string;
  kind: TestKind;
  root: string;
  title: string;
  ja?: string;
  file: string;
  lines: [number, number];
  form: 'code' | 'feature';
  path: string[];
  outcome: TestOutcome;
  aspects: string[];
  subjects: Subject[];
  evidence: Evidence[];
  targets?: string[];
  skipped?: boolean;
  result?: TestStatus;
  /** How many functions it reached in the latest measured run. */
  reached?: number;
  /** The url of the cards of its file (`./data/tests/by-file/<hash>.json`), which holds its card. */
  card?: string;
}

/** The tests of a frame in the index: where its cards are, and the counts the outline shows. */
export interface FrameTestsRef {
  /** The url of its FrameTests (`./data/tests/by-frame/<hash>.json`). */
  url: string;
  /** The unit tests whose describe names it. */
  unit: number;
  /** Of those, the ones that expect success, failure, and check a boundary. */
  success: number;
  failure: number;
  boundary: number;
  /** The tests that reached it in the latest measured run. */
  reached: number;
  /** All the tests related to it (named, called, reached). */
  related: number;
}

/** The tests of an endpoint of a source (hono, nextjs) in the index. */
export interface EndpointTestsRef {
  /** The url of its FrameTests (`./data/tests/by-endpoint/<hash>.json`). */
  url: string;
  counts: TestCounts;
  gaps: number;
}

/** tests.json: the index of the tests the page reads after map.json. */
export interface TestsIndex {
  version: 1;
  /** The run the results and the reach come from, when the build had one. */
  run?: TestRun['run'];
  /** Whether the reach of a run is in (MARONN_REACH=1). */
  measured: boolean;
  tests: TestEntry[];
  /** By frame id. */
  frames: Record<string, FrameTestsRef>;
  /** By `<source>:<endpoint>` (`hono:token`, `nextjs:token`). */
  endpoints: Record<string, EndpointTestsRef>;
  counts: TestCounts;
  /** The cases whose subject, outcome or aspect the rules could not read. */
  unknown: { subject: number; outcome: number; aspect: number };
  /** The phrases (step expressions and the words of expectations) the translation table has no Japanese for. */
  untranslated: string[];
  /**
   * The gaps of every endpoint and feature, for the list of the tests: a
   * function without a unit test once, with the endpoints that reach it; the
   * other gaps of an endpoint with its source and id.
   */
  gaps: Array<Gap & { source?: string; endpoint?: string; endpoints?: string[] }>;
  /** The aspects aspects.yaml asks every endpoint to have. */
  requiredAspects: string[];
  /** The text of each test file (TestSource), by its path, for the code drawer: plain, not highlighted (the tests are larger than the code they test). */
  sources: Record<string, string>;
  /** The labels of the aspects (`boundary` → `境界値`). */
  aspectLabels: Record<string, string>;
}

/** tests/sources/<hash>.json: the text of a test file. */
export interface TestSource {
  path: string;
  text: string;
}

/**
 * tests/by-frame/<hash>.json and tests/by-endpoint/<hash>.json: the cards of
 * the tests of a frame or an endpoint. An endpoint's file has the cards of
 * the tests that request it (API, E2E, scenarios) and names its unit tests by
 * the frames it reaches: their cards are in the files of those frames.
 */
export interface FrameTests {
  version: 1;
  /** The frame id, `<source>:<endpoint>`, or the path of a test file. */
  key: string;
  tests: TestCase[];
  /** For an endpoint: the unit tests of each frame it reaches, by id. */
  units?: Record<string, string[]>;
  gaps: Gap[];
}

/** The diff of the test catalog of a pull request (tests/diff.json). */
export interface TestDiff {
  added: string[];
  removed: string[];
  /** Tests whose name changed: in the same file, with the same subjects and 8 in 10 of the same expectations. */
  renamed: Array<[before: string, after: string]>;
  modified: Array<{
    id: string;
    what: Array<'title' | 'assertions' | 'subjects' | 'requests' | 'body'>;
    assertions?: { added: Assertion[]; removed: Assertion[] };
  }>;
  counts: { before: number; after: number; byKind: Record<string, [number, number]>; byEndpoint: Record<string, [number, number]> };
  /** By changed frame (functions and endpoint bodies). */
  frames: Array<{
    frame: string;
    /** The tests that name, call or reach it. */
    related: string[];
    /** Of those, the ones this pull request added or changed. */
    touched: string[];
    /** It requires a note and none of its related tests changed (the check fails unless `reason`). */
    untouched: boolean;
    /** The `テストを変えない理由:` line of its section of the change notes. */
    reason?: { text: string; note: string };
    /** The failures that newly leave it which no test expects. */
    failuresWithoutTest: string[];
    /** The outcomes, aspects and expected errors of its related tests, before and after. */
    before: { outcomes: string[]; aspects: string[]; errors: string[] };
    after: { outcomes: string[]; aspects: string[]; errors: string[] };
  }>;
  /** The cards of the tests the diff names (added, removed, renamed and modified, before and after), by id. */
  cards: Record<string, Pick<TestCase, 'id' | 'kind' | 'title' | 'outcome' | 'aspects' | 'source' | 'path'> & { ja?: string; examples?: number; endpoints?: string[] }>;
}
