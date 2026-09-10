import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { nextJsGeneratedFiles } from '../web-standard/templates.js';

export class NextJsGenerator implements FrameworkGenerator {
  readonly name = 'nextjs';
  readonly displayName = 'Next.js';

  generate(options: GeneratorOptions): GeneratedFile[] {
    return nextJsGeneratedFiles(options.corePackageName, options.features, options.scopes);
  }
}
