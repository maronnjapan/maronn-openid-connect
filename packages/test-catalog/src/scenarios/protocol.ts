import type { RequestScenario } from '../premises.js';

const LOGIN = { status: 302, description: '認可トランザクションを保存してログイン画面に進む', redirectPath: '/login' };
const NEXT_ERROR_PAGE = { status: 303, description: 'OP のエラー画面へリダイレクトする', redirectPath: '/oidc-error' };
const PUSHED = { status: 201, description: '認可リクエストを保存し、request_uri と expires_in を返す' };

export const protocolScenarios: readonly RequestScenario[] = [
  {
    id: 'authorize-post', endpoint: 'authorize', title: 'フォームで認可リクエストを送る',
    purpose: '認可コード + PKCE のパラメータを POST のフォームボディで渡す。',
    expected: LOGIN,
  },
  {
    id: 'authorize-par', endpoint: 'authorize', feature: 'par', title: 'PAR の request_uri で認可を始める',
    purpose: '事前に /par に送ったパラメータを、返された request_uri で参照する。',
    expected: LOGIN,
  },
  {
    id: 'authorize-par-unknown', endpoint: 'authorize', feature: 'par', title: '保存されていない PAR の参照を確認する',
    purpose: 'OP に存在しない PAR の request_uri を受けたときの応答を確認する。',
    expected: { status: 400, description: '認可を開始できないことを OP のエラー画面に表示する' },
    nextjs: { expected: NEXT_ERROR_PAGE },
  },
  {
    id: 'authorize-form-post', endpoint: 'authorize', feature: 'form-post-response-mode', title: '認可結果をフォーム POST で受け取る',
    purpose: 'response_mode=form_post を指定して、認可後にクライアントへ返す方法を設定する。',
    expected: LOGIN,
  },
  {
    id: 'authorize-jarm', endpoint: 'authorize', feature: 'jarm', title: '認可結果を署名付き JWT で受け取る',
    purpose: 'response_mode=query.jwt で JARM を指定して、署名付きの認可応答を要求する。',
    expected: LOGIN,
  },
  {
    id: 'authorize-implicit', endpoint: 'authorize', feature: 'implicit-flow', title: 'Implicit Flow で ID トークンを要求する',
    purpose: 'response_type=id_token と nonce で、認可応答から直接 ID トークンを受け取る。',
    expected: LOGIN,
  },
  {
    id: 'authorize-hybrid', endpoint: 'authorize', feature: 'hybrid-flow', title: 'Hybrid Flow でコードと ID トークンを要求する',
    purpose: 'response_type=code id_token と PKCE で、ID トークンと交換用コードを認可応答で受け取る。',
    expected: LOGIN,
  },
  {
    id: 'authorize-sso', endpoint: 'authorize', title: 'ログイン済みの利用者を操作なしで認可する',
    purpose: 'ログインと同意が済んでいるブラウザから prompt=none を送り、認可コードを受け取る。',
    expected: { status: 302, description: '認可コード付きで登録済みコールバックに戻る', redirectPath: '/callback' },
  },
  {
    id: 'authorize-silent-consent-required', endpoint: 'authorize', title: '同意が必要なときのサイレント認可を確認する',
    purpose: 'ログイン済みで許可を得ていないスコープに prompt=none を指定する。',
    expected: { status: 302, description: '登録済みコールバックに同意が必要であることを返す', error: 'consent_required' },
  },
  {
    id: 'authorize-force-login', endpoint: 'authorize', title: 'ログイン済みでも再認証を求める',
    purpose: '既存のブラウザセッションを持つ利用者に prompt=login で再ログインを求める。',
    expected: LOGIN,
  },
  {
    id: 'authorize-force-consent', endpoint: 'authorize', title: '以前に同意したスコープをもう一度確認する',
    purpose: '以前に同意した利用者へ prompt=consent で選択画面を提示する。',
    expected: { status: 302, description: '新しい認可トランザクションで同意画面に進む', redirectPath: '/consent' },
  },
  {
    id: 'authorize-unknown-client', endpoint: 'authorize', title: '未登録クライアントの認可リクエストを確認する',
    purpose: '未登録の client_id を指定したとき、利用者が OP のエラーを確認できるようにする。',
    expected: { status: 400, description: 'クライアントの登録を確認できないため OP のエラー画面を返す' },
    nextjs: { expected: NEXT_ERROR_PAGE },
  },
  {
    id: 'authorize-unregistered-redirect', endpoint: 'authorize', title: '登録と異なるコールバック URL を確認する',
    purpose: '登録外の redirect_uri を含むリクエストが OP で拒否されることを確かめる。',
    expected: { status: 400, description: 'OP のエラー画面を返す' },
    nextjs: { expected: NEXT_ERROR_PAGE },
  },
  {
    id: 'authorize-missing-scope', endpoint: 'authorize', title: 'スコープの指定漏れを確認する',
    purpose: 'scope を省略したとき、登録済みコールバックで受け取る OAuth エラーを確認する。',
    expected: { status: 302, description: '登録済みコールバックへスコープのエラーを返す', error: 'invalid_scope' },
  },
  {
    id: 'par-push-code-pkce', endpoint: 'par', feature: 'par', title: '認可パラメータを先に OP に登録する',
    purpose: '認証済みクライアントが認可コード + PKCE のパラメータを送り、ブラウザで使う参照 URI を取得する。',
    expected: PUSHED,
  },
  {
    id: 'par-invalid-client', endpoint: 'par', feature: 'par', title: 'クライアント認証の失敗を確認する',
    purpose: '設定と異なるクライアントシークレットで PAR を送ったときのエラーを確認する。',
    expected: { status: 401, description: 'クライアント認証を要求する', error: 'invalid_client' },
  },
  {
    id: 'par-invalid-redirect', endpoint: 'par', feature: 'par', title: '登録外のコールバックを持つ PAR を確認する',
    purpose: '異なる redirect_uri を送ると、ブラウザ誘導に使う request_uri の発行前に検証される。',
    expected: { status: 400, description: 'パラメータの検証エラーを返す', error: 'invalid_request' },
  },
  {
    id: 'register-public-code-client', endpoint: 'register', feature: 'dynamic-client-registration', title: '認可コードを使うパブリッククライアントを登録する',
    purpose: 'redirect_uris と token_endpoint_auth_method=none を送り、登録済み client_id を取得する。',
    expected: { status: 201, description: '発行した client_id とクライアントのメタデータを返す' },
  },
  {
    id: 'register-confidential-client', endpoint: 'register', feature: 'dynamic-client-registration', title: 'サーバー側のクライアントを登録する',
    purpose: 'token_endpoint_auth_method=client_secret_basic を指定し、バックエンドで使う認証情報を受け取る。',
    expected: { status: 201, description: 'client_id と client_secret を返す' },
  },
  {
    id: 'register-request-object-client', endpoint: 'register', feature: 'dynamic-client-registration', requires: ['request-object'], title: 'Request Object を検証する公開鍵を登録する',
    purpose: '署名に対応する公開 JWK と request_object_signing_alg を、クライアントの登録時に渡す。',
    expected: { status: 201, description: '署名アルゴリズムを含む登録済みメタデータを返す' },
  },
  {
    id: 'register-invalid-redirect', endpoint: 'register', feature: 'dynamic-client-registration', title: '登録できないコールバック URI を確認する',
    purpose: 'redirect_uris に絶対 URI を指定し忘れたときの登録応答を確認する。',
    expected: { status: 400, description: 'コールバック URI の登録を拒否する', error: 'invalid_redirect_uri' },
  },
  {
    id: 'register-invalid-metadata', endpoint: 'register', feature: 'dynamic-client-registration', title: 'サポート外のクライアント設定を確認する',
    purpose: '利用できない grant_types を含むメタデータを登録したときの応答を確認する。',
    expected: { status: 400, description: 'クライアントのメタデータの検証エラーを返す', error: 'invalid_client_metadata' },
  },
];
