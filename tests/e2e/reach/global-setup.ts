/**
 * The global setup of a run with the reach (MARONN_REACH=1): start the reach
 * file of the target empty. The fixture appends a line a test to it, and
 * the workers of a run (Playwright starts a new one after a failure) must
 * not empty it again.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { reachFile } from './config';

/** Empty the reach file of this run's target. */
export default function globalSetup(): void {
  mkdirSync(dirname(reachFile), { recursive: true });
  writeFileSync(reachFile, '');
}
