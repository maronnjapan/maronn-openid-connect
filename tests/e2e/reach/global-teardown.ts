/**
 * The global teardown of a run with the reach (MARONN_REACH=1): write the
 * line coverage of the run, coverage/e2e/<target>/lcov.info, from the raw V8
 * counts the OPs appended (reach/lcov.mjs). It runs before Playwright stops
 * the OPs, whose files are complete by then (they append at every take).
 */
import { reports, target } from './config';
import { writeLcov } from './lcov.mjs';

/** Write the lcov of this run's target. */
export default async function globalTeardown(): Promise<void> {
  const files = await writeLcov({ target, ...(reports === undefined ? {} : { reports }) });
  console.log(`[reach] coverage/e2e/${target}/lcov.info: ${files} files`);
}
