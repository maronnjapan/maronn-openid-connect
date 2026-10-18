/**
 * The db/ files of the two kinds of --db, for the framework generators. The
 * names the generated app uses for them are in names.ts.
 */
import type { DbKind } from '../../db.js';
import type { OidcFeatureConfig } from '../../registry.js';
import type { GeneratedFile } from '../types.js';
import { kvGeneratedFiles } from './kv-templates.js';
import { dbGeneratedFiles, type DbInstanceTarget } from './templates.js';

/** The db/ files of a --db kind, relative to the generated provider directory. */
export function databaseGeneratedFiles(
  db: DbKind,
  corePkg: string,
  features: OidcFeatureConfig,
  target: DbInstanceTarget,
): GeneratedFile[] {
  return db === 'kv'
    ? kvGeneratedFiles(corePkg, features, target)
    : dbGeneratedFiles(corePkg, features, target);
}
