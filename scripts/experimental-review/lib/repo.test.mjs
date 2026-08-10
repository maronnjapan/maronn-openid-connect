import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  findFeatureTaskDir,
  listExperimentalSrc,
  scanCliReferences,
  scanE2e,
  scanSamples,
  scanDocs,
  listTaskDocs,
  buildPacketModel,
} from './repo.mjs';

/** テスト用の最小リポジトリを一時ディレクトリに組み立てる。 */
function buildFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), 'maronn-exp-review-fixture-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  write('packages/experimental/src/par/index.ts', "export * from './par-request.js';\n");
  write('packages/experimental/src/par/par-request.ts', 'export const handlePar = 1;\nexport const two = 2;\n');
  write('packages/experimental/src/par/par-request.test.ts', "describe('par', () => {});\n");
  write('packages/experimental/README.md', '| `par` | Pushed Authorization Requests |\n');

  write('packages/cli/src/features.ts', "export const EXPERIMENTAL_FEATURES = ['par'];\n// par is experimental\n");
  write('packages/cli/src/__tests__/par-feature.test.ts', "it('par', () => { features.par; });\n");
  write('packages/cli/src/frameworks/hono/templates.ts', 'export function parRouteTemplate() {}\n');
  write('packages/cli/src/generator.ts', 'export function generate() {}\n');

  write(
    'samples/hono-cloudflare/package.json',
    JSON.stringify({
      name: 'sample-hono',
      scripts: {
        generate:
          'maronn-oidc generate hono --enable par --enable jarm --output ./src/oidc-provider',
      },
    }),
  );
  write(
    'samples/express-flyio/package.json',
    JSON.stringify({
      name: 'sample-express',
      scripts: { generate: 'maronn-oidc generate express --output ./src/oidc-provider' },
    }),
  );

  write('tests/e2e/specs/pushed-authorization-requests.spec.ts', "test('PAR flow', () => {});\n");
  write('tests/e2e/specs/auth-code-flow.spec.ts', "test('code flow', () => {});\n");
  write('tests/e2e/apps/client.mjs', 'export const client = 1;\n');

  write(
    'docs/library-document/src/content/docs/experimental/par.md',
    '# PAR\n\npar を有効化するには --enable par を使う。\n',
  );
  write('docs/library-document/src/content/docs/guides/getting-started.md', '# はじめに\n');

  write(
    'tasks/experimental/done/par/specification.md',
    '# Experimental機能仕様書: PAR\n\n- **準拠仕様**: RFC 9126 - OAuth 2.0 Pushed Authorization Requests\n',
  );
  write('tasks/experimental/done/par/sources.md', '# 参照資料\n');
  write('tasks/experimental/done/par/review-log.md', '# レビューログ\n');
  write('tasks/experimental/done/par/understanding-guide.md', '# 理解資料\n');
  write('tasks/experimental/done/par/state.yaml', 'status: Implemented\n');

  return root;
}

test('repo scanning', async (t) => {
  const root = buildFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await t.test('findFeatureTaskDir should find the done/ directory for an implemented feature', () => {
    assert.equal(findFeatureTaskDir(root, 'par'), 'tasks/experimental/done/par');
  });

  await t.test('findFeatureTaskDir should prefer the in-progress directory when both exist', () => {
    mkdirSync(join(root, 'tasks/experimental/jarm'), { recursive: true });
    assert.equal(findFeatureTaskDir(root, 'jarm'), 'tasks/experimental/jarm');
  });

  await t.test('findFeatureTaskDir should return null for an unknown feature', () => {
    assert.equal(findFeatureTaskDir(root, 'token-exchange'), null);
  });

  await t.test('listExperimentalSrc should split implementation and test files with line counts', () => {
    assert.deepEqual(listExperimentalSrc(root, 'par'), {
      dir: 'packages/experimental/src/par',
      implFiles: [
        { path: 'packages/experimental/src/par/index.ts', lines: 1 },
        { path: 'packages/experimental/src/par/par-request.ts', lines: 2 },
      ],
      testFiles: [{ path: 'packages/experimental/src/par/par-request.test.ts', lines: 1 }],
    });
  });

  await t.test('scanCliReferences should list only files mentioning the feature', () => {
    assert.deepEqual(scanCliReferences(root, 'par'), [
      { path: 'packages/cli/src/__tests__/par-feature.test.ts', mentions: 2 },
      { path: 'packages/cli/src/features.ts', mentions: 2 },
      { path: 'packages/cli/src/frameworks/hono/templates.ts', mentions: 1 },
    ]);
  });

  await t.test('scanE2e should list only e2e files mentioning the feature', () => {
    assert.deepEqual(scanE2e(root, 'par'), [
      { path: 'tests/e2e/specs/pushed-authorization-requests.spec.ts', mentions: 1 },
    ]);
  });

  await t.test('scanSamples should report enabled features per sample', () => {
    assert.deepEqual(scanSamples(root, 'par'), [
      {
        name: 'express-flyio',
        enabledFeatures: [],
        usesFeature: false,
        generatedDir: 'samples/express-flyio/src/oidc-provider',
      },
      {
        name: 'hono-cloudflare',
        enabledFeatures: ['par', 'jarm'],
        usesFeature: true,
        generatedDir: 'samples/hono-cloudflare/src/oidc-provider',
      },
    ]);
  });

  await t.test('scanDocs should list docs pages and the experimental README mentioning the feature', () => {
    assert.deepEqual(scanDocs(root, 'par'), [
      { path: 'docs/library-document/src/content/docs/experimental/par.md', mentions: 3 },
      { path: 'packages/experimental/README.md', mentions: 1 },
    ]);
  });

  await t.test('listTaskDocs should order the spec first and include state.yaml', () => {
    assert.deepEqual(listTaskDocs(root, 'tasks/experimental/done/par'), [
      { path: 'tasks/experimental/done/par/specification.md' },
      { path: 'tasks/experimental/done/par/understanding-guide.md' },
      { path: 'tasks/experimental/done/par/sources.md' },
      { path: 'tasks/experimental/done/par/review-log.md' },
      { path: 'tasks/experimental/done/par/state.yaml' },
    ]);
  });
});

test('buildPacketModel', async (t) => {
  const root = buildFixtureRepo();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // 実 generator の代わりに、決定的な最小 generator を注入する。
  const fakeGenerator = {
    getAvailableFrameworks: () => ['hono', 'express'],
    resolveFeatures: ({ enable = [] } = {}) => ({ par: enable.includes('par') }),
    generate: ({ framework, features }) => ({
      framework,
      files: features.par
        ? [
            { path: 'app.ts', content: `${framework} app with par\n` },
            { path: 'routes/par.ts', content: 'par route\n' },
          ]
        : [{ path: 'app.ts', content: `${framework} app\n` }],
    }),
  };

  const model = buildPacketModel({ repoRoot: root, featureId: 'par', generator: fakeGenerator });

  await t.test('should locate the packet dir inside the feature task dir', () => {
    assert.equal(model.packetDirRepoPath, 'tasks/experimental/done/par/promotion-review');
    assert.equal(model.relPrefix, '../../../../..');
  });

  await t.test('should parse the spec name from specification.md', () => {
    assert.equal(model.specName, 'RFC 9126 - OAuth 2.0 Pushed Authorization Requests');
  });

  await t.test('should label the comparison trees after the feature', () => {
    assert.equal(model.generated.baselineLabel, 'default-op');
    assert.equal(model.generated.enabledLabel, 'with-par');
  });

  await t.test('should produce one group per distinct framework diff', () => {
    assert.deepEqual(
      model.generated.groups.map((g) => ({
        frameworks: g.frameworks,
        added: g.classification.added,
        changed: g.classification.changed,
      })),
      [
        { frameworks: ['hono'], added: ['routes/par.ts'], changed: ['app.ts'] },
        { frameworks: ['express'], added: ['routes/par.ts'], changed: ['app.ts'] },
      ],
    );
  });

  await t.test('should carry the repository scan results', () => {
    assert.equal(model.featureId, 'par');
    assert.equal(model.samples.length, 2);
    assert.equal(model.e2e.length, 1);
    assert.equal(model.experimentalSrc.implFiles.length, 2);
  });
});
