/**
 * Express and Fastify: the provider's code with Hono replaced by the
 * WebRouter of web-router.ts.
 *
 * The endpoints only use the part of Hono's API WebRouter provides (see
 * web-router.ts), so the replacement is a change of the router's imports and
 * type names. The JSX of the screens stays hono/jsx: Hono is then only the JSX
 * runtime of views.tsx and the pages.
 */
import { parseImports, relativeSpecifier } from './source.js';

/** The hono modules the Express and Fastify output keep importing (the JSX runtime). */
const KEPT_HONO_MODULES = new Set(['hono/jsx', 'hono/jsx/jsx-runtime', 'hono/html']);

const ROUTER_TYPE = 'Hono<{ Variables: Record<string, any> }>';

/**
 * The source of outputPath with Hono's router replaced by WebRouter, imported
 * from routerPath (the output path of web-router.ts).
 *
 * @throws {Error} when the file imports something of hono that WebRouter does
 *   not replace.
 */
export function toWebRouter(source: string, outputPath: string, routerPath: string): string {
  const routerSpecifier = relativeSpecifier(outputPath, routerPath);
  const result = source
    .replace(/^import \{ Hono \} from 'hono';$/m, `import { WebRouter } from '${routerSpecifier}';`)
    .replace(/^import type \{ Hono \} from 'hono';$/m, `import type { WebRouter } from '${routerSpecifier}';`)
    .replace(
      /^import type \{ Context \} from 'hono';$/m,
      `import type { WebContext as Context } from '${routerSpecifier}';`,
    )
    .replaceAll(`new ${ROUTER_TYPE}()`, 'new WebRouter()')
    .replaceAll(ROUTER_TYPE, 'WebRouter')
    .replaceAll('Hono<any>', 'WebRouter');
  const leftover = parseImports(result).filter(
    (declaration) =>
      (declaration.specifier === 'hono' || declaration.specifier.startsWith('hono/')) &&
      !KEPT_HONO_MODULES.has(declaration.specifier),
  );
  if (leftover.length > 0) {
    throw new Error(
      `${outputPath} imports ${leftover.map((declaration) => declaration.specifier).join(', ')}, ` +
        'which WebRouter does not replace: use only the router (Hono, Context) and hono/jsx in the provider',
    );
  }
  return result;
}
