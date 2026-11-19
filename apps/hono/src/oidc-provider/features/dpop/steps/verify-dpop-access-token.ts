import type { AccessTokenInfo } from '@maronn-openid-connect/core';
import { step } from '../../../endpoints/step.js';
import { readDpopJkt } from '../binding.js';
import { dpopSigningAlgsOf } from '../config.js';
import { userInfoEndpointErrorOf } from '../error-responses.js';
import { validateDpopAccessTokenBinding } from '../resource.js';

export const meta = step({
  id: 'verify-dpop-access-token',
  endpoint: 'userinfo',
  feature: 'dpop',
  kind: 'validate',
  label: 'トークンを束縛した鍵と提示の仕方を照らし合わせる',
  spec: 'RFC 9449 §7.1 / §7.2',
  function: 'verifyDpopUserInfoAccess',
  consumes: ['tokenInfo', 'dpopJkt'],
  produces: [],
  removable: false,
  after: ['resolve-access-token'],
});

/**
 * アクセストークンを束縛した鍵（保存したレコードの `cnf.jkt`）が、トークンの提示の仕方に合うことを確かめる。
 *
 * - DPoP スキームで提示した（`dpopJkt` がある）ときは、トークンがその DPoP proof の鍵に束縛されていなければならない（RFC 9449 §7.1）。
 * - Bearer で提示した（`dpopJkt` が `undefined`）ときは、DPoP の鍵に束縛したトークンを拒否する。束縛したトークンを Bearer として使わせない（RFC 9449 §7.2 の MUST）。
 *
 * 失敗は 401 の `invalid_token` で、受け付ける alg 付きの DPoP のチャレンジで応答する。
 *
 * @spec RFC 9449 §7.1
 * @spec RFC 9449 §7.2
 * @throws {UserInfoEndpointError} 401 の `invalid_token`: 束縛の鍵と提示の仕方が合わないとき
 */
export function verifyDpopUserInfoAccess(c: any, tokenInfo: AccessTokenInfo, dpopJkt: string | undefined): void {
  try {
    validateDpopAccessTokenBinding(readDpopJkt(tokenInfo), dpopJkt);
  } catch (error) {
    throw userInfoEndpointErrorOf(error, dpopSigningAlgsOf(c.get('config')));
  }
}
