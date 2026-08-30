import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1';
/**
 * publish 直後は packument への反映に遅れがあり、`npm install` がバージョン未検出
 * （ETARGET）で失敗することがある（verify-release-published.mjs と同じ現象）。
 * 実測では 1 回目の照会から 10 秒足らずで解消しているが、余裕を見て同じ間隔・
 * 合計 35 秒まで引き直す。
 */
const REGISTRY_PROPAGATION_RETRY_DELAYS_MS = [5000, 10000, 20000];

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
    execFileSync('npm', ['install', '--ignore-scripts', '--package-lock=true'], {
      cwd: verificationDirectory,
      stdio: 'inherit',
    });
    const auditOutput = execFileSync(
      'npm',
      ['audit', 'signatures', '--json', '--include-attestations'],
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
 * `npm install` は publish 直後の packument 反映待ちで ETARGET 失敗することがあるため、
 * 間隔を空けて引き直す。最終試行の失敗はそのまま投げる。
 */
async function installAndAuditWithRegistryPropagationRetry(publishedPackages) {
  const delays = [0, ...REGISTRY_PROPAGATION_RETRY_DELAYS_MS];

  for (const [attempt, delay] of delays.entries()) {
    if (attempt > 0) {
      console.log(
        `npm install が publish 直後の registry 反映待ちで失敗した可能性があるため ${delay / 1000} 秒待って引き直します`,
      );
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
