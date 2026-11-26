import { expect, test } from '@playwright/test';
import { authorizationUrl, exchangeIds, exchangeLine, flowNode, mismatchWarning, openFlow, PASSED, playbackPosition, recentRequests, replayLine, requestPanel, responseLine, USER, workspaceOf } from './test-helpers';

/**
 * A browser signs in on the live OP in a tab of the same browser context as
 * the map (the authorization request of a client, the login screen, the
 * consent screen, back to the OP's own callback page): the workspace cookie
 * the map set sends those requests to the reader's workspace, so the flow of
 * /login lists them as from the browser, and opening one replays the way it
 * took without sending it again.
 *
 * The client's redirect URI is the OP's callback page, not
 * https://rp.example.com/callback: Playwright does not route the target of
 * a redirect (page.route is called for the first URL only), so a redirect
 * there would leave the test machine.
 */
test.describe('requests of a browser tab', () => {
  test('should list the login a browser tab made in the flow of /login and replay it without sending it again', async ({ page, context, baseURL }) => {
    await openFlow(page, 'login');
    await expect(recentRequests(page)).toBeVisible();
    const workspace = await workspaceOf(context);

    await test.step('a tab of the same browser signs in and approves', async () => {
      const tab = await context.newPage();
      await tab.goto(authorizationUrl(baseURL ?? ''));
      await expect(tab).toHaveURL(/\/login\?transaction_id=[^&]+$/);
      await tab.getByLabel('Username:').fill(USER.username);
      await tab.getByLabel('Password:').fill(USER.password);
      await tab.getByRole('button', { name: 'Login' }).click();
      await expect(tab).toHaveURL(/\/consent\?transaction_id=[^&]+$/);
      await tab.getByRole('button', { name: 'Approve' }).click();
      await expect(tab.getByRole('heading', { name: 'クライアントへの応答' })).toBeVisible();
      await expect(tab.getByRole('row', { name: /^code \S+$/ })).toBeVisible();
      await expect(tab.getByRole('row', { name: 'state e2e-state' })).toBeVisible();
      await tab.close();
    });

    const recent = recentRequests(page);
    const login = recent.getByRole('button', { name: /ブラウザ・クライアントから .*POST \/login\?transaction_id=/ });
    await test.step('the flow of /login lists the requests of the tab as from the browser', async () => {
      await page.bringToFront();
      await recent.getByRole('button', { name: '読み直す' }).click();
      await expect(login).toContainText('302 Found');
      await expect(recent.getByRole('button', { name: /ブラウザ・クライアントから .*GET \/login\?transaction_id=/ })).toContainText('200 OK');
    });

    await test.step('opening the POST /login replays the way it took, without sending it again', async () => {
      const before = await exchangeIds(page.request, workspace);
      const opened = /^x\d+/.exec((await login.textContent()) ?? '')?.[0];
      await login.click();
      await expect(exchangeLine(page)).toContainText(`開いたリクエスト${opened}ブラウザ・クライアントから`);
      await expect(responseLine(page)).toContainText('302 Found');
      await expect(requestPanel(page).getByText(`ワークスペースが記録したリクエスト ${opened} です。送り直さずに、その道筋を再生しています。`)).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`;x=${opened}$`));
      await expect(replayLine(page)).toBeVisible();
      await expect(async () => {
        await playbackPosition(page).press('End');
        await expect(flowNode(page, '認証したサブジェクトを同意のために保存する')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, 'csrf_token をトランザクションと照合する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(PASSED);
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(page.request, workspace)).toEqual(before);
    });
  });
});
