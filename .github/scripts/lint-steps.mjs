/**
 * Keep the vocabulary of the feature files closed and readable without
 * running anything: the step definitions of tests/steps.
 *
 * The test catalog (packages/test-catalog) reads the step definitions
 * lexically, and the translation table (tests/steps/ja.yaml) is keyed by their
 * expressions, so every call of Given, When, Then (and Step) keeps to these
 * rules:
 *
 *   - its first argument is a Cucumber Expression, not a regular expression
 *     (`step-regexp`): a regular expression matches text no table can name,
 *     and its alternatives are hidden from the catalog
 *   - that expression is a string literal in single quotes on one line, not a
 *     template, a variable or a call (`step-literal`), so the reader takes it
 *     as written
 *   - outside its holes (`{int}`, `{string}`, `{word}`, the types of
 *     defineParameterType) it is ASCII (`step-ascii`): the vocabulary is
 *     English, and the Japanese comes from ja.yaml
 *
 * Undefined and ambiguous steps are bddgen's to report (the lint script of
 * tests/steps); this file only reads the source.
 *
 * Usage: node .github/scripts/lint-steps.mjs (pnpm run lint)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/map-analysis/package.json', import.meta.url));
const { API } = await import(pathToFileURL(require.resolve('typescript/unstable/sync')).href);
const { SyntaxKind } = await import(pathToFileURL(require.resolve('typescript/unstable/ast')).href);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The directory of the step definitions. */
export const STEPS_ROOT = 'tests/steps';

/** The functions of createBdd() that define a step. */
const STEP_FUNCTIONS = new Set(['Given', 'When', 'Then', 'Step']);

/** The directories under tests/steps that hold no step definitions of the repository. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.features-gen', 'test-results']);

/**
 * The characters of a Cucumber Expression that are not ASCII, outside its holes.
 *
 * A hole is `{` up to the next `}`; a backslash escapes the character after it
 * (`\{` is a literal brace, which is outside any hole).
 */
export function nonAsciiOutsideHoles(expression) {
  const found = [];
  let inHole = false;
  for (let index = 0; index < expression.length; index++) {
    const character = expression[index];
    if (!inHole && character === '\\') {
      index++;
      const escaped = expression[index];
      if (escaped !== undefined && escaped.charCodeAt(0) > 0x7f) found.push(escaped);
    } else if (inHole) {
      if (character === '}') inHole = false;
    } else if (character === '{') {
      inHole = true;
    } else if (character.charCodeAt(0) > 0x7f) {
      found.push(character);
    }
  }
  return found;
}

/** The violations of the first argument of one step definition call. */
function checkStepArgument(file, call, name) {
  const [argument] = call.arguments ?? [];
  if (argument === undefined) {
    return [{ node: call, rule: 'step-literal', message: `${name}() has no expression: pass a Cucumber Expression in single quotes as its first argument` }];
  }
  if (argument.kind === SyntaxKind.RegularExpressionLiteral) {
    return [{ node: argument, rule: 'step-regexp', message: `${name}() is defined with a regular expression: write a Cucumber Expression ({int}, {string}, {word}, a/b, (s)) in single quotes instead` }];
  }
  if (argument.kind !== SyntaxKind.StringLiteral) {
    return [{ node: argument, rule: 'step-literal', message: `${name}() takes its expression from a template, a variable or a call: write the Cucumber Expression as a string literal in single quotes so the catalog can read it` }];
  }
  const written = argument.getText(file);
  if (!written.startsWith("'")) {
    return [{ node: argument, rule: 'step-literal', message: `${name}() writes its expression in double quotes: use single quotes` }];
  }
  if (/[\r\n]/.test(written)) {
    return [{ node: argument, rule: 'step-literal', message: `${name}() writes its expression over more than one line: keep it on one line` }];
  }
  const characters = nonAsciiOutsideHoles(argument.text);
  if (characters.length > 0) {
    return [{ node: argument, rule: 'step-ascii', message: `${name}('${argument.text}') has non-ASCII characters outside its holes (${[...new Set(characters)].join('')}): write the expression in English and its Japanese in tests/steps/ja.yaml` }];
  }
  return [];
}

/** The violations of source files, parsed together in one compiler snapshot. */
export function lintSources(sources, repositoryRoot = REPOSITORY_ROOT) {
  const inputs = sources.filter(({ path }) => /\.[cm]?tsx?$/.test(path) && !/\.d\.ts$/.test(path));
  if (inputs.length === 0) return [];
  const configPath = join(repositoryRoot, '.github', 'scripts', 'tsconfig.steps.json');
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
    if (project === undefined) throw new Error('The step-definition lint could not open its virtual TypeScript project');
    const violations = [];
    for (const { path } of inputs) {
      const file = project.program.getSourceFile(resolve(repositoryRoot, path));
      if (file === undefined) throw new Error(`The step-definition lint could not parse ${path}`);
      const visit = (node) => {
        if (node.kind === SyntaxKind.CallExpression && node.expression.kind === SyntaxKind.Identifier
          && STEP_FUNCTIONS.has(node.expression.text)) {
          for (const { node: at, rule, message } of checkStepArgument(file, node, node.expression.text)) {
            violations.push({
              path,
              line: file.getLineAndCharacterOfPosition(at.getStart(file)).line + 1,
              rule,
              message,
            });
          }
        }
        node.forEachChild(visit);
      };
      file.forEachChild(visit);
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

/** The TypeScript files of a directory in a stable order, without the generated and installed ones. */
function sourceFiles(directory) {
  return readdirSync(directory).sort().flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return SKIPPED_DIRECTORIES.has(entry) ? [] : sourceFiles(path);
    return /\.[cm]?tsx?$/.test(entry) ? [path] : [];
  });
}

/** The step-definition violations of tests/steps. */
export function lintRepository(repositoryRoot) {
  const directory = join(repositoryRoot, STEPS_ROOT);
  if (!existsSync(directory)) return [];
  const sources = sourceFiles(directory).map((file) => ({
    path: `${STEPS_ROOT}/${relative(directory, file).split('\\').join('/')}`,
    source: readFileSync(file, 'utf8'),
  }));
  return lintSources(sources, repositoryRoot);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = lintRepository(REPOSITORY_ROOT);
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} step definition violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Step definitions verified.');
  }
}
