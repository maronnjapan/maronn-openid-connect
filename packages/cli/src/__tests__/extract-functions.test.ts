import { describe, expect, it } from 'vitest';
import {
  analyzeFunctions,
  buildFunctionCatalog,
  findFunctions,
  inferFunctionKind,
  parseJsDoc,
  specReferencesOf,
  type FunctionRoot,
} from '../extract/functions.js';
import { readRouteBlockCalls, readRouteBlocks } from '../extract/blocks.js';
import { readFunctionCatalog } from '../extract/templates.js';

const CORE_SOURCE = `
import { sha256 } from './crypto.js';

/**
 * Verify the presented secret against the registered hash.
 * OAuth 2.1 §7.4.1 / RFC 6749 §10.10
 *
 * @throws {TokenError} invalid_client
 */
export async function verifySecretHash(presented: string, registered: string): Promise<void> {
  const hashed = await sha256(presented); // sha256(): a comment with a call.
  if (hashed !== registered) {
    throw new TokenError(TokenErrorCode.InvalidClient, 'failed: compare()');
  }
}

/** A helper that is not exported. */
function pad(value: string): string {
  return value.padEnd(2);
}

/**
 * Build the header.
 * @spec RFC 7515 §4.1.1
 * @kind transform
 */
export function buildHeader<T extends { alg: string }>(input: T): { alg: string } {
  return { alg: pad(input.alg) };
}

export function overload(a: string): string;
export function overload(a: string, b?: string): string {
  return a + (b ?? '');
}
`;

const CRYPTO_SOURCE = `
/** Hash a string with SHA-256. */
export async function sha256(value: string): Promise<string> {
  return value;
}
`;

const CORE_INDEX = `
export { verifySecretHash, buildHeader } from './secret.js';
export { sha256 } from './crypto.js';
`;

const APP_STEP = `
import { verifySecretHash, buildHeader } from '@maronn-openid-connect/core';
import { readCookie } from '../../../cookies.js';
import { step } from '../../step.js';

export const meta = step({ id: 'authenticate-client', function: 'authenticateClient', calls: ['resolver.find'] });

/**
 * Authenticate the client.
 * OAuth 2.1 §2.3
 */
export async function authenticateClient(c: any, params: Record<string, string>): Promise<{ ok: boolean }> {
  const resolver = c.get('resolver');
  const client = await resolver.find(params.client_id);
  await verifySecretHash(params.client_secret, client.hash);
  const header = buildHeader({ alg: 'RS256' });
  return { ok: readCookie(c) !== undefined && header.alg === 'RS256' };
}
`;

const APP_COOKIES = `
/** Read the session cookie. */
export function readCookie(c: any): string | undefined {
  return c.req.header('cookie');
}
`;

const APP_ROUTE = `
import { verifySecretHash } from '@maronn-openid-connect/core';
import { readCookie } from '../_oidc-provider/cookies';

export async function POST(request: Request): Promise<Response> {
  // [parse-request] Parse the request — RFC 6749 §4.1.3
  const cookie = readCookie(request);

  // [authenticate-client] (feature: refresh-token) Authenticate the client — OAuth 2.1 §2.3
  await verifySecretHash('a', 'b');
  return new Response(cookie);
}

/** Not a block: a helper below the handler. */
function helper(): void {
  readCookie(undefined);
}
`;

function roots(): FunctionRoot[] {
  return [
    {
      name: 'core',
      specifier: '@maronn-openid-connect/core',
      files: new Map([
        ['secret.ts', CORE_SOURCE],
        ['crypto.ts', CRYPTO_SOURCE],
        ['index.ts', CORE_INDEX],
      ]),
    },
    {
      name: 'hono',
      files: new Map([
        ['oidc-provider/endpoints/token/steps/authenticate-client.ts', APP_STEP],
        ['oidc-provider/cookies.ts', APP_COOKIES],
      ]),
    },
    {
      name: 'nextjs',
      files: new Map([
        ['app/token/route.ts', APP_ROUTE],
        ['app/_oidc-provider/cookies.ts', APP_COOKIES],
      ]),
    },
  ];
}

describe('buildFunctionCatalog', () => {
  const catalog = buildFunctionCatalog(roots());

  describe('cards', () => {
    it('should make one card per function declaration, exported or not, keyed by root, module and name', () => {
      expect(Object.keys(catalog.functions)).toEqual([
        'core:crypto.ts#sha256',
        'core:secret.ts#buildHeader',
        'core:secret.ts#overload',
        'core:secret.ts#pad',
        'core:secret.ts#verifySecretHash',
        'hono:oidc-provider/cookies.ts#readCookie',
        'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateClient',
        'nextjs:app/_oidc-provider/cookies.ts#readCookie',
        'nextjs:app/token/route.ts#POST',
        'nextjs:app/token/route.ts#helper',
      ]);
      expect(catalog.functions['core:secret.ts#pad']?.exported).toBe(false);
    });

    it('should read the summary from the first paragraph of the JSDoc right above the declaration', () => {
      const card = catalog.functions['core:secret.ts#verifySecretHash'];
      expect(card?.summary).toBe('Verify the presented secret against the registered hash. OAuth 2.1 §7.4.1 / RFC 6749 §10.10');
      expect(card?.line).toBe(10);
    });

    it('should leave the summary empty for a function without a JSDoc', () => {
      expect(catalog.functions['core:secret.ts#overload']?.summary).toBe('');
    });

    it('should read the JSDoc above an eslint-disable comment that sits right above the declaration', () => {
      const source = '/** Mount the provider on an app. */\n// eslint-disable-next-line @typescript-eslint/no-explicit-any\nexport function applyOidc(app: any): void {}\n';
      const cards = buildFunctionCatalog([{ name: 'hono', files: new Map([['oidc-provider/apply.ts', source]]) }]);
      expect(cards.functions['hono:oidc-provider/apply.ts#applyOidc']?.summary).toBe('Mount the provider on an app.');
    });

    it('should take the specification from @spec tags, or from the references the text names', () => {
      expect(catalog.functions['core:secret.ts#buildHeader']?.spec).toEqual(['RFC 7515 §4.1.1']);
      expect(catalog.functions['core:secret.ts#verifySecretHash']?.spec).toEqual(['OAuth 2.1 §7.4.1', 'RFC 6749 §10.10']);
      expect(catalog.functions['core:crypto.ts#sha256']?.spec).toBeUndefined();
    });

    it('should take the kind from @kind, or infer it from the verb of the name', () => {
      expect(catalog.functions['core:secret.ts#buildHeader']?.kind).toBe('transform');
      expect(catalog.functions['core:secret.ts#verifySecretHash']?.kind).toBe('validate');
      expect(catalog.functions['hono:oidc-provider/cookies.ts#readCookie']?.kind).toBe('parse');
      expect(catalog.functions['core:secret.ts#pad']?.kind).toBe('other');
    });

    it('should list what the function throws from @throws and from the errors its body constructs', () => {
      expect(catalog.functions['core:secret.ts#verifySecretHash']?.throws).toEqual([
        '{TokenError} invalid_client',
        'TokenError(InvalidClient)',
      ]);
    });
  });

  describe('calls', () => {
    it('should resolve a call of a function of the same file', () => {
      expect(catalog.functions['core:secret.ts#buildHeader']?.calls).toEqual(['core:secret.ts#pad']);
    });

    it('should resolve a call through a relative import and skip calls in comments and strings', () => {
      expect(catalog.functions['core:secret.ts#verifySecretHash']?.calls).toEqual(['core:crypto.ts#sha256']);
    });

    it('should resolve a call through the package specifier of a library, in order of the first call', () => {
      expect(
        catalog.functions['hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateClient']?.calls,
      ).toEqual(['core:secret.ts#verifySecretHash', 'core:secret.ts#buildHeader', 'hono:oidc-provider/cookies.ts#readCookie']);
    });

    it('should not take a method of an object (resolver.find) or a constructor (new TokenError) for a call', () => {
      const calls = Object.values(catalog.functions).flatMap((card) => card.calls);
      expect(calls.some((id) => id.endsWith('#find') || id.endsWith('#TokenError'))).toBe(false);
    });

    it('should resolve an import without an extension (the Next.js style)', () => {
      expect(catalog.functions['nextjs:app/token/route.ts#POST']?.calls).toEqual([
        'nextjs:app/_oidc-provider/cookies.ts#readCookie',
        'core:secret.ts#verifySecretHash',
      ]);
    });

    it('should list the callers of a function, sorted', () => {
      expect(catalog.functions['core:secret.ts#verifySecretHash']?.calledBy).toEqual([
        'hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateClient',
        'nextjs:app/token/route.ts#POST',
      ]);
    });
  });
});

describe('FunctionProject.spanOf', () => {
  const project = analyzeFunctions(roots());

  it('should give the line the JSDoc opens on, the line of the declaration and the line that closes the body', () => {
    expect(project.spanOf('core:secret.ts#verifySecretHash')).toEqual({ doc: 4, start: 10, end: 15 });
    expect(project.spanOf('core:secret.ts#pad')).toEqual({ doc: 17, start: 18, end: 20 });
    expect(project.spanOf('core:secret.ts#buildHeader')).toEqual({ doc: 22, start: 27, end: 29 });
  });

  it('should cover an overload set from its first signature, without a doc line when there is no JSDoc', () => {
    expect(project.spanOf('core:secret.ts#overload')).toEqual({ start: 31, end: 34 });
  });

  it('should give nothing for an unknown id', () => {
    expect(project.spanOf('core:secret.ts#missing')).toBeUndefined();
  });
});

describe('readRouteBlockCalls', () => {
  it('should read the marker lines of a Route Handler with their feature', () => {
    expect(readRouteBlocks(APP_ROUTE).map(({ id, feature }) => ({ id, feature }))).toEqual([
      { id: 'parse-request', feature: undefined },
      { id: 'authenticate-client', feature: 'refresh-token' },
    ]);
  });

  it('should give each block the calls between its marker and the next, ending with the handler', () => {
    const project = analyzeFunctions(roots());
    const files = roots()[2]?.files as ReadonlyMap<string, string>;
    expect(readRouteBlockCalls(project, 'nextjs', 'app', files)).toEqual({
      'token/route.ts': {
        'parse-request': ['nextjs:app/_oidc-provider/cookies.ts#readCookie'],
        'authenticate-client': ['core:secret.ts#verifySecretHash'],
      },
    });
  });
});

describe('findFunctions', () => {
  const catalog = buildFunctionCatalog(roots());

  it('should find a function by its bare name in every root', () => {
    expect(findFunctions(catalog, 'readCookie').map((card) => card.id)).toEqual([
      'hono:oidc-provider/cookies.ts#readCookie',
      'nextjs:app/_oidc-provider/cookies.ts#readCookie',
    ]);
  });

  it('should narrow a name to a root with root:name, and accept an id', () => {
    expect(findFunctions(catalog, 'nextjs:readCookie').map((card) => card.id)).toEqual([
      'nextjs:app/_oidc-provider/cookies.ts#readCookie',
    ]);
    expect(findFunctions(catalog, 'core:crypto.ts#sha256')).toHaveLength(1);
  });
});

describe('parseJsDoc', () => {
  it('should split the text into the summary and the description and collect the tags', () => {
    const doc = parseJsDoc('/**\n * First line.\n * Still first.\n *\n * Second paragraph.\n * @spec RFC 1\n * @spec RFC 2\n *   §3\n * @throws {E} x\n */');
    expect(doc.summary).toBe('First line. Still first.');
    expect(doc.description).toBe('Second paragraph.');
    expect(doc.tags.get('spec')).toEqual(['RFC 1', 'RFC 2 §3']);
    expect(doc.tags.get('throws')).toEqual(['{E} x']);
  });
});

describe('specReferencesOf', () => {
  it('should find the documents and sections a text names and write Section as §', () => {
    expect(
      specReferencesOf('OIDC Core 1.0 Section 3.1.3.6 binds it; see RFC 6749 §4.1.3 / §3.2 and OAuth 2.1 §2.3 and RFC 7636.'),
    ).toEqual(['OIDC Core 1.0 §3.1.3.6', 'RFC 6749 §4.1.3 / §3.2', 'OAuth 2.1 §2.3', 'RFC 7636']);
  });
});

describe('inferFunctionKind', () => {
  it('should map the verb of a name to a step kind', () => {
    expect(inferFunctionKind('parseTokenRequest')).toBe('parse');
    expect(inferFunctionKind('resolveClient')).toBe('resolve');
    expect(inferFunctionKind('validateScope')).toBe('validate');
    expect(inferFunctionKind('isPublicClient')).toBe('decide');
    expect(inferFunctionKind('redeemDeviceCode')).toBe('dispatch');
    expect(inferFunctionKind('issueAccessToken')).toBe('issue');
    expect(inferFunctionKind('recordConsent')).toBe('persist');
    expect(inferFunctionKind('buildTokenResponse')).toBe('transform');
    expect(inferFunctionKind('respondToken')).toBe('respond');
    expect(inferFunctionKind('sha256')).toBe('other');
  });
});

describe('readFunctionCatalog (the repository)', () => {
  const catalog = readFunctionCatalog();

  it('should give every exported function of core a card with its calls resolved into core', () => {
    const card = catalog.functions['core:client-auth.ts#verifyClientSecret'];
    expect(card?.exported).toBe(true);
    expect(card?.calls).toEqual([
      'core:client-auth.ts#isPublicTokenClient',
      'core:client-auth.ts#verifyClientSecretHash',
      'core:client-auth.ts#verifyClientSecretValue',
    ]);
  });

  it('should resolve the core calls of a step of the hono app', () => {
    const card = catalog.functions['hono:oidc-provider/endpoints/token/steps/authenticate-client.ts#authenticateTokenClient'];
    expect(card?.calls).toEqual([
      'core:client-auth.ts#extractClientCredentials',
      'core:token-request.ts#resolveAuthenticatedTokenClient',
      'core:client-auth.ts#validateClientAuthMethod',
      'hono:oidc-provider/client-auth.ts#verifyPresentedClientCredential',
    ]);
  });

  it('should give every function of every root a summary, so the map describes each one', () => {
    const undocumented = Object.values(catalog.functions)
      .filter((card) => card.summary === '')
      .map((card) => card.id);
    expect(undocumented).toEqual([]);
  });
});
