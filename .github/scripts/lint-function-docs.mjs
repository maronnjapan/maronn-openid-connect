/**
 * The documentation every function of the provider carries, so that
 * `maronn-oidc explain` and the provider map can say what each one does.
 *
 * The function catalog (packages/cli/src/extract/functions.ts) reads a
 * function's role from the JSDoc right above its declaration, and the
 * functions a step calls from the step's source. Both only work while the
 * code keeps to these rules:
 *
 *   - an exported function declaration has a JSDoc block right above it
 *     (only whitespace between `*\/` and `export`), whose first line is text,
 *     not a tag (`function-doc`)
 *   - that first line does not number the function as a step of a pipeline
 *     ("ステップ 1:", "Step 2:"): the order of the steps lives in the step
 *     meta and the endpoint.ts, and a function is called from several
 *     pipelines (`summary-numbering`)
 *   - a specification is named with `@spec` tags, not as a line of the text
 *     that holds nothing else (`spec-tag`)
 *   - the `calls` of a step meta (step({...})) lists only what the source does
 *     not show as a call of a function: a method of a resolver or a store
 *     (`consentResolver.recordConsent`). A bare function name is read from the
 *     source and must not be listed (`step-calls`)
 *
 * The Route Handlers of Next.js (GET / POST / OPTIONS ... of a route.ts) and
 * React components (a PascalCase export of a .tsx) are framework entry points
 * and are not required to carry a JSDoc. Test files are not checked.
 *
 * Usage: node .github/scripts/lint-function-docs.mjs (pnpm run lint)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The roots whose functions the catalog reads (the libraries and the extracted apps). */
export const FUNCTION_ROOTS = [
  'packages/core/src',
  'packages/experimental/src',
  'packages/google-login/src',
  'apps/hono/src/oidc-provider',
  'apps/hono/src/web',
  'apps/nextjs/src/app',
];

const ROUTE_HANDLERS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);

const SPEC_REFERENCE =
  /(?:OIDC (?:Core|Discovery|Session|Registration|Front-Channel Logout|Back-Channel Logout) 1\.0|OpenID Connect [A-Za-z -]+? 1\.0|RP-Initiated Logout 1\.0|CIBA Core 1\.0|OAuth 2\.[01](?: (?:Multiple Response Type Encoding Practices|Form Post Response Mode|Token Exchange|Device Authorization Grant|Security BCP))?|RFC ?\d{4}|JARM|ID-JAG draft|FAPI [\d.]+)(?:\s*(?:§|Section\s+|Sec\.\s*)\s*\d+(?:\.\d+)*(?:\s*\/\s*(?:§\s*|Section\s+)?\d+(?:\.\d+)*)*)?/g;

function isTestFile(path) {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)test-helpers\.ts$/.test(path);
}

/** A line of a JSDoc that names specifications and nothing else. */
export function isSpecOnlyLine(text) {
  const line = text.trim().replace(/^[（(]|[)）]$/g, '').trim();
  if (line === '') return false;
  const rest = line.replace(SPEC_REFERENCE, '').replace(/[\s/,、;]|and|および/g, '');
  return rest === '' && new RegExp(SPEC_REFERENCE.source).test(line);
}

/** The JSDoc block right above an offset (only whitespace between), or undefined. */
export function jsDocAbove(source, index) {
  let end = index;
  while (end > 0 && /\s/.test(source[end - 1])) end -= 1;
  if (!source.endsWith('*/', end)) return undefined;
  const start = source.lastIndexOf('/**', end - 2);
  if (start === -1 || source.indexOf('*/', start + 3) !== end - 2) return undefined;
  return source.slice(start, end);
}

/** The text lines of a JSDoc (before the first tag), without the leading `*`. */
function textLinesOf(jsdoc) {
  const lines = jsdoc.replace(/^\/\*\*/, '').replace(/\*\/$/, '').split('\n').map((line) => line.replace(/^\s*\*\s?/, '').trimEnd());
  const text = [];
  for (const line of lines) {
    if (/^@[a-zA-Z]+/.test(line)) break;
    text.push(line);
  }
  return text;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** The violations of one source file (path relative to the repository). */
export function* lintSource({ path, source }) {
  if (isTestFile(path)) return;
  const isRoute = posix.basename(path) === 'route.ts';
  const isTsx = path.endsWith('.tsx');
  for (const match of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    const name = match[1];
    if (isRoute && ROUTE_HANDLERS.has(name)) continue;
    if (isTsx && /^[A-Z]/.test(name)) continue;
    const line = lineOf(source, match.index);
    // A disable comment of a linter between the JSDoc and the declaration is allowed.
    let index = match.index;
    const above = source.slice(0, index);
    const disable = /\n[ \t]*\/\/ eslint-disable-next-line[^\n]*\n$/.exec(above);
    if (disable) index = disable.index + 1;
    const jsdoc = jsDocAbove(source, index);
    if (jsdoc === undefined) {
      yield { path, line, rule: 'function-doc', message: `${name}() has no JSDoc right above it: write one line that says what it does` };
      continue;
    }
    const text = textLinesOf(jsdoc);
    const summary = text.find((candidate) => candidate.trim() !== '');
    if (summary === undefined) {
      yield { path, line, rule: 'function-doc', message: `the JSDoc of ${name}() starts with a tag: say what it does on its first line` };
      continue;
    }
    if (/^(?:.*?\s)?(?:ステップ\s*\d*|Step \d+)\s*[:：]/.test(summary)) {
      yield { path, line, rule: 'summary-numbering', message: `the summary of ${name}() numbers it as a step ("${summary.slice(0, 30)}…"): the order lives in the step meta` };
    }
    for (const candidate of text) {
      if (isSpecOnlyLine(candidate)) {
        yield { path, line, rule: 'spec-tag', message: `the JSDoc of ${name}() names a specification on a line of its own ("${candidate.trim()}"): write it as @spec ${candidate.trim()}` };
      }
    }
  }
  if (/(^|\/)steps\/[^/]+\.tsx?$/.test(path)) {
    const meta = /\bstep\(\s*\{[\s\S]*?\n\}\)/.exec(source);
    const calls = meta && /\bcalls:\s*\[([^\]]*)\]/.exec(meta[0]);
    if (calls) {
      for (const entry of calls[1].match(/'[^']*'/g) ?? []) {
        const name = entry.slice(1, -1);
        if (!name.includes('.')) {
          yield { path, line: lineOf(source, meta.index + calls.index), rule: 'step-calls', message: `calls lists "${name}", a function the source shows: it is read from the source, so leave it out (calls is for methods of a resolver or a store, like 'consentResolver.recordConsent')` };
        }
      }
    }
  }
}

function listSourceFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : listSourceFiles(path);
      return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

export function lintRepository(repositoryRoot) {
  const violations = [];
  for (const root of FUNCTION_ROOTS) {
    const directory = join(repositoryRoot, root);
    if (!existsSync(directory)) continue;
    for (const file of listSourceFiles(directory)) {
      const path = `${root}/${relative(directory, file).split('\\').join('/')}`;
      violations.push(...lintSource({ path, source: readFileSync(file, 'utf8') }));
    }
  }
  return violations;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const violations = lintRepository(repositoryRoot);
  for (const violation of violations) {
    console.error(`${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
  }
  if (violations.length > 0) {
    console.error(`\n${violations.length} function documentation violation(s).`);
    process.exitCode = 1;
  } else {
    console.log('Function documentation verified.');
  }
}
