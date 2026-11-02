/**
 * EXPERIMENTAL — device verification UI, step 1 (RFC 8628 §3.3).
 *
 * The End-User opens /device on a second device and types the user_code the
 * first device shows. On a match this step binds the verification to this
 * browser: the user_code is known to whoever started the flow — possibly an
 * attacker — so a CSRF token on the record alone would be no defense. The
 * binding cookie minted here is what every later step requires (see
 * buildDeviceBindingCookie() in
 * _oidc-provider/features/device-authorization-grant/cookies.ts for the full
 * model).
 *
 * Backed by @maronn-openid-connect/experimental, whose API is NOT stable.
 */
import type { NextRequest } from 'next/server';
import {
  findPendingRecordByUserCode,
  issueVerificationBinding,
  type DeviceAuthorizationRecord,
} from '@maronn-openid-connect/experimental/device-authorization-grant';
import { deviceAuthorizationStore } from '../../_oidc-provider/features/device-authorization-grant/store';
import { stores } from '../../_oidc-provider/provider';
import { buildDeviceBindingCookie } from '../../_oidc-provider/features/device-authorization-grant/cookies';
import { parseSessionId } from '../../_oidc-provider/cookies';
import { readFormFields } from '../../_oidc-provider/http';
import { resolveGrantableScopes } from '../../_oidc-provider/scopes';
import {
  approvalScreen,
  invalidUserCodeScreen,
  loginScreen,
  verificationScreen,
} from './screens';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * ユーザーコードの入力フォームを HTML で返す。
 *
 * ログインを求めず、何も書き込まない。
 * クエリの `user_code`（`verification_uri_complete` に付いている）は入力欄に入れるだけで、照合はフォームを送信するまで行わない。
 * そのため、`verification_uri_complete` を開いただけでは、コードが使われることも、コードがあるかどうかがわかることもない。
 *
 * @spec RFC 8628 §3.3
 * @spec RFC 8628 §3.3.1
 */
export function GET(request: NextRequest): Response {
  return verificationScreen(request.nextUrl.searchParams.get('user_code') ?? '');
}

/**
 * ユーザーコードを照合し、ログインか承認の画面を返す。
 *
 * `POST /device` の処理である。
 * 送られた `user_code` が保留中のレコードに一致しなければ、照合に失敗した旨を添えた入力フォームを 400 で返す。
 * 一致すれば、バインディングの秘密の値と CSRF トークンを作り直してレコードに保存し、秘密の値をバインディング Cookie にしてこのブラウザに渡す。
 * OP のセッションがあれば承認画面を、なければログインフォームを、どちらもバインディング Cookie を付けて返す。
 *
 * バインディング Cookie を作るのはこの処理だけなので、`csrf_token` を最初に渡すのもこの処理である。
 * 後の処理（ログインと承認）は、どれもこの Cookie を求める。
 *
 * @spec RFC 8628 §3.3
 */
export async function POST(request: Request): Promise<Response> {
  const form = await readFormFields(request);
  const submittedUserCode = String(form.get('user_code') ?? '');

  const record = await findPendingRecordByUserCode(submittedUserCode, deviceAuthorizationStore);
  if (!record) {
    return invalidUserCodeScreen(submittedUserCode);
  }

  // バインディングの秘密の値と CSRF トークンを、まとめて作り直す。
  // 別のブラウザが同じ `user_code` を送信すると、バインディングはそのブラウザに移る（最後に送信したものが勝つ）。
  // 識別子を他人と共有できる設計のフローでは、避けられない性質である。
  const { bindingSecret, csrfToken } = await issueVerificationBinding(
    record,
    deviceAuthorizationStore,
  );
  const bindingCookie = buildDeviceBindingCookie(
    record.userCode,
    bindingSecret,
    remainingTtlSeconds(record),
  );

  const sessionId = parseSessionId(request.headers.get('Cookie'));
  const session = sessionId ? await stores.browserSessionStore.get(sessionId) : undefined;
  if (session) {
    return approvalScreen(
      {
        userCode: record.userCodeDisplay,
        csrfToken,
        clientId: record.clientId,
        scopes: await resolveGrantableScopes(record.scope, session.subject),
      },
      [bindingCookie],
    );
  }
  return loginScreen({ userCode: record.userCodeDisplay, csrfToken }, [bindingCookie]);
}

/**
 * レコードの有効期限までの残りの秒数を返す。
 *
 * 1 秒未満の端数は切り上げ、期限を過ぎていれば 0 を返す。
 * 切り上げるのは、バインディング Cookie がレコードより先に期限切れにならないようにするためである。
 * Cookie が先に切れると、まだ有効な検証が、理由のわからない 403 で拒否されてしまう。
 */
function remainingTtlSeconds(record: DeviceAuthorizationRecord): number {
  return Math.max(0, Math.ceil((record.expiresAt.getTime() - Date.now()) / 1000));
}
