import { describe, expect, it } from 'vitest';
import type * as Api from '../api.js';

const { prepareRequestScenario, runRequest } = (await import(new URL('../../dist/sandbox.js', import.meta.url).href)) as typeof Api;

describe('feature stores in request cases', () => {
  it('should keep approval in its own snapshot and let each run start before consumption', async () => {
    const [device, ciba] = await Promise.all([
      prepareRequestScenario('token-device-approved'),
      prepareRequestScenario('token-ciba-approved'),
    ]);
    const preparedDevice = JSON.parse(JSON.stringify(device.premises)) as Api.PreparedPremises;
    const preparedCiba = JSON.parse(JSON.stringify(ciba.premises)) as Api.PreparedPremises;
    const [first, unrelated, second, backchannel] = await Promise.all([
      runRequest(device.generated.request, preparedDevice),
      runRequest(device.generated.request, preparedCiba),
      runRequest(device.generated.request, preparedDevice),
      runRequest(ciba.generated.request, preparedCiba),
    ]);

    expect(first.response?.status).toBe(200);
    expect(unrelated.response?.status).toBe(400);
    expect(JSON.parse(unrelated.response?.body ?? '{}')).toMatchObject({ error: 'invalid_grant' });
    expect(second.response?.status).toBe(200);
    expect(backchannel.response?.status).toBe(200);
  });

  it('should restore a pushed authorization request for repeated case runs', async () => {
    const { generated, premises } = await prepareRequestScenario('authorize-par');
    const restored = JSON.parse(JSON.stringify(premises)) as Api.PreparedPremises;
    const [first, second] = await Promise.all([runRequest(generated.request, restored), runRequest(generated.request, restored)]);

    expect(first.response?.status).toBe(302);
    expect(first.response?.headers).toContainEqual(['location', expect.stringContaining('/login?transaction_id=')]);
    expect(second.response?.status).toBe(302);
    expect(second.response?.headers).toContainEqual(['location', expect.stringContaining('/login?transaction_id=')]);
  });
});
