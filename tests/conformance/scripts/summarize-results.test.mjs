import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchPlanResults,
  formatAnnotations,
  formatMarkdownSummary,
  planNameOf,
  summarizePlanResults,
  waitForSuite,
} from './summarize-results.mjs';

const IMPLICIT_PLAN = 'oidcc-implicit-certification-test-plan';

// What the suite's API returns for a plan of two modules, each run for both
// response types of the Implicit OP plan, and one module left out of the run.
function implicitPlanResults() {
  return {
    plan: {
      _id: 'PLAN123',
      planName: IMPLICIT_PLAN,
      variant: { server_metadata: 'discovery', client_registration: 'static_client' },
    },
    modules: [
      {
        testModule: 'oidcc-server',
        variant: { server_metadata: 'discovery', client_registration: 'static_client', response_type: 'id_token' },
        testId: 'T1',
        info: { status: 'FINISHED', result: 'PASSED' },
        log: [],
      },
      {
        testModule: 'oidcc-scope-profile',
        variant: { server_metadata: 'discovery', client_registration: 'static_client', response_type: 'id_token' },
        testId: 'T2',
        info: { status: 'FINISHED', result: 'WARNING' },
        log: [
          { src: 'CheckForSubjectInIdToken', result: 'SUCCESS', msg: 'Found sub' },
          {
            src: 'VerifyScopesReturnedInAuthorizationEndpointIdToken',
            result: 'WARNING',
            msg: 'Expected scope claims are missing',
            requirements: ['OIDCC-5.4'],
            missing: ['name'],
            _id: 'internal',
            testId: 'T2',
            time: 1,
          },
        ],
      },
      {
        testModule: 'oidcc-server',
        variant: { server_metadata: 'discovery', client_registration: 'static_client', response_type: 'id_token token' },
        testId: 'T3',
        info: { status: 'FINISHED', result: 'FAILED' },
        log: [
          {
            src: 'ValidateAtHash',
            result: 'FAILURE',
            msg: 'at_hash does not match',
            requirements: ['OIDCC-3.2.2.9'],
          },
        ],
      },
      {
        testModule: 'oidcc-prompt-login',
        variant: { server_metadata: 'discovery', client_registration: 'static_client', response_type: 'id_token token' },
        testId: undefined,
        info: undefined,
        log: [],
      },
    ],
  };
}

describe('planNameOf', () => {
  describe('test plan argument', () => {
    it('should strip the variant and the module selection of a run-test-plan.py argument', () => {
      assert.equal(
        planNameOf(`${IMPLICIT_PLAN}[server_metadata=discovery][client_registration=static_client]:oidcc-server,oidcc-scope-all`),
        IMPLICIT_PLAN,
      );
    });

    it('should keep a plan name without variant', () => {
      assert.equal(planNameOf(IMPLICIT_PLAN), IMPLICIT_PLAN);
    });
  });
});

describe('waitForSuite', () => {
  describe('suite availability', () => {
    // run-op.sh starts the suite again when --abort-on-container-exit stopped
    // it, and the suite answers only once it has booted.
    it('should retry until the runner API of the suite answers', async () => {
      const requested = [];
      let failures = 2;
      const getJson = async (url) => {
        requested.push(url);
        if (failures > 0) {
          failures -= 1;
          throw new Error('connect ECONNREFUSED');
        }
        return [];
      };

      await waitForSuite({ serverUrl: 'https://localhost:8443/', getJson, attempts: 5, delayMs: 0 });

      assert.deepEqual(requested, [
        'https://localhost:8443/api/runner/available',
        'https://localhost:8443/api/runner/available',
        'https://localhost:8443/api/runner/available',
      ]);
    });

    it('should reject once every attempt failed', async () => {
      const getJson = async () => {
        throw new Error('connect ECONNREFUSED');
      };

      await assert.rejects(
        waitForSuite({ serverUrl: 'https://localhost:8443', getJson, attempts: 3, delayMs: 0 }),
        { message: 'The conformance suite did not answer at https://localhost:8443/: connect ECONNREFUSED' },
      );
    });
  });
});

describe('fetchPlanResults', () => {
  describe('suite API', () => {
    it('should read the newest plan of the name and the latest instance of each module', async () => {
      const responses = new Map([
        ['https://localhost:8443/api/plan?length=100', {
          data: [
            { _id: 'OLD', planName: IMPLICIT_PLAN, started: '2026-10-20T01:00:00Z' },
            { _id: 'BASIC', planName: 'oidcc-basic-certification-test-plan', started: '2026-10-20T03:00:00Z' },
            { _id: 'NEW', planName: IMPLICIT_PLAN, started: '2026-10-20T02:00:00Z' },
          ],
        }],
        ['https://localhost:8443/api/plan/NEW', {
          _id: 'NEW',
          planName: IMPLICIT_PLAN,
          variant: { server_metadata: 'discovery' },
          modules: [
            { testModule: 'oidcc-server', variant: { response_type: 'id_token' }, instances: ['FIRST', 'RETRY'] },
            { testModule: 'oidcc-prompt-login', variant: { response_type: 'id_token' }, instances: [] },
          ],
        }],
        ['https://localhost:8443/api/info/RETRY', { status: 'FINISHED', result: 'FAILED' }],
        ['https://localhost:8443/api/log/RETRY', [{ src: 'ValidateAtHash', result: 'FAILURE', msg: 'mismatch' }]],
      ]);
      const requested = [];
      const getJson = async (url) => {
        requested.push(url);
        assert.equal(responses.has(url), true, `unexpected request ${url}`);
        return responses.get(url);
      };

      const results = await fetchPlanResults({ serverUrl: 'https://localhost:8443/', planName: IMPLICIT_PLAN, getJson });

      assert.deepEqual(results, {
        plan: { _id: 'NEW', planName: IMPLICIT_PLAN, variant: { server_metadata: 'discovery' } },
        modules: [
          {
            testModule: 'oidcc-server',
            variant: { response_type: 'id_token' },
            testId: 'RETRY',
            info: { status: 'FINISHED', result: 'FAILED' },
            log: [{ src: 'ValidateAtHash', result: 'FAILURE', msg: 'mismatch' }],
          },
          {
            testModule: 'oidcc-prompt-login',
            variant: { response_type: 'id_token' },
            testId: undefined,
            info: undefined,
            log: [],
          },
        ],
      });
      assert.deepEqual(requested, [
        'https://localhost:8443/api/plan?length=100',
        'https://localhost:8443/api/plan/NEW',
        'https://localhost:8443/api/info/RETRY',
        'https://localhost:8443/api/log/RETRY',
      ]);
    });

    it('should not read the log of a module that passed', async () => {
      const responses = new Map([
        ['https://localhost:8443/api/plan?length=100', [{ _id: 'P', planName: IMPLICIT_PLAN, started: '2026-10-20T01:00:00Z' }]],
        ['https://localhost:8443/api/plan/P', {
          _id: 'P',
          planName: IMPLICIT_PLAN,
          modules: [{ testModule: 'oidcc-server', variant: { response_type: 'id_token' }, instances: ['T1'] }],
        }],
        ['https://localhost:8443/api/info/T1', { status: 'FINISHED', result: 'PASSED' }],
      ]);
      const getJson = async (url) => {
        assert.equal(responses.has(url), true, `unexpected request ${url}`);
        return responses.get(url);
      };

      const results = await fetchPlanResults({ serverUrl: 'https://localhost:8443', planName: IMPLICIT_PLAN, getJson });

      assert.deepEqual(results.modules, [
        {
          testModule: 'oidcc-server',
          variant: { response_type: 'id_token' },
          testId: 'T1',
          info: { status: 'FINISHED', result: 'PASSED' },
          log: [],
        },
      ]);
    });

    it('should reject when the suite has no plan of the name', async () => {
      const getJson = async () => ({ data: [{ _id: 'BASIC', planName: 'oidcc-basic-certification-test-plan' }] });

      await assert.rejects(
        fetchPlanResults({ serverUrl: 'https://localhost:8443/', planName: IMPLICIT_PLAN, getJson }),
        { message: `The conformance suite has no ${IMPLICIT_PLAN} plan` },
      );
    });
  });
});

describe('summarizePlanResults', () => {
  describe('module outcomes', () => {
    it('should report each module with the variant values that tell the runs of a module apart', () => {
      const summary = summarizePlanResults(implicitPlanResults());

      assert.deepEqual(summary, {
        planId: 'PLAN123',
        planName: IMPLICIT_PLAN,
        totals: { PASSED: 1, WARNING: 1, FAILED: 1, 'NOT RUN': 1 },
        modules: [
          { testModule: 'oidcc-server', variant: 'response_type=id_token', testId: 'T1', outcome: 'PASSED', problems: [] },
          {
            testModule: 'oidcc-scope-profile',
            variant: 'response_type=id_token',
            testId: 'T2',
            outcome: 'WARNING',
            problems: [
              {
                result: 'WARNING',
                src: 'VerifyScopesReturnedInAuthorizationEndpointIdToken',
                msg: 'Expected scope claims are missing',
                requirements: ['OIDCC-5.4'],
                details: '{"missing":["name"]}',
              },
            ],
          },
          {
            testModule: 'oidcc-server',
            variant: 'response_type=id_token token',
            testId: 'T3',
            outcome: 'FAILED',
            problems: [
              {
                result: 'FAILURE',
                src: 'ValidateAtHash',
                msg: 'at_hash does not match',
                requirements: ['OIDCC-3.2.2.9'],
                details: '',
              },
            ],
          },
          { testModule: 'oidcc-prompt-login', variant: 'response_type=id_token token', testId: undefined, outcome: 'NOT RUN', problems: [] },
        ],
      });
    });

    it('should report the status of a module that did not finish', () => {
      const results = implicitPlanResults();
      results.modules = [{ ...results.modules[0], info: { status: 'WAITING', result: null } }];

      const summary = summarizePlanResults(results);

      assert.deepEqual(summary.modules.map((module) => module.outcome), ['WAITING']);
      assert.deepEqual(summary.totals, { WAITING: 1 });
    });
  });
});

describe('formatMarkdownSummary', () => {
  describe('job summary', () => {
    it('should list the outcome of every module and the problems of the modules that did not pass', () => {
      const markdown = formatMarkdownSummary(summarizePlanResults(implicitPlanResults()), {
        title: 'OIDF Implicit OP (hono-cloudflare)',
      });

      assert.equal(markdown, [
        '## OIDF Implicit OP (hono-cloudflare)',
        '',
        `Plan \`${IMPLICIT_PLAN}\` (\`PLAN123\`): PASSED 1 / WARNING 1 / FAILED 1 / NOT RUN 1`,
        '',
        '| Module | Variant | Outcome |',
        '| --- | --- | --- |',
        '| oidcc-server | response_type=id_token | PASSED |',
        '| oidcc-scope-profile | response_type=id_token | WARNING |',
        '| oidcc-server | response_type=id_token token | FAILED |',
        '| oidcc-prompt-login | response_type=id_token token | NOT RUN |',
        '',
        '### oidcc-scope-profile (response_type=id_token): WARNING',
        '',
        '- WARNING `VerifyScopesReturnedInAuthorizationEndpointIdToken` [OIDCC-5.4]: Expected scope claims are missing {"missing":["name"]}',
        '',
        '### oidcc-server (response_type=id_token token): FAILED',
        '',
        '- FAILURE `ValidateAtHash` [OIDCC-3.2.2.9]: at_hash does not match',
        '',
      ].join('\n'));
    });
  });
});

describe('formatAnnotations', () => {
  describe('GitHub Actions workflow commands', () => {
    it('should emit a notice with the outcomes and one annotation per module that did not pass', () => {
      const annotations = formatAnnotations(summarizePlanResults(implicitPlanResults()), {
        title: 'implicit-op',
      });

      assert.deepEqual(annotations, [
        '::notice title=implicit-op%3A PASSED 1 / WARNING 1 / FAILED 1 / NOT RUN 1::' +
          'oidcc-server (response_type=id_token): PASSED%0A' +
          'oidcc-scope-profile (response_type=id_token): WARNING%0A' +
          'oidcc-server (response_type=id_token token): FAILED%0A' +
          'oidcc-prompt-login (response_type=id_token token): NOT RUN',
        '::warning title=implicit-op oidcc-scope-profile (response_type=id_token)%3A WARNING::' +
          'WARNING VerifyScopesReturnedInAuthorizationEndpointIdToken [OIDCC-5.4]: Expected scope claims are missing {"missing":["name"]}',
        '::error title=implicit-op oidcc-server (response_type=id_token token)%3A FAILED::' +
          'FAILURE ValidateAtHash [OIDCC-3.2.2.9]: at_hash does not match',
      ]);
    });

    it('should escape the characters a workflow command reserves', () => {
      const results = implicitPlanResults();
      results.modules = [
        {
          ...results.modules[2],
          log: [{ src: 'Check, one', result: 'FAILURE', msg: '100% broken\r\nsecond line' }],
        },
      ];

      const [, annotation] = formatAnnotations(summarizePlanResults(results), { title: 'a:b,c' });

      // A single module: no variant value differs, so the label is the module alone.
      assert.equal(
        annotation,
        '::error title=a%3Ab%2Cc oidcc-server%3A FAILED::' +
          'FAILURE Check, one: 100%25 broken%0D%0Asecond line',
      );
    });

    it('should stop at the annotation limit of a step and name the modules it left out', () => {
      const results = implicitPlanResults();
      const failed = results.modules[2];
      results.modules = Array.from({ length: 12 }, (_, index) => ({
        ...failed,
        testModule: `oidcc-module-${index + 1}`,
      }));

      const annotations = formatAnnotations(summarizePlanResults(results), { title: 'implicit-op', maxPerLevel: 10 });
      const errors = annotations.filter((annotation) => annotation.startsWith('::error'));

      assert.equal(errors.length, 10);
      assert.equal(
        errors[8],
        '::error title=implicit-op oidcc-module-9%3A FAILED::' +
          'FAILURE ValidateAtHash [OIDCC-3.2.2.9]: at_hash does not match',
      );
      assert.equal(
        errors[9],
        '::error title=implicit-op%3A 3 more modules did not pass::' +
          'oidcc-module-10: FAILED%0A' +
          'oidcc-module-11: FAILED%0A' +
          'oidcc-module-12: FAILED',
      );
    });
  });
});
