/**
 * Keep expectations in test bodies, where the test catalog can read them.
 * Helpers and lifecycle hooks prepare data and return values; their callers
 * assert those values in it (or Playwright's test / playwright-bdd's steps).
 * Parse all source files, including support modules, so moving an assertion
 * out of a *.test.ts file cannot bypass the rule.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/map-analysis/package.json', import.meta.url));
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { SyntaxKind: K } = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'work', '.next',
  '.astro', '.cache', '.wrangler', '.features-gen', '.matrix', 'test-results', 'playwright-report',
]);
const WRAPPERS = new Set([K.ParenthesizedExpression, K.AsExpression, K.TypeAssertionExpression, K.SatisfiesExpression, K.NonNullExpression]);
const FUNCTIONS = new Set([K.ArrowFunction, K.FunctionExpression, K.FunctionDeclaration, K.MethodDeclaration]);
const MODIFIERS = new Set(['each', 'for', 'skip', 'only', 'todo', 'fixme', 'skipIf', 'runIf', 'concurrent', 'sequential', 'fails']);
const HOOKS = new Set(['describe', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach', 'before', 'after']);

/** The expression under parentheses and type-only wrappers. */
function unwrap(node) {
  while (node && WRAPPERS.has(node.kind)) node = node.expression;
  return node;
}

/** The root and property names of a call, optionally following parameterized test factories. */
function callable(node, factories = false) {
  node = unwrap(node);
  if (!node) return undefined;
  if (node.kind === K.Identifier) return { name: node.text, members: [] };
  if (factories && node.kind === K.CallExpression) return callable(node.expression, true);
  if (node.kind !== K.PropertyAccessExpression && node.kind !== K.ElementAccessExpression) return undefined;
  const base = callable(node.expression, factories);
  const member = node.kind === K.PropertyAccessExpression ? node.name.text : unwrap(node.argumentExpression)?.text;
  return base && member !== undefined ? { name: base.name, members: [...base.members, member] } : undefined;
}

/** The expectation-scope violations of source files, using a single compiler snapshot. */
export function lintSources(sources, repositoryRoot = ROOT) {
  if (sources.length === 0) return [];
  const config = join(repositoryRoot, '.github/scripts/tsconfig.expect-scope.json');
  const virtual = new Map(sources.map(({ path, source }) => [resolve(repositoryRoot, path), source]));
  virtual.set(config, JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, allowJs: true, types: [], jsx: 'preserve', target: 'esnext' },
    files: [...virtual.keys()],
  }));
  const api = new API({ cwd: repositoryRoot, fs: {
    readFile: (path) => virtual.get(path),
    fileExists: (path) => virtual.has(path) ? true : undefined,
  } });
  try {
    const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
    if (!project) throw new Error('The expectation-scope lint could not open its TypeScript project');
    const violations = [];
    for (const { path } of sources) {
      const file = project.program.getSourceFile(resolve(repositoryRoot, path));
      if (!file) throw new Error(`The expectation-scope lint could not parse ${path}`);
      const expects = new Set(['expect']);
      const tests = new Set(['it', 'test']);
      const hooks = new Set(HOOKS);
      const namespaces = new Set();
      const bddFactories = new Set();
      const steps = new Set();
      for (const statement of file.statements) {
        if (statement.kind !== K.ImportDeclaration) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings?.kind === K.NamespaceImport && /^(vitest|@playwright\/test)$/.test(statement.moduleSpecifier.text)) namespaces.add(bindings.name.text);
        if (bindings?.kind !== K.NamedImports) continue;
        for (const specifier of bindings.elements) {
          if (specifier.isTypeOnly || statement.importClause.isTypeOnly) continue;
          const imported = specifier.propertyName?.text ?? specifier.name.text;
          const local = specifier.name.text;
          if (imported === 'expect') expects.add(local);
          if (imported === 'it' || imported === 'test') tests.add(local);
          if (HOOKS.has(imported)) hooks.add(local);
          if (imported === 'createBdd' && statement.moduleSpecifier.text === 'playwright-bdd') bddFactories.add(local);
        }
      }
      /** Whether a reference calls expect or one of its static helpers. */
      function isExpect(reference) {
        return reference && (expects.has(reference.name) || (namespaces.has(reference.name) && reference.members[0] === 'expect'));
      }
      /** Read aliases and BDD registrations without treating arbitrary callbacks as tests. */
      function bindings(node) {
        if (node.kind === K.VariableDeclaration) {
          const initializer = callable(node.initializer, true);
          if (node.name.kind === K.Identifier && isExpect(initializer)) expects.add(node.name.text);
          if (node.name.kind === K.ObjectBindingPattern && initializer && bddFactories.has(initializer.name)) {
            for (const element of node.name.elements) {
              const imported = element.propertyName?.text ?? element.name.text;
              if (['Given', 'When', 'Then'].includes(imported) && element.name.kind === K.Identifier) steps.add(element.name.text);
            }
          }
        }
        node.forEachChild(bindings);
      }
      bindings(file);
      const callbackScopes = new Map();
      /** Whether a callback belongs to a test, a hook, or an ordinary operation. */
      function callbackScope(call) {
        const reference = callable(call.expression, true);
        if (!reference) return undefined;
        let { name, members } = reference;
        if (namespaces.has(name)) { name = members[0]; members = members.slice(1); }
        if (hooks.has(name) || members.some((member) => HOOKS.has(member))) return false;
        if (steps.has(name) && members.length === 0) return true;
        if (tests.has(name) && members.every((member) => MODIFIERS.has(member)) && call.arguments.length >= 2) return true;
        return undefined;
      }
      /** Check calls lexically inside test bodies, resetting the scope at lifecycle hooks and suites. */
      function visit(node, inside = false) {
        if (FUNCTIONS.has(node.kind)) inside = callbackScopes.get(node) ?? inside;
        if (node.kind === K.CallExpression) {
          const scope = callbackScope(node);
          if (scope !== undefined) {
            for (const argument of node.arguments) {
              const callback = unwrap(argument);
              if (FUNCTIONS.has(callback.kind)) callbackScopes.set(callback, scope);
            }
          }
        }
        if (node.kind === K.CallExpression && isExpect(callable(node.expression)) && !inside) {
          violations.push({ path, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
            rule: 'expect-in-test', message: 'expect must be inside an it / Playwright test / BDD step callback; return values from helpers and assert them in the test body' });
        }
        node.forEachChild((child) => visit(child, inside));
      }
      visit(file);
    }
    return violations;
  } finally {
    api.close();
  }
}

/** The violations of one virtual source file. */
export function lintSource(source) {
  return lintSources([source]);
}

/** The source files to check, including test helpers and hidden CI scripts. */
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return IGNORED_DIRECTORIES.has(entry.name) ? [] : sourceFiles(path);
    return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : [];
  });
}

/** The expectation-scope violations of every source file in the repository. */
export function lintRepository(repositoryRoot = ROOT) {
  return lintSources(sourceFiles(repositoryRoot).map((path) => ({
    path: relative(repositoryRoot, path).split('\\').join('/'), source: readFileSync(path, 'utf8'),
  })), repositoryRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = lintRepository();
  for (const v of violations) console.error(`${v.path}:${v.line}: ${v.rule}: ${v.message}`);
  if (violations.length > 0) { console.error(`\n${violations.length} expectation scope violation(s).`); process.exitCode = 1; }
  else console.log('Expectations are confined to test bodies.');
}
