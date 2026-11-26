import { expect, test } from '@playwright/test';
import { caseSelect, flowNode, formValue, lookInside, mismatchWarning, openFlow, player, previewReplayLine, requestForm, responseLine, sceneShown, shownFrames } from './test-helpers';

/**
 * The flow goes where the reader asks: going into a call (中に入る in the
 * scene, 中の流れを見る on a card of the chart) moves the playback to the
 * first scene inside it, and a call the request does not make shows its
 * function's chart alone until the reader goes back. A request written on
 * moves the playback too: to where its way departs from the way shown
 * before, here where a request written from blank fails.
 */
test.describe('the flow goes where the reader asks', () => {
  test('should go into a call from the scene and from a card of the chart, and look into a call the request does not make', async ({ page }) => {
    await openFlow(page, 'token');
    await caseSelect(page).selectOption({ label: 'サービス自身のアクセストークンを取得する' });
    await expect(previewReplayLine(page)).toBeVisible();
    await expect(shownFrames(page)).not.toContainText('()');

    await test.step('中に入る in the scene: the chart is the function\'s, and the playback is at its first scene', async () => {
      await sceneShown(page).getByRole('button', { name: '中に入る ▸' }).first().click();
      await expect(shownFrames(page)).toContainText('parseTokenRequest()');
      await expect(sceneShown(page)).toContainText('↳ parseTokenRequest()');
    });

    await test.step('the crumb of the endpoint: back to the scene the request was in it', async () => {
      await shownFrames(page).getByRole('button', { name: 'POST /token' }).click();
      await expect(shownFrames(page)).not.toContainText('()');
      await expect(sceneShown(page)).not.toContainText('↳');
    });

    await test.step('中の流れを見る on the card of a node the request takes: the playback goes into that function', async () => {
      await flowNode(page, 'クライアントを認証する').hover();
      await lookInside(page, 'authenticateTokenClient()').click();
      await expect(shownFrames(page)).toContainText('authenticateTokenClient()');
      await expect(sceneShown(page)).toContainText('↳ authenticateTokenClient()');
    });

    await test.step('中の流れを見る on a node the request does not take: that function\'s chart alone, said so, until the reader goes back', async () => {
      await shownFrames(page).getByRole('button', { name: 'POST /token' }).click();
      await expect(shownFrames(page)).not.toContainText('()');
      await flowNode(page, '署名鍵を選ぶ').hover();
      await lookInside(page, 'selectTokenSigningKeys()').click();
      await expect(shownFrames(page)).toContainText('selectTokenSigningKeys()');
      const notice = page.getByRole('status').filter({ hasText: 'このリクエストは selectTokenSigningKeys() を通りません' });
      await expect(notice).toBeVisible();
      // The playback stays where it was, in the endpoint's own frame.
      await expect(sceneShown(page)).not.toContainText('↳');
      await notice.getByRole('button', { name: '再生の場所に戻る' }).click();
      await expect(notice).toHaveCount(0);
      await expect(shownFrames(page)).not.toContainText('()');
    });
  });

  test('should move the playback to where a request written from blank fails, and say what it answered above the chart', async ({ page }) => {
    await openFlow(page, 'token');
    const body = requestForm(page).getByRole('group', { name: 'ボディ（フォーム）' });
    await body.getByRole('button', { name: '+ 行を足す' }).click();
    await body.getByRole('textbox', { name: 'ボディ（フォーム）の1 行目の名前' }).fill('grant_type');
    // No client authentication: the client cannot be told, and the request fails there.
    await formValue(page, 'grant_type').fill('client_credentials');
    await expect(responseLine(page)).toContainText('401 Unauthorized');
    await expect(player(page)).toContainText('401 Unauthorized');
    await expect(player(page)).toContainText('失敗: TokenError(invalid_client)（requireClientId から）');
    await expect(shownFrames(page)).toContainText('requireClientId()');
    await expect(sceneShown(page)).toContainText('失敗する');
    await expect(mismatchWarning(page)).toHaveCount(0);
  });
});
