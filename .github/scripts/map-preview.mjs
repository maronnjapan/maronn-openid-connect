/**
 * Deploy the OIDC Provider Map (apps/map) to Cloudflare Workers from CI.
 *
 *   node .github/scripts/map-preview.mjs create --pr <number> [--sha <sha>]
 *       Deploy the map of the pull request where it is viewable beside main's
 *       and the other pull requests', with a URL every push updates:
 *       - When the Worker declares Durable Objects (wrangler.jsonc
 *         `durable_objects`: the map's live OP keeps a workspace in each), a
 *         Worker of the pull request (`wrangler deploy --name
 *         <worker>-pr-<number>`), with Durable Objects of its own. A Worker
 *         Preview would not do: its Durable Object bindings reach the
 *         namespace of production, whose objects run main's code, so the
 *         preview's OP would not be the pull request's.
 *       - Otherwise (a Worker of assets only), the Worker Preview of the
 *         pull request (`wrangler preview --name pr-<number>`): an isolated
 *         deployment of the same Worker. Worker Previews are an open beta;
 *         when the command fails, the script falls back to the Worker of the
 *         pull request.
 *   node .github/scripts/map-preview.mjs delete --pr <number>
 *       Remove both: the Preview and the Worker of the pull request (its
 *       Durable Objects with it), each ignored when it does not exist (the
 *       pull request was closed).
 *   node .github/scripts/map-preview.mjs deploy
 *       Deploy main to production (`wrangler deploy`).
 *
 * wrangler reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the
 * environment. The script writes `url`, `mode` (preview | pr-worker: the
 * Worker of the pull request because the Worker has Durable Objects |
 * worker: the Worker of the pull request because the Preview failed |
 * production | none) and `note` to $GITHUB_OUTPUT when it is set, and prints
 * them.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_DIRECTORY = 'apps/map';

/** The name of the Preview of a pull request. */
export function previewNameOf(prNumber) {
  return `pr-${Number(prNumber)}`;
}

/** The name of the fallback Worker of a pull request. */
export function workerNameOf(baseName, prNumber) {
  return `${baseName}-pr-${Number(prNumber)}`;
}

/** The index of the first character at or after an index of a JSONC text that is neither whitespace nor in a comment. */
function significantFrom(text, index) {
  let at = index;
  while (at < text.length) {
    if (/\s/.test(text[at])) at += 1;
    else if (text.startsWith('//', at)) at = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
    else if (text.startsWith('/*', at)) at = text.indexOf('*/', at + 2) === -1 ? text.length : text.indexOf('*/', at + 2) + 2;
    else break;
  }
  return at;
}

/** A wrangler.jsonc as a value: its comments and trailing commas left out, its strings (`"/login/*"`, URLs) kept as they are. */
export function parseJsonc(text) {
  let json = '';
  let index = 0;
  while (index < text.length) {
    const at = significantFrom(text, index);
    if (at > index) {
      json += ' ';
      index = at;
      continue;
    }
    if (text[index] === '"') {
      const string = /"(?:[^"\\]|\\.)*"/y;
      string.lastIndex = index;
      const literal = string.exec(text)?.[0] ?? text.slice(index);
      json += literal;
      index += literal.length;
      continue;
    }
    const trailingComma = text[index] === ',' && ['}', ']'].includes(text[significantFrom(text, index + 1)]);
    if (!trailingComma) json += text[index];
    index += 1;
  }
  return JSON.parse(json);
}

/** The `name` of a wrangler.jsonc (comments allowed). */
export function workerBaseName(wranglerJsonc) {
  const config = parseJsonc(wranglerJsonc);
  if (typeof config.name !== 'string' || config.name === '') throw new Error('wrangler.jsonc has no name');
  return config.name;
}

/** Whether a wrangler.jsonc binds Durable Objects, whose previews must be Workers of their own (see the module comment). */
export function usesDurableObjects(wranglerJsonc) {
  const bindings = parseJsonc(wranglerJsonc).durable_objects?.bindings;
  return Array.isArray(bindings) && bindings.length > 0;
}

/** The JSON object printed among other output (wrangler prints warnings around `--json`). */
export function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Every https URL on a workers.dev host (or any https URL, when none is) in a text. */
export function urlsIn(text) {
  const all = [...String(text).matchAll(/https:\/\/[^\s"'`<>)\]]+/g)].map((match) => match[0].replace(/[.,]+$/, ''));
  const workers = all.filter((url) => /\.workers\.dev(\/|$)/.test(url));
  return [...new Set(workers.length > 0 ? workers : all)];
}

/**
 * The URL of a Preview from the JSON of `wrangler preview --json`: the
 * documented `preview.urls[0]`, else the first workers.dev URL anywhere in it.
 */
export function previewUrlOf(json, rawText = '') {
  const documented = json?.preview?.urls?.[0] ?? json?.preview?.url ?? json?.urls?.[0] ?? json?.url;
  if (typeof documented === 'string' && documented.startsWith('https://')) return documented;
  const found = urlsIn(json === undefined ? rawText : JSON.stringify(json));
  return found[0];
}

/** The URL `wrangler deploy` prints for the Worker, if any. */
export function deploymentUrlOf(output) {
  return urlsIn(output)[0];
}

function run(args, { cwd, allowFailure = false }) {
  const result = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd, encoding: 'utf8', env: { ...process.env, CI: 'true' } });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`wrangler ${args.join(' ')} failed (${result.status}):\n${output}`);
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? '', output };
}

function writeOutputs(outputs) {
  for (const [key, value] of Object.entries(outputs)) console.log(`${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${String(value).replace(/\n/g, ' ')}\n`).join(''));
  }
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function main(argv, repositoryRoot) {
  const [command, ...args] = argv;
  const cwd = join(repositoryRoot, APP_DIRECTORY);
  const wranglerJsonc = readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8');
  const baseName = workerBaseName(wranglerJsonc);
  const pr = argValue(args, '--pr');
  if (command === 'create') {
    if (pr === undefined) throw new Error('create needs --pr <number>');
    const sha = argValue(args, '--sha') ?? '';
    if (usesDurableObjects(wranglerJsonc)) {
      const name = workerNameOf(baseName, pr);
      const deploy = run(['deploy', '--name', name, '--message', `PR #${pr} ${sha}`.trim()], { cwd });
      writeOutputs({ url: deploymentUrlOf(deploy.output) ?? '', mode: 'pr-worker', note: `Worker ${name} (the map's OP keeps its workspaces in Durable Objects of this Worker)` });
      return;
    }
    const preview = run(['preview', '--name', previewNameOf(pr), '--message', `PR #${pr} ${sha}`.trim(), '--json'], { cwd, allowFailure: true });
    if (preview.status === 0) {
      const url = previewUrlOf(extractJson(preview.stdout), preview.output);
      if (url !== undefined) {
        writeOutputs({ url, mode: 'preview', note: `Worker Preview ${previewNameOf(pr)} of ${baseName}` });
        return;
      }
    }
    console.error(`wrangler preview did not give a URL; deploying a Worker per pull request instead.\n${preview.output}`);
    const name = workerNameOf(baseName, pr);
    const deploy = run(['deploy', '--name', name], { cwd });
    const url = deploymentUrlOf(deploy.output);
    writeOutputs({ url: url ?? '', mode: 'worker', note: `Worker ${name} (wrangler preview failed, see the log)` });
    return;
  }
  if (command === 'delete') {
    if (pr === undefined) throw new Error('delete needs --pr <number>');
    const preview = run(['preview', 'delete', '--name', previewNameOf(pr), '-y'], { cwd, allowFailure: true });
    const worker = run(['delete', '--name', workerNameOf(baseName, pr), '--force'], { cwd, allowFailure: true });
    const removed = [preview.status === 0 ? `preview ${previewNameOf(pr)}` : null, worker.status === 0 ? `worker ${workerNameOf(baseName, pr)}` : null].filter(Boolean);
    writeOutputs({ url: '', mode: 'none', note: removed.length > 0 ? `removed ${removed.join(' and ')}` : 'nothing to remove' });
    return;
  }
  if (command === 'deploy') {
    const deploy = run(['deploy'], { cwd });
    writeOutputs({ url: deploymentUrlOf(deploy.output) ?? '', mode: 'production', note: `Worker ${baseName}` });
    return;
  }
  throw new Error(`Unknown command "${command}": create --pr <n> [--sha <sha>] | delete --pr <n> | deploy`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    main(process.argv.slice(2), repositoryRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
