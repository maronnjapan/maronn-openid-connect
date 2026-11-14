import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    focus_paths: 'packages/core/src/,apps/map/changes/', question_count: '7',
    question_categories: 'vocabulary,knowledge,flow,design,debugging,comparison,implementation',
  } });
});

test('invalid inputs and missing authentication never send a dispatch', async () => {
  let sent = false;
  const options = { token: 'test', fetcher: async () => { sent = true; return { status: 204 }; } };
  for (const input of [{ prNumber: '-1' }, { prNumber: '194', questionCount: '0' }, { prNumber: '194', focusPaths: '../secret' },
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
