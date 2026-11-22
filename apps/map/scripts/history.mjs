/**
 * The history of main for an AI (Claude Code), from the data of the map
 * (packages/map-analysis history-brief.ts): what a change meant, the diff of
 * the provider's code it made function by function, and where each of those
 * functions is in the code the map was built from, so the AI reads that code
 * with the diff in mind instead of the diff alone.
 *
 *   pnpm map:history                                  the latest changes, with the keys that open them
 *   pnpm map:history pr-219                           a change ('#219', 219, its commit or a commit of its branch too)
 *   pnpm map:history pr-219 --summary                 the outline of a large change: its functions by file, the size of their diffs
 *   pnpm map:history pr-219 --function verify         one function of that change
 *   pnpm map:history --function verifyClientSecret    the changes that made a function (its name, root:name, module#name or id)
 *
 * --limit <n> caps the list and the changes of a function. --site (or
 * MAP_SITE) is where the map is: a built one (apps/map/public, the default,
 * written by `pnpm run build:map` or `pnpm --filter @maronn-openid-connect/map data`)
 * or the URL of the map deployed. The data is the map's own (map.json and
 * history/), so the map shows the same changes.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { changeBrief, changeNamed, changesFor, functionBrief, functionsNamed, keyOf, keyOfInput, listBrief, placeOf, sharingNumber } from '@maronn-openid-connect/map-analysis';

const USAGE = "Usage: pnpm map:history [<change: pr-219, '#219', a commit> [--summary | --function <name>]] [--function <name or id>] [--limit <n>] [--site <directory or URL of the map>]";

/** The size of a brief past which the command points at a narrower one: a large change read whole fills the context of an AI. */
const LARGE_BRIEF = 40000;

/** Read a file of the map by its url in the data (`./data/map.json`): from the directory, or from the map deployed. */
function readerOf(site) {
  if (/^https?:\/\//.test(site)) {
    const root = site.endsWith('/') ? site : `${site}/`;
    return async (path) => {
      const url = new URL(path, root);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${response.statusText} (${url})`);
      return response.json();
    };
  }
  return async (path) => JSON.parse(await readFile(resolve(site, path), 'utf8'));
}

// A reader that stops early (`| head`) closes the pipe: that ends the brief, not in an error.
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

/** Stop with a message for the reader (the AI or the person who ran it). */
function fail(message) {
  console.error(message);
  process.exit(1);
}

/** The root of the repository, where git runs. */
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Whether git says a commit is an ancestor of another (or the same); false when git cannot say. */
function isAncestor(commit, of) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, of], { cwd: repository, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The changes of the history whose commit this clone has (a map deployed from a newer main has changes it has not fetched). */
function changesGitKnows(history) {
  let output;
  try {
    output = execFileSync('git', ['cat-file', '--batch-check'], { cwd: repository, encoding: 'utf8', input: history.entries.map((entry) => entry.commit).join('\n') + '\n', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return [];
  }
  const known = new Set(output.split('\n').filter((line) => / commit \d+$/.test(line)).map((line) => line.split(' ')[0]));
  return history.entries.filter((entry) => known.has(entry.commit));
}

/**
 * The change that brought a commit the data does not hold (a merge inside a
 * merged branch, as git blame gives it): the oldest change of the history
 * whose commit has it, found with git by halves among the changes this clone
 * has (the changes are the first-parent chain, so the ones that have it are
 * the newest ones). Undefined when git does not know the commit or no change
 * it has holds it.
 */
function changeWithCommit(history, text) {
  // A shallow clone cannot see the ancestry past its oldest commits, so it would name a newer change than the one that brought the commit.
  try {
    if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true') {
      console.error(`This clone is shallow, so git cannot tell which change brought ${text}: run git fetch --unshallow, or name the change by its key.`);
      return undefined;
    }
  } catch {
    return undefined;
  }
  let commit;
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${keyOfInput(text)}^{commit}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
  const entries = changesGitKnows(history);
  if (entries.length === 0 || !isAncestor(commit, entries[0].commit)) return undefined;
  let low = 0;
  let high = entries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (isAncestor(commit, entries[middle].commit)) low = middle;
    else high = middle - 1;
  }
  return entries[low];
}

/** The words of an error. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

let parsed;
try {
  // pnpm passes on the `--` before the arguments of a script.
  parsed = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: { function: { type: 'string', short: 'f' }, summary: { type: 'boolean' }, limit: { type: 'string' }, site: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
} catch (error) {
  fail(`${messageOf(error)}\n${USAGE}`);
}
const { values, positionals } = parsed;
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}
if (positionals.length > 1) fail(`Name one change, not ${positionals.length} (${positionals.join(' ')}). In a shell, quote a number with #: '#219'.\n${USAGE}`);
if (values.summary === true && (positionals.length === 0 || values.function !== undefined)) fail(`--summary is the outline of a change: name the change, without --function.\n${USAGE}`);
const limit = values.limit === undefined ? undefined : Number(values.limit);
if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail(`--limit takes a positive whole number, not ${values.limit}.\n${USAGE}`);
const given = values.site?.trim() || process.env.MAP_SITE?.trim() || undefined;
// A directory is read from where it was typed: pnpm runs a script of apps/map there and says where it was run from (INIT_CWD).
const typedIn = process.env.npm_lifecycle_event !== undefined && process.env.INIT_CWD !== undefined ? process.env.INIT_CWD : process.cwd();
const site = given === undefined ? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public') : /^https?:\/\//.test(given) ? given : resolve(typedIn, given);
const read = readerOf(site);

const map = await read('./data/map.json').catch((error) => fail(`No map at ${site} (${messageOf(error)}): build it with pnpm run build:map, or pass --site the URL of the map.`));
if (map.history === undefined) fail(`The map at ${site} was built without the history of main (no git repository, or the build could not read it).`);
const history = await read(map.history).catch((error) => fail(`The history of the map at ${site} cannot be read (${messageOf(error)}).`));

let entry = positionals.length === 0 ? undefined : changeNamed(history, positionals[0]);
if (entry === undefined && positionals.length > 0 && /^[0-9a-f]{7,}$/.test(keyOfInput(positionals[0]))) {
  entry = changeWithCommit(history, positionals[0]);
  if (entry !== undefined) console.error(`${positionals[0]} reached main with ${keyOf(history, entry)}.`);
}
if (positionals.length > 0 && entry === undefined) fail(`No change ${positionals[0]} in the history of the map (${history.entries.length} changes; run pnpm map:history to list the latest).`);

if (values.function !== undefined) {
  const ids = functionsNamed(map, history, values.function, entry);
  if (ids.length === 0 && entry === undefined) fail(`No function ${values.function} in the map nor in its history.`);
  if (ids.length === 0) {
    const others = sharingNumber(history, entry).filter((other) => functionsNamed(map, history, values.function, other).length > 0);
    const also = others.length === 0 ? '' : ` ${others.map((other) => keyOf(history, other)).join(', ')}, with the same number #${entry.pr}, changed it.`;
    fail(`The change ${keyOf(history, entry)} changed no function ${values.function}: run pnpm map:history ${keyOf(history, entry)} --summary for its functions.${also}`);
  }
  if (ids.length > 1) {
    const lines = ids.map((id) => {
      const place = placeOf(map, id);
      return `  ${id}${place === undefined ? '' : `  ${place.path}:${place.start}`}`;
    });
    fail(`Several functions are named ${values.function}; pass one of these ids:\n${lines.join('\n')}`);
  }
  const id = ids[0];
  const touched = changesFor(map, history, id);
  const shown = entry === undefined ? touched.slice(0, limit ?? 10) : touched.filter((candidate) => candidate === entry);
  // The diff of each change the brief shows, read side by side; a change whose diff cannot be read says so.
  const details = new Map();
  await Promise.all(
    shown
      .filter((candidate) => candidate?.detail !== undefined)
      .map(async (candidate) => {
        const detail = await read(candidate.detail).catch((error) => console.error(`The diff of ${candidate.commit.slice(0, 10)} cannot be read: ${messageOf(error)}`));
        if (detail !== undefined) details.set(candidate.commit, detail);
      }),
  );
  process.stdout.write(functionBrief(map, history, id, details, { ...(limit === undefined ? {} : { limit }), ...(entry === undefined ? {} : { only: entry }) }));
} else if (entry !== undefined) {
  const detail = entry.detail === undefined ? undefined : await read(entry.detail).catch((error) => console.error(`The diff cannot be read: ${messageOf(error)}`));
  const brief = changeBrief(map, history, entry, detail, { diffs: values.summary !== true });
  process.stdout.write(brief);
  if (brief.length > LARGE_BRIEF) {
    const words = `${Math.ceil(brief.length / 1000)}k characters`;
    console.error(values.summary === true ? `Even the outline of this change is large (${words}): read one function of it with --function <name>.` : `This change is large (${words}): --summary gives its outline (its functions by file, the size of their diffs), and --function <name> one function of it.`);
  }
} else {
  process.stdout.write(listBrief(history, limit));
}
