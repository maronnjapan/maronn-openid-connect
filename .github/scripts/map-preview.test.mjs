import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { deploymentUrlOf, extractJson, parseJsonc, previewNameOf, previewUrlOf, urlsIn, usesDurableObjects, workerBaseName, workerNameOf } from './map-preview.mjs';

describe('previewNameOf / workerNameOf', () => {
  it('should name the Preview and the Worker of a pull request after its number', () => {
    assert.equal(previewNameOf('42'), 'pr-42');
    assert.equal(workerNameOf('maronn-oidc-map', 42), 'maronn-oidc-map-pr-42');
  });
});

describe('workerBaseName', () => {
  it('should read the name of a wrangler.jsonc with comments', () => {
    assert.equal(workerBaseName('{\n  // the worker\n  "name": "maronn-oidc-map", /* x */ "assets": { "directory": "./dist" }\n}\n'), 'maronn-oidc-map');
  });

  it('should refuse a config without a name', () => {
    assert.throws(() => workerBaseName('{}'), /has no name/);
  });
});

describe('parseJsonc', () => {
  it('should leave out comments and trailing commas but keep strings that look like them', () => {
    const text = '{\n  // the routes\n  "run_worker_first": ["/__live/*", "/login/*", /* exact */ "/token",],\n  "$schema": "https://example.com//schema", "note": "a, }",\n}\n';
    assert.deepEqual(parseJsonc(text), { run_worker_first: ['/__live/*', '/login/*', '/token'], $schema: 'https://example.com//schema', note: 'a, }' });
  });
});

describe('usesDurableObjects', () => {
  it('should tell a Worker with Durable Object bindings from one of assets only', () => {
    assert.equal(usesDurableObjects('{ "name": "m", "durable_objects": { "bindings": [{ "name": "LIVE_OP", "class_name": "LiveOpWorkspace" }] } }'), true);
    assert.equal(usesDurableObjects('{ "name": "m", "assets": { "directory": "./dist" } }'), false);
    assert.equal(usesDurableObjects('{ "name": "m", "durable_objects": { "bindings": [] } }'), false);
  });

  it('should find the Durable Objects of the map, whose previews are Workers of their own', () => {
    const wranglerJsonc = readFileSync(new URL('../../apps/map/wrangler.jsonc', import.meta.url), 'utf8');
    assert.equal(usesDurableObjects(wranglerJsonc), true);
    assert.equal(workerBaseName(wranglerJsonc), 'maronn-oidc-map');
  });
});

describe('extractJson', () => {
  it('should read the JSON object among the warnings wrangler prints', () => {
    assert.deepEqual(extractJson('▲ [WARNING] proxy detected\n{"preview":{"urls":["https://pr-1-map.sub.workers.dev"]}}\n'), { preview: { urls: ['https://pr-1-map.sub.workers.dev'] } });
    assert.equal(extractJson('no json here'), undefined);
  });
});

describe('previewUrlOf', () => {
  it('should take the documented preview.urls[0]', () => {
    assert.equal(previewUrlOf({ preview: { urls: ['https://pr-1-map.sub.workers.dev', 'https://x'] } }), 'https://pr-1-map.sub.workers.dev');
  });

  it('should fall back to the first workers.dev URL anywhere in the output', () => {
    assert.equal(previewUrlOf({ deployment: { url: 'https://abc-map.sub.workers.dev' } }), 'https://abc-map.sub.workers.dev');
    assert.equal(previewUrlOf(undefined, 'Preview URL: https://pr-2-map.sub.workers.dev/'), 'https://pr-2-map.sub.workers.dev/');
    assert.equal(previewUrlOf(undefined, 'nothing'), undefined);
  });
});

describe('urlsIn / deploymentUrlOf', () => {
  it('should prefer workers.dev URLs over other links in the output', () => {
    const output = 'Learn more at https://developers.cloudflare.com/workers/\nDeployed maronn-oidc-map triggers (1.2 sec)\n  https://maronn-oidc-map.sub.workers.dev\nCurrent Version ID: 1234';
    assert.deepEqual(urlsIn(output), ['https://maronn-oidc-map.sub.workers.dev']);
    assert.equal(deploymentUrlOf(output), 'https://maronn-oidc-map.sub.workers.dev');
  });

  it('should give any https URL when no workers.dev URL is there', () => {
    assert.deepEqual(urlsIn('see https://example.com/x.'), ['https://example.com/x']);
  });
});
