import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  groupFrameworksByDiff,
  renderPacketReadme,
  renderGeneratedCodeDoc,
  buildPacketFiles,
} from './packet.mjs';

function fixtureFrameworkDiff(framework, patch) {
  return {
    framework,
    patch,
    classification: {
      added: ['routes/par.ts'],
      removed: [],
      changed: ['app.ts', 'conformance.test.ts'],
      unchanged: ['views.ts'],
    },
    stats: { files: 3, insertions: 10, deletions: 2 },
  };
}

test('groupFrameworksByDiff', async (t) => {
  await t.test('should group frameworks whose diff text is identical', () => {
    const groups = groupFrameworksByDiff([
      fixtureFrameworkDiff('hono', 'PATCH-A'),
      fixtureFrameworkDiff('express', 'PATCH-B'),
      fixtureFrameworkDiff('fastify', 'PATCH-B'),
      fixtureFrameworkDiff('nextjs', 'PATCH-C'),
    ]);
    assert.deepEqual(
      groups.map((g) => ({ frameworks: g.frameworks, docFile: g.docFile })),
      [
        { frameworks: ['hono'], docFile: 'generated-code/hono.md' },
        { frameworks: ['express', 'fastify'], docFile: 'generated-code/express-fastify.md' },
        { frameworks: ['nextjs'], docFile: 'generated-code/nextjs.md' },
      ],
    );
  });

  await t.test('should keep patch, classification and stats on each group', () => {
    const groups = groupFrameworksByDiff([fixtureFrameworkDiff('hono', 'PATCH-A')]);
    assert.equal(groups[0].patch, 'PATCH-A');
    assert.deepEqual(groups[0].stats, { files: 3, insertions: 10, deletions: 2 });
    assert.deepEqual(groups[0].classification.added, ['routes/par.ts']);
  });
});

function fixtureModel() {
  return {
    featureId: 'par',
    specName: 'RFC 9126 - OAuth 2.0 Pushed Authorization Requests',
    packetDirRepoPath: 'tasks/experimental/done/par/promotion-review',
    relPrefix: '../../../../..',
    experimentalSrc: {
      dir: 'packages/experimental/src/par',
      implFiles: [{ path: 'packages/experimental/src/par/index.ts', lines: 12 }],
      testFiles: [{ path: 'packages/experimental/src/par/par-request.test.ts', lines: 300 }],
    },
    cliReferences: [
      { path: 'packages/cli/src/__tests__/par-feature.test.ts', mentions: 40 },
      { path: 'packages/cli/src/features.ts', mentions: 9 },
    ],
    generated: {
      baselineLabel: 'default-op',
      enabledLabel: 'with-par',
      groups: groupFrameworksByDiff([
        fixtureFrameworkDiff('hono', 'PATCH-A'),
        fixtureFrameworkDiff('express', 'PATCH-B'),
        fixtureFrameworkDiff('fastify', 'PATCH-B'),
      ]),
    },
    samples: [
      {
        name: 'hono-cloudflare',
        enabledFeatures: ['par', 'token-exchange', 'transaction-binding', 'jarm'],
        usesFeature: true,
        generatedDir: 'samples/hono-cloudflare/src/oidc-provider',
      },
      { name: 'express-flyio', enabledFeatures: [], usesFeature: false, generatedDir: 'samples/express-flyio/src/oidc-provider' },
    ],
    e2e: [{ path: 'tests/e2e/specs/pushed-authorization-requests.spec.ts', mentions: 4 }],
    docs: [{ path: 'docs/library-document/src/content/docs/experimental/par.md', mentions: 21 }],
    taskDocs: [
      { path: 'tasks/experimental/done/par/specification.md' },
      { path: 'tasks/experimental/done/par/review-log.md' },
    ],
  };
}

test('renderPacketReadme', async (t) => {
  const readme = renderPacketReadme(fixtureModel());

  await t.test('should title the packet with the feature id', () => {
    assert.equal(readme.split('\n')[0], '# 昇格レビューパケット: par');
  });

  await t.test('should declare that judgment belongs to the human reviewer', () => {
    assert.equal(
      readme.includes('ツールは材料の収集と差分の切り出しだけを行い、判断はしません。'),
      true,
    );
  });

  await t.test('should warn that the packet is regenerated and decision.md is the exception', () => {
    assert.equal(
      readme.includes('`decision.md` 以外はツールが再生成のたびに作り直します。手で編集しないでください。'),
      true,
    );
  });

  await t.test('should link experimental source files relative to the packet dir', () => {
    assert.equal(
      readme.includes(
        '| [packages/experimental/src/par/index.ts](../../../../../packages/experimental/src/par/index.ts) | 12 |',
      ),
      true,
    );
  });

  await t.test('should list generated-code groups with their stats', () => {
    assert.equal(
      readme.includes(
        '| hono | [generated-code/hono.md](./generated-code/hono.md) | 1 | 2 | 0 | +10 / -2 |',
      ),
      true,
    );
    assert.equal(
      readme.includes(
        '| express / fastify | [generated-code/express-fastify.md](./generated-code/express-fastify.md) | 1 | 2 | 0 | +10 / -2 |',
      ),
      true,
    );
  });

  await t.test('should list files the feature does not touch', () => {
    assert.equal(readme.includes('- hono: views.ts'), true);
  });

  await t.test('should mark which samples actually enable the feature', () => {
    assert.equal(
      readme.includes(
        '| [samples/hono-cloudflare](../../../../../samples/hono-cloudflare) | par, token-exchange, transaction-binding, jarm | **有効** |',
      ),
      true,
    );
    assert.equal(
      readme.includes('| [samples/express-flyio](../../../../../samples/express-flyio) | （なし） | 無効 |'),
      true,
    );
  });

  await t.test('should point the reviewer at decision.md as the final step', () => {
    assert.equal(
      readme.includes('[decision.md](./decision.md) のチェックリストを埋め、判断を記録する'),
      true,
    );
  });
});

test('renderGeneratedCodeDoc', async (t) => {
  const model = fixtureModel();
  const doc = renderGeneratedCodeDoc(model, model.generated.groups[1]);

  await t.test('should title the doc with the grouped frameworks', () => {
    assert.equal(doc.split('\n')[0], '# 生成コード差分: par — express / fastify');
  });

  await t.test('should explain both sides of the comparison with generate commands', () => {
    assert.equal(
      doc.includes('`a/default-op/...`: `maronn-oidc generate <framework>`（experimental 機能なしのデフォルト構成）'),
      true,
    );
    assert.equal(
      doc.includes('`b/with-par/...`: `maronn-oidc generate <framework> --enable par`'),
      true,
    );
  });

  await t.test('should note when multiple frameworks share the identical diff', () => {
    assert.equal(
      doc.includes('express / fastify の生成コード差分は完全に同一のため、まとめて表示しています。'),
      true,
    );
  });

  await t.test('should embed the patch in a diff fence', () => {
    assert.equal(doc.includes('````diff\nPATCH-B\n````'), true);
  });

  await t.test('should summarize added and changed files', () => {
    assert.equal(doc.includes('| 追加 | routes/par.ts |'), true);
    assert.equal(doc.includes('| 変更 | app.ts, conformance.test.ts |'), true);
  });
});

test('buildPacketFiles', async (t) => {
  const files = buildPacketFiles(fixtureModel());

  await t.test('should emit the README and one doc per generated-code group', () => {
    assert.deepEqual(
      files.map((f) => f.path),
      ['README.md', 'generated-code/hono.md', 'generated-code/express-fastify.md'],
    );
  });

  await t.test('should not emit decision.md', () => {
    assert.equal(files.some((f) => f.path === 'decision.md'), false);
  });
});
