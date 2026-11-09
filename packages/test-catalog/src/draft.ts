/**
 * What the draft of a change note (`changes:draft`, map-analysis draft.ts)
 * says about the tests: for each change the diff of the tests fails on (it
 * requires a note, none of its related tests changed, and no reason is
 * written), the titles of its related tests.
 *
 * The draft has no map data of its own, so the endpoints and the bodies are
 * taken from the CLI's flows and the frames of the working tree.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeResult, DraftTests, MapData, Repository } from '@maronn-openid-connect/map-analysis';
import { readBaseCatalog, readTables } from './build.js';
import { readCatalog } from './catalog.js';
import { diffCatalogs } from './diff.js';
import { listFiles, testFiles } from './discover.js';

/** The part of the map data the catalog and the diff read, from a repository. */
export function mapDataOf(repository: Repository): MapData {
  const bodies: MapData['bodies'] = {};
  for (const frame of repository.head.frames.values()) {
    if (frame.kind !== 'body' || frame.endpoint === undefined) continue;
    bodies[frame.id] = { id: frame.id, endpoint: frame.endpoint, name: frame.name, package: frame.root, module: frame.module, line: frame.line, summary: '', calls: [], sites: [], frame: '' };
  }
  return { flows: repository.cli.flows, bodies, functions: {}, members: {}, sources: {}, features: repository.cli.features } as unknown as MapData;
}

/** The related tests of the changes that need a test or a reason (see the module comment). */
export function draftTests(context: { repository: Repository; changes: ChangeResult }): Map<string, DraftTests> {
  const { repository, changes } = context;
  const root = repository.repository;
  const data = mapDataOf(repository);
  const tables = readTables(root);
  const head = readCatalog({ repository, data, files: testFiles(repository.roots, listFiles(root)), read: (path) => readFileSync(join(root, path), 'utf8'), ...tables }).tests;
  const base = readBaseCatalog({ data, repository, changes, out: '', failures: new Map(), log: [] }, head, tables);
  const diff = diffCatalogs(base, head, data, changes.changes, false);
  const titles = new Map(head.map((test) => [test.id, test.title]));
  const drafts = new Map<string, DraftTests>();
  for (const frame of diff.frames) {
    if (!frame.untouched || frame.reason !== undefined) continue;
    drafts.set(frame.frame, { related: frame.related.map((id) => titles.get(id) ?? id) });
  }
  return drafts;
}
