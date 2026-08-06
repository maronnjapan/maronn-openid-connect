/**
 * CI の「静的検証ゲート」が成立していることを検証する。
 *
 * 構文的に壊れたコード（未解決コンフリクトマーカー）が main に入り、
 * @maronn-openid-connect/core と @maronn-openid-connect/cli がビルド不能なまま残ったことがある。
 * 原因は単一の作業ミスではなく、CI の構成そのものにあった。
 *
 *   1. ci.yml のトリガが pull_request だけで、main への直接 push が一度も検査されない
 *   2. typecheck がコメントアウトされたまま運用されている
 *   3. build が CI のどのジョブでも走らず、ビルド破綻が publish 直前まで露見しない
 *
 * ゲートは「一度直せば終わり」ではなく、外されたら気づける必要がある。
 * ここでは ci.yml と packages/* の package.json を突き合わせ、
 * ゲートが機能する形で残っていることをテストとして固定する。
 *
 * 参照: tasks/done/p1-ci-push-trigger-and-static-verification-gate.md
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAIN_BRANCH = 'main';
const BUILD_COMMAND = 'pnpm run build';
const TYPECHECK_COMMAND = 'pnpm run typecheck';
const TEST_COMMAND = 'pnpm run test:ci';
const LINT_COMMAND = 'pnpm run lint';
/** root の test:ci から sample の契約テストを起動するスクリプト名。 */
const SAMPLE_TEST_SCRIPT = 'test:samples';
/** 各 sample が持たなければならない、契約テストを実行するスクリプト名。 */
const SAMPLE_CONTRACT_TEST_SCRIPT = 'test:conformance';

/** build -> typecheck -> test:ci の順で並んでいることを要求する。 */
const REQUIRED_STEP_ORDER = [BUILD_COMMAND, TYPECHECK_COMMAND, TEST_COMMAND];

const MISSING_STEP_REASON = {
  [BUILD_COMMAND]:
    'vitest は都度 transform するためビルド破綻を検知できず、' +
    'build が初めて走るのが publish 直前になります。',
  [TYPECHECK_COMMAND]:
    'vitest は型エラーで落ちないケースがあり、型エラーが CI をすり抜けます。',
  [TEST_COMMAND]: 'テストが書かれていることと常に実行され緑であることは別です。',
};

/**
 * GitHub Actions のワークフロー YAML を、本スクリプトが必要とする範囲で読む。
 *
 * production の dependencies には外部ライブラリを入れない方針であり、
 * ここで扱う構文（入れ子マッピング / ブロックシーケンス / フローシーケンス /
 * ブロックスカラー / コメント）に限定した最小の読み取りを行う。
 */
export function parseWorkflow(text) {
  const lines = text.split(/\r?\n/).map((line) => ({
    indent: line.length - line.trimStart().length,
    trimmed: line.trim(),
    raw: line,
  }));

  const cursor = { index: 0 };
  const value = parseNode(lines, cursor, 0);
  return value === undefined ? {} : value;
}

function skipIgnorableLines(lines, cursor) {
  while (cursor.index < lines.length) {
    const { trimmed } = lines[cursor.index];
    if (trimmed !== '' && !trimmed.startsWith('#')) return;
    cursor.index += 1;
  }
}

function parseNode(lines, cursor, indent) {
  skipIgnorableLines(lines, cursor);
  if (cursor.index >= lines.length) return undefined;

  const line = lines[cursor.index];
  if (line.indent < indent) return undefined;

  return isSequenceItem(line.trimmed)
    ? parseSequence(lines, cursor, line.indent)
    : parseMapping(lines, cursor, line.indent);
}

function isSequenceItem(trimmed) {
  return trimmed === '-' || trimmed.startsWith('- ');
}

function parseSequence(lines, cursor, indent) {
  const items = [];

  for (;;) {
    skipIgnorableLines(lines, cursor);
    if (cursor.index >= lines.length) break;

    const line = lines[cursor.index];
    if (line.indent !== indent || !isSequenceItem(line.trimmed)) break;

    const content = line.trimmed.slice(1).trim();
    if (content === '') {
      cursor.index += 1;
      items.push(parseNode(lines, cursor, indent + 1) ?? null);
      continue;
    }

    // `- name: Build` のような要素は、`- ` を字下げに読み替えると
    // 続く同じ字下げの行と 1 つのマッピングになる。
    const itemIndent = indent + 2;
    lines[cursor.index] = { indent: itemIndent, trimmed: content, raw: line.raw };
    items.push(
      content.includes(':')
        ? parseMapping(lines, cursor, itemIndent)
        : consumeScalarItem(lines, cursor, content),
    );
  }

  return items;
}

function consumeScalarItem(lines, cursor, content) {
  cursor.index += 1;
  return parseScalar(content);
}

function parseMapping(lines, cursor, indent) {
  const mapping = {};

  for (;;) {
    skipIgnorableLines(lines, cursor);
    if (cursor.index >= lines.length) break;

    const line = lines[cursor.index];
    if (line.indent !== indent || isSequenceItem(line.trimmed)) break;

    const separator = line.trimmed.indexOf(':');
    if (separator === -1) break;

    const key = line.trimmed.slice(0, separator).trim();
    const rest = line.trimmed.slice(separator + 1).trim();
    cursor.index += 1;

    if (rest === '') {
      mapping[key] = parseNode(lines, cursor, indent + 1) ?? '';
      continue;
    }
    if (isBlockScalarHeader(rest)) {
      mapping[key] = parseBlockScalar(lines, cursor, indent);
      continue;
    }
    mapping[key] = parseScalar(rest);
  }

  return mapping;
}

function isBlockScalarHeader(rest) {
  return /^[|>][+-]?$/.test(rest);
}

function parseBlockScalar(lines, cursor, indent) {
  const collected = [];

  while (cursor.index < lines.length) {
    const line = lines[cursor.index];
    if (line.trimmed !== '' && line.indent <= indent) break;
    collected.push(line.trimmed);
    cursor.index += 1;
  }

  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop();
  return collected.join('\n');
}

function parseScalar(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((entry) => parseScalar(entry.trim()));
  }
  if (
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2) ||
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function triggerBranches(workflow, event) {
  const branches = workflow?.on?.[event]?.branches;
  if (Array.isArray(branches)) return branches;
  return typeof branches === 'string' ? [branches] : [];
}

export function assertWorkflowVerifiesMainPush(workflow) {
  if (!triggerBranches(workflow, 'pull_request').includes(MAIN_BRANCH)) {
    throw new Error(
      'CI ワークフローが main 向けの pull request で起動しません。' +
        'on.pull_request.branches に main を追加してください。',
    );
  }

  if (!triggerBranches(workflow, 'push').includes(MAIN_BRANCH)) {
    throw new Error(
      'CI ワークフローが main への push で起動しません。on.push.branches に main を追加してください。' +
        'PR を経由しない直接 push が無検査のまま release.yml の publish 経路へ流れ込みます。',
    );
  }
}

function jobRunCommands(job) {
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  return steps
    .map((step) => step?.run)
    .filter((run) => typeof run === 'string')
    .map((run) => run.trim());
}

function findJobRunning(workflow, command) {
  const jobs = workflow?.jobs ?? {};
  for (const [name, job] of Object.entries(jobs)) {
    if (jobRunCommands(job).includes(command)) return { name, job };
  }
  return undefined;
}

export function assertStaticVerificationGate(workflow) {
  const testJob = findJobRunning(workflow, TEST_COMMAND);
  if (testJob === undefined) {
    throw new Error(`CI に \`${TEST_COMMAND}\` を実行するジョブがありません。`);
  }

  const commands = jobRunCommands(testJob.job);
  for (const required of REQUIRED_STEP_ORDER) {
    if (!commands.includes(required)) {
      throw new Error(
        `CI の ${testJob.name} ジョブに \`${required}\` を実行するステップがありません。` +
          MISSING_STEP_REASON[required],
      );
    }
  }

  const positions = REQUIRED_STEP_ORDER.map((required) => commands.indexOf(required));
  const isOrdered = positions.every((position, index) => index === 0 || positions[index - 1] < position);
  if (!isOrdered) {
    throw new Error(
      `CI の ${testJob.name} ジョブは ` +
        REQUIRED_STEP_ORDER.map((command) => `\`${command}\``).join(' -> ') +
        ' の順で実行してください。build を先に置くのは samples / experimental の型解決が core の' +
        'ビルド成果物 (dist) に依存するためで、typecheck を先に置くのは重いテストより先に' +
        '静的エラーで落とすためです。',
    );
  }
}

export function assertEveryPackageIsTypechecked(packageJsons) {
  const missing = packageJsons
    .filter((packageJson) => packageJson?.scripts?.typecheck === undefined)
    .map((packageJson) => packageJson.name);

  if (missing.length > 0) {
    throw new Error(
      `typecheck スクリプトを持たないパッケージがあります: ${missing.join(', ')}。` +
        'pnpm --filter は該当スクリプトを持たないパッケージを黙って読み飛ばすため、' +
        'そのパッケージの型エラーが CI をすり抜けます。',
    );
  }
}

export function assertLintGateIsBacked(workflow, packageJsons) {
  if (findJobRunning(workflow, LINT_COMMAND) === undefined) return;

  const implemented = packageJsons.some((packageJson) => packageJson?.scripts?.lint !== undefined);
  if (implemented) return;

  throw new Error(
    `CI が \`${LINT_COMMAND}\` を実行していますが、packages/* のどのパッケージにも ` +
      'lint スクリプトがありません。pnpm --filter は対象が 0 件でも成功するため、' +
      'この Lint ステップは常に緑になり何も検証しません。',
  );
}

/**
 * samples/* の conformance.test.ts が実際に実行されることを要求する。
 *
 * CLAUDE.md は生成 OP の conformance.test.ts を「利用者に示す契約テスト」と位置づけ、
 * 想定挙動から外れたらテスト失敗で気づけることを前提にしている。だがテストは
 * 「書かれていること」と「常に実行され緑であること」が別であり、実際に 3 sample は
 * どのランナーにも接続されないまま壊れた生成物を抱えていた（tasks/done/p1-exec-conformance-test.md）。
 *
 * 落とし穴は 2 つあり、どちらも「黙って成功する」形で現れる。
 *   1. root の test:ci が sample を呼ばなくなる（呼び出し行を消しても誰も気づかない）
 *   2. sample が test:conformance スクリプトを失う（pnpm --filter は該当スクリプトを
 *      持たないパッケージを読み飛ばし、0 件のまま成功する）
 */
export function assertSampleContractTestsAreExecuted(rootPackageJson, samplePackageJsons) {
  const ciScript = rootPackageJson?.scripts?.[TEST_COMMAND.replace('pnpm run ', '')];
  if (typeof ciScript !== 'string' || !ciScript.includes(`pnpm run ${SAMPLE_TEST_SCRIPT}`)) {
    throw new Error(
      `root の ${TEST_COMMAND.replace('pnpm run ', '')} スクリプトが ` +
        `\`pnpm run ${SAMPLE_TEST_SCRIPT}\` を実行していません。` +
        'samples/* の conformance.test.ts はどのランナーにも接続されず、' +
        '契約テストが 1 件も走らないまま CI が緑になります。',
    );
  }

  const missing = samplePackageJsons
    .filter((packageJson) => packageJson?.scripts?.[SAMPLE_CONTRACT_TEST_SCRIPT] === undefined)
    .map((packageJson) => packageJson.name);

  if (missing.length > 0) {
    throw new Error(
      `${SAMPLE_CONTRACT_TEST_SCRIPT} スクリプトを持たない sample があります: ${missing.join(', ')}。` +
        'pnpm --filter は該当スクリプトを持たないパッケージを黙って読み飛ばすため、' +
        'その sample の契約テストが CI をすり抜けます。',
    );
  }
}

function readPackageJsons(packagesDirectory) {
  return readdirSync(packagesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDirectory, entry.name, 'package.json'))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')));
}

function verifyCiGate() {
  const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const workflow = parseWorkflow(
    readFileSync(join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8'),
  );
  const packageJsons = readPackageJsons(join(repositoryRoot, 'packages'));
  const rootPackageJson = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8'));
  const samplePackageJsons = readPackageJsons(join(repositoryRoot, 'samples'));

  assertWorkflowVerifiesMainPush(workflow);
  assertStaticVerificationGate(workflow);
  assertEveryPackageIsTypechecked(packageJsons);
  assertLintGateIsBacked(workflow, packageJsons);
  assertSampleContractTestsAreExecuted(rootPackageJson, samplePackageJsons);

  console.log(
    'CI gate verified: main push trigger, build / typecheck / test order, typecheck coverage, sample contract tests',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyCiGate();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
