import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testReports } from './vitest.js';
import { repositoryRoot } from './env.js';

const CONFIG = new URL('../vitest.config.js', import.meta.url);
const PACKAGE = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

describe('testReports', () => {
  it('should add nothing without MARONN_TEST_REPORTS and MARONN_REACH', () => {
    expect(testReports({ root: CONFIG, roots: ['packages/core/src'], env: {} })).toEqual({});
  });

  it('should add the JSON and JUnit reports, named after the package, without the reach', () => {
    const config = testReports({ root: CONFIG, roots: ['packages/core/src'], env: { MARONN_TEST_REPORTS: '/reports' } });
    expect(config.setupFiles).toBeUndefined();
    expect(config.coverage).toBeUndefined();
    expect(config.includeTaskLocation).toBe(true);
    expect(/** @type {unknown[]} */ (config.reporters).slice(-2)).toEqual([
      [fileURLToPath(new URL('./vitest-reporter.js', import.meta.url)), { outputFile: '/reports/vitest/test-reach.json', repositoryRoot: repositoryRoot() }],
      ['junit', { outputFile: '/reports/junit/vitest-test-reach.xml' }],
    ]);
  });

  it('should measure the roots it names with MARONN_REACH=1, under work/test-reports by default', () => {
    const reports = `${repositoryRoot()}/work/test-reports`;
    const config = testReports({ root: PACKAGE, name: 'demo', roots: ['packages/test-reach/src', 'packages/core/src'], env: { MARONN_REACH: '1' } });
    expect(config.setupFiles).toEqual([fileURLToPath(new URL('./vitest-setup.js', import.meta.url))]);
    expect(/** @type {unknown[]} */ (config.reporters).at(-2)).toEqual([
      fileURLToPath(new URL('./vitest-reporter.js', import.meta.url)),
      { outputFile: `${reports}/vitest/demo.json`, repositoryRoot: repositoryRoot(), reachFile: `${reports}/reach/vitest-demo.jsonl` },
    ]);
    expect(config.coverage).toMatchObject({
      enabled: true,
      provider: 'istanbul',
      include: ['src/**/*.{js,jsx,ts,tsx,mjs,mts}', '../core/src/**/*.{js,jsx,ts,tsx,mjs,mts}'],
      allowExternal: true,
      reportsDirectory: `${reports}/coverage/vitest/demo`,
      reporter: [['lcovonly', { file: 'lcov.info', projectRoot: repositoryRoot() }]],
    });
  });

  it('should only report a tool that names no roots, even with MARONN_REACH=1', () => {
    const config = testReports({ root: CONFIG, env: { MARONN_REACH: '1', MARONN_TEST_REPORTS: '/reports' } });
    expect(config.coverage).toBeUndefined();
    expect(config.setupFiles).toBeUndefined();
  });
});
