import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderDecisionTemplate, parseDecision } from './decision.mjs';

test('renderDecisionTemplate', async (t) => {
  await t.test('should start with a pending front matter for the feature', () => {
    const lines = renderDecisionTemplate('par').split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'feature: par');
    assert.equal(lines[2], 'decision: pending');
    assert.equal(lines[3], 'decided_at: null');
    assert.equal(lines[4], 'decided_by: null');
    assert.equal(lines[5], 'reviewed_commit: null');
    assert.equal(lines[6], '---');
  });

  await t.test('should include the promotion criteria checklist from the experimental README', () => {
    const content = renderDecisionTemplate('jarm');
    assert.equal(content.includes('- [ ] 生成 OP の conformance テストが 2 サイクル以上安定している'), true);
    assert.equal(content.includes('- [ ] resolver / store 契約への変更要望が収束している'), true);
    assert.equal(
      content.includes('- [ ] この仕様がリポジトリのロードマップ上で必須になっている'),
      true,
    );
  });

  await t.test('should include the review completion checklist', () => {
    const content = renderDecisionTemplate('jarm');
    assert.equal(
      content.includes('- [ ] specification.md の期待挙動と実装が一致していることを確認した'),
      true,
    );
    assert.equal(
      content.includes('- [ ] packages/experimental/src/jarm を単体テスト含めて読了した'),
      true,
    );
    assert.equal(
      content.includes('- [ ] 生成コード差分（全フレームワーク）を読了した'),
      true,
    );
  });
});

test('parseDecision', async (t) => {
  await t.test('should parse the pending template as pending', () => {
    assert.deepEqual(parseDecision(renderDecisionTemplate('par')), {
      decision: 'pending',
      decidedAt: null,
    });
  });

  await t.test('should parse a recorded go decision with its date', () => {
    const content = [
      '---',
      'feature: par',
      'decision: go',
      'decided_at: 2026-08-10',
      'decided_by: maronn',
      'reviewed_commit: 0123abc',
      '---',
      '',
    ].join('\n');
    assert.deepEqual(parseDecision(content), { decision: 'go', decidedAt: '2026-08-10' });
  });

  await t.test('should return null decision for a file without front matter', () => {
    assert.deepEqual(parseDecision('# メモだけのファイル\n'), {
      decision: null,
      decidedAt: null,
    });
  });

  await t.test('should return null decision for an unknown decision value', () => {
    const content = ['---', 'feature: par', 'decision: maybe', '---', ''].join('\n');
    assert.deepEqual(parseDecision(content), { decision: null, decidedAt: null });
  });
});
