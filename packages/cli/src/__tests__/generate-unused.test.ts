import { describe, it, expect } from 'vitest';
import { dropUnusedBindings, dropUnusedImports, transformRouteHandler } from '../generate.js';

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
  it('should keep a binding that a later block reads only inside a template expression and drop one only its text names', () => {
    const source = [
      'export async function POST(request: Request) {',
      '  // [read-host] Read the host',
      '  const host = new URL(request.url).host;',
      '  const port = new URL(request.url).port;',
      '  // [respond] Respond',
      '  return Response.json({ issuer: `https://${host}/port` });',
      '}',
      '',
    ].join('\n');

    expect(dropUnusedBindings(source)).toBe(source.replace('  const port = new URL', '  new URL'));
  });

  // Without its declaration line, the rest of a template literal that the line opens has no opening backtick.
  it('should keep a binding whose declaration line opens a multi-line template literal that a later block reads', () => {
    const source = [
      'export async function POST(request: Request) {',
      '  // [describe-request] Describe the request',
      '  const message = `first ${request.url}',
      'second`;',
      '  // [respond] Respond',
      '  return new Response(message);',
      '}',
      '',
    ].join('\n');

    expect(dropUnusedBindings(source)).toBe(source);
  });

  it('should keep a binding that a later block reads after a backtick in a regex literal', () => {
    const source = [
      'export async function POST(request: Request) {',
      '  // [read-body] Read the body',
      '  const raw = await request.text();',
      '  // [check-url] Check the URL',
      '  if (/`/.test(request.url)) throw new Error();',
      '  // [respond] Respond',
      '  return new Response(raw);',
      '}',
      '',
    ].join('\n');

    expect(dropUnusedBindings(source)).toBe(source);
  });
});

describe('transformRouteHandler', () => {
  it('should leave undefined the value of a removed block that a later block reads only inside a template expression', () => {
    const route = [
      'export async function POST(request: Request) {',
      '  // [read-host] (feature: demo) Read the host',
      '  const host = new URL(request.url).host;',
      '',
      '  // [respond] Respond',
      '  return Response.json({ issuer: `https://${host}` });',
      '}',
      '',
    ].join('\n');
    const endpoint = [
      'export const endpoint = defineEndpoint({',
      '  steps: [',
      "    { id: 'read-host', feature: 'demo', consumes: [], produces: ['host'] },",
      "    { id: 'respond', consumes: ['host'], produces: [] },",
      '  ],',
      '});',
      '',
    ].join('\n');

    expect(transformRouteHandler(route, new Set(), endpoint)).toBe(
      [
        'export async function POST(request: Request) {',
        '  const host = undefined;',
        '',
        '  // [respond] Respond',
        '  return Response.json({ issuer: `https://${host}` });',
        '}',
        '',
      ].join('\n'),
    );
  });
});
