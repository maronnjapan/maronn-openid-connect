import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyTestsViewer } from './copy-tests-viewer.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'copy-tests-viewer-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write files under the temporary directory: path → text. */
function write(files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

const dirs = () => ({ viewerDist: join(root, 'tests', 'dist'), mapDist: join(root, 'map', 'dist') });
const viewer = { 'tests/dist/index.html': '<!doctype html>viewer', 'tests/dist/assets/app.js': 'app', 'tests/dist/data/tests.json': '{"version":1}', 'tests/dist/data/tests/by-file/a.json': '{}' };
const map = { 'map/dist/index.html': '<!doctype html>map', 'map/dist/data/map.json': '{}' };

describe('copying the tests viewer into the page of the map', () => {
  it('should put the built viewer and its data at dist/tests, and count what it copied', () => {
    write({ ...viewer, ...map });
    const result = copyTestsViewer(dirs());
    expect(result).toMatchObject({ target: join(root, 'map', 'dist', 'tests'), files: 4 });
    expect(readFileSync(join(root, 'map/dist/tests/index.html'), 'utf8')).toBe('<!doctype html>viewer');
    expect(existsSync(join(root, 'map/dist/tests/data/tests/by-file/a.json'))).toBe(true);
    // The map's own page is untouched.
    expect(readFileSync(join(root, 'map/dist/index.html'), 'utf8')).toBe('<!doctype html>map');
  });

  it('should replace what an earlier build left at dist/tests', () => {
    write({ ...viewer, ...map, 'map/dist/tests/old.js': 'old' });
    copyTestsViewer(dirs());
    expect(existsSync(join(root, 'map/dist/tests/old.js'))).toBe(false);
  });

  it('should fail when the viewer was not built, or was built without its data', () => {
    write(map);
    expect(() => copyTestsViewer(dirs())).toThrow(/tests viewer is not built/);
    write({ 'tests/dist/index.html': 'viewer' });
    expect(() => copyTestsViewer(dirs())).toThrow(/without its data/);
  });

  it('should fail when the map was not built', () => {
    write(viewer);
    expect(() => copyTestsViewer(dirs())).toThrow(/map is not built/);
  });

  it('should fail when the data of the map still holds the tests', () => {
    write({ ...viewer, ...map, 'map/dist/data/tests.json': '{}' });
    expect(() => copyTestsViewer(dirs())).toThrow(/map's data holds the tests/);
    rmSync(join(root, 'map/dist/data/tests.json'));
    write({ 'map/dist/data/tests/by-file/a.json': '{}' });
    expect(() => copyTestsViewer(dirs())).toThrow(/map's data holds the tests/);
  });
});
