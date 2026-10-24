import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseWorkflow } from './verify-ci-gate.mjs';
import {
  assertChangesetsActionMatchesCli,
  assertCoreBreakingChangeReleasesCoreDependents,
  assertCorePeerDependencyShape,
  assertCorePeerRangeCoversNextCore,
  assertExperimentalReleasesAreAlwaysPatch,
  assertPrivatePackagesAreNotVersioned,
  collectStepOutputReferences,
  CORE_DEPENDENT_PACKAGES,
  computeNextVersion,
  findChangesetsActionStep,
  parseChangesetBumps,
  parseChangesetsActionMajor,
  parseChangesetsCliMajor,
  parseMinimumCoreVersion,
  resolveNextCoreVersion,
} from './verify-release-contract.mjs';

describe('parseChangesetBumps', () => {
  it('should read every package bump from the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-openid-connect/core": minor',
      '"@maronn-openid-connect/experimental": patch',
      '---',
      '',
      'some description',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), {
      '@maronn-openid-connect/core': 'minor',
      '@maronn-openid-connect/experimental': 'patch',
    });
  });

  it('should accept single quotes around the package name', () => {
    const content = ['---', "'@maronn-openid-connect/core': patch", '---', '', 'body', ''].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-openid-connect/core': 'patch' });
  });

  it('should return an empty object for a file without frontmatter', () => {
    assert.deepEqual(parseChangesetBumps('# Changesets\n\nread me\n'), {});
  });

  it('should ignore bump-like lines that appear after the frontmatter', () => {
    const content = [
      '---',
      '"@maronn-openid-connect/core": patch',
      '---',
      '',
      '"@maronn-openid-connect/experimental": major は本文中の例示なので無視する',
      '',
    ].join('\n');

    assert.deepEqual(parseChangesetBumps(content), { '@maronn-openid-connect/core': 'patch' });
  });
});

describe('CORE_DEPENDENT_PACKAGES', () => {
  it('should list every package that declares core as a peer dependency', () => {
    assert.deepEqual(CORE_DEPENDENT_PACKAGES, [
      { name: '@maronn-openid-connect/experimental', manifestPath: 'packages/experimental/package.json' },
      { name: '@maronn-openid-connect/google-login', manifestPath: 'packages/google-login/package.json' },
    ]);
  });
});

describe('assertCoreBreakingChangeReleasesCoreDependents', () => {
  it('should accept a core patch release without releasing the core dependents', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
      ]);
    });
  });

  it('should accept an experimental only release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        { file: 'a.md', bumps: { '@maronn-openid-connect/experimental': 'minor' } },
      ]);
    });
  });

  it('should accept a google-login only release', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        { file: 'a.md', bumps: { '@maronn-openid-connect/google-login': 'minor' } },
      ]);
    });
  });

  it('should accept a core minor release that also releases every core dependent', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
        { file: 'c.md', bumps: { '@maronn-openid-connect/google-login': 'patch' } },
      ]);
    });
  });

  it('should accept a single changeset that releases core and every core dependent', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        {
          file: 'a.md',
          bumps: {
            '@maronn-openid-connect/core': 'major',
            '@maronn-openid-connect/experimental': 'patch',
            '@maronn-openid-connect/google-login': 'minor',
          },
        },
      ]);
    });
  });

  it('should reject a core minor release without any core dependent release', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesCoreDependents([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        ]),
      new Error(
        '@maronn-openid-connect/core を minor 以上で上げる changeset (a.md) がありますが、' +
          '@maronn-openid-connect/experimental, @maronn-openid-connect/google-login の changeset がありません。' +
          'これらは core を広い peer range で参照しており、公開済みの古いパッケージが' +
          '新しい core をそのまま受け入れてしまうため、core の minor / major では' +
          '同時にリリースして最新 core との組み合わせを保証してください。',
      ),
    );
  });

  it('should reject a core minor release that releases experimental but not google-login', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesCoreDependents([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
        ]),
      /がありますが、@maronn-openid-connect\/google-login の changeset がありません/,
    );
  });

  it('should reject a core minor release that releases google-login but not experimental', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesCoreDependents([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-openid-connect/google-login': 'patch' } },
        ]),
      /がありますが、@maronn-openid-connect\/experimental の changeset がありません/,
    );
  });

  it('should reject a core major release without a core dependent release', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesCoreDependents([
          { file: 'core-major.md', bumps: { '@maronn-openid-connect/core': 'major' } },
        ]),
      /core-major\.md/,
    );
  });

  it('should list every offending changeset file when several exist', () => {
    assert.throws(
      () =>
        assertCoreBreakingChangeReleasesCoreDependents([
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'major' } },
        ]),
      /\(a\.md, b\.md\)/,
    );
  });

  it('should accept a release that touches neither core nor its dependents', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents([
        { file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } },
      ]);
    });
  });

  it('should check only the dependents that are passed explicitly', () => {
    assert.doesNotThrow(() => {
      assertCoreBreakingChangeReleasesCoreDependents(
        [
          { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
          { file: 'b.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
        ],
        ['@maronn-openid-connect/experimental'],
      );
    });
  });
});

describe('assertCorePeerDependencyShape', () => {
  it('should accept core declared as a peer dependency and linked for local development', () => {
    assert.doesNotThrow(() => {
      assertCorePeerDependencyShape({
        name: '@maronn-openid-connect/experimental',
        peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
        devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
      });
    });
  });

  it('should reject core declared as a runtime dependency', () => {
    assert.throws(
      () =>
        assertCorePeerDependencyShape({
          name: '@maronn-openid-connect/google-login',
          dependencies: { '@maronn-openid-connect/core': '0.0.1' },
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-openid-connect/google-login は @maronn-openid-connect/core を dependencies に持ってはいけません。' +
          'core が二重にインストールされると instanceof 判定が静かに false になります。',
      ),
    );
  });

  it('should reject a missing core peer dependency', () => {
    assert.throws(
      () =>
        assertCorePeerDependencyShape({
          name: '@maronn-openid-connect/experimental',
          devDependencies: { '@maronn-openid-connect/core': 'workspace:*' },
        }),
      new Error(
        '@maronn-openid-connect/experimental は @maronn-openid-connect/core を peerDependencies に宣言してください。',
      ),
    );
  });

  it('should reject a missing workspace link for local development', () => {
    assert.throws(
      () =>
        assertCorePeerDependencyShape({
          name: '@maronn-openid-connect/google-login',
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
        }),
      new Error(
        '@maronn-openid-connect/google-login は @maronn-openid-connect/core を devDependencies の workspace:* で' +
          '参照してください。ローカル開発とテストが registry の core を引いてしまいます。',
      ),
    );
  });

  it('should reject a devDependency that does not use the workspace protocol', () => {
    assert.throws(
      () =>
        assertCorePeerDependencyShape({
          name: '@maronn-openid-connect/experimental',
          peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
          devDependencies: { '@maronn-openid-connect/core': '^0.0.1' },
        }),
      /workspace:\*/,
    );
  });

  it('should fall back to a placeholder when the manifest has no name', () => {
    assert.throws(
      () => assertCorePeerDependencyShape({ devDependencies: { '@maronn-openid-connect/core': 'workspace:*' } }),
      /^Error: \(name 未設定のパッケージ\) は @maronn-openid-connect\/core を peerDependencies に宣言してください。$/,
    );
  });
});

describe('assertExperimentalReleasesAreAlwaysPatch', () => {
  it('should accept a patch bump for experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-openid-connect/experimental': 'patch' } },
      ]);
    });
  });

  it('should accept changesets that do not release experimental', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([
        { file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'major' } },
      ]);
    });
  });

  it('should accept an empty changeset list', () => {
    assert.doesNotThrow(() => {
      assertExperimentalReleasesAreAlwaysPatch([]);
    });
  });

  it('should reject a minor bump for experimental', () => {
    assert.throws(
      () =>
        assertExperimentalReleasesAreAlwaysPatch([
          { file: 'experimental-par.md', bumps: { '@maronn-openid-connect/experimental': 'minor' } },
        ]),
      /experimental-par\.md \(minor\)/,
    );
  });

  it('should reject a major bump for experimental', () => {
    assert.throws(
      () =>
        assertExperimentalReleasesAreAlwaysPatch([
          { file: 'breaking.md', bumps: { '@maronn-openid-connect/experimental': 'major' } },
        ]),
      /breaking\.md \(major\)/,
    );
  });
});

describe('parseMinimumCoreVersion', () => {
  it('should read the lower bound from a range with an upper bound', () => {
    assert.equal(parseMinimumCoreVersion('>=0.1.0 <1.0.0'), '0.1.0');
  });

  it('should read the lower bound from a range without an upper bound', () => {
    assert.equal(parseMinimumCoreVersion('>=0.2.3'), '0.2.3');
  });

  it('should tolerate extra whitespace around the comparator', () => {
    assert.equal(parseMinimumCoreVersion('  >= 1.2.3   <2.0.0 '), '1.2.3');
  });

  it('should return null for a caret range', () => {
    assert.equal(parseMinimumCoreVersion('^0.1.0'), null);
  });

  it('should return null for a wildcard range', () => {
    assert.equal(parseMinimumCoreVersion('*'), null);
  });
});

describe('computeNextVersion', () => {
  it('should raise the patch segment for a patch bump', () => {
    assert.equal(computeNextVersion('0.1.0', 'patch'), '0.1.1');
  });

  it('should raise the minor segment and reset patch for a minor bump', () => {
    assert.equal(computeNextVersion('0.0.1', 'minor'), '0.1.0');
  });

  it('should raise the major segment and reset minor and patch for a major bump', () => {
    assert.equal(computeNextVersion('0.1.2', 'major'), '1.0.0');
  });

  it('should keep the version unchanged when there is no bump', () => {
    assert.equal(computeNextVersion('0.1.0', undefined), '0.1.0');
  });
});

describe('resolveNextCoreVersion', () => {
  it('should return the current version when no changeset releases core', () => {
    assert.equal(
      resolveNextCoreVersion('0.1.0', [{ file: 'a.md', bumps: { '@maronn-openid-connect/cli': 'minor' } }]),
      '0.1.0',
    );
  });

  it('should apply the pending core bump', () => {
    assert.equal(
      resolveNextCoreVersion('0.0.1', [{ file: 'a.md', bumps: { '@maronn-openid-connect/core': 'minor' } }]),
      '0.1.0',
    );
  });

  it('should apply the largest pending core bump when several changesets release core', () => {
    assert.equal(
      resolveNextCoreVersion('0.0.1', [
        { file: 'a.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
        { file: 'b.md', bumps: { '@maronn-openid-connect/core': 'minor' } },
        { file: 'c.md', bumps: { '@maronn-openid-connect/core': 'patch' } },
      ]),
      '0.1.0',
    );
  });
});

describe('assertCorePeerRangeCoversNextCore', () => {
  it('should accept a lower bound equal to the next core version', () => {
    assert.doesNotThrow(() => {
      assertCorePeerRangeCoversNextCore(
        {
          name: '@maronn-openid-connect/experimental',
          peerDependencies: { '@maronn-openid-connect/core': '>=0.1.0 <1.0.0' },
        },
        '0.1.0',
      );
    });
  });

  it('should accept a lower bound above the next core version', () => {
    assert.doesNotThrow(() => {
      assertCorePeerRangeCoversNextCore(
        {
          name: '@maronn-openid-connect/google-login',
          peerDependencies: { '@maronn-openid-connect/core': '>=0.2.0 <1.0.0' },
        },
        '0.1.0',
      );
    });
  });

  it('should reject a lower bound below the next core version', () => {
    assert.throws(
      () =>
        assertCorePeerRangeCoversNextCore(
          {
            name: '@maronn-openid-connect/experimental',
            peerDependencies: { '@maronn-openid-connect/core': '>=0.0.1 <1.0.0' },
          },
          '0.1.0',
        ),
      /">=0\.0\.1 <1\.0\.0" は core 0\.1\.0 より古い 0\.0\.1 を下限にしています/,
    );
  });

  it('should name the package whose lower bound is stale', () => {
    assert.throws(
      () =>
        assertCorePeerRangeCoversNextCore(
          {
            name: '@maronn-openid-connect/google-login',
            peerDependencies: { '@maronn-openid-connect/core': '>=0.3.0 <1.0.0' },
          },
          '0.4.0',
        ),
      /^Error: @maronn-openid-connect\/google-login の @maronn-openid-connect\/core peer range ">=0\.3\.0 <1\.0\.0" は core 0\.4\.0 より古い 0\.3\.0 を下限にしています。@maronn-openid-connect\/google-login はモノレポ内の core だけを相手に/,
    );
  });

  it('should compare each version segment numerically rather than as text', () => {
    assert.throws(
      () =>
        assertCorePeerRangeCoversNextCore(
          {
            name: '@maronn-openid-connect/experimental',
            peerDependencies: { '@maronn-openid-connect/core': '>=0.9.0 <1.0.0' },
          },
          '0.10.0',
        ),
      /core 0\.10\.0 より古い 0\.9\.0 を下限にしています/,
    );
  });

  it('should reject a range whose lower bound cannot be read', () => {
    assert.throws(
      () =>
        assertCorePeerRangeCoversNextCore(
          {
            name: '@maronn-openid-connect/experimental',
            peerDependencies: { '@maronn-openid-connect/core': '^0.1.0' },
          },
          '0.1.0',
        ),
      /"\^0\.1\.0" から下限を読み取れません/,
    );
  });
});

describe('assertPrivatePackagesAreNotVersioned', () => {
  it('should accept a config that turns versioning off for private packages', () => {
    assert.doesNotThrow(() => {
      assertPrivatePackagesAreNotVersioned({ privatePackages: { version: false, tag: false } });
    });
  });

  it('should accept the false shorthand that turns off both versioning and tagging', () => {
    assert.doesNotThrow(() => {
      assertPrivatePackagesAreNotVersioned({ privatePackages: false });
    });
  });

  it('should reject a config without privatePackages because Changesets versions them by default', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ access: 'public' }),
      /`privatePackages\.version` を false にしてください/,
    );
  });

  it('should reject a config that keeps versioning private packages', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ privatePackages: { version: true } }),
      /`privatePackages\.version` を false にしてください/,
    );
  });

  it('should reject a config that only omits the version key', () => {
    assert.throws(
      () => assertPrivatePackagesAreNotVersioned({ privatePackages: { tag: false } }),
      /`privatePackages\.version` を false にしてください/,
    );
  });
});

/** release.yml の changesets/action まわりだけを抜き出した workflow を組み立てる。`id: null` で id を省く。 */
const releaseWorkflowText = ({
  uses = 'changesets/action@v2',
  id = 'changesets',
  withLines = [
    'version-script: pnpm run ci:version',
    'publish-script: pnpm run ci:publish',
    'push-with-git-cli: true',
  ],
  outputReferences = ['published', 'published-packages', 'has-changesets'],
} = {}) =>
  [
    'name: Release',
    '',
    'jobs:',
    '  release:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - name: Checkout',
    '        uses: actions/checkout@v7',
    '',
    '      - name: Create Release PR or Publish to npm',
    ...(id === null ? [] : [`        id: ${id}`]),
    `        uses: ${uses}`,
    '        with:',
    '          # 未消化の changeset があれば Version Packages PR を作成/更新する。',
    ...withLines.map((line) => `          ${line}`),
    '',
    ...outputReferences.flatMap((name, index) => [
      `      - name: Read output ${index}`,
      '        env:',
      `          VALUE: \${{ steps.changesets.outputs.${name} }}`,
      '        run: node check.mjs',
      '',
    ]),
  ].join('\n');

const assertPairing = ({ cliRange = '^3.0.2', ...workflowOptions } = {}) => {
  const workflowText = releaseWorkflowText(workflowOptions);
  assertChangesetsActionMatchesCli({ cliRange, workflow: parseWorkflow(workflowText), workflowText });
};

const V1_WITH_LINES = ['version: pnpm run ci:version', 'publish: pnpm run ci:publish'];
const V1_OUTPUT_REFERENCES = ['published', 'publishedPackages', 'hasChangesets'];

describe('parseChangesetsCliMajor', () => {
  it('should read the major of a caret range', () => {
    assert.equal(parseChangesetsCliMajor('^3.0.2'), 3);
  });

  it('should read the major of a tilde range and an exact version', () => {
    assert.equal(parseChangesetsCliMajor('~2.31.1'), 2);
    assert.equal(parseChangesetsCliMajor('3.0.3'), 3);
  });

  it('should reject a range that spans several majors', () => {
    assert.throws(() => parseChangesetsCliMajor('>=2.0.0 <4.0.0'), /major を読み取れません/);
  });

  it('should reject a missing declaration', () => {
    assert.throws(() => parseChangesetsCliMajor(undefined), /major を読み取れません/);
  });
});

describe('parseChangesetsActionMajor', () => {
  it('should read the major of a major ref and of a full version ref', () => {
    assert.equal(parseChangesetsActionMajor('changesets/action@v2'), 2);
    assert.equal(parseChangesetsActionMajor('changesets/action@v2.1.2'), 2);
  });

  it('should reject a commit SHA because its major cannot be read', () => {
    assert.throws(
      () => parseChangesetsActionMajor('changesets/action@ae32849d5ba541f9ae29e40e22a623bc13562f51'),
      /major を読み取れません/,
    );
  });
});

describe('findChangesetsActionStep', () => {
  it('should find the step that uses changesets/action', () => {
    const step = findChangesetsActionStep(parseWorkflow(releaseWorkflowText()));

    assert.equal(step.id, 'changesets');
    assert.equal(step.uses, 'changesets/action@v2');
  });

  // sub-action（changesets/action/publish など）へ移すと、この検査は何も見なくなる。
  // 黙って通さずに、検査を書き換えるよう求める。
  it('should reject a workflow without the changesets/action step', () => {
    const workflow = parseWorkflow(releaseWorkflowText({ uses: 'changesets/action/publish@v2' }));

    assert.throws(() => findChangesetsActionStep(workflow), /changesets\/action を使うステップがありません/);
  });
});

describe('collectStepOutputReferences', () => {
  it('should collect each referenced output name once', () => {
    const text = [
      "if: steps.changesets.outputs.published == 'true'",
      'PUBLISHED_PACKAGES: ${{ steps.changesets.outputs.published-packages }}',
      'HAS_CHANGESETS: ${{ steps.changesets.outputs.has-changesets }}',
      'OTHER: ${{ steps.changesets.outputs.published }}',
    ].join('\n');

    assert.deepEqual(collectStepOutputReferences(text, 'changesets'), [
      'published',
      'published-packages',
      'has-changesets',
    ]);
  });

  // 改名の経緯をコメントに残しても、存在しない出力の参照として数えない。
  it('should skip comment lines', () => {
    const text = '# v1 の steps.changesets.outputs.publishedPackages は v2 で改名された\n';

    assert.deepEqual(collectStepOutputReferences(text, 'changesets'), []);
  });

  it('should not collect the outputs of another step', () => {
    assert.deepEqual(collectStepOutputReferences('${{ steps.build.outputs.published }}', 'changesets'), []);
  });
});

describe('assertChangesetsActionMatchesCli', () => {
  it('should accept changesets/action@v2 with @changesets/cli 3 and the v2 inputs and outputs', () => {
    assert.doesNotThrow(() => assertPairing());
  });

  it('should accept changesets/action@v1 with @changesets/cli 2 and the v1 inputs and outputs', () => {
    assert.doesNotThrow(() =>
      assertPairing({
        cliRange: '^2.31.1',
        uses: 'changesets/action@v1',
        withLines: V1_WITH_LINES,
        outputReferences: V1_OUTPUT_REFERENCES,
      }),
    );
  });

  // 2026-09-03 に Dependabot が @changesets/cli だけを 3 系に上げ、changesets/action@v1 のまま
  // CLI 3 の publish を検出できない状態が 7 週間続いた。その PR を赤くする。
  it('should reject changesets/action@v1 with @changesets/cli 3', () => {
    assert.throws(
      () =>
        assertPairing({
          uses: 'changesets/action@v1',
          withLines: V1_WITH_LINES,
          outputReferences: V1_OUTPUT_REFERENCES,
        }),
      /changesets\/action@v1 を使っていますが、@changesets\/cli v3 と組むのは changesets\/action@v2 です/,
    );
  });

  it('should reject changesets/action@v2 with @changesets/cli 2', () => {
    assert.throws(
      () => assertPairing({ cliRange: '^2.31.1' }),
      /@changesets\/cli v2 と組むのは changesets\/action@v1 です/,
    );
  });

  // 次の major の組み合わせは、action 側の対応を確かめるまで分からない。黙って通さない。
  it('should reject a @changesets/cli major that has no registered changesets/action', () => {
    assert.throws(
      () => assertPairing({ cliRange: '^4.0.0' }),
      /@changesets\/cli v4 と組む changesets\/action の major が登録されていません/,
    );
  });

  // v1 の入力名のまま v2 に上げると、publish-script が渡らない。
  it('should reject an input that changesets/action@v2 does not have', () => {
    assert.throws(
      () => assertPairing({ withLines: ['version: pnpm run ci:version', 'publish: pnpm run ci:publish'] }),
      /changesets\/action@v2 に無い入力を渡しています: version, publish/,
    );
  });

  // v1 の出力名のままだと空文字列が届き、provenance 検証の対象が空になる。
  it('should reject an output that changesets/action@v2 does not have', () => {
    assert.throws(
      () => assertPairing({ outputReferences: ['published', 'publishedPackages', 'hasChangesets'] }),
      /changesets\/action@v2 に無い出力を参照しています: publishedPackages, hasChangesets/,
    );
  });

  it('should reject a changesets/action step without an id', () => {
    assert.throws(() => assertPairing({ id: null, outputReferences: [] }), /ステップに id がありません/);
  });
});
