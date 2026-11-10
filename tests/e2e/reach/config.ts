/**
 * The reports and the reach of an E2E run, for playwright.config.ts and
 * fixtures.ts (apps/map/docs/design-test-catalog.md §2):
 *
 * - With MARONN_TEST_REPORTS (or MARONN_REACH=1), the JSON and JUnit reports
 *   of Playwright: playwright/<target>.json and junit/e2e-<target>.junit.xml.
 * - With MARONN_REACH=1 against apps/hono or apps/nextjs (the OPs that start
 *   packages/test-reach), every OP instance gets a control port (its own
 *   port + 1) and an access log, the tests run one at a time, and the
 *   fixture writes the reach of each test to reach/e2e-<target>.jsonl. The
 *   global teardown writes coverage/e2e/<target>/lcov.info.
 *
 * Without either variable nothing here changes the run.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReporterDescription } from '@playwright/test';
import { reachEnabled, reportsDirectory } from '@maronn-openid-connect/test-reach/env';

/** An OP instance of the run whose reach the fixture takes. */
export interface ReachOp {
  /** main, xaa, dcr or rotation. */
  role: string;
  /** Its issuer, the origin its requests go to. */
  issuer: string;
  /** Its control port (packages/test-reach op.js). */
  control: number;
  /** Its access log. */
  accessLog: string;
}

/** The OPs that start packages/test-reach when MARONN_REACH is 1, and the target each is. */
const MEASURED: Record<string, string> = {
  '@maronn-openid-connect/app-hono': 'hono',
  '@maronn-openid-connect/app-nextjs': 'nextjs',
};

/** The variable through which the config tells the workers the OP instances it starts. */
const OPS_VARIABLE = 'MARONN_REACH_OPS';

/** The package of the OP the run tests (E2E_OP_PACKAGE, as playwright.config.ts reads it). */
const opPackage = process.env['E2E_OP_PACKAGE'] ?? '@maronn-openid-connect/app-hono';

/** The directory of the reports; none when neither variable is set. */
export const reports = reportsDirectory();

/** What the run tests: hono, nextjs, or the name of a sample (sample-hono-cloudflare → hono-cloudflare). */
export const target = MEASURED[opPackage] ?? opPackage.replace(/^@[^/]+\//, '').replace(/^sample-/, '');

/** Whether the run takes the reach of each test: MARONN_REACH=1 against an OP that measures itself. */
export const reachOn = reachEnabled() && opPackage in MEASURED;

/** The JSONL file of the reach of this run. */
export const reachFile = reports === undefined ? '' : join(reports, 'reach', `e2e-${target}.jsonl`);

/**
 * The reporters of the reports (JSON and JUnit) to add to the console and
 * HTML ones; none without MARONN_TEST_REPORTS or MARONN_REACH=1.
 */
export function reportReporters(): ReporterDescription[] {
  if (reports === undefined) return [];
  return [
    ['json', { outputFile: join(reports, 'playwright', `${target}.json`) }],
    ['junit', { outputFile: join(reports, 'junit', `e2e-${target}.junit.xml`) }],
  ];
}

/**
 * The part of the Playwright config the reach needs: one test at a time (the
 * counts and the access log of the OP are cut per test), and the global
 * setup and teardown of the reach files.
 */
export function reachRun(): { workers?: number; globalSetup?: string; globalTeardown?: string } {
  if (!reachOn) return {};
  return {
    workers: 1,
    globalSetup: fileURLToPath(new URL('./global-setup.ts', import.meta.url)),
    globalTeardown: fileURLToPath(new URL('./global-teardown.ts', import.meta.url)),
  };
}

/**
 * The environment an OP instance starts with for the reach (none when the
 * reach is off), and the instance recorded for the fixture: its control
 * port is the port of its issuer + 1.
 */
export function reachEnv(role: string, issuer: string): Record<string, string> {
  if (!reachOn || reports === undefined) return {};
  const url = new URL(issuer);
  const control = Number(url.port || (url.protocol === 'https:' ? 443 : 80)) + 1;
  const accessLog = join(reports, 'access', `${target}-${role}.log`);
  const op: ReachOp = { role, issuer: url.origin, control, accessLog };
  const ops = reachOps().filter((known) => known.role !== role);
  process.env[OPS_VARIABLE] = JSON.stringify([...ops, op]);
  return {
    MARONN_REACH: '1',
    MARONN_TEST_REPORTS: reports,
    MARONN_REACH_PORT: String(control),
    MARONN_REACH_TARGET: target,
    MARONN_REACH_ROLE: role,
    MARONN_REACH_ACCESS_LOG: accessLog,
  };
}

/** The OP instances the config starts with the reach (the workers inherit the variable). */
export function reachOps(): ReachOp[] {
  const value = process.env[OPS_VARIABLE];
  return value ? (JSON.parse(value) as ReachOp[]) : [];
}
