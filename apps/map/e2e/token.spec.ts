import { expect, test } from '@playwright/test';
import { AHEAD, caseSelect, flowNode, formValue, mismatchWarning, NOT_TAKEN, openFlow, playbackPosition, replayLine, requestPanel, responseLine, runButton } from './test-helpers';

/**
 * The flow of the token endpoint runs the case of an authorization code on
 * the live OP, whose workspace keeps its state between requests: the code
 * the case prepared is exchanged once, and the same request sent again is
 * refused as a code already used, which the replay ends at.
 */
test.describe('the flow of the token endpoint', () => {
  test('should exchange the prepared authorization code once, and replay the second exchange to the check that the code is unused', async ({ page }) => {
    await openFlow(page, 'token');
    await caseSelect(page).selectOption({ label: '認可コードをトークンに交換する' });
    await expect(formValue(page, 'grant_type')).toHaveValue('authorization_code');
    await expect(formValue(page, 'code')).not.toHaveValue('');

    await test.step('the first exchange: 200 with the tokens', async () => {
      await runButton(page).click();
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(requestPanel(page).getByText('✓ ステータスと OAuth のエラーは期待どおり')).toBeVisible();
      await expect(replayLine(page)).toContainText('終わり方: return respondToken(c, tokenResponse)');
      await expect(mismatchWarning(page)).toHaveCount(0);
    });

    await test.step('the same request again: 400 invalid_grant, ended by validateAuthorizationCodeNotUsed', async () => {
      await runButton(page).click();
      await expect(responseLine(page)).toContainText('400 Bad Request');
      await expect(responseLine(page)).toContainText('invalid_grant');
      await expect(replayLine(page)).toContainText('失敗: TokenError(invalid_grant)（validateAuthorizationCodeNotUsed から）');
      await expect(async () => {
        // End stops the playback that follows the request, and Home goes back to its first scene, in the endpoint's own frame.
        await playbackPosition(page).press('End');
        await playbackPosition(page).press('Home');
        await expect(flowNode(page, '署名鍵を選ぶ')).toHaveAccessibleName(NOT_TAKEN, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, 'クライアントを認証する')).toHaveAccessibleName(AHEAD);
      await expect(flowNode(page, 'authorization_code グラントを検証する')).toHaveAccessibleName(AHEAD);
      await expect(flowNode(page, 'アクセストークンを発行する')).toHaveAccessibleName(NOT_TAKEN);
      await expect(flowNode(page, '応答して終わる。ステップの失敗に、OAuth のエラーレスポンスで応答する')).toHaveAccessibleName(AHEAD);
      await expect(mismatchWarning(page)).toHaveCount(0);
    });
  });
});
