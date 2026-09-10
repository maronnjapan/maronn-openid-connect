import type { FrameworkGenerator, GeneratedFile, GeneratorOptions } from '../types.js';
import { fastifyApplyTemplate, webGeneratedFiles } from '../web-standard/templates.js';

export class FastifyGenerator implements FrameworkGenerator {
  readonly name = 'fastify';
  readonly displayName = 'Fastify';

  generate(options: GeneratorOptions): GeneratedFile[] {
    return webGeneratedFiles(
      options.corePackageName,
      fastifyApplyTemplate(options.features),
      options.features,
      options.scopes,
    );
  }
}
