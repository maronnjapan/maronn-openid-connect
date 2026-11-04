import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeStale, writeHashed } from '../build.js';

describe('the files of the data, written in place', () => {
  const made: string[] = [];
  const directory = () => {
    const path = mkdtempSync(join(tmpdir(), 'map-build-'));
    made.push(path);
    return path;
  };
  afterEach(() => {
    for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it('should write a file under the hash of its content, and leave one already there alone', () => {
    const out = join(directory(), 'functions');
    const written = new Set<string>();
    const name = writeHashed(out, 'core:a.ts#f', '{"a":1}', written);
    const before = statSync(join(out, name)).mtimeMs;
    expect(writeHashed(out, 'core:a.ts#f', '{"a":1}', written)).toBe(name);
    expect(statSync(join(out, name)).mtimeMs).toBe(before);
    expect(readFileSync(join(out, name), 'utf8')).toBe('{"a":1}');
    expect([...written]).toEqual([name]);
  });

  it('should write again a file a build left cut short', () => {
    const out = directory();
    const name = writeHashed(out, 'f', '{"a":1}', new Set());
    writeFileSync(join(out, name), '{"a"');
    writeHashed(out, 'f', '{"a":1}', new Set());
    expect(readFileSync(join(out, name), 'utf8')).toBe('{"a":1}');
  });

  it('should remove only the files the build did not write, keeping the directory', () => {
    const out = directory();
    const written = new Set<string>();
    const kept = writeHashed(out, 'f', 'new', written);
    writeFileSync(join(out, 'old.json'), 'old');
    removeStale(out, written);
    expect(readdirSync(out)).toEqual([kept]);
    removeStale(join(out, 'missing'), written);
  });
});
