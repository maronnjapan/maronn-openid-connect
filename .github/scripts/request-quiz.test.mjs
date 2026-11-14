import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { quizRequest, requestQuiz } from './request-quiz.mjs';

test('a PR-only request sends information for material preparation from the reader main branch', async () => {
  let call;
  const url = await requestQuiz({ prNumber: '194', focusPaths: 'packages/core/src/, apps/map/changes/' }, {
    token: 'test-dispatch-token', fetcher: async (url, options) => { call = { url, options }; return { status: 204 }; },
  });
  assert.match(url, /readRFCInMobile\/actions\/workflows\/quiz-authoring.yml$/);
  assert.equal(call.options.headers.Authorization, 'Bearer test-dispatch-token');
  assert.equal(call.options.redirect, 'error');
  assert.deepEqual(JSON.parse(call.options.body), { ref: 'main', inputs: {
    operation: 'prepare', code_source: 'maronn-openid-connect', pr_number: '194', spec_id: '',
    focus_paths: 'packages/core/src/,apps/map/changes/', question_count: '',
    question_categories: 'vocabulary,knowledge,flow,design,debugging,comparison,implementation',
  } });
});

test('omitted inputs scope the materials to provider code, tests and docs without choosing a question count', () => {
  const request = quizRequest({ prNumber: '194' });
  assert.equal(request.inputs.question_count, '');
  assert.deepEqual(request.inputs.focus_paths.split(','), [
    'apps/hono/', 'apps/nextjs/', 'packages/core/', 'packages/experimental/', 'packages/google-login/', 'tests/', 'docs/',
  ]);
  assert.equal(quizRequest({ prNumber: '194', questionCount: '', focusPaths: '' }).inputs.focus_paths, '');
});

test('CLI dry runs use the defaults and preserve an explicitly empty path selection', () => {
  const env = { ...process.env, PR_NUMBER: '194', SPEC_ID: '', QUESTION_CATEGORIES: '' };
  delete env.FOCUS_PATHS;
  delete env.QUESTION_COUNT;
  const run = (env) => JSON.parse(execFileSync(process.execPath, ['.github/scripts/request-quiz.mjs', '--dry-run'], {
    cwd: new URL('../../', import.meta.url), env, encoding: 'utf8',
  }));
  assert.deepEqual(run(env), quizRequest({ prNumber: '194' }));
  const empty = run({ ...env, FOCUS_PATHS: '', QUESTION_COUNT: '' }).inputs;
  assert.equal(empty.focus_paths, '');
  assert.equal(empty.question_count, '');
});

test('invalid inputs and missing authentication never send a dispatch', async () => {
  let sent = false;
  const options = { token: 'test', fetcher: async () => { sent = true; return { status: 204 }; } };
  for (const input of [{ prNumber: '-1' }, ...[0, '0', '-1', '1.5', 'seven', ' '].map((questionCount) => ({ prNumber: '194', questionCount })), { prNumber: '194', focusPaths: '../secret' },
    { prNumber: '194', questionCategories: 'knowledge,knowledge' },
    { prNumber: '194', specId: 'bad\nvalue' }]) await assert.rejects(requestQuiz(input, options));
  await assert.rejects(requestQuiz({ prNumber: '194' }), /QUIZ_DISPATCH_TOKEN/);
  assert.equal(sent, false);
});

test('material requests have no question-count, path-count or eight-file partition limits', () => {
  const paths = Array.from({ length: 30 }, (_, i) => `new-directory-${i}/`).join(',');
  const request = quizRequest({ prNumber: 194, questionCount: '100', focusPaths: paths });
  assert.equal(request.inputs.question_count, '100');
  assert.equal(request.inputs.focus_paths.split(',').length, 30);
  assert.equal(request.inputs.part, undefined);
  assert.equal(quizRequest({ prNumber: 194, questionCount: '1' }).inputs.operation, 'prepare');
});

test('a scoped specification request reports remote setup failures without logging credentials', async () => {
  assert.equal(quizRequest({ prNumber: 194, specId: 'rfc-6749', questionCount: '2', questionCategories: 'knowledge,debugging' }).inputs.spec_id, 'rfc-6749');
  await assert.rejects(requestQuiz({ prNumber: 194 }, { token: 'test', fetcher: async () => ({ status: 403 }) }), /dispatch failed \(403\)/);
});
