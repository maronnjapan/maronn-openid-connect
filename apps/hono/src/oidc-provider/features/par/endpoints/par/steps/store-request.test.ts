import { PAR_REQUEST_URI_PREFIX } from '@maronn-openid-connect/experimental/par';
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../../../../test-support/context.js';
import { InMemoryPushedAuthorizationRequestStore } from '../../../store.js';
import { storePushedRequest } from './store-request.js';

function contextWithStore() {
  const parStore = new InMemoryPushedAuthorizationRequestStore();
  return { c: contextOf(undefined, { parStore }), parStore };
}

interface StoredBody {
  request_uri: string;
  expires_in: number;
}

describe('storePushedRequest', () => {
  // RFC 9126 §2.2: 201 with a URN request_uri and its lifetime (parConfig: 60 seconds).
  it('should answer 201 with a URN request_uri that expires in 60 seconds', async () => {
    const { c } = contextWithStore();

    const response = await storePushedRequest(c, 'client-1', { client_id: 'client-1', scope: 'openid' });
    const body = response.body as StoredBody;

    expect(response.status).toBe(201);
    expect(body.expires_in).toBe(60);
    // RFC 9126 §2.2 / §7.1: the reference value is 32 random bytes, base64url without padding.
    expect(body.request_uri.slice(0, PAR_REQUEST_URI_PREFIX.length)).toBe(PAR_REQUEST_URI_PREFIX);
    expect(body.request_uri.slice(PAR_REQUEST_URI_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  // RFC 9126 §2.2: the request_uri is bound to the client; the client credentials are not kept.
  it('should store the pushed parameters for the client without the client_secret', async () => {
    const { c, parStore } = contextWithStore();

    const response = await storePushedRequest(c, 'client-1', {
      client_id: 'client-1',
      client_secret: 'secret-1',
      scope: 'openid',
    });
    const record = await parStore.consume((response.body as StoredBody).request_uri);

    expect(record).toMatchObject({ clientId: 'client-1', requestUri: (response.body as StoredBody).request_uri });
    expect(record?.params).toEqual({ client_id: 'client-1', scope: 'openid' });
  });

  // RFC 9126 §7.1: the reference value is random, so two requests never share one.
  it('should mint a different request_uri for every request', async () => {
    const { c } = contextWithStore();

    const first = await storePushedRequest(c, 'client-1', { client_id: 'client-1' });
    const second = await storePushedRequest(c, 'client-1', { client_id: 'client-1' });

    expect((first.body as StoredBody).request_uri).not.toBe((second.body as StoredBody).request_uri);
  });
});
