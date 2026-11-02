import { defineEndpoint } from '../step.js';

/**
 * OP が署名に使う鍵（ID トークン、アクセストークン、UserInfo のレスポンス）の公開鍵を、JWK Set の JSON で返す。
 * クライアントは、この公開鍵で署名を検証する。
 *
 * 鍵を入れ替えた後も残した古い鍵を含めて公開し、レスポンスは 1 時間キャッシュしてよい（`Cache-Control: public, max-age=3600`）。
 */
export const endpoint = defineEndpoint({
  id: 'jwks',
  order: 20,
  label: 'JWKS',
  path: '/.well-known/jwks.json',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'メタデータ' },
  spec: 'OIDC Discovery 1.0 §3 (jwks_uri)',
  rearrangeable: true,
  steps: [
    'collect-public-keys',
    'export-jwks',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
