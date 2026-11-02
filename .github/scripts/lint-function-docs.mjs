/**
 * The documentation every function of the provider carries, so that
 * `maronn-oidc explain` and the provider map can say what each one does.
 *
 * The function catalog (packages/cli/src/extract/functions.ts) reads a
 * function's role from the JSDoc right above its declaration, and the
 * functions a step calls from the step's source. Both only work while the
 * code keeps to these rules:
 *
 *   - every top-level function declaration (exported or not, a default
 *     export, a Route Handler of Next.js and a React component included) has
 *     a JSDoc block right above it (only whitespace between `*\/` and the
 *     declaration), whose first line is text, not a tag (`function-doc`).
 *     The map shows every function the catalog reads, so none may be left
 *     without a description of what it does
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
 * Test files are not checked.
 *
 * Usage: node .github/scripts/lint-function-docs.mjs (pnpm run lint)
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
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

const SPEC_REFERENCE =
  /(?:OIDC (?:Core|Discovery|Session|Registration|Front-Channel Logout|Back-Channel Logout) 1\.0|OpenID Connect [A-Za-z -]+? 1\.0|RP-Initiated Logout 1\.0|CIBA Core 1\.0|OAuth 2\.[01](?: (?:Multiple Response Type Encoding Practices|Form Post Response Mode|Token Exchange|Device Authorization Grant|Security BCP))?|RFC ?\d{4}|JARM|ID-JAG draft|FAPI [\d.]+)(?:\s*(?:§|Section\s+|Sec\.\s*)\s*\d+(?:\.\d+)*(?:\s*\/\s*(?:§\s*|Section\s+)?\d+(?:\.\d+)*)*)?/g;

/**
 * A top-level function declaration, as the catalog reads it: at the start of a
 * line, exported or not, a default export included.
 */
const FUNCTION_DECLARATION = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm;

/** Whether a path is a test (or a helper of the tests), which the lint does not check. */
function isTestFile(path) {
  return /\.test\.[cm]?[jt]sx?$/.test(path) || /(^|\/)test-helpers\.ts$/.test(path);
}

/**
 * Whether the character at an offset is code: not inside a comment or a
 * string, so a line of a comment that starts with `function` is not taken for
 * a declaration. Reads the source the way the catalog does (codeOf of
 * packages/cli/src/extract/meta.ts): a template literal counts as code.
 */
export function isCode(source, offset) {
  let quote;
  for (let index = 0; index < offset; index += 1) {
    const char = source[index];
    if (quote !== undefined) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index);
      if (end === -1 || end >= offset) return false;
      index = end;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end === -1 || end + 2 > offset) return false;
      index = end + 1;
    }
  }
  return quote === undefined;
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

/** The 1-based line of an offset. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/** The violations of one source file (path relative to the repository). */
export function* lintSource({ path, source }) {
  if (isTestFile(path)) return;
  for (const match of source.matchAll(FUNCTION_DECLARATION)) {
    const name = match[1];
    if (!isCode(source, match.index)) continue;
    const line = lineOf(source, match.index);
    // A disable comment of a linter between the JSDoc and the declaration is allowed.
    let index = match.index;
    const above = source.slice(0, index);
    const disable = /\n[ \t]*\/\/ eslint-disable-next-line[^\n]*\n$/.exec(above);
    if (disable) index = disable.index + 1;
    const jsdoc = jsDocAbove(source, index);
    if (jsdoc === undefined) {
      yield { path, line, rule: 'function-doc', message: `${name}() has no JSDoc right above it: write one line that says what it does (its behavior: what it returns, writes or throws)` };
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

/** The .ts and .tsx files under a directory, node_modules left out, in a stable order. */
function listSourceFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((entry) => {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : listSourceFiles(path);
      return /\.tsx?$/.test(entry) ? [path] : [];
    });
}

/** The violations of every source file of the catalog roots of a repository. */
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
