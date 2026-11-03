import { defineEndpoint } from '../../_oidc-provider/endpoint';

/**
 * OP のメタデータを JSON で返す。
 * メタデータには、発行者、各エンドポイントの URL、OP が対応するレスポンスタイプ、グラントタイプ、スコープ、クレーム、署名アルゴリズムを含む。
 *
 * 有効な機能は、それぞれのエンドポイントや対応する値をメタデータに加える。
 * レスポンスは 1 時間キャッシュしてよい（`Cache-Control: public, max-age=3600`）。
 * 署名鍵を読み込めないときは、503 の `server_error` で応答する。
 *
 * @spec OIDC Discovery 1.0 §4
 */
export const endpoint = defineEndpoint({
  path: '/.well-known/openid-configuration',
  steps: [
    { id: 'load-signing-keys', consumes: [], produces: ['keys'] },
    { id: 'build-metadata', consumes: ['keys'], produces: ['issuer', 'metadata'] },
    { id: 'respond', consumes: ['metadata', 'issuer'], produces: [] },
  ],
});
