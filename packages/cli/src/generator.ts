import { extractProvider, extractableFrameworks } from './generate.js';
import { DEFAULT_FEATURES } from './registry.js';
import type { OidcFeatureConfig } from './registry.js';
import type { GeneratedFile } from './generated-file.js';
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
  /** `--flow`: rearranged steps per endpoint (default: the catalog's steps everywhere). */
  steps?: Record<string, string[]>;
  /** `--flow`: endpoint mount order (default: the catalog order). */
  endpointOrder?: string[];
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
    steps = {},
    endpointOrder,
  } = options;

  // Next.js keeps the order of its Route Handlers: a flow document can not
  // rearrange or drop their steps.
  const rearranged = Object.keys(steps);
  if (framework === 'nextjs' && rearranged.length > 0) {
    throw new Error(
      'The Next.js output does not follow a rearranged step order yet ' +
        `(endpoint ${rearranged.map((id) => `"${id}"`).join(', ')}). ` +
        'Remove the steps changes from the flow document, or generate for hono, express or fastify',
    );
  }

  if (extractableFrameworks().includes(framework)) {
    const files = extractProvider({
      framework,
      features,
      scopes,
      corePackageName,
      steps,
      ...(db === undefined ? {} : { db }),
    });
    void outputDir;
    void endpointOrder;
    return { files, framework };
  }

  const available = getAvailableFrameworks().join(', ');
  throw new Error(`Unknown framework: "${framework}". Available frameworks: ${available}`);
}

/** The frameworks generate accepts: the ones extract.json describes. */
export function getAvailableFrameworks(): string[] {
  return extractableFrameworks();
}
