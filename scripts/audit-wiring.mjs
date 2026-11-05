/** Scan production TypeScript for wiring shapes, without matching domain names. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const requireFromAnalysis = createRequire(new URL('../packages/map-analysis/package.json', import.meta.url));
const { API, SignatureKind, SymbolFlags } = await import(pathToFileURL(requireFromAnalysis.resolve('typescript/unstable/sync')).href);
const { SyntaxKind } = await import(pathToFileURL(requireFromAnalysis.resolve('typescript/unstable/ast')).href);

const repository = resolve(import.meta.dirname, '..');
mkdirSync(`${repository}/work`, { recursive: true });
const ref = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : undefined;
const outputPath = process.argv.includes('--output') ? process.argv[process.argv.indexOf('--output') + 1] : 'work/wiring-inventory.json';
const snapshot = ref === undefined ? undefined : `${repository}/work/inventory-before-repo`;
if (snapshot !== undefined) {
  mkdirSync(snapshot, { recursive: true });
  const archive = execFileSync('git', ['archive', '--format=tar', ref, '--', 'apps/hono/src', 'apps/nextjs/src', 'packages'], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
  execFileSync('tar', ['-x', '-C', snapshot], { cwd: repository, input: archive });
}
/** Enumerate source files without requiring a search executable in the map build environment. */
function sourcePaths(directory) {
  const ignored = new Set(['node_modules', 'dist', 'templates', '.matrix', '.git', '.next', '.data', '.wrangler', 'coverage']);
  return readdirSync(resolve(repository, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return ignored.has(entry.name) ? [] : sourcePaths(path);
    return entry.isFile() ? [path] : [];
  });
}
const candidatePaths = ref === undefined ? ['apps/hono/src', 'apps/nextjs/src', 'packages'].flatMap(sourcePaths) : execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--', 'apps/hono/src', 'apps/nextjs/src', 'packages'], { cwd: repository, encoding: 'utf8' }).trim().split('\n');
const paths = candidatePaths
  .filter((path) => /\.tsx?$/.test(path) && !/(?:\.test\.|\.spec\.|\/__tests__\/|\/__fixtures__\/|\/dist\/|\/templates\/|\/node_modules\/|test-support|test-helpers|\.d\.ts$)/.test(path));
const definition = JSON.parse(readFileSync(`${repository}/packages/cli/extract.json`, 'utf8'));
// Resolve package imports to the same source declarations the map reads. A
// dist declaration proves a callable shape but cannot identify its source call.
const libraryPaths = {};
for (const library of Object.values(definition.libraries)) {
  const packageDirectory = dirname(resolve(repository, 'packages/cli', library.directory));
  const manifest = JSON.parse(readFileSync(resolve(packageDirectory, 'package.json'), 'utf8'));
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const types = typeof target === 'string' ? target : target.types;
    if (types === undefined) continue;
    const specifier = subpath === '.' ? library.package : `${library.package}/${subpath.replace(/^\.\//, '')}`;
    libraryPaths[specifier] = [resolve(packageDirectory, types.replace(/^\.\/dist\//, 'src/').replace(/\.d\.ts$/, '.ts'))];
  }
}
const config = `${repository}/work/tsconfig.wiring-inventory.json`;
writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'esnext', module: 'nodenext', moduleResolution: 'nodenext', jsx: 'preserve', skipLibCheck: true, noEmit: true, paths: libraryPaths }, files: paths.map((path) => `${repository}/${path}`) }));
const overlay = new Map(snapshot === undefined ? [] : paths.map((path) => [`${repository}/${path}`, readFileSync(`${snapshot}/${path}`, 'utf8')]));
const api = new API({ cwd: repository, fs: { readFile: (path) => overlay.get(path), fileExists: (path) => overlay.has(path) ? true : undefined } });
const project = api.updateSnapshot({ openProjects: [config] }).getProjects()[0];
const checker = project.checker;
const roots = [...Object.entries(definition.sources).map(([name, entry]) => ({ name, ...entry })), ...Object.entries(definition.libraries).map(([name, entry]) => ({ name, ...entry }))].map((root) => ({ ...root, directory: resolve(repository, 'packages/cli', root.directory) + '/' }));
/** Find the configured provider-map root for a repository source path. */
function rootOf(path) { const absolute = `${repository}/${path}`; return roots.find((root) => absolute.startsWith(root.directory) && (!root.include || root.include.some((include) => absolute.slice(root.directory.length) === include || absolute.slice(root.directory.length).startsWith(include + '/'))) && !root.exclude.some((pattern) => new RegExp(pattern).test(absolute.slice(root.directory.length)))); }
const items = [];
const typeErrors = [];
const functionKinds = new Set([SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction, SyntaxKind.MethodDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.Constructor]);
const wrappers = new Set([SyntaxKind.ParenthesizedExpression, SyntaxKind.AwaitExpression, SyntaxKind.AsExpression, SyntaxKind.NonNullExpression, SyntaxKind.SatisfiesExpression, SyntaxKind.TypeAssertionExpression]);
/** Read the expression under non-behavioral TypeScript wrappers. */
function unwrap(node) { while (node && wrappers.has(node.kind)) node = node.expression; return node; }
/** Visit every syntax node below a source node. */
function walk(node, visit) { if (visit(node) === false) return; node.forEachChild((child) => { walk(child, visit); }); }
/** Test whether syntax or TypeScript identifies a callable value. */
function callable(node) { const value = unwrap(node); if (!value) return false; if (functionKinds.has(value.kind)) return true; if (![SyntaxKind.Identifier, SyntaxKind.PropertyAccessExpression].includes(value.kind)) return false; try { const type = checker.getTypeAtLocation(value); return type !== undefined && checker.getSignaturesOfType(type, SignatureKind.Call).length > 0; } catch (error) { typeErrors.push({ file: value.getSourceFile().fileName, line: value.getSourceFile().getLineAndCharacterOfPosition(value.getStart(value.getSourceFile())).line + 1, why: String(error).split('\n')[0] }); return false; } }
/** Resolve a function reference to its declaration in a provider-map root. */
function declaredTarget(node) {
  let value = unwrap(node);
  if (value.kind === SyntaxKind.PropertyAccessExpression) value = value.name;
  if (value.kind !== SyntaxKind.Identifier) return undefined;
  let symbol = checker.getSymbolAtLocation(value);
  if (symbol && (symbol.flags & SymbolFlags.Alias)) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.declarations.find((entry) => entry.kind === SyntaxKind.FunctionDeclaration);
  if (!declaration || !declaration.path.startsWith(repository + '/')) return undefined;
  const root = rootOf(declaration.path.slice(repository.length + 1));
  return root ? `${root.name}:${declaration.path.slice(root.directory.length)}#${symbol.name}` : undefined;
}
/** Collect repository function targets used inside an inline callback. */
function repositoryCallsOf(node) { const targets = new Set(); walk(node, (child) => { if (child.kind === SyntaxKind.CallExpression) { const target = declaredTarget(child.expression); if (target) targets.add(target); } }); return [...targets]; }
/** Find the immediate function body that owns a source node. */
function functionOwner(node) { for (let owner = node.parent; owner; owner = owner.parent) if (functionKinds.has(owner.kind)) return owner; return undefined; }
/** Read the text of a declared name or identifier. */
function name(node) { return node?.name?.text ?? node?.text; }
for (const path of paths) {
  const file = project.program.getSourceFile(`${repository}/${path}`);
  if (!file) throw new Error(`Missing source file: ${path}`);
  /** Read the exact source text of a syntax node. */
  function text(node) { return file.text.slice(node.getStart(file), node.end); }
  /** Record a matched syntax shape with its source and catalog identity. */
  function record(kind, node, extra = {}) {
    const owner = functionOwner(node);
    const root = rootOf(path);
    let frame;
    for (let parent = node.parent; parent; parent = parent.parent) { if (parent.kind === SyntaxKind.FunctionDeclaration && parent.parent?.kind === SyntaxKind.SourceFile) frame = root === undefined ? undefined : `${root.name}:${path.slice(root.directory.length - repository.length - 1)}#${name(parent)}`; }
    items.push({ kind, file: path, mapRoot: root?.name ?? null, ...(frame ? { frame } : {}), line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, end: file.getLineAndCharacterOfPosition(Math.max(node.getStart(file), node.end - 1)).line + 1, owner: owner ? name(owner) ?? '<inline>' : '<module>', code: text(node).replace(/\s+/g, ' ').slice(0, 300), ...extra });
  }
  walk(file, (node) => {
    if (node.kind === SyntaxKind.CallExpression) {
      const callee = unwrap(node.expression);
      if (callee.kind === SyntaxKind.PropertyAccessExpression && name(callee.name) === 'set' && node.arguments.length === 2) {
        const receiverType = checker.getTypeAtLocation(callee.expression);
        // Hono uses any; Map/Headers setters have their own known types.
        if (receiverType?.isIntrinsicType() && receiverType.intrinsicName === 'any') record(node.arguments[0].kind === SyntaxKind.StringLiteral ? 'context-write' : 'dynamic-context-write', node, { key: node.arguments[0].text ?? text(node.arguments[0]), value: text(node.arguments[1]), valueCallable: callable(node.arguments[1]) });
      }
      if (callee.kind === SyntaxKind.PropertyAccessExpression && /^(use|onError|notFound|on|route|register|hook)$/.test(name(callee.name) ?? '')) record('registration', node, { callee: text(callee) });
      for (const argument of node.arguments) {
        const value = unwrap(argument);
        if (value && callable(value)) record('callback-argument', argument, { callee: text(callee), inline: functionKinds.has(value.kind), target: declaredTarget(value), repositoryCalls: functionKinds.has(value.kind) ? repositoryCallsOf(value) : [] });
      }
    }
    if (node.kind === SyntaxKind.VariableDeclaration && node.initializer && functionOwner(node) === undefined) {
      const calls = [];
      walk(node.initializer, (child) => { if (functionKinds.has(child.kind)) return false; if (child.kind === SyntaxKind.CallExpression) calls.push(text(child.expression)); });
      if (calls.length) record('module-initializer', node, { calls });
      if (callable(node.initializer)) record('module-callable', node);
    }
    if (node.kind === SyntaxKind.ReturnStatement && node.expression) {
      const value = unwrap(node.expression);
      if (value.kind === SyntaxKind.ObjectLiteralExpression) {
        const methods = value.properties.filter((property) => property.kind === SyntaxKind.MethodDeclaration || (property.kind === SyntaxKind.PropertyAssignment && callable(property.initializer)) || (property.kind === SyntaxKind.ShorthandPropertyAssignment && callable(property.name))).map((property) => name(property));
        if (methods.length) record('returned-method-object', node, { methods });
      }
    }
    if (node.kind === SyntaxKind.PropertyAssignment && callable(node.initializer)) record('callback-property', node, { property: name(node) });
  });
}
api.close();
items.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind));
const counts = Object.fromEntries([...new Set(items.map((item) => item.kind))].map((kind) => [kind, items.filter((item) => item.kind === kind).length]));
const output = { revision: execFileSync('git', ['rev-parse', ref ?? 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), files: paths.length, counts, typeErrors, items };
writeFileSync(resolve(repository, outputPath), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ files: output.files, counts }, null, 2));

if (typeErrors.length > 0) process.exitCode = 1;
