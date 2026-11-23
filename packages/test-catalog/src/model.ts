/**
 * The data of the tests viewer (apps/tests, apps/map/docs/design-test-catalog.md):
 * the test catalog, a card a test case, joined to the function catalog of
 * the OIDC Provider map by the ids of its functions (`<root>:<module>#<name>`)
 * and endpoint bodies (`endpoint:<id>`), with the results and the reach of a
 * run and, in the build of a pull request, the diff of the tests.
 *
 * The tests viewer (apps/tests) imports these types as
 * `@maronn-openid-connect/test-catalog/model`, so this module has no code and
 * has only type imports.
 */
import type { FeatureRange, MapFeature, StepKind } from '@maronn-openid-connect/map-analysis';

/**
 * What kind of test a case is, by where it is and what it does:
 *
 * - `e2e`: a Playwright test of tests/e2e/specs, or a scenario of a feature
 *   file that runs over HTTP (`@http`), against a running OP.
 * - `api`: a test of the code (packages/*, apps/*) that sends an HTTP
 *   request to an app or a handler (`app.request()`, `app.fetch()`,
 *   `fastify.inject()`, `fetch()` to a server it runs, a Request handed to a
 *   Route Handler), whether its path is that of an endpoint of the provider
 *   (an endpoint subject) or of a route the test registers itself (none),
 *   or a scenario that runs in the process (`@hono`, `@nextjs`).
 * - `unit`: a test of packages/* or apps/* that sends no request: it calls
 *   the functions it tests. A Request it only builds (for a context) or a
 *   fetch it mocks is no request.
 * - `tool`: a test of the CLI, the map, the analysis, the test catalog, the
 *   tests viewer and the scripts; listed, never under an endpoint.
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

/**
 * Why a request of an API test reaches no endpoint of the OP:
 *
 * - `own`: the test registers a route of its own on the path
 *   (`router.post('/token', (c) => ...)`), even the path of an endpoint;
 * - `app`: the path is a route of the app the test sends it to that is no
 *   endpoint (`/health`, the operator's API, a path nothing serves);
 * - `unknown`: its URL has no fixed part in the code, so its path is known
 *   only when the test runs.
 */
export type RequestRoute = 'own' | 'app' | 'unknown';

/** A request a case sends. */
export interface RequestShape {
  /** The endpoint its path matched, by id; absent for a path no endpoint has, or a route the test registers itself on the path (`route` says which). */
  endpoint?: string;
  /** Why it reaches no endpoint, for a request without `endpoint` (RequestRoute). */
  route?: RequestRoute;
  method: string;
  /**
   * The path as written (`/token`, `${TEST_ISSUER}/token` → `/token`, a
   * helper's `authorizePath(params)` → `/authorize`, a row of the table of
   * an `it.each` → each path of the table, one request a row); '' when its
   * URL has no fixed part (a parameter of the test, the URL of a server it
   * starts), with the route `unknown`.
   */
  path: string;
  /** The keys of its body or query (`grant_type`, `code`). */
  params?: string[];
  /** How it authenticates the client: `client_secret_basic`, `client_secret_post`, `bearer`. */
  auth?: string;
  line: number;
}

/**
 * A range of a file the viewer can show (inclusive, from 1): the file's
 * text is in TestsIndex.sources under the same path.
 */
export interface CodeRef {
  /** The path from the repository root. */
  file: string;
  lines: [number, number];
}

/** A range of a file that declares a name: a function, a class, a variable. */
export interface NamedCodeRef extends CodeRef {
  /** The name it declares (`createOperatorApp`, `WebRouter`). */
  name: string;
}

/** A helper a test calls: a function of its own file or of a test support module, not a function it tests. */
export interface HelperRef extends CodeRef {
  /** The name it is called by (`post`, `expectCode`, `login`). */
  name: string;
  /**
   * How deep it is called: 1 for a helper the test (a step definition of a
   * scenario) calls itself, 2 for one a helper of depth 1 calls, and so on.
   * The list is in the order of a walk depth first, so a helper deeper than
   * 1 is under the nearest helper before it one level up. Absent: 1.
   */
  depth?: number;
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
  /** The code of the step definition it matched (tests/steps). */
  definition?: CodeRef;
}

/** A test case: a test of the code (`it`, `test`) or a scenario (a row of the examples of an outline). */
export interface TestCase {
  /** A stable id (see id.ts): the `@id` tag, the `// @test-id` comment, else a hash of the root, the describe path and the title. */
  id: string;
  kind: TestKind;
  /** The root it belongs to: core, experimental, google-login, hono, nextjs, e2e, features, or the tool (cli, map, map-analysis, map-sandbox, test-catalog, test-reach, tests-viewer, scripts). */
  root: string;
  source: { file: string; lines: [number, number]; form: 'code' | 'feature' };
  /** The name of the `it`, or of the scenario, in English. */
  title: string;
  /** Its translation (the `// ja:` comment above the `it`, the `ja:` line of a scenario); absent, the page shows the English. */
  ja?: { title?: string };
  /** The `describe` blocks it is in, or the feature (and the outline) of a scenario. */
  path: string[];
  subjects: Subject[];
  /** Features this case directly tests: its file owner, explicit annotations and direct subjects; never transitive reach. */
  features?: string[];
  /**
   * The requests it sends, in the order of the code: every request of an API
   * test (to an endpoint, or not); the requests of an E2E test to the
   * endpoints of the provider (not those to the RP); the action steps of a
   * scenario. A unit test sends none.
   */
  requests?: RequestShape[];
  /**
   * The requests its own code sent in the measured run (an API test whose
   * app records its requests), in the order they were sent, each at the
   * line of the test that sent it (sent.ts); absent without a measured run
   * or a recorded request. The viewer shows these, not `requests`: what the
   * code is read to send may differ from what it sent.
   */
  recorded?: RecordedRequest[];
  /** How many requests were recorded for it that no line of its own code sent (a hook, a framework that forwarded them): never shown as its requests. */
  unpinned?: number;
  /**
   * The code that answers the requests of an API test that reach no
   * endpoint of the OP (RequestShape.route): the app, the router or the
   * function its innermost describe that names a declaration names,
   * followed through the imports of its file by the types (`createOperatorApp`
   * of apps/hono/src/operator.ts, the class `WebRouter`), else found at the
   * top of the module its file tests (`app.test.ts` → `app.ts`), whether the
   * function catalog has it or not. Absent when that describe names a
   * function it tests (its subject shows it). Its file is in
   * TestsIndex.sources.
   */
  routeCode?: NamedCodeRef;
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
  /**
   * The helpers its body calls, directly or through another helper: the
   * functions of its file and of the test support modules it imports
   * (test-helpers.ts, test-support/, tests/e2e/fixtures.ts, tests/steps).
   * Those it calls itself come first, each followed by the helpers it calls
   * in turn (HelperRef.depth). For a scenario, the helpers the step
   * definitions of its steps call, in the order of the steps, each once. The
   * functions it tests are its subjects.
   */
  helpers?: HelperRef[];
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

/**
 * What packages/test-reach writes for a test of a measured run that sent
 * requests (exchanges/vitest-<package>.jsonl, one a line): the test named as
 * in RawReach, and each request it sent with the response and what ran while
 * it was answered.
 */
export interface RawExchanges {
  file: string;
  path: string[];
  title: string;
  exchanges: RawExchange[];
}

/** One request a test sent, as the measured run recorded it (packages/test-reach exchanges.js). */
export interface RawExchange {
  request: {
    method: string;
    /** The absolute URL as sent. */
    url: string;
    /** Lower-case names, in the order the headers were iterated. */
    headers: Array<[string, string]>;
    body?: string;
    /** The body was cut at 16 KiB. */
    truncated?: true;
  };
  /** Absent when the request threw instead of answering (`error`). */
  response?: {
    status: number;
    statusText?: string;
    headers: Array<[string, string]>;
    body?: string;
    truncated?: true;
  };
  /** Another request of the same test was in flight while this one ran: their counts are mixed. */
  overlapped?: true;
  /** What the request threw instead of answering. */
  error?: string;
  /**
   * Where the request was sent from: the repository path and the line of
   * each frame of the call stack at the call, innermost first (absent when
   * the recorder kept none). The line of the test's code that sent it is
   * among them when its code did (sent.ts sentLine).
   */
  from?: Array<[string, number]>;
  /**
   * What ran while the request was answered: the Istanbul counters that went
   * up, by repository path of the original source (files of the function
   * catalog only), at their places in it (lines from 1, columns from 0).
   */
  ran: Record<string, ExchangeRun>;
}

/** What ran in one file while a request was answered (RawExchange.ran). */
export interface ExchangeRun {
  /** The statements whose counter went up: [line, column, increment], the place where the statement starts. */
  s: Array<[number, number, number]>;
  /**
   * The branches whose counter went up: [line, column, type, increments],
   * the place where the branch starts (the `if` or `switch` keyword, the
   * first operand of a `binary-expr`, the test of a `cond-expr`), the type
   * as Istanbul names it, an increment a location in Istanbul's order.
   */
  b: Array<[number, number, string, number[]]>;
  /** The functions whose counter went up: [line, name?], the line of the declaration's name (else its start), as the reach has it. */
  f: Array<[number, string] | [number]>;
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
  /** Features this case directly tests: its file owner, explicit annotations and direct subjects; never transitive reach. */
  features?: string[];
  /**
   * Why the requests of an API test that reach no endpoint of the OP reach
   * none (RequestShape.route), each once: the lists tell a test of routes of
   * its own or of the app from one of paths known at run time without its
   * card.
   */
  routes?: RequestRoute[];
  evidence: Evidence[];
  targets?: string[];
  skipped?: boolean;
  result?: TestStatus;
  /** How many functions it reached in the latest measured run. */
  reached?: number;
  /** The url of the cards of its file (`./data/tests/by-file/<hash>.json`), which holds its card. */
  card?: string;
}

/** The tests of a frame in the index: the counts the viewer shows beside a step. */
export interface FrameTestsRef {
  /** The unit tests whose describe names it, or whose expectations call it. */
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

/**
 * The tests of an endpoint of a source (hono, nextjs) in the index, by id:
 * the entries of tests.json hold every case once, so an endpoint names its
 * tests instead of copying them (a function every endpoint reaches would
 * otherwise carry a thousand cards in each of the files of its endpoints).
 */
export interface EndpointTestsRef {
  counts: TestCounts;
  gaps: number;
  /**
   * Its tests that are no unit test of a frame of `units`: the API and E2E
   * tests that request it, by their code or in the measured run, and the
   * unit tests whose measured run reached its body without naming a frame it
   * reaches. With `units` it lists every test `counts` counts.
   */
  tests: string[];
  /** The unit tests of each frame it reaches, by frame id; frames without a unit test are left out. */
  units: Record<string, string[]>;
}

/** tests.json: the index of the tests viewer (apps/tests), every case once. */
export interface TestsIndex {
  version: 1;
  /** The run the results and the reach come from, when the build had one. */
  run?: TestRun['run'];
  /** Whether the reach of a run is in (MARONN_REACH=1). */
  measured: boolean;
  tests: TestEntry[];
  /** By frame id: the frames with a test. */
  frames: Record<string, FrameTestsRef>;
  /** By `<source>:<endpoint>` (`hono:token`, `nextjs:token`). */
  endpoints: Record<string, EndpointTestsRef>;
  counts: TestCounts;
  /** The cases whose subject, outcome or aspect the rules could not read. */
  unknown: { subject: number; outcome: number; aspect: number };
  /** The phrases (step expressions and the words of expectations) the translation table has no Japanese for. */
  untranslated: string[];
  /**
   * The gaps of every endpoint and feature: a function without a unit test
   * once, with the endpoints that reach it; the other gaps of an endpoint
   * with its source and id.
   */
  gaps: Array<Gap & { source?: string; endpoint?: string; endpoints?: string[] }>;
  /** The aspects aspects.yaml asks every endpoint to have. */
  requiredAspects: string[];
  /**
   * The url of the text (TestSource) of every file the viewer shows, by its
   * path: the test files, and the files of the helpers, the step
   * definitions, the functions and the endpoint bodies the tests name, and
   * of the code that answers the requests of the API tests to routes that
   * are no endpoint (TestCase.routeCode).
   */
  sources: Record<string, string>;
  /** The labels of the aspects (`boundary` → `境界値`). */
  aspectLabels: Record<string, string>;
  /** Whether tests/diff.json is there (a build of a pull request). */
  diff?: boolean;
  /**
   * The url of the cases of each endpoint that has any (EndpointCases), by
   * `<source>:<endpoint>`: the ways a request takes through it, read when
   * its page opens. Absent in data older than the cases.
   */
  cases?: Record<string, string>;
}

/**
 * The tests that speak for a failure of a case, by how surely:
 *
 * - `direct`: the tests of the function that throws it (they name it, call
 *   it, or reached it in a measured run) that expect this error;
 * - `byCode`: the other tests of the endpoint that expect this error: the
 *   same code can come from another cause;
 * - `nearby`: when neither has any, the tests of the function that throws it
 *   that expect a failure whose error the catalog could not read.
 *
 * Each is a list of test ids, sorted.
 */
export interface FailureTests {
  direct: string[];
  byCode: string[];
  nearby: string[];
}

/**
 * A case of an endpoint: one way a request takes through it, as the map
 * offers it ready-made (よく使う選択): the way into a step, a way it ends,
 * or a failure that ends it.
 */
export interface EndpointCase {
  /** A hash of its kind, its name and where it leads: the same case has the same id in two builds. */
  id: string;
  kind: 'step' | 'exit' | 'failure';
  /** Its name in words, as the map says it (`refresh_token グラントを検証する`); code is between backticks. */
  name: string;
  /** Where it leads (`→ return respondToken(…)`), when the map says. */
  note?: string;
  /** The node of the endpoint's tree it leads to (Selection.target): with its kind, the map finds its choice of the way by it. */
  target: string;
  /** The steps of the endpoint it runs, in the order it reaches them. */
  steps: string[];
  /** How it ends: the endpoint answers, a failure is caught and answered with an error, or a failure leaves the endpoint. */
  end: 'response' | 'error-response' | 'escapes';
  /** For a failure: the error, its OAuth code when it has one, the function that throws it (frame id and name), and the step it comes up in. */
  failure?: { error: string; code?: string; from: string; name: string; step?: string };
  /** For a failure: the tests that expect it (FailureTests). */
  tests?: FailureTests;
  /**
   * The sides this way takes, in words, in the order the walk meets them:
   * what a request must do to take it. Written from the decisions of its
   * selection, so a case without an example still says what makes a request
   * take it.
   */
  conditions?: CaseCondition[];
  /** Requests measured API tests sent that took this way, best first (at most 3); absent when none, or without a measured run. */
  examples?: CaseExample[];
  /** How many recorded requests took this way in all (at least examples.length). */
  exampleCount?: number;
}

/** A decision and the side a way takes at it, in words. */
export interface CaseCondition {
  /** The step the decision is in, by id, when it is in one. */
  step?: string;
  /** The decision as the outline says it: its words when it has some, else its code. */
  text: string;
  /** Whether text is code. */
  code: boolean;
  /** The side taken, in words (成立, 不成立, null または undefined, case 'x', 例外が起きたとき, …); 失敗する for a call that fails. */
  side: string;
}

/** A request as a measured API test sent it. */
export interface ExampleRequest {
  method: string;
  /** The path and the query of the URL (`/token`, `/authorize?client_id=…`). */
  path: string;
  /** The host of the URL (`op.example.com`). */
  host: string;
  /** The headers, lower-case names, in the order they were sent. */
  headers: Array<[string, string]>;
  body?: string;
  /** The body was cut (at 16 KiB). */
  truncated?: true;
}

/** A parameter a request sent: from its query, its form body or the top level of its JSON body (a JSON value other than a string as JSON). */
export interface RequestParam {
  name: string;
  value: string;
  in: 'query' | 'form' | 'json';
}

/** A request a test's own code sent in the measured run (TestCase.recorded). */
export interface RecordedRequest {
  /** The line of the test's code that sent it (its call, directly or through a helper), from 1. */
  line: number;
  method: string;
  /** The path and the query of its URL. */
  path: string;
  /** What it sent in its query and body (requestParams); absent when nothing. */
  params?: RequestParam[];
  /** Its Authorization header in short: the scheme, and for Basic the client id (`Basic client-1`). */
  auth?: string;
  /** The status of the response; absent when the send threw. */
  status?: number;
}

/** The response the endpoint gave to an ExampleRequest. */
export interface ExampleResponse {
  status: number;
  statusText?: string;
  headers: Array<[string, string]>;
  body?: string;
  /** The body was cut (at 16 KiB). */
  truncated?: true;
}

/** A step of the endpoint a recorded request ran, with what happened in it. */
export interface ExampleStep {
  /** The step id (as in EndpointCase.steps). */
  id: string;
  /**
   * ran: the step ran and the request went on; answered: the endpoint's
   * answer was returned from here; failed: a failure came up here; caught:
   * the step that turned a failure into the error response (a catch).
   */
  how: 'ran' | 'answered' | 'failed' | 'caught';
  /** The decisions of the endpoint's own frame inside this step that the request met, with the side it took (measured). */
  decisions?: CaseCondition[];
  /** Functions of the catalog the request ran that this step's own code calls directly (frame ids, in the order the step calls them). */
  calls?: string[];
  /** For how = failed: the error (`TokenError(invalid_grant)`). */
  error?: string;
}

/** A request a measured API test sent that took a case's way: what was sent, the steps it ran and what came back. */
export interface CaseExample {
  /** The test that sent it, by id. */
  test: string;
  /** The line of the test's code that sent it (its call, directly or through a helper), from 1: a request no line of its test sent is never an example. */
  line: number;
  /** The code of that line, trimmed (cut at 160 characters). */
  code: string;
  request: ExampleRequest;
  response: ExampleResponse;
  /** The steps of the endpoint the request ran, in order. */
  steps: ExampleStep[];
}

/** tests/cases/<hash>.json: the cases of one endpoint of a source (the url is TestsIndex.cases). */
export interface EndpointCases {
  version: 1;
  /** `<source>:<endpoint>`. */
  key: string;
  cases: EndpointCase[];
}

/** tests/sources/<hash>.json: the text of a file the viewer shows (TestsIndex.sources): a test file, or the file of a helper, a step definition, a function or an endpoint body. */
export interface TestSource {
  /** Feature-owned lines of the implementation, preserved from the map. */
  features?: FeatureRange[];
  path: string;
  text: string;
}

/** tests/by-file/<hash>.json: the cards of the tests of one file (the url is TestEntry.card). */
export interface FileTests {
  version: 1;
  /** The path of the test file. */
  key: string;
  tests: TestCase[];
}

/** A step of an endpoint in the outline: its name, and the function it calls when it has one of its own (hono). */
export interface OutlineStep {
  feature?: string;
  id: string;
  /** Its name in Japanese (`クライアントを認証する`). */
  label: string;
  /** What the step does, by its kind (the map's FlowStep.kind). */
  kind?: StepKind;
  /** The values it reads from the steps before it (FlowStep.consumes). */
  consumes?: string[];
  /** The values it hands on (FlowStep.produces). */
  produces?: string[];
  /** The frame id of the function of the step; absent for a step of Next.js, a block of its Route Handler. */
  function?: string;
  /**
   * For a step without `function` (a block of a Route Handler): the frames
   * the block calls that have unit tests among the endpoint's
   * (EndpointTestsRef.units), so the step has unit tests like a step of hono.
   */
  calls?: string[];
  /** All catalog functions the block calls, including those without unit tests, for browsing its code. */
  codeCalls?: string[];
  /**
   * The code of the step: the function of a step of hono; the block of the
   * Route Handler of Next.js, from its marker (`// [step-id]`) to its last
   * statement.
   */
  code?: CodeRef;
}

/** An endpoint of a source in the outline, in the order of the map. */
export interface OutlineEndpoint {
  feature?: string;
  /** `<source>:<endpoint>`, the key of TestsIndex.endpoints. */
  key: string;
  source: 'hono' | 'nextjs';
  id: string;
  /** Its name in Japanese (`トークンエンドポイント`). */
  label: string;
  summary?: string;
  path: string;
  methods: string[];
  group: { id: string; label: string };
  layer: 'api' | 'browser' | 'metadata';
  /** The frame of its body (`endpoint:token`, `endpoint:nextjs:token`). */
  root: string;
  steps: OutlineStep[];
  /** The code of its body: the pipeline of hono, the Route Handler of Next.js (BodyEntry.source of the map). */
  code?: CodeRef;
}

/** A function of the catalog the viewer names. */
export interface OutlineFunction {
  feature?: string;
  id: string;
  name: string;
  package: string;
  module: string;
  summary?: string;
  /** Its code, the JSDoc and the overloads included (FunctionEntry.source of the map). */
  code?: CodeRef;
  /** The catalog functions or endpoint bodies this code calls, in the order of their first call. */
  calls?: string[];
}

/**
 * outline.json: what the viewer needs of the function catalog to name what
 * the tests test, so it reads no map.json: the endpoints of hono and Next.js
 * with their steps, the functions the tests and the steps name, and the
 * functions they call, transitively.
 */
export interface TestsOutline {
  /** CLI flags and defaults of the features named by the outline and tests. */
  features?: MapFeature[];
  version: 1;
  endpoints: OutlineEndpoint[];
  functions: Record<string, OutlineFunction>;
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
  /**
   * The cards of the tests the diff names (added, removed, renamed and
   * modified, before and after, and the touched tests of the frames), by id:
   * a removed test is in no catalog the viewer reads, so its card is all
   * there is of it.
   */
  cards: Record<string, TestDiffCard>;
}

/** A test as the diff keeps it (TestDiff.cards): enough to list it where the viewer lists it. */
export interface TestDiffCard extends Pick<TestCase, 'id' | 'kind' | 'title' | 'outcome' | 'aspects' | 'source' | 'path'> {
  /** Its Japanese title. */
  ja?: string;
  /** The rows of an outline counted on its first row, when more than one. */
  examples?: number;
  /** The endpoints it requests or declares (`hono:token`), those a measured run added left out. */
  endpoints?: string[];
  /**
   * The functions it tests by its describe or its declaration (its function
   * subjects of how `describe` or `declared`), by id, each once: the frames
   * whose unit tests it is (FrameJoin.unit, EndpointTestsRef.units), so the
   * viewer lists a removed unit test under an endpoint and a step only where
   * its live version was.
   */
  functions?: string[];
  /**
   * The functions whose results its expectations check (its function
   * subjects of how `call` that are none of `functions`), by id, each once:
   * with `functions`, the functions the viewer lists it under by what it
   * tests (the unit tests by function, the target of its row).
   */
  calls?: string[];
}
