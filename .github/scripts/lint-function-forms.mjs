/**
 * Keep module-level function bodies visible to the provider's function catalog.
 *
 * The catalog reads function declarations. An arrow or function expression in
 * a top-level variable (or a default export) hides its body from that catalog,
 * even when the variable has a function type. Aliases, factory results and
 * object methods are values or implementations, and remain allowed.
 *
 * Parse with the installed TypeScript API, using virtual source/config files;
 * the lint needs neither generated dist files nor a typecheck of the apps.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FUNCTION_ROOTS } from './lint-function-docs.mjs';

const require = createRequire(new URL('../../packages/map-analysis/package.json', import.meta.url));
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { SyntaxKind } = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WRAPPERS = new Set([
  SyntaxKind.ParenthesizedExpression,
  SyntaxKind.AsExpression,
  SyntaxKind.TypeAssertionExpression,
  SyntaxKind.SatisfiesExpression,
  SyntaxKind.NonNullExpression,
]);

/** Whether a file belongs to a function-catalog root, excluding tests and declarations. */
function checks(path) {
  return FUNCTION_ROOTS.some((root) => path.startsWith(`${root}/`))
    && /\.tsx?$/.test(path)
    && !/\.d\.ts$/.test(path)
    && !/\.test\.[cm]?[jt]sx?$/.test(path)
    && !/(^|\/)test-helpers\.ts$/.test(path);
}

/** The expression under parentheses and type-only wrappers. */
function unwrap(expression) {
  let value = expression;
  while (value !== undefined && WRAPPERS.has(value.kind)) value = value.expression;
  return value;
}

/** Whether an expression directly defines a function body. */
function definesFunction(expression) {
  const value = unwrap(expression);
  return value?.kind === SyntaxKind.ArrowFunction || value?.kind === SyntaxKind.FunctionExpression;
}

/** The violations of source files, parsed together in one compiler snapshot. */
export function lintSources(sources, repositoryRoot = REPOSITORY_ROOT) {
  const inputs = sources.filter(({ path }) => checks(path));
  if (inputs.length === 0) return [];
  const configPath = join(repositoryRoot, '.github', 'scripts', 'tsconfig.function-forms.json');
  const files = new Map(inputs.map(({ path, source }) => [resolve(repositoryRoot, path), source]));
  const virtual = new Map(files);
  virtual.set(configPath, JSON.stringify({
    compilerOptions: { noLib: true, noResolve: true, types: [], jsx: 'preserve', target: 'esnext' },
    files: [...files.keys()],
  }));
  const api = new API({
    cwd: repositoryRoot,
    fs: {
      readFile: (path) => virtual.get(path),
      fileExists: (path) => virtual.has(path) ? true : undefined,
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    if (project === undefined) throw new Error('The function-form lint could not open its virtual TypeScript project');
    const violations = [];
    for (const { path } of inputs) {
      const file = project.program.getSourceFile(resolve(repositoryRoot, path));
      if (file === undefined) throw new Error(`The function-form lint could not parse ${path}`);
      const report = (node, name) => violations.push({
        path,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
        rule: 'function-declaration',
        message: `${name} defines a module-level function body outside a function declaration: use a function declaration so the map and explain catalog can read it`,
      });
      for (const statement of file.statements) {
        if (statement.kind === SyntaxKind.VariableStatement) {
          for (const declaration of statement.declarationList.declarations) {
            if (definesFunction(declaration.initializer)) report(declaration, declaration.name.getText(file));
          }
        } else if (statement.kind === SyntaxKind.ExportAssignment && definesFunction(statement.expression)) {
          report(statement, 'the default export');
        }
      }
    }
    return violations;
  } finally {
    api.close();
  }
}

/** The violations of one source file, using the same AST path as the repository lint. */
export function lintSource(source) {
  return lintSources([source]);
}

/** The TypeScript source files of a directory in a stable order. */
function sourceFiles(directory) {
  return readdirSync(directory).sort().flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

/** The function-form violations of the existing catalog roots. */
export function lintRepository(repositoryRoot) {
  const sources = FUNCTION_ROOTS.flatMap((root) => {
    const directory = join(repositoryRoot, root);
    if (!existsSync(directory)) return [];
    return sourceFiles(directory).map((file) => ({
      path: `${root}/${relative(directory, file).split('\\').join('/')}`,
      source: readFileSync(file, 'utf8'),
    }));
  });
  return lintSources(sources, repositoryRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = lintRepository(REPOSITORY_ROOT);
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} module-level function form violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Module-level function declarations verified.');
  }
}
