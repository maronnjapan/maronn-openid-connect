import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parsePublishedVersions } from './verify-release-published.mjs';

const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
const REGISTRY_ORIGIN = 'https://registry.npmjs.org';
/** npm install が受け取るのと同じ abbreviated packument を照会する（registry と CDN は Accept ごとに応答を分ける）。 */
const ABBREVIATED_PACKUMENT_ACCEPT =
  'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*';

/**
 * npm は publish を受け付けてから packument に載せるまで数分かかる。2026-10-22 の run 121 では
 * changeset publish が 07:59:45 に成功を返し、registry の time に記録された core@0.10.0 の時刻は 08:04:53 だった
 * （10-20 の run 118 では core@0.9.0 が 7 分後）。載る前は npm install も npm audit signatures も
 * そのバージョンを見つけられない（ETARGET）。そこで registry が publish した全バージョンを返すまで
 * 30 秒おきに照会して待つ。上限は実測の 2 倍ほどの 15 分。
 *
 * 待ちきれなかったときは release.yml の verify-provenance ジョブだけを re-run する（Re-run job）。
 * publish をやり直さずに、release ジョブが出した同じ published-packages を検証し直せる。
 */
const REGISTRY_PROPAGATION_TIMEOUT_MS = 15 * 60 * 1000;
const REGISTRY_PROPAGATION_POLL_INTERVAL_MS = 30 * 1000;

/**
 * registry に載ったのを確かめた後の npm install / npm audit signatures も、一時的なエラーで
 * 落ちることがあるので、5 秒・10 秒・20 秒の間隔で合計 35 秒まで引き直す。
 * どちらも --prefer-online で実行する。registry の packument は `max-age=300` で返るため、
 * 付けないと npm は 5 分間ローカルにキャッシュした古い packument を使い、引き直しても同じ結果になる。
 */
const REGISTRY_PROPAGATION_RETRY_DELAYS_MS = [5000, 10000, 20000];

/** publish した name@version のうち、registry がまだ返さないものを選ぶ。 */
export function selectUnlistedPackages(publishedPackages, listedVersionsByName) {
  return publishedPackages.filter(
    ({ name, version }) => !(listedVersionsByName[name] ?? []).includes(version),
  );
}

/**
 * registry が publish した全バージョンを返すまで待つ。照会の失敗は待つ理由と同じに扱い、次の照会で引き直す。
 *
 * @param fetchListedVersions name を受け取り、registry が返すバージョンの一覧を返す
 */
export async function waitForRegistryToListPublishedPackages(
  publishedPackages,
  {
    fetchListedVersions,
    timeoutMs = REGISTRY_PROPAGATION_TIMEOUT_MS,
    intervalMs = REGISTRY_PROPAGATION_POLL_INTERVAL_MS,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
) {
  const deadline = now() + timeoutMs;

  for (;;) {
    let unlisted;
    try {
      const listed = await Promise.all(
        publishedPackages.map(async ({ name }) => [name, await fetchListedVersions(name)]),
      );
      unlisted = selectUnlistedPackages(publishedPackages, Object.fromEntries(listed));
    } catch (error) {
      console.log(`npm registry への照会に失敗しました: ${error instanceof Error ? error.message : error}`);
      unlisted = publishedPackages;
    }
    if (unlisted.length === 0) return;

    const label = unlisted.map(({ name, version }) => `${name}@${version}`).join(', ');
    if (now() + intervalMs > deadline) {
      throw new Error(
        `npm registry が ${timeoutMs / 60000} 分待っても次のバージョンを返しません: ${label}\n` +
          'publish は release ジョブの changesets/action で成功しています。npm の反映がさらに遅れているだけなら、' +
          'この run の verify-provenance ジョブだけを re-run（このジョブの Re-run job）してください。' +
          'publish をやり直さずに、同じバージョンを検証し直せます。release ジョブごと re-run すると、' +
          '何も publish されないので検証が skipped になります（RELEASE.md「registry に載るのを待ってから検証する」）。',
      );
    }

    console.log(`npm registry にまだ載っていないため ${intervalMs / 1000} 秒待って照会し直します: ${label}`);
    await sleep(intervalMs);
  }
}

async function fetchListedVersions(name) {
  const response = await fetch(`${REGISTRY_ORIGIN}/${name}`, {
    headers: { accept: ABBREVIATED_PACKUMENT_ACCEPT },
  });

  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`${name} (${response.status})`);

  return parsePublishedVersions(await response.json());
}

export function assertPublishedPackageProvenance(publishedPackages, auditResult) {
  const verified = Array.isArray(auditResult?.verified) ? auditResult.verified : [];
  const missing = publishedPackages.filter(({ name, version }) => {
    return !verified.some((entry) => {
      return (
        entry?.name === name &&
        entry?.version === version &&
        entry?.attestations?.provenance?.predicateType === SLSA_PROVENANCE_V1
      );
    });
  });

  if (missing.length > 0) {
    const packageVersions = missing.map(({ name, version }) => `${name}@${version}`);
    throw new Error(
      `Missing verified SLSA provenance attestation for: ${packageVersions.join(', ')}`,
    );
  }
}

function parsePublishedPackages(value) {
  const publishedPackages = JSON.parse(value ?? '[]');
  if (!Array.isArray(publishedPackages) || publishedPackages.length === 0) {
    throw new Error('PUBLISHED_PACKAGES must contain at least one published package');
  }

  const names = new Set();
  for (const { name, version } of publishedPackages) {
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      typeof version !== 'string' ||
      version.length === 0
    ) {
      throw new Error('Each published package must include non-empty string name and version values');
    }
    if (names.has(name)) {
      throw new Error(`PUBLISHED_PACKAGES contains duplicate package name: ${name}`);
    }
    names.add(name);
  }

  return publishedPackages;
}

/** 一時ディレクトリへ publish 済みパッケージをインストールし、署名監査結果を返す。 */
function installAndAuditPublishedPackages(publishedPackages) {
  const dependencies = Object.fromEntries(
    publishedPackages.map(({ name, version }) => [name, version]),
  );
  const verificationDirectory = mkdtempSync(join(tmpdir(), 'maronn-npm-provenance-'));

  try {
    writeFileSync(
      join(verificationDirectory, 'package.json'),
      `${JSON.stringify({ private: true, dependencies }, null, 2)}\n`,
    );
    execFileSync('npm', ['install', '--ignore-scripts', '--package-lock=true', '--prefer-online'], {
      cwd: verificationDirectory,
      stdio: 'inherit',
    });
    const auditOutput = execFileSync(
      'npm',
      ['audit', 'signatures', '--json', '--include-attestations', '--prefer-online'],
      {
        cwd: verificationDirectory,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    return JSON.parse(auditOutput);
  } finally {
    rmSync(verificationDirectory, { recursive: true, force: true });
  }
}

/**
 * registry に載ったのを確かめた後でも npm install / npm audit signatures が一時的に失敗することが
 * あるため、間隔を空けて引き直す。最終試行の失敗はそのまま投げる。
 */
async function installAndAuditWithRegistryPropagationRetry(publishedPackages) {
  const delays = [0, ...REGISTRY_PROPAGATION_RETRY_DELAYS_MS];

  for (const [attempt, delay] of delays.entries()) {
    if (attempt > 0) {
      console.log(`npm install / npm audit signatures が失敗したため ${delay / 1000} 秒待って引き直します`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    try {
      return installAndAuditPublishedPackages(publishedPackages);
    } catch (error) {
      if (attempt === delays.length - 1) throw error;
    }
  }
}

async function verifyPublishedPackages() {
  const publishedPackages = parsePublishedPackages(process.env.PUBLISHED_PACKAGES);
  await waitForRegistryToListPublishedPackages(publishedPackages, { fetchListedVersions });
  const auditResult = await installAndAuditWithRegistryPropagationRetry(publishedPackages);
  assertPublishedPackageProvenance(publishedPackages, auditResult);
  console.log(
    `Verified SLSA provenance for ${publishedPackages
      .map(({ name, version }) => `${name}@${version}`)
      .join(', ')}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await verifyPublishedPackages();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
