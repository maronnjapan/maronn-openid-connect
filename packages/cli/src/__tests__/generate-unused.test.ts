import { describe, it, expect } from 'vitest';
import { dropUnusedBindings, dropUnusedImports } from '../generate.js';

// The generator drops what a removed owner block was the only reader of. A name read only inside `${…}`
// is still read: dropping it would leave the output without the import or the value it needs.
describe('dropUnusedImports', () => {
  it('should keep an import that only a template expression reads', () => {
    const source = [
      "import { describeKey } from './key.js';",
      "import { removed } from './removed.js';",
      '',
      'export function label(key: string): string {',
      '  return `key ${describeKey(key)}`;',
      '}',
      '',
    ].join('\n');

    expect(dropUnusedImports(source)).toBe(source.replace("import { removed } from './removed.js';\n", ''));
  });
});

describe('dropUnusedBindings', () => {
  it('should keep a binding of an owner block that a later block reads only inside a template expression', () => {
    const source = [
      'export async function POST(request: Request) {',
      '  // [read-host] Read the host',
      '  const host = new URL(request.url).host;',
      '  // [respond] Respond',
      '  return Response.json({ issuer: `https://${host}` });',
      '}',
      '',
    ].join('\n');

    expect(dropUnusedBindings(source)).toBe(source);
  });
});
