import { describe, expect, it } from 'vitest';
import { REQUEST_SCENARIOS, requestScenario } from '../../../test-catalog/src/premises.js';
import type * as Api from '../api.js';

// @ts-expect-error The bundle built by the package script has no declarations.
const { prepareRequestScenario, runRequest } = await import('../../dist/sandbox.js') as typeof Api;

const paths: Readonly<Record<string, string>> = {
  discovery: '/.well-known/openid-configuration',
  jwks: '/.well-known/jwks.json',
  introspection: '/introspect',
  revocation: '/revoke',
  'device-authorization': '/device_authorization',
  'backchannel-authentication': '/backchannel_authentication',
  'login-google': '/login/google',
};

/** Read an OAuth error from the response's redirect, JSON or authentication challenge. */
function errorOf(response: NonNullable<Api.SandboxRun['response']>, origin: string): string | undefined {
  const location = response.headers.find(([name]) => name === 'location')?.[1];
  if (location !== undefined) {
    const url = new URL(location, origin);
    return url.searchParams.get('error') ?? new URLSearchParams(url.hash.slice(1)).get('error') ?? undefined;
  }
  const challenge = response.headers.find(([name]) => name === 'www-authenticate')?.[1];
  if (challenge !== undefined) {
    const error = /\berror="([^"]+)"/.exec(challenge)?.[1];
    if (error !== undefined) return error;
  }
  try {
    return (JSON.parse(response.body ?? '') as { error?: string } | null)?.error;
  } catch {
    return undefined;
  }
}

describe('purpose-based request cases', () => {
  it('should use the Next.js action path and response for the login form', async () => {
    const { generated, premises } = await prepareRequestScenario('login-submit-password', 'nextjs');
    expect(generated.request.method).toBe('POST');
    expect(new URL(generated.url).pathname).toBe('/login/submit');
    expect(requestScenario('login-submit-password', 'nextjs')?.expected.status).toBe(303);
    expect(premises.steps.some((step) => step.request.method === 'GET' && new URL(step.request.url).pathname === '/login')).toBe(true);
  });

  it.each(REQUEST_SCENARIOS)('should prepare and verify $id', async (scenario) => {
    const framework = scenario.frameworks?.includes('hono') === false ? scenario.frameworks[0] : 'hono';
    const { generated, premises } = await prepareRequestScenario(scenario.id, framework);
    const pathname = new URL(generated.url).pathname;
    const path = paths[scenario.endpoint] ?? `/${scenario.endpoint}`;
    expect(pathname === path || pathname.startsWith(`${path}/`)).toBe(true);
    expect(generated.request.method).toMatch(/^(GET|POST)$/);
    if (scenario.external !== undefined) return;

    const { response } = await runRequest(generated.request, premises);
    expect(response?.status).toBe(scenario.expected.status);
    if (scenario.expected.error !== undefined && response !== undefined) {
      expect(errorOf(response, generated.url)).toBe(scenario.expected.error);
    }
    if (scenario.expected.redirectPath !== undefined && response !== undefined) {
      const location = response.headers.find(([name]) => name === 'location')?.[1];
      expect(location === undefined ? undefined : new URL(location, generated.url).pathname).toBe(scenario.expected.redirectPath);
      if (scenario.expected.error === undefined) expect(errorOf(response, generated.url)).toBeUndefined();
    }
  });
});
