/**
 * Deploy the OIDC Provider Map (apps/map) to Cloudflare Workers from CI.
 *
 *   node .github/scripts/map-preview.mjs create --pr <number> [--sha <sha>]
 *       Create or update the Worker Preview of the pull request (`wrangler
 *       preview --name pr-<number>`): an isolated deployment of the same
 *       Worker with a URL of its own that every push updates, so several
 *       pull requests are viewable side by side while main stays one
 *       deployment. Worker Previews are an open beta; when the command
 *       fails, the script falls back to a Worker per pull request
 *       (`wrangler deploy --name <worker>-pr-<number>`), which gives the
 *       same isolation with a URL per pull request.
 *   node .github/scripts/map-preview.mjs delete --pr <number>
 *       Remove both: the Preview and the fallback Worker, each ignored
 *       when it does not exist (the pull request was closed).
 *   node .github/scripts/map-preview.mjs deploy
 *       Deploy main to production (`wrangler deploy`).
 *
 * wrangler reads CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID from the
 * environment. The script writes `url`, `mode` (preview | worker | production
 * | none) and `note` to $GITHUB_OUTPUT when it is set, and prints them.
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

/** The `name` of a wrangler.jsonc (comments allowed). */
export function workerBaseName(wranglerJsonc) {
  const stripped = wranglerJsonc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const config = JSON.parse(stripped);
  if (typeof config.name !== 'string' || config.name === '') throw new Error('wrangler.jsonc has no name');
  return config.name;
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
  const baseName = workerBaseName(readFileSync(join(cwd, 'wrangler.jsonc'), 'utf8'));
  const pr = argValue(args, '--pr');
  if (command === 'create') {
    if (pr === undefined) throw new Error('create needs --pr <number>');
    const sha = argValue(args, '--sha') ?? '';
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
