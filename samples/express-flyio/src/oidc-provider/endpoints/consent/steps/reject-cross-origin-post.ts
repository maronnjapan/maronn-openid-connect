import { isSameOriginFormPost, CROSS_ORIGIN_FORM_POST_MESSAGE } from '../../../cookies.js';
import type { ConsentError } from '../screen.js';
import { step } from '../../step.js';

export const meta = step({
  id: 'reject-cross-origin-post',
  endpoint: 'consent',
  kind: 'validate',
  label: '別オリジンからのフォーム POST を拒否する',
  function: 'rejectCrossOriginFormPost',
  consumes: [],
  produces: [],
  removable: false,
});

/**
 * フォームの送信元が別オリジンなら 403 のエラーを返す。
 *
 * 送信元は、ブラウザが付ける `Sec-Fetch-Site` と `Origin` のヘッダーで判定する（cookies.ts の `isSameOriginFormPost()`）。
 * OP 自身のページから送られたと判定したときは `undefined` を返す。
 * エラーは OP のエラーページに表示し、クライアントへはリダイレクトしない。
 */
export function rejectCrossOriginFormPost(c: any): ConsentError | undefined {
  const sameOrigin = isSameOriginFormPost(
    { origin: c.req.header('Origin') ?? null, secFetchSite: c.req.header('Sec-Fetch-Site') ?? null },
    c.get('config').issuer,
  );
  return sameOrigin ? undefined : { kind: 'error', error: CROSS_ORIGIN_FORM_POST_MESSAGE, statusCode: 403 };
}
