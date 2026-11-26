import { expect, test } from '@playwright/test';
import { AHEAD, basicAuthorization, CLIENT, EXCHANGE_HEADER, exchangeLine, flowNode, mismatchWarning, NOT_TAKEN, openFlow, playbackPosition, recentRequests, replayLine, responseLine, WORKSPACE_HEADER, workspaceOf } from './test-helpers';

/**
 * A request a client sends to the live OP outside the map page (here
 * Playwright's own HTTP client, as curl would) reaches the reader's
 * workspace by its header; the response names its exchange in
 * x-map-exchange, and the map opened with that exchange in the hash
 * (`;x=<id>`) replays the way the request took, here to the failure of the
 * client's authentication.
 */
test.describe('requests sent outside the page', () => {
  test('should replay a token request with a wrong client secret, opened by the exchange its response names', async ({ page, context }) => {
    await openFlow(page, 'token');
    await expect(recentRequests(page)).toBeVisible();
    const workspace = await workspaceOf(context);

    const response = await page.request.post('/token', {
      headers: { [WORKSPACE_HEADER]: workspace, authorization: basicAuthorization(CLIENT.id, 'not-the-client-secret') },
      form: { grant_type: 'authorization_code', code: 'not-a-code', redirect_uri: 'https://rp.example.com/callback' },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: 'invalid_client' });
    const exchange = response.headers()[EXCHANGE_HEADER];
    expect(exchange).toMatch(/^x\d+$/);

    const map = await context.newPage();
    await openFlow(map, 'token', `;x=${exchange}`);
    await expect(exchangeLine(map)).toContainText(`開いたリクエスト${exchange}ブラウザ・クライアントから`);
    await expect(responseLine(map)).toContainText('401 Unauthorized');
    await expect(responseLine(map)).toContainText('invalid_client');
    await expect(replayLine(map)).toContainText('失敗: TokenError(invalid_client)（verifyClientSecretHash から）');
    await expect(async () => {
      // End stops the playback that follows the request, and Home goes back to its first scene, in the endpoint's own frame.
      await playbackPosition(map).press('End');
      await playbackPosition(map).press('Home');
      await expect(flowNode(map, 'grant_type を検証する')).toHaveAccessibleName(NOT_TAKEN, { timeout: 1000 });
    }).toPass();
    await expect(flowNode(map, 'クライアントを認証する')).toHaveAccessibleName(AHEAD);
    await expect(flowNode(map, '応答して終わる。ステップの失敗に、OAuth のエラーレスポンスで応答する')).toHaveAccessibleName(AHEAD);
    await expect(flowNode(map, 'authorization_code グラントを検証する')).toHaveAccessibleName(NOT_TAKEN);
    await expect(mismatchWarning(map)).toHaveCount(0);
  });
});
