import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { expressApplyTemplate, webGeneratedFiles } from '../web-standard/templates.js';

export class ExpressGenerator implements FrameworkGenerator {
  readonly name = 'express';
  readonly displayName = 'Express';

  generate(options: GeneratorOptions): GeneratedFile[] {
    return webGeneratedFiles(
      options.corePackageName,
      expressApplyTemplate(options.features),
      options.features,
      options.scopes,
    );
  }
}
