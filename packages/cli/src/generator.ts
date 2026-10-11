import { getGenerator, getAvailableFrameworks } from './frameworks/index.js';
import { DEFAULT_FEATURES } from './features.js';
import type { OidcFeatureConfig } from './features.js';
import type { GeneratedFile } from './frameworks/types.js';
import type { DbKind } from './db.js';

export interface GenerateOptions {
  /** Target framework name */
  framework: string;
  /** Output directory path */
  outputDir: string;
  /** Core package name (default: @maronn-openid-connect/core) */
  corePackageName?: string;
  /** Feature toggles for the generated provider (default: every feature enabled) */
  features?: OidcFeatureConfig;
  /**
   * Custom scopes the generated provider accepts (default: none declared, so no
   * scope policy is generated and the provider keeps accepting any scope value).
   */
  scopes?: string[];
  /** Generate db/ and keep the provider's data in SQL tables or a key-value store (default: none). */
  db?: DbKind;
}

export interface GenerateResult {
  files: GeneratedFile[];
  framework: string;
}

const DEFAULT_CORE_PACKAGE = '@maronn-openid-connect/core';

/**
 * Generate OIDC provider code for the specified framework.
 */
export function generate(options: GenerateOptions): GenerateResult {
  const {
    framework,
    outputDir,
    corePackageName = DEFAULT_CORE_PACKAGE,
    features = { ...DEFAULT_FEATURES },
    scopes = [],
    db,
  } = options;

  const generator = getGenerator(framework);
  if (!generator) {
    const available = getAvailableFrameworks().join(', ');
    throw new Error(
      `Unknown framework: "${framework}". Available frameworks: ${available}`,
    );
  }

  const files = generator.generate({ outputDir, corePackageName, features, scopes, db });

  return { files, framework };
}

export { getAvailableFrameworks };
