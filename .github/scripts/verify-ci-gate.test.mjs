import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertEveryPackageIsTypechecked,
  assertLintGateIsBacked,
  assertStaticVerificationGate,
  assertWorkflowVerifiesMainPush,
  parseWorkflow,
} from './verify-ci-gate.mjs';

const workflowWith = (yaml) => parseWorkflow(yaml);

const CI_WORKFLOW = [
  'name: CI',
  '',
  'on:',
  '  pull_request:',
  '    branches: [main]',
  '  push:',
  '    branches: [main]',
  '',
  'jobs:',
  '  test:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v7',
  '',
  '      - name: Build packages',
  '        run: pnpm run build',
  '',
  '      - name: Type check',
  '        run: pnpm run typecheck',
  '',
  '      - name: Unit & Integration tests',
  '        run: pnpm run test:ci',
  '',
].join('\n');

describe('parseWorkflow', () => {
  it('should parse nested mappings into nested objects', () => {
    const workflow = parseWorkflow(['jobs:', '  test:', '    runs-on: ubuntu-latest', ''].join('\n'));

    assert.deepEqual(workflow, { jobs: { test: { 'runs-on': 'ubuntu-latest' } } });
  });

  it('should parse a flow sequence into an array', () => {
    const workflow = parseWorkflow(['on:', '  push:', '    branches: [main, release]', ''].join('\n'));

    assert.deepEqual(workflow, { on: { push: { branches: ['main', 'release'] } } });
  });

  it('should parse a block sequence of scalars into an array', () => {
    const workflow = parseWorkflow(['branches:', '  - main', '  - release', ''].join('\n'));

    assert.deepEqual(workflow, { branches: ['main', 'release'] });
  });

  it('should parse a block sequence of mappings into an array of objects', () => {
    const workflow = parseWorkflow(
      ['steps:', '  - uses: actions/checkout@v7', '  - name: Build', '    run: pnpm run build', ''].join(
        '\n',
      ),
    );

    assert.deepEqual(workflow, {
      steps: [{ uses: 'actions/checkout@v7' }, { name: 'Build', run: 'pnpm run build' }],
    });
  });

  it('should keep newlines when parsing a block scalar value', () => {
    const workflow = parseWorkflow(
      ['path: |', '  tests/e2e/playwright-report', '  tests/e2e/test-results', 'name: reports', ''].join(
        '\n',
      ),
    );

    assert.deepEqual(workflow, {
      path: 'tests/e2e/playwright-report\ntests/e2e/test-results',
      name: 'reports',
    });
  });

  it('should ignore comment lines and blank lines', () => {
    const workflow = parseWorkflow(
      ['# leading comment', '', 'on:', '  # nested comment', '  push:', '    branches: [main]', ''].join(
        '\n',
      ),
    );

    assert.deepEqual(workflow, { on: { push: { branches: ['main'] } } });
  });

  it('should strip surrounding quotes from a scalar value', () => {
    const workflow = parseWorkflow(["node-version: '22'", ''].join('\n'));

    assert.deepEqual(workflow, { 'node-version': '22' });
  });

  it('should keep an expression value containing a colon intact', () => {
    const workflow = parseWorkflow(
      ['concurrency:', '  group: ci-${{ github.workflow }}-${{ github.ref }}', ''].join('\n'),
    );

    assert.deepEqual(workflow, { concurrency: { group: 'ci-${{ github.workflow }}-${{ github.ref }}' } });
  });
});

describe('assertWorkflowVerifiesMainPush', () => {
  it('should accept a workflow triggered by both pull requests and main pushes', () => {
    assert.doesNotThrow(() => {
      assertWorkflowVerifiesMainPush(workflowWith(CI_WORKFLOW));
    });
  });

  it('should reject a workflow without a push trigger', () => {
    const workflow = workflowWith(['on:', '  pull_request:', '    branches: [main]', ''].join('\n'));

    assert.throws(
      () => assertWorkflowVerifiesMainPush(workflow),
      new Error(
        'CI ワークフローが main への push で起動しません。on.push.branches に main を追加してください。' +
          'PR を経由しない直接 push が無検査のまま release.yml の publish 経路へ流れ込みます。',
      ),
    );
  });

  it('should reject a push trigger that does not cover main', () => {
    const workflow = workflowWith(
      ['on:', '  pull_request:', '    branches: [main]', '  push:', '    branches: [develop]', ''].join(
        '\n',
      ),
    );

    assert.throws(() => assertWorkflowVerifiesMainPush(workflow), /on\.push\.branches に main/);
  });

  it('should reject a workflow without a pull request trigger', () => {
    const workflow = workflowWith(['on:', '  push:', '    branches: [main]', ''].join('\n'));

    assert.throws(
      () => assertWorkflowVerifiesMainPush(workflow),
      new Error(
        'CI ワークフローが main 向けの pull request で起動しません。' +
          'on.pull_request.branches に main を追加してください。',
      ),
    );
  });
});

describe('assertStaticVerificationGate', () => {
  it('should accept a job that builds, type checks, then tests in that order', () => {
    assert.doesNotThrow(() => {
      assertStaticVerificationGate(workflowWith(CI_WORKFLOW));
    });
  });

  it('should reject a job that runs tests without building the packages', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Type check',
        '        run: pnpm run typecheck',
        '      - name: Unit & Integration tests',
        '        run: pnpm run test:ci',
        '',
      ].join('\n'),
    );

    assert.throws(
      () => assertStaticVerificationGate(workflow),
      new Error(
        'CI の test ジョブに `pnpm run build` を実行するステップがありません。' +
          'vitest は都度 transform するためビルド破綻を検知できず、' +
          'build が初めて走るのが publish 直前になります。',
      ),
    );
  });

  it('should reject a job that runs tests without type checking', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Build packages',
        '        run: pnpm run build',
        '      - name: Unit & Integration tests',
        '        run: pnpm run test:ci',
        '',
      ].join('\n'),
    );

    assert.throws(
      () => assertStaticVerificationGate(workflow),
      /CI の test ジョブに `pnpm run typecheck` を実行するステップがありません。/,
    );
  });

  it('should reject a job that type checks before building the packages', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Type check',
        '        run: pnpm run typecheck',
        '      - name: Build packages',
        '        run: pnpm run build',
        '      - name: Unit & Integration tests',
        '        run: pnpm run test:ci',
        '',
      ].join('\n'),
    );

    assert.throws(
      () => assertStaticVerificationGate(workflow),
      new Error(
        'CI の test ジョブは `pnpm run build` -> `pnpm run typecheck` -> `pnpm run test:ci` の順で' +
          '実行してください。build を先に置くのは samples / experimental の型解決が core の' +
          'ビルド成果物 (dist) に依存するためで、typecheck を先に置くのは重いテストより先に' +
          '静的エラーで落とすためです。',
      ),
    );
  });

  it('should reject a workflow that has no job running the test suite', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  dependency-audit:',
        '    steps:',
        '      - name: Audit',
        '        run: pnpm audit --audit-level=high',
        '',
      ].join('\n'),
    );

    assert.throws(
      () => assertStaticVerificationGate(workflow),
      new Error('CI に `pnpm run test:ci` を実行するジョブがありません。'),
    );
  });
});

describe('assertEveryPackageIsTypechecked', () => {
  it('should accept packages that all define a typecheck script', () => {
    assert.doesNotThrow(() => {
      assertEveryPackageIsTypechecked([
        { name: '@maronn-openid-connect/core', scripts: { typecheck: 'tsc --noEmit' } },
        { name: '@maronn-openid-connect/cli', scripts: { typecheck: 'tsc --noEmit' } },
      ]);
    });
  });

  it('should reject a package without a typecheck script', () => {
    assert.throws(
      () =>
        assertEveryPackageIsTypechecked([
          { name: '@maronn-openid-connect/core', scripts: { build: 'tsc' } },
          { name: '@maronn-openid-connect/cli', scripts: { typecheck: 'tsc --noEmit' } },
        ]),
      new Error(
        'typecheck スクリプトを持たないパッケージがあります: @maronn-openid-connect/core。' +
          'pnpm --filter は該当スクリプトを持たないパッケージを黙って読み飛ばすため、' +
          'そのパッケージの型エラーが CI をすり抜けます。',
      ),
    );
  });

  it('should list every package that is missing a typecheck script', () => {
    assert.throws(
      () =>
        assertEveryPackageIsTypechecked([
          { name: '@maronn-openid-connect/core', scripts: {} },
          { name: '@maronn-openid-connect/cli', scripts: {} },
        ]),
      /@maronn-openid-connect\/core, @maronn-openid-connect\/cli/,
    );
  });

  it('should reject a package without a scripts field', () => {
    assert.throws(
      () => assertEveryPackageIsTypechecked([{ name: '@maronn-openid-connect/core' }]),
      /@maronn-openid-connect\/core/,
    );
  });
});

describe('assertLintGateIsBacked', () => {
  it('should accept a workflow that does not run lint at all', () => {
    assert.doesNotThrow(() => {
      assertLintGateIsBacked(workflowWith(CI_WORKFLOW), [{ name: '@maronn-openid-connect/core', scripts: {} }]);
    });
  });

  it('should accept a lint step backed by a package lint script', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Lint',
        '        run: pnpm run lint',
        '',
      ].join('\n'),
    );

    assert.doesNotThrow(() => {
      assertLintGateIsBacked(workflow, [{ name: '@maronn-openid-connect/core', scripts: { lint: 'eslint .' } }]);
    });
  });

  it('should reject a lint step that no package implements', () => {
    const workflow = workflowWith(
      [
        'jobs:',
        '  test:',
        '    steps:',
        '      - name: Lint',
        '        run: pnpm run lint',
        '',
      ].join('\n'),
    );

    assert.throws(
      () => assertLintGateIsBacked(workflow, [{ name: '@maronn-openid-connect/core', scripts: {} }]),
      new Error(
        'CI が `pnpm run lint` を実行していますが、packages/* のどのパッケージにも ' +
          'lint スクリプトがありません。pnpm --filter は対象が 0 件でも成功するため、' +
          'この Lint ステップは常に緑になり何も検証しません。',
      ),
    );
  });
});
