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
  partingButton,
  partingNote,
  PASSED,
  playbackPosition,
  previewLine,
  previewReplayLine,
  replayLine,
  requestForm,
  requestPanel,
  responseLine,
  runButton,
  shownFrames,
  workspaceOf,
} from './test-helpers';

/** How long a spec waits to see that nothing is previewed: longer than the pause after an edit before its preview (lib/preview.ts PREVIEW_DELAY, 400 ms). */
const PAST_THE_PAUSE = 1200;

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
 * stays selected while the request is edited. An edited request is read
 * against the request before the edits: the flow goes into the functions
 * where their ways part and the playback moves there, also when the
 * endpoint answers both the same way through its own steps.
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

    await test.step('another code_verifier, not run: the flow follows the PKCE check that fails, the playback moves to that check, and the case stays selected', async () => {
      await formValue(page, 'code_verifier').fill(otherValue(verifier));
      await expect(previewReplayLine(page)).toContainText('失敗: TokenError(invalid_grant)（verifyPkceCodeVerifier から）');
      await expect(responseLine(page)).toContainText('400 Bad Request');
      await expect(responseLine(page)).toContainText('invalid_grant');
      // The one place the edit makes the way part: the playback is there, in the function that checks the verifier.
      await expect(partingNote(page)).toContainText('次の 1 か所で道筋が分かれます');
      await expect(partingButton(page, 'verifyPkceCodeVerifier()')).toBeEnabled();
      await expect(shownFrames(page)).toContainText('verifyPkceCodeVerifier()');
      // The case expects the answer of its own request: an edited one is not held against it.
      await expect(requestPanel(page).getByText('ケースが準備したリクエストではないので、ケースの期待とは比べていません')).toBeVisible();
      await playbackPosition(page).press('Home');
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
      await expect(partingNote(page)).toHaveCount(0);
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

  test('should let go of the preview of a request written from blank when it is written back, back to おまかせ, and keep the way of a preview out of the hash', async ({ page, context, request }) => {
    await openFlow(page, 'userinfo');
    const way = page.getByRole('combobox', { name: 'コードの道筋' });
    const headers = requestForm(page).getByRole('group', { name: 'ヘッダー' });
    await expect(way).toHaveValue('auto');
    const workspace = await workspaceOf(context);
    const before = await exchangeIds(request, workspace);

    await test.step('a bearer token the OP never issued, written on the blank request: previewed to invalid_token', async () => {
      await headers.getByRole('button', { name: '+ 行を足す' }).click();
      await headers.getByRole('textbox', { name: 'ヘッダーの1 行目の名前' }).fill('Authorization');
      await formValue(page, 'Authorization').fill('Bearer garbage');
      await expect(previewLine(page)).toBeVisible();
      await expect(responseLine(page)).toContainText('401 Unauthorized');
      await expect(responseLine(page)).toContainText('invalid_token');
      await expect(previewReplayLine(page)).toContainText('失敗: UserInfoError(invalid_token)');
      await expect(way).toHaveValue('run');
      // The way a preview takes is no choice of the reader's: the hash keeps none.
      await expect(page).not.toHaveURL(/;d=/);
    });

    await test.step('元のリクエストに戻す: the blank request again, no preview, the flow back to おまかせ', async () => {
      await requestPanel(page).getByRole('button', { name: '元のリクエストに戻す' }).click();
      await expect(headers.getByRole('textbox')).toHaveCount(0);
      await expect(previewLine(page)).toHaveCount(0);
      await expect(responseLine(page)).toHaveCount(0);
      await expect(way).toHaveValue('auto');
      await expect(page).not.toHaveURL(/;d=/);
    });

    await test.step('written again and the page reloaded: おまかせ, not a way the reader chose, and nothing was sent', async () => {
      await headers.getByRole('button', { name: '+ 行を足す' }).click();
      await headers.getByRole('textbox', { name: 'ヘッダーの1 行目の名前' }).fill('Authorization');
      await formValue(page, 'Authorization').fill('Bearer garbage');
      await expect(previewReplayLine(page)).toContainText('失敗: UserInfoError(invalid_token)');
      await expect(way).toHaveValue('run');
      await page.reload();
      await expect(requestForm(page)).toBeVisible();
      await expect(way).toHaveValue('auto');
      await expect(way.locator('option[value="custom"]')).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toEqual(before);
    });
  });

  test('should preview nothing while the request is sent, show the response sent when it lands, then preview the edit made meanwhile', async ({ page, context, request }) => {
    await openFlow(page, 'token');
    await caseSelect(page).selectOption({ label: 'サービス自身のアクセストークンを取得する' });
    await expect(previewLine(page)).toBeVisible();
    await expect(responseLine(page)).toContainText('200 OK');
    const workspace = await workspaceOf(context);
    const prepared = await exchangeIds(request, workspace);
    // The OP answers the send and the previews after it at once; the page gets each answer when the spec lets it through, so each state can be read.
    let landRun = () => {};
    const run = new Promise<void>((resolve) => {
      landRun = resolve;
    });
    await page.route('**/__live/run', async (route) => {
      const response = await route.fetch();
      await run;
      await route.fulfill({ response });
    });
    let previews = 0;
    let landPreview = () => {};
    const preview = new Promise<void>((resolve) => {
      landPreview = resolve;
    });
    await page.route('**/__live/preview', async (route) => {
      previews += 1;
      const response = await route.fetch();
      await preview;
      await route.fulfill({ response });
    });
    const sending = requestForm(page).getByRole('button', { name: '送っています…' });

    await test.step('a scope the service has no right to, written while the request is sent: no preview, the send stays shown', async () => {
      await runButton(page).click();
      await expect(sending).toBeDisabled();
      await formValue(page, 'scope').fill('scope-not-registered');
      await page.waitForTimeout(PAST_THE_PAUSE);
      expect(previews).toBe(0);
      await expect(sending).toBeDisabled();
      await expect(requestPanel(page).getByText('地図の OP に送っています…')).toBeVisible();
    });

    await test.step('the send lands: its response shows, and the edit is previewed after it', async () => {
      landRun();
      await expect(exchangeLine(page)).toContainText('地図から送った');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(runButton(page)).toBeEnabled();
      await expect(requestPanel(page).getByRole('status').filter({ hasText: '試算中…' })).toBeVisible();
      // Two previews for the one edit: the request before the edit, and the edited one read against it.
      await expect.poll(() => previews).toBe(2);
    });

    await test.step('the preview lands: the flow follows the scope refused, and only the one request was sent', async () => {
      landPreview();
      await expect(previewLine(page)).toBeVisible();
      await expect(responseLine(page)).toContainText('400 Bad Request');
      await expect(responseLine(page)).toContainText('invalid_scope');
      await expect(mismatchWarning(page)).toHaveCount(0);
      const sent = await exchangeIds(request, workspace);
      expect(sent).toHaveLength(prepared.length + 1);
    });

    await test.step('a header name that cannot be sent: nothing previewed, the result marked as the request before', async () => {
      const headers = requestForm(page).getByRole('group', { name: 'ヘッダー' });
      await headers.getByRole('button', { name: '+ 行を足す' }).click();
      await headers.getByRole('textbox', { name: /^ヘッダーの\d+ 行目の名前$/ }).last().fill('bad header');
      await expect(requestPanel(page).getByText('この結果は書き換える前のリクエストのものです', { exact: false })).toBeVisible();
      await page.waitForTimeout(PAST_THE_PAUSE);
      expect(previews).toBe(2);
      await expect(responseLine(page)).toContainText('invalid_scope');
    });
  });

  test('should go into the functions where an edited token parts from the prepared one, though the endpoint answers 200 through the same steps, and come back when the edit is undone', async ({ page, context, request }) => {
    await openFlow(page, 'introspection');
    await caseSelect(page).selectOption({ label: '有効なアクセストークンを確認する' });
    await expect(formValue(page, 'token')).not.toHaveValue('');
    const workspace = await workspaceOf(context);
    const prepared = await exchangeIds(request, workspace);
    const inactive = '返して終わる。INACTIVE_INTROSPECTION_RESPONSE を返す';
    const active = '有効なトークンのレスポンスを組み立てて返す';

    await test.step('the prepared token: the steps of the endpoint, and nothing to tell apart', async () => {
      await expect(previewLine(page)).toBeVisible();
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(previewReplayLine(page)).toBeVisible();
      await expect(partingNote(page)).toHaveCount(0);
      await expect(flowNode(page, 'トークンの情報をまとめる（有効かどうか）')).toHaveAccessibleName(AHEAD);
      await expect(shownFrames(page)).not.toContainText('()');
    });

    await test.step('a token the OP never issued, not run: 200 again, and the playback moves into the lookup that finds no token', async () => {
      await formValue(page, 'token').fill('not-a-token-the-op-issued');
      await expect(partingNote(page)).toContainText('次の 2 か所で道筋が分かれます');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(shownFrames(page)).toContainText('resolveIntrospectionToken()');
      await expect(partingButton(page, 'resolveIntrospectionToken()')).toBeEnabled();
      await expect(requestPanel(page).getByText('ケースが準備したリクエストではないので、ケースの期待とは比べていません')).toBeVisible();
      await expect(caseSelect(page)).toHaveValue('introspection-active-access-token');
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toEqual(prepared);
    });

    await test.step('the second place: the token is described as inactive', async () => {
      await partingButton(page, 'describeIntrospectedToken()').click();
      await expect(shownFrames(page)).toContainText('describeIntrospectedToken()');
      await expect(flowNode(page, inactive)).toHaveAccessibleName(AHEAD);
      await expect(flowNode(page, active)).toHaveAccessibleName(NOT_TAKEN);
    });

    await test.step('元のリクエストに戻す: the steps of the endpoint again, at the step the playback was inside', async () => {
      await requestPanel(page).getByRole('button', { name: '元のリクエストに戻す' }).click();
      await expect(partingNote(page)).toHaveCount(0);
      await expect(shownFrames(page)).not.toContainText('()');
      await expect(flowNode(page, 'トークンの情報をまとめる（有効かどうか）')).toHaveAccessibleName(PASSED);
      await expect(requestPanel(page).getByText('✓ ステータスと OAuth のエラーは期待どおり')).toBeVisible();
    });

    await test.step('a hint the OP does not know, not run: the same way, and the flow says so and opens nothing', async () => {
      await formValue(page, 'token_type_hint').fill('not-a-hint');
      await expect(partingNote(page)).toContainText('書き換える前のリクエストと同じ道筋を通ります');
      await expect(shownFrames(page)).not.toContainText('()');
      await requestPanel(page).getByRole('button', { name: '元のリクエストに戻す' }).click();
      await expect(partingNote(page)).toHaveCount(0);
    });

    await test.step('run the token the OP never issued: sent once, and the replay of the request sent goes into the same two functions', async () => {
      await formValue(page, 'token').fill('not-a-token-the-op-issued');
      await expect(partingNote(page)).toContainText('次の 2 か所で道筋が分かれます');
      await runButton(page).click();
      await expect(exchangeLine(page)).toContainText('地図から送った');
      await expect(responseLine(page)).toContainText('200 OK');
      await expect(replayLine(page)).toBeVisible();
      await expect(partingNote(page)).toContainText('次の 2 か所で道筋が分かれます');
      await expect(partingButton(page, 'describeIntrospectedToken()')).toBeEnabled();
      await expect(mismatchWarning(page)).toHaveCount(0);
      expect(await exchangeIds(request, workspace)).toHaveLength(prepared.length + 1);
    });
  });
});
