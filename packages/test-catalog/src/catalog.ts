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
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  catalogModules,
  Compiler,
  overlayConfigs,
  overlayOf,
  Resolver,
  type AnalysisRoot,
  type MapData,
  type Node,
  type Overlay,
  type Project,
  type Repository,
} from '@maronn-openid-connect/map-analysis';
import { aspectsOf, type AspectTable } from './aspects.js';
import type { TestFile } from './discover.js';
import { fileTestId, hashedTestId } from './id.js';
import type { Assertion, FeatureStep, RequestShape, Subject, TestCase, TestKind, TestOutcome } from './model.js';
import { codeSubjects, readCodeTests, type CodeTest } from './read-code.js';
import { readFeatureTags, readFeatureTests, type FeatureTest } from './read-feature.js';
import { holesOf, type Translations, type Vocabulary } from './vocabulary.js';
import { expectedErrors, expectsFailure, headerOf, isStatus } from './words.js';

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

/** The phrase holes of a said expectation as the Japanese shows them: a string or a header in backticks, the rest as they are. */
function japaneseHoles(phrase: string, holes: readonly string[]): string[] {
  const kinds = holesOf(phrase);
  return holes.map((hole, index) => (kinds[index] === 'string' ? `\`${hole}\`` : hole));
}

/** A hash of a text with its whitespace aside. */
export function digestOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

/** The card of a test of the code. */
function codeCard(file: TestFile, test: CodeTest, kind: TestKind, isFunction: (id: string) => boolean, aspects: AspectTable): TestCase {
  const sources = sourcesOf(file.root);
  const subjects = kind === 'tool' ? [] : codeSubjects(test, sources, isFunction);
  const errors = test.expectations.flatMap(expectedErrors);
  const statuses = test.expectations.filter((expectation) => isStatus(expectation.actual) && expectation.args[0]?.kind === 'number').map((expectation) => (expectation.args[0] as { value: number }).value);
  const headers = test.expectations.map((expectation) => headerOf(expectation.actual)).filter((header): header is string => header !== undefined);
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
    ...(test.requests.length === 0 ? {} : { requests: test.requests }),
    outcome: outcomeOf(test.expectations.some(expectsFailure), test.expectations.length > 0),
    aspects: kind === 'tool' ? [] : aspectsOf(aspects, { declared: test.comments.aspects, names: [...test.path, test.title], errors, statuses, headers }),
    spec: test.comments.spec,
    assertions: test.assertions,
    ...(errors.length === 0 ? {} : { errors: [...new Set(errors)] }),
    ...(file.place === 'e2e' ? { targets: ['hono', 'nextjs'] } : {}),
    evidence,
    ...(test.skipped ? { skipped: true } : {}),
    digest: digestOf(test.body),
  };
  return card;
}

/** The kind of a test of the code by where it is and what it does (design §1). */
function codeKind(file: TestFile, test: CodeTest): TestKind {
  if (file.place === 'tool') return 'tool';
  if (file.place === 'e2e') return 'e2e';
  const sendsRequests = test.requests.some((request) => request.endpoint !== undefined) || test.endpoints.length > 0;
  return sendsRequests && (file.root === 'hono' || file.root === 'nextjs') ? 'api' : 'unit';
}

/** What a `Then` step expects (design §3): a status by its value; an error code or a failure, a failure; anything else, success. */
export function stepOutcome(text: string): TestOutcome {
  const status = /\bHTTP status is (\d{3})\b/.exec(text);
  if (status !== null) return Number(status[1]) >= 400 ? 'failure' : 'success';
  if (/\berror\b|\bfails?\b|\brejected\b|\brefuse[sd]?\b/i.test(text)) return 'failure';
  return 'success';
}

/** The card of a case of a feature file. */
function featureCard(file: TestFile, test: FeatureTest, input: CatalogInput, endpoints: EndpointIndex, isFunction: (id: string) => boolean, catalogNamed: (name: string) => string | undefined, untranslated: Set<string>): TestCase {
  const tags = readFeatureTags(test.tags);
  const inProcess = tags.targets.filter((target): target is 'hono' | 'nextjs' => target === 'hono' || target === 'nextjs');
  const sources: Array<'hono' | 'nextjs'> = tags.targets.includes('http') ? ['hono', 'nextjs'] : inProcess;
  const subjects: Subject[] = [];
  for (const endpoint of tags.endpoints) for (const source of sources) subjects.push({ kind: 'endpoint', id: endpoint, source, how: 'declared' });
  for (const name of tags.functions) {
    const id = isFunction(name) ? name : catalogNamed(name);
    if (id !== undefined) subjects.push({ kind: 'function', id, how: 'declared' });
  }
  const steps: FeatureStep[] = test.steps.map((step) => {
    const [match] = input.vocabulary.matches(step.text);
    if (match === undefined) return step;
    const ja = input.translations.translate(match.definition.expression, match.holes);
    if (ja === undefined) untranslated.add(match.definition.expression);
    return { ...step, phrase: match.definition.expression, ...(ja === undefined ? {} : { ja }) };
  });
  const assertions: Assertion[] = steps
    .filter((step) => step.type === 'outcome')
    .map((step) => ({ actual: '', matcher: 'step', line: step.line, text: step.text, ...(step.phrase === undefined ? {} : { phrase: step.phrase }), ...(step.ja === undefined ? {} : { ja: step.ja }) }));
  const endpoint = tags.endpoints[0];
  const requests: RequestShape[] = steps
    .filter((step) => step.type === 'action')
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
  const headers = assertions.flatMap((assertion) => [...assertion.text.matchAll(/(?:the )?([A-Za-z-]+) header/g)].map((match) => match[1] as string));
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
  configs.set(
    otherConfig,
    JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: false, noEmit: true, noResolve: true, skipLibCheck: true, target: 'es2022', module: 'nodenext', moduleResolution: 'nodenext', types: [] },
      files: others.map((file) => `./${file.path}`),
    }),
  );
  const compiler = new Compiler(root, configs, input.overlay);
  const tests: TestCase[] = [];
  try {
    const projects = new Map<string, { project: Project; resolver?: Resolver }>();
    const projectOf = (file: TestFile) => {
      const analysisRoot = file.place === 'catalog' ? repo.roots.find((candidate: AnalysisRoot) => candidate.name === file.root) : undefined;
      const config = analysisRoot === undefined ? otherConfig : overlayOf(root, analysisRoot);
      let entry = projects.get(config);
      if (entry === undefined) {
        const project = compiler.project(config);
        entry = { project, ...(analysisRoot === undefined ? {} : { resolver: new Resolver(project, { repository: root, roots: repo.roots, isFunction, paragraph: (text) => text }) }) };
        projects.set(config, entry);
      }
      return entry;
    };
    for (const file of codeFiles) {
      const { project, resolver } = projectOf(file);
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
    for (const test of read) tests.push(featureCard(file, test, input, endpoints, isFunction, catalogNamed, untranslated));
  }

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
