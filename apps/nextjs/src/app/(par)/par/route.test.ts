import { NextRequest } from 'next/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ISSUER, requestTo } from '../../../test-support/context';
import { createDatabase, registerClient } from '../../_oidc-provider/db';
import { parStore } from '../../_oidc-provider/features/par/store';
import { GET as authorize } from '../../authorize/route';
import { POST } from './route';

// provider.ts keeps its clients in the key-value store of db/ (in memory for
// the tests, vitest.config.ts) and the par feature its pushed requests in one
// parStore, both for the whole file: every request_uri a test pushes is new.

const CLIENT_ID = 'par-route-client';
const CLIENT_SECRET = 'par-route-secret';
const REDIRECT_URI = 'https://rp.example.com/callback';
/** RFC 7636 Appendix B: the S256 code_challenge of its example code_verifier. */
const CODE_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const PUSHED_FIELDS = {
  response_type: 'code',
  redirect_uri: REDIRECT_URI,
  scope: 'openid',
  state: 'state-1',
  code_challenge: CODE_CHALLENGE,
  code_challenge_method: 'S256',
};

beforeAll(async () => {
  await registerClient(createDatabase(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethods: ['client_secret_basic'],
  });
});

afterEach(() => vi.restoreAllMocks());

/** A POST of body to /par with the Basic credentials of the client (secret) and the headers. */
function postToPar(body: string, headers: Record<string, string> = {}, secret = CLIENT_SECRET): Request {
  return new Request(`${TEST_ISSUER}/par`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${CLIENT_ID}:${secret}`)}`,
      ...headers,
    },
    body,
  });
}

/** A pushed authorization request of the client, with the fields over the usual code flow parameters. */
function pushedRequest(fields: Record<string, string> = {}, secret = CLIENT_SECRET): Request {
  return postToPar(new URLSearchParams({ ...PUSHED_FIELDS, ...fields }).toString(), {}, secret);
}

/** The status, the cache headers and the JSON body of a response of /par. */
async function answerOf(response: Response): Promise<{ status: number; cache: (string | null)[]; body: unknown }> {
  return {
    status: response.status,
    cache: [response.headers.get('Cache-Control'), response.headers.get('Pragma')],
    body: await response.json(),
  };
}

/** A GET of /authorize with the request_uri of the client, from a caller that accepts JSON. */
function authorizeWith(requestUri: string): NextRequest {
  const query = new URLSearchParams({ client_id: CLIENT_ID, request_uri: requestUri });
  return new NextRequest(requestTo(`/authorize?${query}`, { headers: { Accept: 'application/json' } }));
}

describe('POST /par', () => {
  describe('Pushed Requests', () => {
    // RFC 9126 §2.2: 201 with the request_uri and its lifetime, never cached.
    it('should answer 201 with a request_uri and its lifetime that may not be cached', async () => {
      const answer = await answerOf(await POST(pushedRequest()));

      expect(answer).toEqual({
        status: 201,
        cache: ['no-cache, no-store', 'no-cache'],
        body: { request_uri: expect.stringMatching(/^urn:ietf:params:oauth:request_uri:/), expires_in: 60 },
      });
    });

    // RFC 9126 §2.1 / §2.2: the parameters are stored under the request_uri, with the
    // client_id of the client the endpoint authenticated.
    it('should store the pushed parameters with the client_id of the authenticated client under the request_uri', async () => {
      const response = await POST(pushedRequest());
      const { request_uri: requestUri } = (await response.json()) as { request_uri: string };

      const record = await parStore.consume(requestUri);

      expect(record?.clientId).toBe(CLIENT_ID);
      expect(record?.params).toEqual({ ...PUSHED_FIELDS, client_id: CLIENT_ID });
    });

    // RFC 9126 §4 / §7.3: /authorize expands the request_uri once.
    it('should let the authorization endpoint use the request_uri once', async () => {
      const response = await POST(pushedRequest());
      const { request_uri: requestUri } = (await response.json()) as { request_uri: string };

      const first = await authorize(authorizeWith(requestUri));
      const replay = await authorize(authorizeWith(requestUri));

      expect(first.status).toBe(302);
      expect(new URL(first.headers.get('Location') ?? '', TEST_ISSUER).pathname).toBe('/login');
      expect(replay.status).toBe(400);
      expect(await replay.json()).toEqual({
        error: 'invalid_request_uri',
        error_description: 'The request_uri is invalid, expired, or has already been used',
      });
    });
  });

  describe('Rejected Requests', () => {
    // RFC 9126 §2.1: the body must be a form.
    it('should answer 400 invalid_request to a body that is not a form', async () => {
      const answer = await answerOf(await POST(postToPar(JSON.stringify(PUSHED_FIELDS), { 'Content-Type': 'application/json' })));

      expect(answer).toEqual({
        status: 400,
        cache: ['no-cache, no-store', 'no-cache'],
        body: {
          error: 'invalid_request',
          error_description: 'Pushed authorization requests must use application/x-www-form-urlencoded',
        },
      });
    });

    // RFC 6749 §3.1: a parameter may not be repeated.
    it('should answer 400 invalid_request to a repeated parameter', async () => {
      const body = `${new URLSearchParams(PUSHED_FIELDS)}&scope=profile`;

      const answer = await answerOf(await POST(postToPar(body)));

      expect(answer).toEqual({
        status: 400,
        cache: ['no-cache, no-store', 'no-cache'],
        body: { error: 'invalid_request', error_description: 'Parameter "scope" must not be repeated' },
      });
    });

    // RFC 9126 §2.1: a request_uri MUST NOT be pushed.
    it('should answer 400 invalid_request to a pushed request_uri', async () => {
      const answer = await answerOf(await POST(pushedRequest({ request_uri: 'urn:ietf:params:oauth:request_uri:pushed' })));

      expect(answer).toEqual({
        status: 400,
        cache: ['no-cache, no-store', 'no-cache'],
        body: {
          error: 'invalid_request',
          error_description: 'request_uri MUST NOT be included in a pushed authorization request',
        },
      });
    });

    // RFC 9126 §2.1 / RFC 6749 §5.2: the client is authenticated as at the token endpoint.
    it('should answer 401 invalid_client with a Basic challenge for a wrong client_secret', async () => {
      const response = await POST(pushedRequest({}, 'wrong-secret'));

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toBe('Basic realm="Client Authentication"');
      expect(await response.json()).toEqual({ error: 'invalid_client', error_description: 'Client authentication failed' });
    });

    // RFC 9126 §2.1: validated as the authorization endpoint would, and answered as JSON.
    it('should answer 400 invalid_request for a redirect_uri the client did not register', async () => {
      const answer = await answerOf(await POST(pushedRequest({ redirect_uri: 'https://attacker.example.com/cb' })));

      expect(answer).toEqual({
        status: 400,
        cache: ['no-cache, no-store', 'no-cache'],
        body: { error: 'invalid_request', error_description: 'redirect_uri not registered' },
      });
    });

    it('should answer 500 server_error when the pushed request cannot be stored', async () => {
      vi.spyOn(parStore, 'save').mockRejectedValue(new Error('the store is down'));

      const answer = await answerOf(await POST(pushedRequest()));

      expect(answer).toEqual({ status: 500, cache: ['no-cache, no-store', 'no-cache'], body: { error: 'server_error' } });
    });
  });
});
