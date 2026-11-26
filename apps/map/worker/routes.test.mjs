/**
 * The Worker's configuration (wrangler.jsonc, read as wrangler reads it to
 * deploy) against the live OP it runs: the paths the Worker answers before
 * the assets (`run_worker_first`) are exactly the OP's paths (OP_ROUTES)
 * and its control API, so a path the OP answers is never served the page
 * and a path of the page never reaches the OP; and the Durable Object the
 * Worker exports is bound and SQLite-backed. It reads the built live OP
 * (packages/live-op/dist).
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isLivePath, LIVE_PREFIX, OP_ROUTES } from '@maronn-openid-connect/live-op';
import { unstable_readConfig } from 'wrangler';

const config = unstable_readConfig({ config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) });

describe('wrangler.jsonc run_worker_first', () => {
  it('should send exactly the paths of the live OP and its control API to the Worker before the assets', () => {
    assert.deepEqual([...config.assets.run_worker_first].sort(), [`${LIVE_PREFIX}*`, ...OP_ROUTES].sort());
  });

  it('should leave the page and its files to the assets', () => {
    for (const path of ['/', '/index.html', '/code/', '/tests/', '/tests/index.html', '/assets/map.js', '/data/changes.md', '/health']) {
      assert.equal(isLivePath(path), false, path);
    }
  });

  it('should keep the page as the answer to a path the assets do not hold', () => {
    assert.equal(config.assets.not_found_handling, 'single-page-application');
    assert.equal(config.assets.binding, 'ASSETS');
  });
});

describe('wrangler.jsonc Durable Objects', () => {
  it('should bind the class the Worker exports as LIVE_OP, SQLite-backed so it runs on the Free plan', () => {
    assert.equal(config.main, fileURLToPath(new URL('./index.ts', import.meta.url)));
    assert.deepEqual(config.durable_objects.bindings, [{ name: 'LIVE_OP', class_name: 'LiveOpWorkspace' }]);
    assert.deepEqual(config.migrations.flatMap((migration) => migration.new_sqlite_classes ?? []), ['LiveOpWorkspace']);
    assert.deepEqual(config.migrations.flatMap((migration) => migration.new_classes ?? []), []);
  });

  it('should enable the Node.js compatibility the OP bundle needs for node:crypto', () => {
    assert.ok(config.compatibility_flags.includes('nodejs_compat'));
  });
});
