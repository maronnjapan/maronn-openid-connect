/**
 * The test catalog of a revision: every test file read (read-code.ts,
 * read-feature.ts) and each case made a card (model.ts TestCase) whose kind,
 * subjects, outcome, aspects and id follow the rules of the design §1.
 *
 * The test code is read with the compiler the map reads the code with, in
 * the projects of the roots of the catalog (their tests added to the files of
 * the overlay configs: most tsconfigs exclude the tests), so a describe block
 * that names a function resolves through the imports of its file by the
 * types. The E2E specs and the tests of the tools only need their syntax and
 * are read in one more project of their own.
 *
 * For a revision other than the working tree (the base of a pull request),
 * the overlay gives the files of that revision.
 *
 * The helpers a test imports are found by the types too: the projects of the
 * roots reach their test support modules through the imports, and the
 * project of the E2E specs and the tools has the support modules of the
 * repository among its files (it resolves no import outside them). The step
 * definitions (tests/steps) are in that project as well, so a step of a
 * scenario names the code of the definition it matched.
 */
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import {
  any,
  catalogModules,
  Compiler,
  is,
  isAlias,
  isTestPath,
  nameOf,
  overlayConfigs,
  overlayOf,
  Resolver,
  startLine,
  SyntaxKind,
  unwrap,
  walk,
  type AnalysisRoot,
  type MapData,
  type Node,
  type Overlay,
  type Project,
  type Repository,
  type SourceFile,
} from '@maronn-openid-connect/map-analysis';
import { attachTestFeatures } from './features.js';
import { aspectsOf, type AspectTable } from './aspects.js';
import { isTestSupportPath, type TestFile } from './discover.js';
import { fileTestId, hashedTestId } from './id.js';
import type { Assertion, CodeRef, FeatureStep, HelperRef, NamedCodeRef, RequestShape, Subject, TestCase, TestKind, TestOutcome } from './model.js';
import { codeSubjects, declarationLines, fileHelpers, readCodeTests, type CodeTest, type HelperDeclaration } from './read-code.js';
import { readFeatureTags, readFeatureTests, type FeatureTest } from './read-feature.js';
import { holesOf, type StepDefinition, type Translations, type Vocabulary } from './vocabulary.js';
import { expectedErrors, expectsFailure, headerOf, isStatus, japaneseHole } from './words.js';

/** The virtual tsconfig the E2E specs and the tests of the tools are read in. */
const OTHER_CONFIG = 'tsconfig.test-catalog.json';

export interface CatalogInput {
  repository: Repository;
  data: MapData;
  files: readonly TestFile[];
  /** Read a file of the revision (the working tree by default). */
  read: (path: string) => string;
  /** The files of the revision that differ from the working tree. */
  overlay?: Overlay;
  aspects: AspectTable;
  vocabulary: Vocabulary;
  translations: Translations;
  /**
   * The test support modules of the revision (discover.ts supportFiles): the
   * project of the E2E specs and the tools reads them, so the helpers those
   * tests import are found.
   */
  supportFiles?: readonly string[];
}

export interface CatalogResult {
  tests: TestCase[];
  /** What the reader could not do, one line each (a file that does not parse, two tests with one id). */
  warnings: string[];
  /** The phrases the tests use that the translation table has no Japanese for. */
  untranslated: string[];
}

/** The endpoints of the map, to tell a path or a Route Handler. */
export class EndpointIndex {
  private readonly paths = new Map<string, string>();
  private readonly routes = new Map<string, string>();
  readonly methods = new Map<string, string[]>();
  readonly pathOf = new Map<string, string>();

  constructor(data: MapData) {
    for (const [framework, flow] of Object.entries(data.flows)) {
      for (const endpoint of flow.endpoints) {
        if (!this.paths.has(endpoint.path)) this.paths.set(endpoint.path, endpoint.id);
        if (!this.methods.has(endpoint.id)) this.methods.set(endpoint.id, endpoint.methods);
        if (!this.pathOf.has(endpoint.id)) this.pathOf.set(endpoint.id, endpoint.path);
        // A Route Handler of Next.js: the module of the endpoint under app/.
        if (framework === 'nextjs' && endpoint.module !== undefined && /(^|\/)route\.tsx?$/.test(endpoint.module)) this.routes.set(`app/${endpoint.module}`, endpoint.id);
      }
    }
  }

  /** The endpoint a path is: the one with that path, or the longest whose path and a `/` start it. */
  endpointOfPath(path: string): string | undefined {
    const exact = this.paths.get(path);
    if (exact !== undefined) return exact;
    let best: [string, string] | undefined;
    for (const [known, id] of this.paths) {
      if (known !== '/' && path.startsWith(`${known}/`) && (best === undefined || known.length > best[0].length)) best = [known, id];
    }
    return best?.[1];
  }

  /** The endpoint whose Route Handler (Next.js) a function of the catalog is. */
  endpointOfFunction(id: string): string | undefined {
    const match = /^nextjs:(.+)#[^#]+$/.exec(id);
    return match === null ? undefined : this.routes.get(match[1] as string);
  }
}

/** The sources whose endpoints a case of a root tests: the app of its root, or both for the E2E tests (they run against both apps). */
function sourcesOf(root: string): Array<'hono' | 'nextjs'> {
  if (root === 'hono') return ['hono'];
  if (root === 'nextjs') return ['nextjs'];
  if (root === 'e2e') return ['hono', 'nextjs'];
  return [];
}

/** The outcome of a case from what it expects (design §1): failure when anything expects one, success when it expects anything else. */
export function outcomeOf(expectsAnyFailure: boolean, expectsAnything: boolean): TestOutcome {
  if (expectsAnyFailure) return 'failure';
  return expectsAnything ? 'success' : 'unknown';
}

/** The phrase holes of a said expectation as the Japanese shows them (words.ts japaneseHole). */
function japaneseHoles(phrase: string, holes: readonly string[]): string[] {
  const kinds = holesOf(phrase);
  return holes.map((hole, index) => japaneseHole(kinds[index], hole));
}

/** A hash of a text with its whitespace aside. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/**
 * The helper a name refers to by the types of a project (CodeReadOptions.helperOf):
 * the symbol of the name (Checker.getSymbolAtLocation), through the aliases of
 * the imports and re-exports (Checker.getAliasedSymbol), declared in a file of
 * the repository that is test support code (discover.ts isTestSupportPath) as
 * a function with a body (its overloads before it) or as a variable bound to
 * an arrow function or a function expression (its variable statement). The
 * answers are kept by node and by symbol: every test of a file, and every
 * file of the project, asks for the same helpers.
 */
export function helperResolver(project: Project, repository: string): (name: Node) => HelperDeclaration | undefined {
  const byNode = new Map<Node, HelperDeclaration | null>();
  const bySymbol = new Map<number, HelperDeclaration | null>();
  const pathOf = (absolute: string): string | undefined => repositoryPath(repository, absolute);
  /** The declarations of a symbol (NodeHandle: its kind, its file, the node it resolves to) that are test support code, as a helper. */
  const declarationOf = (handles: ReadonlyArray<{ kind: SyntaxKind; path: string; resolve(project?: Project): Node | undefined }>): HelperDeclaration | undefined => {
    const own = handles.flatMap((handle) => {
      const path = pathOf(handle.path);
      return path !== undefined && isTestSupportPath(path) ? [{ kind: handle.kind, path, handle }] : [];
    });
    // A function: its overloads in its file, then the implementation.
    const functions = own.filter((declaration) => declaration.kind === SyntaxKind.FunctionDeclaration).flatMap((declaration) => {
      const node = declaration.handle.resolve(project);
      return node === undefined ? [] : [{ node, path: declaration.path }];
    });
    const implementation = functions.find((declaration) => any(declaration.node)['body'] !== undefined);
    if (implementation !== undefined) {
      const file = implementation.node.getSourceFile();
      const first = functions.find((declaration) => declaration.path === implementation.path) ?? implementation;
      return { file: implementation.path, lines: declarationLines(file, first.node, implementation.node), fn: implementation.node };
    }
    // A variable bound to an arrow function or a function expression: its variable statement.
    for (const declaration of own) {
      if (declaration.kind !== SyntaxKind.VariableDeclaration) continue;
      const node = declaration.handle.resolve(project);
      const initializer = node === undefined ? undefined : (any(node)['initializer'] as Node | undefined);
      const value = initializer === undefined ? undefined : unwrap(initializer);
      if (node === undefined || !(is(value, SyntaxKind.ArrowFunction) || is(value, SyntaxKind.FunctionExpression))) continue;
      const statement = is(node.parent?.parent, SyntaxKind.VariableStatement) ? (node.parent.parent as Node) : node;
      return { file: declaration.path, lines: declarationLines(node.getSourceFile(), statement), fn: value as Node };
    }
    return undefined;
  };
  return (name) => {
    const known = byNode.get(name);
    if (known !== undefined) return known ?? undefined;
    let found: HelperDeclaration | null = null;
    try {
      let symbol = project.checker.getSymbolAtLocation(name);
      if (symbol !== undefined && isAlias(symbol)) {
        const target = project.checker.getAliasedSymbol(symbol);
        symbol = project.checker.isUnknownSymbol(target) ? undefined : target;
      }
      if (symbol !== undefined) {
        const cached = bySymbol.get(symbol.id);
        found = cached !== undefined ? cached : (declarationOf(symbol.declarations) ?? null);
        bySymbol.set(symbol.id, found);
      }
    } catch {
      // A name the types cannot answer for (a broken file): no helper.
      found = null;
    }
    byNode.set(name, found);
    return found ?? undefined;
  };
}

/** The path of a file from the root of the repository, or undefined for a file outside it. */
function repositoryPath(repository: string, absolute: string): string | undefined {
  const path = relative(repository, absolute).split('\\').join('/');
  return path.startsWith('..') || isAbsolute(path) ? undefined : path;
}

/** Whether a path of the repository is code the viewer may show for what a test tests: a source of the code, not a test, a test support module or a declaration file. */
function isProductCode(path: string): boolean {
  return /\.[cm]?[jt]sx?$/.test(path) && !/\.d\.[cm]?ts$/.test(path) && !isTestSupportPath(path) && !path.includes('node_modules/');
}

/** The top-level declaration of a name in a file: a function with a body (from its first overload), a class, or the statement of a variable. */
function topDeclaration(file: SourceFile, name: string): { first: Node; last: Node } | undefined {
  let first: Node | undefined;
  for (const statement of (any(file)['statements'] as Node[] | undefined) ?? []) {
    if (is(statement, SyntaxKind.FunctionDeclaration) && nameOf(statement['name'] as Node | undefined) === name) {
      first ??= statement;
      if (statement['body'] !== undefined) return { first, last: statement };
    } else if (is(statement, SyntaxKind.ClassDeclaration) && nameOf(statement['name'] as Node | undefined) === name) {
      return { first: statement, last: statement };
    } else if (is(statement, SyntaxKind.VariableStatement)) {
      const declarations = (any(statement['declarationList'] as Node)['declarations'] as Node[] | undefined) ?? [];
      if (declarations.some((declaration) => nameOf(any(declaration)['name'] as Node | undefined) === name)) return { first: statement, last: statement };
    }
  }
  return undefined;
}

/**
 * The code a name of a describe block names, by the types of a project
 * (CodeReadOptions.describedCode): for an imported name, the declaration its
 * symbol resolves to through the aliases of the imports and re-exports, a
 * function (from its first overload to its implementation), a class or the
 * statement of a variable, in a file of the repository that is product code
 * (isProductCode); for a name the file does not import, a declaration of
 * that name at the top of the module the test file tests (`app.test.ts` →
 * `app.ts`, `.tsx` too), when the project has that module. The answers are
 * kept by node and by symbol.
 */
export function describedCodeResolver(project: Project, repository: string): (name: string, file: SourceFile, imported: Node | undefined) => NamedCodeRef | undefined {
  const byNode = new Map<Node, NamedCodeRef | null>();
  const bySymbol = new Map<number, NamedCodeRef | null>();
  const declared = (node: Node, name: string, path: string): NamedCodeRef | undefined => {
    const file = node.getSourceFile();
    const found = topDeclaration(file, name);
    if (found !== undefined) return { name, file: path, lines: declarationLines(file, found.first, found.last) };
    // A declaration that is not at the top of its file (a namespace): its own lines.
    const statement = is(node, SyntaxKind.VariableDeclaration) && is(node.parent?.parent, SyntaxKind.VariableStatement) ? (node.parent.parent as Node) : node;
    return { name, file: path, lines: declarationLines(file, statement) };
  };
  const byTypes = (imported: Node, name: string): NamedCodeRef | undefined => {
    let symbol = project.checker.getSymbolAtLocation(imported);
    if (symbol !== undefined && isAlias(symbol)) {
      const target = project.checker.getAliasedSymbol(symbol);
      symbol = project.checker.isUnknownSymbol(target) ? undefined : target;
    }
    if (symbol === undefined) return undefined;
    const cached = bySymbol.get(symbol.id);
    if (cached !== undefined) return cached ?? undefined;
    let found: NamedCodeRef | undefined;
    for (const handle of symbol.declarations) {
      if (handle.kind !== SyntaxKind.FunctionDeclaration && handle.kind !== SyntaxKind.ClassDeclaration && handle.kind !== SyntaxKind.VariableDeclaration) continue;
      const path = repositoryPath(repository, handle.path);
      if (path === undefined || !isProductCode(path)) continue;
      const node = handle.resolve(project);
      if (node === undefined) continue;
      found = declared(node, nameOf(any(node)['name']) ?? name, path);
      if (found !== undefined) break;
    }
    bySymbol.set(symbol.id, found ?? null);
    return found;
  };
  const byModule = (file: SourceFile, name: string): NamedCodeRef | undefined => {
    const tested = file.fileName.replace(/\.(test|spec)(\.[cm]?[jt]sx?)$/, '$2');
    if (tested === file.fileName) return undefined;
    for (const candidate of [...new Set([tested, tested.replace(/\.ts$/, '.tsx'), tested.replace(/\.tsx$/, '.ts')])]) {
      const source = project.program.getSourceFile(candidate);
      const path = source === undefined ? undefined : repositoryPath(repository, candidate);
      if (source === undefined || path === undefined || !isProductCode(path)) continue;
      const found = topDeclaration(source, name);
      if (found !== undefined) return { name, file: path, lines: declarationLines(source, found.first, found.last) };
    }
    return undefined;
  };
  return (name, file, imported) => {
    if (imported === undefined) return byModule(file, name);
    const known = byNode.get(imported);
    if (known !== undefined) return known ?? undefined;
    let found: NamedCodeRef | undefined;
    try {
      found = byTypes(imported, name);
    } catch {
      // A name the types cannot answer for (a broken file): no code.
      found = undefined;
    }
    byNode.set(imported, found ?? null);
    return found;
  };
}

/**
 * The initializer of the constant a name refers to by the types of a
 * project, when it is declared in a test support module (discover.ts
 * isTestSupportPath, not a test): the table of an `it.each` the test imports
 * (CodeReadOptions.valueOf).
 */
export function supportValueResolver(project: Project, repository: string): (name: Node) => Node | undefined {
  return (name) => {
    try {
      let symbol = project.checker.getSymbolAtLocation(name);
      if (symbol !== undefined && isAlias(symbol)) {
        const target = project.checker.getAliasedSymbol(symbol);
        symbol = project.checker.isUnknownSymbol(target) ? undefined : target;
      }
      for (const handle of symbol?.declarations ?? []) {
        if (handle.kind !== SyntaxKind.VariableDeclaration) continue;
        const path = repositoryPath(repository, handle.path);
        if (path === undefined || !isTestSupportPath(path) || isTestPath(path)) continue;
        const node = handle.resolve(project);
        const initializer = node === undefined ? undefined : (any(node)['initializer'] as Node | undefined);
        if (initializer !== undefined) return initializer;
      }
    } catch {
      // A name the types cannot answer for: no value.
    }
    return undefined;
  };
}

/**
 * The code of each step definition of a file of tests/steps: the statement
 * of its `Given(...)`, `When(...)`, `Then(...)` or `Step(...)` call with the
 * comment lines right above it, and the function it hands the call (the
 * last argument that is one), by the line of its keyword (where the
 * vocabulary reads it, vocabulary.ts readDefinitions).
 */
export function stepDefinitionLines(file: SourceFile): Map<number, { keyword: string; lines: [number, number]; fn?: Node }> {
  const found = new Map<number, { keyword: string; lines: [number, number]; fn?: Node }>();
  walk(file, (node) => {
    if (!is(node, SyntaxKind.CallExpression)) return true;
    const callee = unwrap(node['expression'] as Node);
    const keyword = is(callee, SyntaxKind.Identifier) ? (callee['text'] as string) : '';
    if (!['Given', 'When', 'Then', 'Step'].includes(keyword)) return true;
    const statement = is(node.parent, SyntaxKind.ExpressionStatement) ? (node.parent as Node) : node;
    const line = startLine(file, callee);
    const fn = [...((node['arguments'] as Node[] | undefined) ?? [])]
      .reverse()
      .map((argument) => unwrap(argument))
      .find((argument) => is(argument, SyntaxKind.ArrowFunction) || is(argument, SyntaxKind.FunctionExpression));
    if (!found.has(line)) found.set(line, { keyword, lines: declarationLines(file, statement), ...(fn === undefined ? {} : { fn }) });
    return true;
  });
  return found;
}

/** The code of a step definition and the helpers its function calls (HelperRef, with the file of each). */
export interface StepDefinitionCode {
  code: CodeRef;
  helpers: HelperRef[];
}

/**
 * The code of the step definitions of the vocabulary, by file and line, read
 * from a project that has their files, and the helpers each calls (found as
 * those of a test, read-code.ts fileHelpers; without `helperOf`, those of
 * its own file only).
 */
export function stepDefinitionCode(project: Project, repository: string, definitions: readonly StepDefinition[], helperOf?: (name: Node) => HelperDeclaration | undefined): Map<string, StepDefinitionCode> {
  const code = new Map<string, StepDefinitionCode>();
  for (const path of new Set(definitions.map((definition) => definition.file))) {
    const source = project.program.getSourceFile(join(repository, path));
    if (source === undefined) continue;
    const lines = stepDefinitionLines(source);
    const helpersOf = fileHelpers(source, helperOf);
    for (const definition of definitions) {
      if (definition.file !== path) continue;
      const found = lines.get(definition.line);
      // The vocabulary and the program read the same text: a definition whose keyword is not there (a revision laid over the tree) has no code.
      if (found === undefined || found.keyword !== definition.keyword) continue;
      const helpers = found.fn === undefined ? [] : helpersOf(found.fn).map((helper) => ({ name: helper.name, file: helper.file ?? path, lines: helper.lines, depth: helper.depth }));
      code.set(`${path}:${definition.line}`, { code: { file: path, lines: found.lines }, helpers });
    }
  }
  return code;
}

/**
 * The helpers of a scenario: those of the step definitions of its steps, in
 * the order of the steps, each once. A helper an earlier step listed is not
 * listed again, nor what it calls under it, so each helper stays under the
 * helper that calls it.
 */
export function scenarioHelpers(lists: ReadonlyArray<readonly HelperRef[]>): HelperRef[] {
  const helpers: HelperRef[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    let skipping: number | undefined;
    for (const helper of list) {
      const depth = helper.depth ?? 1;
      if (skipping !== undefined && depth > skipping) continue;
      skipping = undefined;
      const key = `${helper.file}:${helper.lines[0]}`;
      if (seen.has(key)) {
        skipping = depth;
        continue;
      }
      seen.add(key);
      helpers.push(helper);
    }
  }
  return helpers;
}

/**
 * The code that answers the requests of a test to routes that are no
 * endpoint (TestCase.routeCode): what its innermost describe that names
 * code names, unless that is a function of the catalog it imports (its
 * describe subject, whose code the viewer shows as the function it tests).
 */
export function routeCodeOf(test: Pick<CodeTest, 'pathIds' | 'pathCode'>): NamedCodeRef | undefined {
  for (let index = test.pathCode.length - 1; index >= 0; index -= 1) {
    if (test.pathIds[index] !== undefined) return undefined;
    const code = test.pathCode[index];
    if (code !== undefined) return code;
  }
  return undefined;
}

/** The card of a test of the code. */
function codeCard(file: TestFile, test: CodeTest, kind: TestKind, isFunction: (id: string) => boolean, aspects: AspectTable): TestCase {
  const sources = sourcesOf(file.root);
  const subjects = kind === 'tool' ? [] : codeSubjects(test, sources, isFunction);
  const errors = test.expectations.flatMap(expectedErrors);
  const statuses = test.expectations.filter((expectation) => isStatus(expectation.actual) && expectation.args[0]?.kind === 'number').map((expectation) => (expectation.args[0] as { value: number }).value);
  const headers = test.expectations.map((expectation) => headerOf(expectation.actual)).filter((header): header is string => header !== undefined);
  // An API test keeps every request it sends, to an endpoint or to a route of its own (a unit test sends none); an E2E test also requests the RP (`/start`), which is not on the map, so it keeps those to the endpoints, as a tool does.
  const requests = kind === 'api' ? test.requests : test.requests.filter((request) => request.endpoint !== undefined);
  const routeCode = kind === 'api' && requests.some((request) => request.endpoint === undefined) ? routeCodeOf(test) : undefined;
  const evidence: TestCase['evidence'] = [];
  if (test.comments.subjects.length > 0) evidence.push('declared');
  if (subjects.some((subject) => subject.how !== 'declared')) evidence.push('static');
  const card: TestCase = {
    id: '',
    kind,
    root: file.root,
    source: { file: file.path, lines: test.lines, form: 'code' },
    title: test.title,
    ...(test.comments.ja === undefined ? {} : { ja: { title: test.comments.ja } }),
    path: test.path,
    subjects,
    ...(test.comments.features === undefined ? {} : { features: test.comments.features }),
    ...(requests.length === 0 ? {} : { requests }),
    ...(routeCode === undefined ? {} : { routeCode }),
    outcome: outcomeOf(test.expectations.some(expectsFailure), test.expectations.length > 0),
    aspects: kind === 'tool' ? [] : aspectsOf(aspects, { declared: test.comments.aspects, names: [...test.path, test.title], errors, statuses, headers }),
    spec: test.comments.spec,
    assertions: test.assertions,
    ...(errors.length === 0 ? {} : { errors: [...new Set(errors)] }),
    ...(file.place === 'e2e' ? { targets: ['hono', 'nextjs'] } : {}),
    evidence,
    ...(test.skipped ? { skipped: true } : {}),
    digest: digestOf(test.body),
    ...(test.helpers.length === 0 ? {} : { helpers: test.helpers.map((helper) => ({ name: helper.name, file: helper.file ?? file.path, lines: helper.lines, depth: helper.depth })) }),
  };
  return card;
}

/**
 * The kind of a test of the code by where it is and what it does (design
 * §1): a test of a tool or an E2E spec by its place; else an API test when it
 * sends a request to an app or a handler (read-code.ts requestsOf: to the
 * path of an endpoint, to a route it registers itself, to a path it gets at
 * run time) or calls a Route Handler, a unit test when it sends none. Its
 * endpoint subjects are another rule: only a request whose path is an
 * endpoint of the provider, not a route of the test's own, gives one
 * (codeSubjects).
 */
export function codeKind(file: Pick<TestFile, 'place'>, test: Pick<CodeTest, 'requests' | 'endpoints'>): TestKind {
  if (file.place === 'tool') return 'tool';
  if (file.place === 'e2e') return 'e2e';
  return test.requests.length > 0 || test.endpoints.length > 0 ? 'api' : 'unit';
}

/** What a `Then` step expects (design §3): a status by its value; an error code or a failure, a failure; anything else, success. */
export function stepOutcome(text: string): TestOutcome {
  const status = /\bHTTP status is (\d{3})\b/.exec(text);
  if (status !== null) return Number(status[1]) >= 400 ? 'failure' : 'success';
  if (/\berror\b|\bfails?\b|\brejected\b|\brefuse[sd]?\b/i.test(text)) return 'failure';
  return 'success';
}

/** The card of a case of a feature file. */
function featureCard(file: TestFile, test: FeatureTest, input: CatalogInput, endpoints: EndpointIndex, isFunction: (id: string) => boolean, catalogNamed: (name: string) => string | undefined, untranslated: Set<string>, definitions: ReadonlyMap<string, StepDefinitionCode>): TestCase {
  const tags = readFeatureTags(test.tags);
  const inProcess = tags.targets.filter((target): target is 'hono' | 'nextjs' => target === 'hono' || target === 'nextjs');
  const sources: Array<'hono' | 'nextjs'> = tags.targets.includes('http') ? ['hono', 'nextjs'] : inProcess;
  const subjects: Subject[] = [];
  for (const endpoint of tags.endpoints) for (const source of sources) subjects.push({ kind: 'endpoint', id: endpoint, source, how: 'declared' });
  for (const name of tags.functions) {
    const id = isFunction(name) ? name : catalogNamed(name);
    if (id !== undefined) subjects.push({ kind: 'function', id, how: 'declared' });
  }
  const helperLists: HelperRef[][] = [];
  const steps: FeatureStep[] = test.steps.map((step) => {
    const [match] = input.vocabulary.matches(step.text);
    if (match === undefined) return step;
    const ja = input.translations.translate(match.definition.expression, match.holes);
    if (ja === undefined) untranslated.add(match.definition.expression);
    const definition = definitions.get(`${match.definition.file}:${match.definition.line}`);
    if (definition !== undefined) helperLists.push(definition.helpers);
    return { ...step, phrase: match.definition.expression, ...(ja === undefined ? {} : { ja }), ...(definition === undefined ? {} : { definition: definition.code }) };
  });
  const helpers = scenarioHelpers(helperLists);
  const assertions: Assertion[] = steps
    .filter((step) => step.type === 'outcome')
    .map((step) => ({ actual: '', matcher: 'step', line: step.line, text: step.text, ...(step.phrase === undefined ? {} : { phrase: step.phrase }), ...(step.ja === undefined ? {} : { ja: step.ja }) }));
  const endpoint = tags.endpoints[0];
  const requests: RequestShape[] = steps
    .filter((step) => step.type === 'action')
    .filter((step) => endpoint !== undefined || endpoints.endpointOfPath(/\/[\w./-]+/.exec(step.text)?.[0] ?? '') !== undefined)
    .map((step) => {
      const target = endpoint ?? endpoints.endpointOfPath(/\/[\w./-]+/.exec(step.text)?.[0] ?? '');
      const params = [...new Set([...(step.table?.[0] ?? []), ...[...(step.phrase ?? '').matchAll(/\b([a-z][a-z0-9]*_[a-z0-9_]+) \{(?:string|word|int)\}/g)].map((match) => match[1] as string)])];
      return {
        ...(target === undefined ? {} : { endpoint: target }),
        method: (target === undefined ? undefined : endpoints.methods.get(target)?.[0]) ?? 'POST',
        path: (target === undefined ? undefined : endpoints.pathOf.get(target)) ?? '',
        ...(params.length === 0 ? {} : { params }),
        line: step.line,
      };
    });
  const outcomes = assertions.map((assertion) => stepOutcome(assertion.text));
  const errors = assertions.flatMap((assertion) => [...assertion.text.matchAll(/error code is "([^"]+)"/g)].map((match) => match[1] as string));
  const statuses = assertions.flatMap((assertion) => [...assertion.text.matchAll(/HTTP status is (\d{3})/g)].map((match) => Number(match[1])));
  const headers = assertions.flatMap((assertion) => [...assertion.text.matchAll(/(?:the )?["`]?([A-Za-z-]+)["`]? header/g)].map((match) => match[1] as string));
  const kind: TestKind = inProcess.length > 0 || !tags.targets.includes('http') ? 'api' : 'e2e';
  return {
    id: test.id ?? hashedTestId('features', test.path, test.title),
    kind,
    root: 'features',
    source: { file: file.path, lines: test.lines, form: 'feature' },
    title: test.title,
    ...(test.ja === undefined ? {} : { ja: { title: test.ja } }),
    path: test.path,
    subjects,
    ...(tags.features === undefined ? {} : { features: tags.features }),
    ...(requests.length === 0 ? {} : { requests }),
    outcome: outcomeOf(outcomes.includes('failure'), outcomes.length > 0),
    aspects: aspectsOf(input.aspects, { declared: tags.aspects, names: [...test.path, test.title], errors, statuses, headers }),
    spec: tags.spec,
    assertions,
    ...(errors.length === 0 ? {} : { errors: [...new Set(errors)] }),
    steps,
    ...(tags.targets.length === 0 ? {} : { targets: tags.targets }),
    evidence: subjects.length > 0 ? ['declared'] : [],
    digest: digestOf(test.steps.map((step) => `${step.keyword}${step.text}\n${(step.table ?? []).map((row) => row.join('|')).join('\n')}`).join('\n')),
    ...(helpers.length === 0 ? {} : { helpers }),
  };
}

/** Read the catalog of a revision (see the module comment). */
export function readCatalog(input: CatalogInput): CatalogResult {
  const { repository: repo, files } = input;
  const root = repo.repository;
  const warnings: string[] = [];
  const untranslated = new Set<string>();
  const endpoints = new EndpointIndex(input.data);
  const catalog = repo.cli.catalog;
  const isFunction = (id: string) => catalog[id] !== undefined;
  const byName = new Map<string, string[]>();
  for (const card of Object.values(catalog)) byName.set(card.name, [...(byName.get(card.name) ?? []), card.id]);
  /** A function named by its name (`verifyClientSecret`) or its root and name (`core:verifyClientSecret`), when only one function is. */
  const catalogNamed = (name: string): string | undefined => {
    const colon = name.indexOf(':');
    const bare = colon === -1 ? name : name.slice(colon + 1);
    const ids = (byName.get(bare) ?? []).filter((id) => colon === -1 || id.startsWith(`${name.slice(0, colon)}:`));
    return ids.length === 1 ? ids[0] : undefined;
  };

  // One compiler for the code: the roots with their tests added, and a project for the rest.
  const codeFiles = files.filter((file) => file.form === 'code');
  const modules = new Map([...catalogModules(Object.values(catalog))].map(([name, list]) => [name, [...list]]));
  for (const file of codeFiles) if (file.place === 'catalog' && file.module !== undefined) modules.set(file.root, [...(modules.get(file.root) ?? []), file.module]);
  const configs = overlayConfigs(root, repo.roots, modules);
  const others = codeFiles.filter((file) => file.place !== 'catalog');
  const otherConfig = join(root, OTHER_CONFIG);
  // The E2E specs and the tests of the tools, with the support modules they may import and the step definitions: the project resolves no import outside its files.
  const otherFiles = [...new Set([...others.map((file) => file.path), ...(input.supportFiles ?? []), ...input.vocabulary.definitions.map((definition) => definition.file)])];
  configs.set(
    otherConfig,
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: false, noEmit: true, noResolve: true, skipLibCheck: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', types: [] },
      files: otherFiles.map((path) => `./${path}`),
    }),
  );
  const compiler = new Compiler(root, configs, input.overlay);
  const tests: TestCase[] = [];
  let definitions = new Map<string, StepDefinitionCode>();
  try {
    const projects = new Map<
      string,
      {
        project: Project;
        resolver?: Resolver;
        helperOf: (name: Node) => HelperDeclaration | undefined;
        describedCode: (name: string, file: SourceFile, imported: Node | undefined) => NamedCodeRef | undefined;
        valueOf: (name: Node) => Node | undefined;
      }
    >();
    const projectOf = (file: TestFile) => {
      const analysisRoot = file.place === 'catalog' ? repo.roots.find((candidate: AnalysisRoot) => candidate.name === file.root) : undefined;
      const config = analysisRoot === undefined ? otherConfig : overlayOf(root, analysisRoot);
      let entry = projects.get(config);
      if (entry === undefined) {
        const project = compiler.project(config);
        entry = {
          project,
          helperOf: helperResolver(project, root),
          describedCode: describedCodeResolver(project, root),
          valueOf: supportValueResolver(project, root),
          ...(analysisRoot === undefined ? {} : { resolver: new Resolver(project, { repository: root, roots: repo.roots, isFunction, paragraph: (text) => text }) }),
        };
        projects.set(config, entry);
      }
      return entry;
    };
    for (const file of codeFiles) {
      const { project, resolver, helperOf, describedCode, valueOf } = projectOf(file);
      const source = project.program.getSourceFile(join(root, file.path));
      if (source === undefined) {
        warnings.push(`${file.path}: not in the program of its project; its tests are not in the catalog`);
        continue;
      }
      let read: CodeTest[];
      try {
        read = readCodeTests(source, {
          importTarget: (name: Node) => {
            if (resolver === undefined) return undefined;
            try {
              const target = resolver.reference(name);
              return target?.kind === 'function' ? target.id : undefined;
            } catch {
              return undefined;
            }
          },
          endpointOfPath: (path) => endpoints.endpointOfPath(path),
          endpointOfFunction: (id) => endpoints.endpointOfFunction(id),
          specReferencesOf: (text) => repo.cli.specReferencesOf(text),
          constantsOf: (nodes) => {
            const values = new Map<Node, string>();
            if (resolver === undefined) return values;
            try {
              const types = project.checker.getTypeAtLocation([...nodes]);
              nodes.forEach((node, index) => {
                const type = types[index];
                if (type !== undefined && (type.isStringLiteralType() || type.isNumberLiteralType())) values.set(node, String(type.value));
              });
            } catch {
              // The types of a broken file: the members stay code.
            }
            return values;
          },
          translate: (phrase, holes) => {
            const ja = input.translations.translate(phrase, japaneseHoles(phrase, holes));
            if (ja === undefined) untranslated.add(phrase);
            return ja;
          },
          helperOf,
          // The code a describe names answers the requests of an API test to routes that are no endpoint; the E2E specs and the tools have none.
          ...(file.place === 'catalog' ? { describedCode } : {}),
          valueOf,
        });
      } catch (error) {
        warnings.push(`${file.path}: could not be read (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }
      for (const test of read) {
        const kind = codeKind(file, test);
        const card = codeCard(file, test, kind, isFunction, input.aspects);
        card.id = test.comments.id ?? hashedTestId(file.root, test.path.map((name, index) => test.pathIds[index] ?? name), test.title);
        tests.push(card);
      }
    }
    // The step definitions are in the project of the E2E specs and the tools, with the support modules their helpers are in.
    const other = compiler.project(otherConfig);
    definitions = stepDefinitionCode(other, root, input.vocabulary.definitions, projects.get(otherConfig)?.helperOf ?? helperResolver(other, root));
  } finally {
    compiler.close();
  }

  for (const file of files.filter((candidate) => candidate.form === 'feature')) {
    let read: FeatureTest[];
    try {
      read = readFeatureTests(input.read(file.path));
    } catch (error) {
      warnings.push(`${file.path}: does not parse (${error instanceof Error ? error.message.split('\n')[0] : String(error)})`);
      continue;
    }
    for (const test of read) tests.push(featureCard(file, test, input, endpoints, isFunction, catalogNamed, untranslated, definitions));
  }

  attachTestFeatures(tests, input.data);

  // Two tests with one id: tell them apart by their files (design §1), and say so.
  const seen = new Map<string, TestCase[]>();
  for (const test of tests) seen.set(test.id, [...(seen.get(test.id) ?? []), test]);
  for (const [id, same] of seen) {
    if (same.length < 2) continue;
    const files = new Set(same.map((test) => test.source.file));
    if (files.size > 1) warnings.push(`${same.length} tests have the id ${id} (${[...files].join(', ')}): they are told apart by their files`);
    same.forEach((test, index) => {
      const byFile = fileTestId(test.root, test.source.file, test.path, test.title);
      test.id = same.filter((other) => other.source.file === test.source.file).length > 1 ? `${byFile}-${index + 1}` : byFile;
    });
  }
  tests.sort((a, b) => (a.source.file < b.source.file ? -1 : a.source.file > b.source.file ? 1 : a.source.lines[0] - b.source.lines[0]));
  return { tests, warnings, untranslated: [...untranslated].sort() };
}
