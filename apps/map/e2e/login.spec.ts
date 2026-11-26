import { expect, test } from '@playwright/test';
import { caseSelect, exchangeLine, flowNode, formValue, mismatchWarning, NOT_TAKEN, openFlow, PASSED, playbackPosition, replayLine, requestPanel, responseLine, runButton, shownFrames } from './test-helpers';

/**
 * The flow of the login screen (GET | POST /login) runs the case of a login
 * on the live OP of the map's Worker and replays the way each request took
 * through the POST handler (submitLogin): a login that succeeds, a wrong
 * password that shows the form again, and a csrf_token that is not the
 * form's, which stops at the CSRF check.
 */
test.describe('the flow of the login screen', () => {
  test('should run the login case on the live OP and replay each request through the steps of submitLogin', async ({ page }) => {
    await openFlow(page, 'login');
    await caseSelect(page).selectOption({ label: 'ユーザー名とパスワードでログインする' });
    await expect(formValue(page, 'password')).toHaveValue('password');
    await expect(formValue(page, 'csrf_token')).not.toHaveValue('');

    await test.step('the prepared request signs in: 302 through every step of submitLogin', async () => {
      await runButton(page).click();
      await expect(exchangeLine(page)).toContainText('地図から送った');
      await expect(responseLine(page)).toContainText('302 Found');
      await expect(requestPanel(page).getByText('✓ ステータスと OAuth のエラーは期待どおり')).toBeVisible();
      await expect(replayLine(page)).toBeVisible();
      await expect(async () => {
        await playbackPosition(page).press('End');
        await expect(flowNode(page, 'csrf_token をトランザクションと照合する')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(shownFrames(page)).toContainText('submitLogin()');
      await expect(flowNode(page, '別オリジンからのフォーム POST を拒否する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, 'ブラウザに OP のセッションを確立する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '認証したサブジェクトを同意のために保存する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '失敗した試行を数える（ロックアウト）')).toHaveAccessibleName(NOT_TAKEN);
      await expect(mismatchWarning(page)).toHaveCount(0);
    });

    await test.step('a wrong password: 200 with the form again, through the count of the failed attempt', async () => {
      await formValue(page, 'password').fill('wrong-password');
      await runButton(page).click();
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(requestPanel(page).getByText(/Invalid credentials\. Attempts remaining: \d+/)).toBeVisible();
      await expect(replayLine(page)).toBeVisible();
      await expect(async () => {
        await playbackPosition(page).press('End');
        await expect(flowNode(page, '失敗した試行を数える（ロックアウト）')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '返して終わる。kind、screen、remainingAttempts を返す')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, 'ブラウザに OP のセッションを確立する')).toHaveAccessibleName(NOT_TAKEN);
      await expect(mismatchWarning(page)).toHaveCount(0);
    });

    await test.step('a csrf_token that is not the form\'s: 403, and the replay stops at the CSRF check', async () => {
      await requestPanel(page).getByRole('button', { name: '元のリクエストに戻す' }).click();
      await expect(formValue(page, 'password')).toHaveValue('password');
      await formValue(page, 'csrf_token').fill('not-the-form-csrf-token');
      await runButton(page).click();
      await expect(responseLine(page)).toContainText('403 Forbidden');
      await expect(requestPanel(page).getByText(/Invalid CSRF token\./)).toBeVisible();
      await expect(replayLine(page)).toBeVisible();
      await expect(async () => {
        await playbackPosition(page).press('End');
        await expect(flowNode(page, '返して終わる。csrfError を返す')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, 'csrf_token をトランザクションと照合する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(NOT_TAKEN);
      await expect(flowNode(page, '失敗した試行を数える（ロックアウト）')).toHaveAccessibleName(NOT_TAKEN);
      await expect(mismatchWarning(page)).toHaveCount(0);
    });
  });
});
