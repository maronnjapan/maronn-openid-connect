/**
 * Represents a single generated file
 */
export interface GeneratedFile {
  /** Relative path from output directory */
  path: string;
  /** File content */
  content: string;
  /**
   * The user writes this file (db/instance.ts): the CLI only creates it when it
   * does not exist yet and never overwrites it, not even with --force.
   */
  userOwned?: boolean;
}

import type { DbKind } from '../db.js';
import type { OidcFeatureConfig } from '../registry.js';

/**
 * Options for code generation
 */
export interface GeneratorOptions {
  /** Output directory path */
  outputDir: string;
  /** Core package name to import from */
  corePackageName: string;
  /** Resolved feature toggles for the generated provider (default: every feature enabled) */
  features?: OidcFeatureConfig;
  /**
   * Custom scopes the generated provider accepts, from `--scope`
   * (default: none declared, which generates no scope policy at all).
   */
  scopes?: string[];
  /**
   * `--db sql` / `--db kv`: generate db/ (SQL tables or a key-value layout, the
   * stores on them, and the db/instance.ts the user writes) and use it as the
   * default storage (default: none, the in-memory stores).
   */
  db?: DbKind;
  /**
   * `--flow`: the ordered step ids of each rearrangeable endpoint whose steps
   * were removed or reordered (see flow/flow-file.ts). An endpoint that is
   * absent keeps the catalog's steps (default: none rearranged).
   */
  steps?: Record<string, string[]>;
  /**
   * `--flow`: the endpoints in the order of the flow document, which the
   * generated app mounts them in (default: the catalog order).
   */
  endpointOrder?: string[];
}

/**
 * Framework-specific code generator interface.
 * Each supported framework implements this interface.
 */
export interface FrameworkGenerator {
  /** Framework identifier */
  readonly name: string;
  /** Human-readable display name */
  readonly displayName: string;
  /**
   * Whether the generated pipelines follow `GeneratorOptions.steps`. A
   * generator without it still produces every endpoint of a flow document,
   * but rejects a document that removes or reorders steps.
   */
  readonly supportsStepSelection: boolean;
  /** Generate all files for the OIDC provider */
  generate(options: GeneratorOptions): GeneratedFile[];
}
