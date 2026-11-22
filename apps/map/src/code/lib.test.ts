import { describe, expect, it } from 'vitest';
import type { CodeIndex } from '../types';
import { codeHash, fileTree, hashOf, locationOfHash, parseCodeHash, searchCode, shownOf } from './lib';

const index: CodeIndex = {
  version: 1,
  features: [],
  sources: {
    'core:client-auth.ts': { path: 'packages/core/src/client-auth.ts', url: './data/sources/a.json' },
    'core:token/a.ts': { path: 'packages/core/src/token/a.ts', url: './data/sources/b.json' },
    'hono:oidc-provider/endpoints/token/pipeline.ts': { path: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', url: './data/sources/c.json' },
  },
  frames: {
    'core:client-auth.ts#verifyClientSecret': { name: 'verifyClientSecret', kind: 'function', source: { file: 'core:client-auth.ts', start: 10, end: 30 } },
    'core:client-auth.ts#verify': { name: 'verify', kind: 'function', source: { file: 'core:client-auth.ts', start: 40, end: 50 } },
    'endpoint:token': { name: 'POST /token', kind: 'body', source: { file: 'hono:oidc-provider/endpoints/token/pipeline.ts', start: 40, end: 120 } },
  },
  members: {},
};

describe('the hash of the code page', () => {
  it('should read a path, a line and a range of lines, and write them back the same', () => {
    const places = ['packages/core/src/client-auth.ts', 'packages/core/src/client-auth.ts:L12', 'apps/nextjs/src/app/(par)/par/route.ts:L3-L9'].map((hash) => parseCodeHash(`#${hash}`));
    expect([places, places.map((place) => (place === undefined ? '' : codeHash(place)))]).toEqual([
      [{ path: 'packages/core/src/client-auth.ts' }, { path: 'packages/core/src/client-auth.ts', line: 12 }, { path: 'apps/nextjs/src/app/(par)/par/route.ts', line: 3, end: 9 }],
      ['packages/core/src/client-auth.ts', 'packages/core/src/client-auth.ts:L12', 'apps/nextjs/src/app/(par)/par/route.ts:L3-L9'],
    ]);
  });

  it('should read a malformed escape as it is, without throwing', () => {
    expect(parseCodeHash('#packages/core/src/a%E0%A4%A.ts:L3')).toEqual({ path: 'packages/core/src/a%E0%A4%A.ts', line: 3 });
  });

  it('should name no file for an empty hash, and open a file the hash names at its lines', () => {
    expect([parseCodeHash(''), parseCodeHash('#'), locationOfHash(index, { path: 'packages/core/src/client-auth.ts', line: 12, end: 14 }), locationOfHash(index, { path: 'nowhere.ts' })]).toEqual([
      undefined,
      undefined,
      { id: 'core:client-auth.ts', line: 12, end: 14 },
      undefined,
    ]);
  });
});

describe('what the code page shows for a place', () => {
  it('should open a function as its file with its lines marked, and a file at the line of the name or the lines asked for', () => {
    expect([shownOf(index, { id: 'endpoint:token' }), shownOf(index, { id: 'core:token/a.ts', line: 3, column: 4, length: 5 }), shownOf(index, { id: 'core:token/a.ts', line: 3, end: 6 }), shownOf(index, { id: 'core:gone.ts' })]).toEqual([
      { file: 'hono:oidc-provider/endpoints/token/pipeline.ts', path: 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts', range: [40, 120], focus: { line: 40 } },
      { file: 'core:token/a.ts', path: 'packages/core/src/token/a.ts', focus: { line: 3, column: 4, length: 5 } },
      { file: 'core:token/a.ts', path: 'packages/core/src/token/a.ts', range: [3, 6], focus: { line: 3 } },
      undefined,
    ]);
  });

  it('should write the lines of a frame, or the line of a name, into the hash', () => {
    const shown = [shownOf(index, { id: 'endpoint:token' }), shownOf(index, { id: 'endpoint:token', line: 52, column: 4 }), shownOf(index, { id: 'core:token/a.ts', line: 3 }), shownOf(index, { id: 'core:token/a.ts' })];
    expect(shown.map((place) => (place === undefined ? '' : hashOf(place)))).toEqual(['apps/hono/src/oidc-provider/endpoints/token/pipeline.ts:L40-L120', 'apps/hono/src/oidc-provider/endpoints/token/pipeline.ts:L52', 'packages/core/src/token/a.ts:L3', 'packages/core/src/token/a.ts']);
  });
});

describe('the tree of the files', () => {
  it('should fold a directory that holds only one directory, and sort the directories and the files', () => {
    const tree = fileTree(index);
    const names = (directory: ReturnType<typeof fileTree>): unknown => ({ name: directory.name, directories: directory.directories.map(names), files: directory.files.map((file) => file.name) });
    expect(names(tree)).toEqual({
      name: '',
      directories: [
        { name: 'apps/hono/src/oidc-provider/endpoints/token', directories: [], files: ['pipeline.ts'] },
        { name: 'packages/core/src', directories: [{ name: 'token', directories: [], files: ['a.ts'] }], files: ['client-auth.ts'] },
      ],
      files: [],
    });
  });
});

describe('the quick open', () => {
  it('should put a name that is the text first, then one that starts with it, then files', () => {
    expect(searchCode(index, 'Verify').map((result) => `${result.kind} ${result.label}`)).toEqual(['frame verify()', 'frame verifyClientSecret()']);
    expect(searchCode(index, 'client').map((result) => `${result.kind} ${result.label} ${result.detail}`)).toEqual(['file client-auth.ts packages/core/src/client-auth.ts', 'frame verifyClientSecret() packages/core/src/client-auth.ts:10']);
    expect(searchCode(index, 'token').map((result) => result.label)).toEqual(['POST /token', 'a.ts', 'pipeline.ts']);
  });
});
