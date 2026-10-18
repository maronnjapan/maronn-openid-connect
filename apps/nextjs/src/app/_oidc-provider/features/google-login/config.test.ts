import { afterEach, describe, expect, it, vi } from 'vitest';
import { readGoogleLoginConfig } from './config';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('readGoogleLoginConfig', () => {
  it('should return undefined without GOOGLE_CLIENT_ID', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', undefined);
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', 'example.com');

    expect(readGoogleLoginConfig()).toBeUndefined();
  });

  it('should return undefined for an empty GOOGLE_CLIENT_ID', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', '');

    expect(readGoogleLoginConfig()).toBeUndefined();
  });

  it('should read the client ID of GOOGLE_CLIENT_ID', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', undefined);

    expect(readGoogleLoginConfig()).toEqual({ clientId: 'google-client-id' });
  });

  it('should read the hosted domain of GOOGLE_HOSTED_DOMAIN with the client ID', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', 'example.com');

    expect(readGoogleLoginConfig()).toEqual({ clientId: 'google-client-id', hostedDomain: 'example.com' });
  });

  it('should leave out an empty GOOGLE_HOSTED_DOMAIN', () => {
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-client-id');
    vi.stubEnv('GOOGLE_HOSTED_DOMAIN', '');

    expect(readGoogleLoginConfig()).toEqual({ clientId: 'google-client-id' });
  });
});
