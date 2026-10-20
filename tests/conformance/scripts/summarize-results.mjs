import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveProfile } from './create-op-config.mjs';

/**
 * Summarize the plan a conformance run just finished: the outcome of every
 * module, and for the modules that did not pass, the conditions that failed
 * or warned. run-op.sh calls it once the runner exits, while the suite is still
 * up, and it reads the results from the suite's API (the same records the
 * exported ZIP holds):
 *
 * - results/<profile>-summary.md and results/<profile>-summary.json
 * - the job summary of GitHub Actions (GITHUB_STEP_SUMMARY), and an annotation
 *   per module that did not pass, so a run can be read on its page without
 *   downloading the ZIP
 */

const DEFAULT_RESULTS_DIR = fileURLToPath(new URL('../results', import.meta.url));

/** The results of a log entry that explain why a module did not pass. */
const PROBLEM_RESULTS = ['FAILURE', 'WARNING', 'REVIEW', 'SKIPPED', 'INTERRUPTED'];

/** Outcomes reported as errors; any other outcome but PASSED and NOT RUN is a warning. */
const ERROR_OUTCOMES = ['FAILED', 'INTERRUPTED', 'UNKNOWN'];

/** The fields of a log entry that the summary shows on their own, or that only the suite uses. */
const LOG_ENTRY_METADATA = [
  '_id', 'testId', 'testOwner', 'src', 'msg', 'result', 'requirements', 'time',
  'blockId', 'startBlock', 'upload', 'http',
];

const MAX_DETAILS_LENGTH = 500;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * The plan name of a run-test-plan.py argument
 * (`<plan>[<variant>=<value>]...:<module>,<module>`).
 */
export function planNameOf(testPlan) {
  return String(testPlan).split(/[[:]/)[0];
}

/**
 * Wait until the suite answers its runner API (the readiness check of
 * run-suite-runner.sh), as it does again only after it booted.
 */
export async function waitForSuite({ serverUrl, getJson, attempts = 60, delayMs = 2_000 }) {
  const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await getJson(`${base}api/runner/available`);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`The conformance suite did not answer at ${base}: ${lastError?.message}`);
}

/**
 * Read the newest plan named planName from the suite API, with the info and
 * the log of the latest instance of each of its modules. A module the run left
 * out has no instance. The log of a module that passed is not read.
 */
export async function fetchPlanResults({ serverUrl, planName, getJson }) {
  const base = serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`;
  const listed = await getJson(`${base}api/plan?length=100`);
  const plans = Array.isArray(listed) ? listed : listed?.data ?? [];
  const candidates = plans
    .filter((plan) => plan.planName === planName)
    .sort((a, b) => String(b.started ?? '').localeCompare(String(a.started ?? '')));
  if (candidates.length === 0) {
    throw new Error(`The conformance suite has no ${planName} plan`);
  }

  const plan = await getJson(`${base}api/plan/${candidates[0]._id}`);
  const modules = [];
  for (const module of plan.modules ?? []) {
    const testId = module.instances?.at(-1);
    if (testId === undefined) {
      modules.push({ testModule: module.testModule, variant: module.variant, testId: undefined, info: undefined, log: [] });
      continue;
    }
    const info = await getJson(`${base}api/info/${testId}`);
    const passed = info?.status === 'FINISHED' && info?.result === 'PASSED';
    const log = passed ? [] : await getJson(`${base}api/log/${testId}`);
    modules.push({ testModule: module.testModule, variant: module.variant, testId, info, log });
  }

  return {
    plan: { _id: plan._id, planName: plan.planName, variant: plan.variant },
    modules,
  };
}

/**
 * The outcome of each module and what made it fail or warn. The variant of a
 * module shows only the values that differ between the modules of the plan
 * (the response_type of the Implicit OP plan), not those the plan fixes.
 */
export function summarizePlanResults(results) {
  const variantKeys = differingVariantKeys(results.modules);
  const totals = {};
  const modules = results.modules.map((module) => {
    const outcome = outcomeOf(module.info);
    totals[outcome] = (totals[outcome] ?? 0) + 1;
    return {
      testModule: module.testModule,
      variant: variantKeys.map((key) => `${key}=${module.variant?.[key]}`).join(', '),
      testId: module.testId,
      outcome,
      problems: (module.log ?? [])
        .filter((entry) => PROBLEM_RESULTS.includes(entry.result))
        .map((entry) => ({
          result: entry.result,
          src: entry.src,
          msg: entry.msg,
          requirements: entry.requirements ?? [],
          details: detailsOf(entry),
        })),
    };
  });
  return { planId: results.plan._id, planName: results.plan.planName, totals, modules };
}

/** The job summary: a table of the outcomes, then the problems of each module that did not pass. */
export function formatMarkdownSummary(summary, { title }) {
  const lines = [
    `## ${title}`,
    '',
    `Plan \`${summary.planName}\` (\`${summary.planId}\`): ${formatTotals(summary.totals)}`,
    '',
    '| Module | Variant | Outcome |',
    '| --- | --- | --- |',
    ...summary.modules.map((module) => `| ${module.testModule} | ${module.variant} | ${module.outcome} |`),
    '',
  ];
  for (const module of summary.modules.filter(needsAttention)) {
    lines.push(`### ${labelOf(module)}: ${module.outcome}`, '');
    const problems = module.problems.length > 0
      ? module.problems.map((problem) => `- ${problem.result} \`${problem.src}\`${formatProblemTail(problem)}`)
      : [`- ${module.outcome}`];
    lines.push(...problems, '');
  }
  return lines.join('\n');
}

/**
 * GitHub Actions annotations: a notice with the outcome of every module, and an
 * error (FAILED, INTERRUPTED, UNKNOWN) or a warning (any other outcome but
 * PASSED and NOT RUN) per module that did not pass. A step keeps at most
 * maxPerLevel annotations of a level, so the last one of a level names the
 * modules it could not annotate one by one.
 */
export function formatAnnotations(summary, { title, maxPerLevel = 10 }) {
  const annotations = [
    workflowCommand(
      'notice',
      `${title}: ${formatTotals(summary.totals)}`,
      summary.modules.map((module) => `${labelOf(module)}: ${module.outcome}`).join('\n'),
    ),
  ];

  for (const level of ['warning', 'error']) {
    const modules = summary.modules.filter((module) => needsAttention(module) && levelOf(module) === level);
    const annotated = modules.length > maxPerLevel ? modules.slice(0, maxPerLevel - 1) : modules;
    for (const module of annotated) {
      const lines = module.problems.length > 0
        ? module.problems.map((problem) => `${problem.result} ${problem.src}${formatProblemTail(problem)}`)
        : [module.outcome];
      annotations.push(workflowCommand(level, `${title} ${labelOf(module)}: ${module.outcome}`, lines.join('\n')));
    }
    const rest = modules.slice(annotated.length);
    if (rest.length > 0) {
      annotations.push(workflowCommand(
        level,
        `${title}: ${rest.length} more modules did not pass`,
        rest.map((module) => `${labelOf(module)}: ${module.outcome}`).join('\n'),
      ));
    }
  }
  return annotations;
}

/** GET a JSON document. The suite of a local or CI run serves a self-signed certificate. */
export function getJson(url, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'http:' ? httpRequest : httpsRequest;
    const request = send(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      // Only for the suite this run started (run-suite-runner.sh likewise sets
      // DISABLE_SSL_VERIFY for the runner).
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`GET ${url} answered ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new Error(`GET ${url} did not return JSON`));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error(`GET ${url} timed out`)));
    request.on('error', reject);
    request.end();
  });
}

function outcomeOf(info) {
  if (info === undefined) return 'NOT RUN';
  if (info.status === 'FINISHED') return info.result ?? 'UNKNOWN';
  return info.status ?? 'UNKNOWN';
}

function needsAttention(module) {
  return module.outcome !== 'PASSED' && module.outcome !== 'NOT RUN';
}

function levelOf(module) {
  return ERROR_OUTCOMES.includes(module.outcome) ? 'error' : 'warning';
}

function labelOf(module) {
  return module.variant ? `${module.testModule} (${module.variant})` : module.testModule;
}

function formatTotals(totals) {
  return Object.entries(totals).map(([outcome, count]) => `${outcome} ${count}`).join(' / ');
}

function formatProblemTail(problem) {
  const requirements = problem.requirements.length > 0 ? ` [${problem.requirements.join(', ')}]` : '';
  const details = problem.details ? ` ${problem.details}` : '';
  return `${requirements}: ${problem.msg}${details}`;
}

// The variant keys whose values are not the same for every module.
function differingVariantKeys(modules) {
  const keys = [...new Set(modules.flatMap((module) => Object.keys(module.variant ?? {})))];
  return keys.filter((key) => {
    const values = new Set(modules.map((module) => JSON.stringify(module.variant?.[key])));
    return values.size > 1;
  });
}

// What a log entry adds besides its message: the values a condition reports,
// such as the expected and the actual claim.
function detailsOf(entry) {
  const details = Object.fromEntries(
    Object.entries(entry).filter(([key]) => !LOG_ENTRY_METADATA.includes(key)),
  );
  if (Object.keys(details).length === 0) return '';
  const json = JSON.stringify(details);
  return json.length > MAX_DETAILS_LENGTH ? `${json.slice(0, MAX_DETAILS_LENGTH)}…` : json;
}

// A workflow command (::<level> title=<title>::<message>), escaped as
// @actions/core escapes the properties and the data of a command.
function workflowCommand(level, title, message) {
  const truncated = message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message;
  return `::${level} title=${escapeProperty(title)}::${escapeData(truncated)}`;
}

function escapeData(value) {
  return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(value) {
  return escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

async function main() {
  const profile = resolveProfile(process.env.CONFORMANCE_PROFILE || undefined);
  const sampleApp = process.env.CONFORMANCE_SAMPLE_APP || 'hono-cloudflare';
  const serverUrl = process.env.CONFORMANCE_SUITE_URL
    || `https://localhost:${process.env.CONFORMANCE_SUITE_PORT || '8443'}/`;
  const resultsDir = process.env.CONFORMANCE_RESULTS_DIR || DEFAULT_RESULTS_DIR;

  await waitForSuite({ serverUrl, getJson });
  const results = await fetchPlanResults({ serverUrl, planName: planNameOf(profile.testPlan), getJson });
  const summary = summarizePlanResults(results);
  const markdown = formatMarkdownSummary(summary, { title: `OIDF ${profile.displayName} (${sampleApp})` });

  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, `${profile.name}-summary.json`), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(resultsDir, `${profile.name}-summary.md`), markdown);
  console.log(markdown);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const annotation of formatAnnotations(summary, { title: `${profile.name} (${sampleApp})` })) {
      console.log(annotation);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Could not summarize the conformance results: ${error.message}`);
    process.exitCode = 1;
  });
}
