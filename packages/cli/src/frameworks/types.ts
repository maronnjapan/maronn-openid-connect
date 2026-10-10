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

import type { OidcFeatureConfig } from '../features.js';

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
   * `--db`: generate db/ (SQL tables, the stores on them, and the db/instance.ts
   * the user writes) and use it as the default storage (default: false).
   */
  db?: boolean;
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
  /** Generate all files for the OIDC provider */
  generate(options: GeneratorOptions): GeneratedFile[];
}
