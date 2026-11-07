import type { ClientResolver } from '@maronn-openid-connect/core';
import { describe, expect, it } from 'vitest';
import { resolveClientDisplay, selectClientDisplayUri } from './client-display';
import type { RegisteredClient } from './config';

const CLIENT: RegisteredClient = {
  clientId: 'rp-1',
  redirectUris: ['https://rp.example.com/callback'],
  clientName: 'Example RP',
  logoUri: 'https://rp.example.com/logo.png',
  policyUri: 'https://rp.example.com/privacy',
  tosUri: 'https://openid.net',
  clientUri: 'https://rp.example.com/',
};

function resolverOf(...clients: RegisteredClient[]): ClientResolver {
  return {
    async findClient(clientId) {
      return clients.find((client) => client.clientId === clientId) ?? null;
    },
  };
}

const DEFAULTS = { allowInsecureClientDisplayUris: false, requireClientDisplayUriHostMatch: false };

describe('resolveClientDisplay', () => {
  // OIDC Dynamic Client Registration 1.0 §2.
  it('should return the name and the https URLs of the client', async () => {
    expect(await resolveClientDisplay(resolverOf(CLIENT), DEFAULTS, 'rp-1')).toEqual({
      clientId: 'rp-1',
      name: 'Example RP',
      logoUri: 'https://rp.example.com/logo.png',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://openid.net',
      clientUri: 'https://rp.example.com/',
    });
  });

  it('should return the client_id only for a client it cannot find', async () => {
    expect(await resolveClientDisplay(resolverOf(), DEFAULTS, 'unknown')).toEqual({ clientId: 'unknown' });
  });

  it('should leave out an http logo_uri unless insecure URLs are allowed', async () => {
    const client = { ...CLIENT, logoUri: 'http://rp.example.com/logo.png' };

    const secure = await resolveClientDisplay(resolverOf(client), DEFAULTS, 'rp-1');
    const insecure = await resolveClientDisplay(resolverOf(client), { ...DEFAULTS, allowInsecureClientDisplayUris: true }, 'rp-1');

    expect(secure.logoUri).toBeUndefined();
    expect(insecure.logoUri).toBe('http://rp.example.com/logo.png');
  });

  // OIDC Dynamic Client Registration 1.0 §9.1: logo_uri and policy_uri on the host of a redirect_uri.
  it('should leave out a logo_uri and a policy_uri of another host when the hosts must match, and keep tos_uri', async () => {
    const client = { ...CLIENT, logoUri: 'https://cdn.example.net/logo.png' };

    const display = await resolveClientDisplay(resolverOf(client), { ...DEFAULTS, requireClientDisplayUriHostMatch: true }, 'rp-1');

    expect(display).toEqual({
      clientId: 'rp-1',
      name: 'Example RP',
      policyUri: 'https://rp.example.com/privacy',
      tosUri: 'https://openid.net',
      clientUri: 'https://rp.example.com/',
    });
  });
});

describe('selectClientDisplayUri', () => {
  it('should refuse a javascript: URL', () => {
    expect(selectClientDisplayUri('javascript:alert(1)', { allowInsecure: true })).toBeUndefined();
  });

  it('should refuse a value that is not a URL', () => {
    expect(selectClientDisplayUri('not a url', { allowInsecure: false })).toBeUndefined();
  });

  it('should keep an https URL whose host is allowed', () => {
    expect(selectClientDisplayUri('https://rp.example.com/x', { allowInsecure: false, allowedHosts: ['rp.example.com'] })).toBe(
      'https://rp.example.com/x',
    );
  });
});
