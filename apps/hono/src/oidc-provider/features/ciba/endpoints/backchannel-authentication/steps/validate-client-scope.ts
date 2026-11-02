import { type TokenClientInfo, findUnregisteredClientScopes } from '@maronn-openid-connect/core';
import { BackchannelAuthenticationError } from '@maronn-openid-connect/experimental/ciba';
import { findUnsupportedScopes } from '../../../../../scopes.js';
import { step } from '../../../../../endpoints/step.js';

export const meta = step({
  id: 'validate-client-scope',
  endpoint: 'backchannel-authentication',
  feature: 'ciba',
  kind: 'validate',
  label: 'Check the requested scope against the registration',
  spec: 'RFC 7591 §2 / RFC 6749 §3.3',
  function: 'validateCibaClientScope',
  consumes: ['params', 'client'],
  produces: [],
  removable: false,
});

/**
 * 使えないスコープがあれば `invalid_scope` を投げる。
 *
 * まず、OP が宣言していないスコープの要求を拒否する（RFC 6749 §3.3）。
 * 判定には `/authorize` と同じ許可リスト（`scopes.ts`）を使い、`offline_access` は判定から外す。
 * 独自のスコープを宣言していない間は、この判定はどの値も通す。
 * 次に、スコープの一覧（`client.scope`）を登録したクライアントが、一覧にないスコープを要求していれば拒否する（RFC 7591 §2）。
 * これも `/authorize` と同じ規則である。
 *
 * @spec RFC 6749 §3.3
 * @spec RFC 7591 §2
 * @throws {BackchannelAuthenticationError} `invalid_scope`: OP が宣言していないスコープか、クライアントが登録していないスコープを要求しているとき。
 */
export function validateCibaClientScope(params: Record<string, string>, client: TokenClientInfo): void {
  // OP が宣言していないスコープを、`/authorize` と同じ許可リスト（`scopes.ts`）で拒否する（RFC 6749 §3.3）。
  // 未知のスコープを含むリクエストをストアに保存しないよう、experimental パッケージの処理より前に確かめる。
  // `offline_access` は判定から外す。
  // experimental パッケージは許可できない `offline_access` を独自の方針で無視する（OIDC Core 1.0 §11）ので、ここで拒否すると、無視されるはずの値でリクエスト全体が失敗してしまう。
  const unsupportedScopes = findUnsupportedScopes(
    (params['scope'] ?? '')
      .split(' ')
      .filter((scope) => scope.length > 0 && scope !== 'offline_access'),
  );
  if (unsupportedScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Unsupported scope: ' + unsupportedScopes.join(' '),
    );
  }

  const unregisteredScopes = findUnregisteredClientScopes(
    (params['scope'] ?? '').split(' ').filter((scope) => scope.length > 0),
    client.scope,
  );
  if (unregisteredScopes.length > 0) {
    throw new BackchannelAuthenticationError(
      'invalid_scope',
      'Client is not registered for scope: ' + unregisteredScopes.join(' '),
    );
  }
}
