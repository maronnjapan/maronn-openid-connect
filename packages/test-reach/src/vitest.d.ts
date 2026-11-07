import type { InlineConfig } from 'vitest/node';

/** The options of testReports(). */
export interface TestReportsOptions {
  /** The URL of the vitest.config (import.meta.url), or the directory of the package. */
  root: string | URL;
  /** The name of the report files; the package name without its scope by default. */
  name?: string;
  /** The repository paths of the function catalog roots the package's tests reach; none for the tools (reports only). */
  roots?: string[];
  /** The environment to read MARONN_REACH and MARONN_TEST_REPORTS from; process.env by default. */
  env?: Record<string, string | undefined>;
}

/** The part of a Vitest `test` config testReports() returns. */
export type TestReportsConfig = Pick<InlineConfig, 'includeTaskLocation' | 'reporters' | 'setupFiles' | 'coverage'>;

/** The reporters, coverage and setup files of the reports and the reach; an empty object when both are off. */
export declare function testReports(options: TestReportsOptions): TestReportsConfig;
