import { hashClientSecret } from '@maronn-openid-connect/core';
import type { DynamicallyRegisteredClient } from '@maronn-openid-connect/experimental/dynamic-client-registration';
import { RegistrationEndpointError } from '../response.js';
import { step } from '../../../../../endpoints/step.js';
import { toClientRegistration } from '../../../store.js';

export const meta = step({
  id: 'store-client',
  endpoint: 'register',
  feature: 'dynamic-client-registration',
  kind: 'persist',
  label: 'Enforce the inventory cap and store the client',
  spec: 'RFC 7591 §5',
  function: 'storeRegisteredClient',
  consumes: ['client'],
  produces: [],
  removable: false,
});

/**
 * 登録数が上限内なら、クライアントをストアに保存する。
 *
 * 登録数がすでに `maxRegisteredClients` に達していれば、保存せずに固定のボディの 429 を投げる（RFC 7591 §5）。
 * メタデータには誤りがないので、`invalid_client_metadata` にはしない。
 * そう応答すると、クライアントがメタデータを直して送り直す繰り返しを招き、上限で防ぎたいサービス妨害攻撃の負荷をかえって増やす。
 * `Retry-After` も付けない。
 * 上限は登録の総数に対するもので時間あたりの頻度の制限ではないので、いつ登録できるようになるかを約束できない。
 *
 * 保存するレコード（`toClientRegistration()`）は、静的に登録したクライアント（db/memory/clients.ts の `registerClient()`）と同じく `client_secret` をハッシュでだけ持ち、`jwks` の鍵を設定の用途ごとに持つ。
 * 201 のレスポンスはこのステップが受け取ったメモリ上のクライアントから組み立てるので、平文のシークレットをストアに置く必要はない。
 *
 * @spec RFC 7591 §5
 * @throws {RegistrationEndpointError} 429 の `too_many_registrations`: 登録数が上限に達しているとき、または同時の登録で上限を超えたとき
 */
export async function storeRegisteredClient(c: any, client: DynamicallyRegisteredClient): Promise<void> {
  const config = c.get('dynamicClientRegistrationConfig');
  const store = c.get('dynamicClientStore');
  if ((await store.count()) >= config.maxRegisteredClients) {
    throw inventoryCapError();
  }
  const clientSecretHash = client.clientSecret === undefined ? undefined : await hashClientSecret(client.clientSecret);
  await store.save(toClientRegistration(client, { clientSecretHash, jwksPurposes: config.jwksPurposes }));
  // 保存したあとに登録数を数え直し、上限を超えていればこの登録を削除して 429 を投げる。
  // 同時に届いたリクエストは、上の `await` の間に処理が入れ替わり、そろって最初の確認を通ることがあるためである。
  // これで上限を超えた登録が残ることはない（同時に削除し合って、上限より少ないまま終わることはある）。
  if ((await store.count()) > config.maxRegisteredClients) {
    await store.delete(client.clientId);
    throw inventoryCapError();
  }
  // 登録のメタデータと発行した `client_secret` は、ログに出さない。
}

/**
 * 登録数が上限に達したときの 429 のエラーを作って返す。
 *
 * ボディの `error` は `too_many_registrations`、`error_description` は `registration limit reached` で、`Retry-After` ヘッダーは付けない。
 */
function inventoryCapError(): RegistrationEndpointError {
  return new RegistrationEndpointError({
    status: 429,
    body: { error: 'too_many_registrations', error_description: 'registration limit reached' },
  });
}
