import { expect, test } from '@playwright/test';
import {
  AHEAD,
  caseSelect,
  exchangeIds,
  exchangeLine,
  flowNode,
  formValue,
  mismatchWarning,
  NOT_TAKEN,
  openFlow,
  PASSED,
  playbackPosition,
  previewLine,
  previewReplayLine,
  replayLine,
  requestPanel,
  responseLine,
  runButton,
  workspaceOf,
} from './test-helpers';

/** A value of the same form with its last character changed: a PKCE verifier that is still one, but not the one the code was issued for. */
function otherValue(value: string): string {
  return `${value.slice(0, -1)}${value.endsWith('A') ? 'B' : 'A'}`;
}

/**
 * The flow follows the request the editor shows before it is sent: the
 * request a case prepared, and each edit of it, is previewed on a copy of
 * the workspace's state (POST /__live/preview), and the playback follows
 * the way the preview took. Nothing is sent: the exchanges of the
 * workspace stay as they were until the request is run. The case selected
 * stays selected while the request is edited.
 */
test.describe('the flow follows the request as the reader edits it', () => {
  test('should preview the prepared code exchange, an edited code_verifier that fails the PKCE check, and the request again, without sending any, then send it', async ({ page, context, request }) => {
    await openFlow(page, 'token');
    await caseSelect(page).selectOption({ label: '認可コードをトークンに交換する' });
    await expect(formValue(page, 'code_verifier')).not.toHaveValue('');
    const verifier = await formValue(page, 'code_verifier').inputValue();
    const workspace = await workspaceOf(context);
    const prepared = await exchangeIds(request, workspace);

    await test.step('the prepared request: previewed at once, through the success way, nothing sent', async () => {
      await expect(previewLine(page)).toContainText('（地図の OP の今の状態のコピーで動かしました。OP の状態は変えていません）');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(previewReplayLine(page)).toContainText('終わり方: return respondToken(c, tokenResponse)');
      await expect(flowNode(page, 'アクセストークンを発行する')).toHaveAccessibleName(AHEAD);
      await expect(page.getByRole('combobox', { name: 'コードの道筋' })).toHaveValue('run');
      await expect(exchangeLine(page)).toHaveCount(0);
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toEqual(prepared);
    });

    await test.step('another code_verifier, not run: the flow follows the PKCE check that fails, and the case stays selected', async () => {
      await formValue(page, 'code_verifier').fill(otherValue(verifier));
      await expect(previewReplayLine(page)).toContainText('失敗: TokenError(invalid_grant)（verifyPkceCodeVerifier から）');
      await expect(responseLine(page)).toContainText('400 Bad Request');
      await expect(responseLine(page)).toContainText('invalid_grant');
      await expect(flowNode(page, 'authorization_code グラントを検証する')).toHaveAccessibleName(AHEAD);
      await expect(flowNode(page, 'アクセストークンを発行する')).toHaveAccessibleName(NOT_TAKEN);
      await expect(caseSelect(page)).toHaveValue('token-authorization-code');
      await expect(exchangeLine(page)).toHaveCount(0);
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toEqual(prepared);
    });

    await test.step('the code_verifier written back: the success way again, the code still unused', async () => {
      await formValue(page, 'code_verifier').fill(verifier);
      await expect(previewReplayLine(page)).toContainText('終わり方: return respondToken(c, tokenResponse)');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(flowNode(page, 'アクセストークンを発行する')).toHaveAccessibleName(AHEAD);
      await expect(caseSelect(page)).toHaveValue('token-authorization-code');
      expect(await exchangeIds(request, workspace)).toEqual(prepared);
    });

    await test.step('run: the request is sent once, and the flow follows the exchange it was recorded as', async () => {
      await runButton(page).click();
      await expect(exchangeLine(page)).toContainText('地図から送った');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(replayLine(page)).toContainText('終わり方: return respondToken(c, tokenResponse)');
      await expect(previewLine(page)).toHaveCount(0);
      await expect(mismatchWarning(page)).toHaveCount(0);
      const sent = await exchangeIds(request, workspace);
      expect(sent).toHaveLength(prepared.length + 1);
      expect(sent.slice(0, prepared.length)).toEqual(prepared);
    });
  });

  test('should preview a wrong password through the count of the failed attempt and a csrf_token that is not the form\'s to the CSRF check, without sending any', async ({ page, context, request }) => {
    await openFlow(page, 'login');
    await caseSelect(page).selectOption({ label: 'ユーザー名とパスワードでログインする' });
    await expect(formValue(page, 'password')).toHaveValue('password');
    await expect(formValue(page, 'csrf_token')).not.toHaveValue('');
    const workspace = await workspaceOf(context);
    const prepared = await exchangeIds(request, workspace);

    await test.step('the prepared login, previewed: through every step of submitLogin', async () => {
      await expect(previewLine(page)).toBeVisible();
      await expect(responseLine(page)).toContainText('302 Found');
      await expect(previewReplayLine(page)).toBeVisible();
      await expect(async () => {
        // The playback stays where it was: End moves it to the last scene, once the frames the replay opens have loaded.
        await playbackPosition(page).press('End');
        await expect(flowNode(page, 'ブラウザに OP のセッションを確立する')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '失敗した試行を数える（ロックアウト）')).toHaveAccessibleName(NOT_TAKEN);
      await expect(mismatchWarning(page)).toHaveCount(0);
    });

    await test.step('a wrong password, not run: the form again, through the count of the failed attempt', async () => {
      await formValue(page, 'password').fill('wrong-password');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(async () => {
        // The playback stays where it was: End moves it to the last scene, once the frames the replay opens have loaded.
        await playbackPosition(page).press('End');
        await expect(flowNode(page, '失敗した試行を数える（ロックアウト）')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, 'ブラウザに OP のセッションを確立する')).toHaveAccessibleName(NOT_TAKEN);
      await expect(caseSelect(page)).toHaveValue('login-submit-password');
      await expect(mismatchWarning(page)).toHaveCount(0);
    });

    await test.step('the password back and a csrf_token that is not the form\'s, not run: 403, and the flow stops at the CSRF check', async () => {
      await requestPanel(page).getByRole('button', { name: '元のリクエストに戻す' }).click();
      await expect(formValue(page, 'password')).toHaveValue('password');
      await formValue(page, 'csrf_token').fill('not-the-form-csrf-token');
      await expect(responseLine(page)).toContainText('403 Forbidden');
      await expect(async () => {
        // The playback stays where it was: End moves it to the last scene, once the frames the replay opens have loaded.
        await playbackPosition(page).press('End');
        await expect(flowNode(page, '返して終わる。csrfError を返す')).toHaveAccessibleName(PASSED, { timeout: 1000 });
      }).toPass();
      await expect(flowNode(page, 'csrf_token をトランザクションと照合する')).toHaveAccessibleName(PASSED);
      await expect(flowNode(page, '認証情報を確かめる')).toHaveAccessibleName(NOT_TAKEN);
      await expect(exchangeLine(page)).toHaveCount(0);
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toEqual(prepared);
    });
  });
});
