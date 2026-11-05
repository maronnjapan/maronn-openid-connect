import { defineEndpoint } from '../step.js';

/**
 * OP のメタデータを JSON で返す。
 * メタデータには、発行者、各エンドポイントの URL、OP が対応するレスポンスタイプ、グラントタイプ、スコープ、クレーム、署名アルゴリズムを含む。
 *
 * 有効な機能は、それぞれのエンドポイントや対応する値をメタデータに加える。
 * レスポンスは 1 時間キャッシュしてよい（`Cache-Control: public, max-age=3600`）。
 *
 * @spec OIDC Discovery 1.0 §4
 */
export const endpoint = defineEndpoint({
  id: 'discovery',
  order: 10,
  label: 'ディスカバリー',
  path: '/.well-known/openid-configuration',
  methods: ['GET'],
  layer: 'metadata',
  group: { id: 'metadata', label: 'メタデータ' },
  spec: 'OIDC Discovery 1.0 §4',
  rearrangeable: true,
  steps: [
    'collect-signing-algorithms',
    'build-metadata',
    'respond',
  ],
  edges: {
    chain: true,
  },
});
