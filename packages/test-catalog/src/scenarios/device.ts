import type { RequestScenario } from '../premises.js';

/** A device grant or browser companion case with the feature it requires. */
function device(endpoint: string, id: string, title: string, purpose: string, status: number, description: string, error?: string): RequestScenario {
  return { endpoint, id, title, purpose, feature: 'device-authorization-grant', expected: { status, description, ...(error === undefined ? {} : { error }) } };
}

/** A CIBA poll or authentication-device case with the feature it requires. */
function ciba(endpoint: string, id: string, title: string, purpose: string, status: number, description: string, error?: string): RequestScenario {
  return { endpoint, id, title, purpose, feature: 'ciba', expected: { status, description, ...(error === undefined ? {} : { error }) } };
}

export const deviceScenarios: readonly RequestScenario[] = [
  device('device-authorization', 'device-authorization-public', '入力の限られたデバイスで認可を始める', 'パブリッククライアントが別画面でユーザーの承認を得るため、デバイスコードとユーザーコードを発行する。', 200, 'デバイスコード、ユーザーコード、確認先 URL とポーリング間隔を返す'),
  device('device-authorization', 'device-authorization-confidential', '認証付きクライアントでデバイス認可を始める', 'クライアントシークレットで認証してから、デバイス用のコードを発行する。', 200, 'コードと確認先 URL を返す'),
  device('device-authorization', 'device-authorization-invalid-client', '誤ったクライアント認証情報を検出する', '間違ったクライアントシークレットでデバイス認可を要求する。', 401, 'invalid_client を返す', 'invalid_client'),
  device('device-authorization', 'device-authorization-unregistered-grant', 'デバイス認可を登録していないクライアントを検出する', '認可コード用のクライアントがデバイス認可を要求する。', 400, 'unauthorized_client を返す', 'unauthorized_client'),
  device('device-authorization', 'device-authorization-invalid-scope', 'デバイスで利用できないスコープを検出する', 'デバイスクライアントが、自分の登録にないスコープを要求する。', 400, 'invalid_scope を返す', 'invalid_scope'),
  device('device', 'device-entry', 'ユーザーコードの入力画面を開く', '別のデバイスに表示されたコードを手入力する画面を表示する。', 200, 'コードの入力フォームを返す'),
  device('device', 'device-entry-prefill', '確認用リンクからユーザーコードを入力する', '発行された確認用リンクを開き、ユーザーコードの欄を自動入力する。', 200, '発行済みコードが入ったフォームを返す'),
  device('device', 'device-code-submit', '発行済みのユーザーコードを入力する', 'デバイスとブラウザを結び付け、未ログインの利用者が承認手続きを始める。', 200, 'ブラウザへの結び付けを設定し、ログインフォームを返す'),
  device('device', 'device-unknown-code', '一致しないユーザーコードを入力する', '認可の開始時に発行されていないコードを送って、入力の訂正を促す。', 400, '照合エラー付きのコード入力画面を返す'),
  device('device', 'device-login', 'デバイスの承認に進むためログインする', 'ユーザーコードを送信したブラウザからログインし、デバイスが要求したスコープを確認する。', 200, 'OP のセッションを作成し、承認画面を返す'),
  device('device', 'device-login-retry', 'デバイス認可のログインをやり直す', 'ユーザーコードは有効で、パスワードだけが誤っている場合の再入力を確認する。', 200, '認証情報のエラーと残り試行回数を含むログイン画面を返す'),
  device('device', 'device-approve', 'デバイスからの認可を承認する', 'ユーザーコードと要求スコープを確認し、同じブラウザで承認を送信する。', 200, '承認を記録し、デバイスに戻る画面を返す'),
  device('device', 'device-decline', 'デバイスからの認可を拒否する', 'ユーザーがデバイスへのアクセス許可を断る。', 200, '拒否を記録し、デバイスに戻る画面を返す'),
  device('token', 'token-device-pending', 'デバイスからユーザーの承認を待つ', '発行済みデバイスコードを使い、承認前に最初のポーリングを行う。', 400, 'authorization_pending を返す', 'authorization_pending'),
  device('token', 'token-device-slow-down', 'デバイスが次のポーリングまで待つ時間を確認する', '直前のポーリングから指定間隔を待たず、同じデバイスコードで再度問い合わせる。', 400, 'slow_down を返して必要な待ち時間を延ばす', 'slow_down'),
  device('token', 'token-device-approved', '承認されたデバイスのトークンを受け取る', '実際にユーザーの承認を得たデバイスコードをトークンに引き換える。', 200, 'アクセストークンと ID トークンを返す'),
  device('token', 'token-device-declined', 'デバイスでユーザーの拒否を受け取る', 'ユーザーが拒否したデバイスコードの結果をポーリングする。', 400, 'access_denied を返す', 'access_denied'),
  device('token', 'token-device-used', '使用済みデバイスコードを引き換え直す', '承認後に引き換えたコードをもう一度送信し、利用できないことを確かめる。', 400, 'invalid_grant を返す', 'invalid_grant'),
  device('token', 'token-device-expired', 'デバイスコードの有効期限切れを確認する', '発行時の有効期間を過ぎてからデバイスコードの認可結果を問い合わせる。', 400, 'expired_token を返す', 'expired_token'),
  ciba('backchannel-authentication', 'backchannel-authentication-start', '利用者のデバイスに認証を依頼する', '機密クライアントが利用者のログイン名と確認用の文字列を指定して CIBA の認証を開始する。', 200, 'ポーリングに使う auth_req_id、有効期間、問い合わせ間隔を返す'),
  ciba('backchannel-authentication', 'backchannel-authentication-unknown-user', '認証の宛先が特定できない場合を確認する', '登録されていないログイン名を利用者のヒントとして送る。', 400, 'unknown_user_id を返す', 'unknown_user_id'),
  ciba('backchannel-authentication', 'backchannel-authentication-missing-hint', '認証依頼の宛先の指定漏れを検出する', '利用者のヒントを付けずに CIBA の認証を要求する。', 400, 'invalid_request を返す', 'invalid_request'),
  ciba('backchannel-authentication', 'backchannel-authentication-invalid-client', 'CIBA のクライアント認証情報を確認する', '誤ったクライアントシークレットで認証依頼を送る。', 401, 'invalid_client を返す', 'invalid_client'),
  ciba('ciba', 'ciba-entry', 'CIBA の確認画面を開く', '認証を依頼されたユーザーが、未ログインのブラウザで確認画面を開く。', 200, 'ブラウザへ結び付けたログインフォームを返す'),
  ciba('ciba', 'ciba-pending-list', '自分宛ての未決定の認証依頼を一覧する', 'CIBA の依頼を受けたユーザーが、ログイン済みのブラウザで依頼を確認する。', 200, '保留中の依頼と確認用の文字列を表示する'),
  ciba('ciba', 'ciba-login', '認証依頼を確認するためログインする', 'ログインフォームに正しい認証情報を入力し、保留中の依頼に進む。', 200, 'OP のセッションを作り、保留中の依頼を返す'),
  ciba('ciba', 'ciba-login-retry', 'CIBA のログインをやり直す', 'ログインフォームで誤ったパスワードを入力したとき再入力できることを確かめる。', 200, '認証情報のエラーと残り試行回数を含むログイン画面を返す'),
  ciba('ciba', 'ciba-approve', '別デバイスからの認証依頼を承認する', '依頼されたクライアントと確認用の文字列を見て認証を承認する。', 200, '承認を記録し、完了画面を返す'),
  ciba('ciba', 'ciba-decline', '別デバイスからの認証依頼を拒否する', '依頼を受けた利用者が認証を断る。', 200, '拒否を記録し、完了画面を返す'),
  ciba('token', 'token-ciba-pending', 'CIBA の認証の完了を待つ', '依頼を発行したクライアントが、ユーザーの決定前に auth_req_id をポーリングする。', 400, 'authorization_pending を返す', 'authorization_pending'),
  ciba('token', 'token-ciba-slow-down', 'CIBA のポーリング間隔を確認する', '直前のポーリングから指定の間隔を待たずに認証結果を再照会する。', 400, 'slow_down を返して必要な待ち時間を延ばす', 'slow_down'),
  ciba('token', 'token-ciba-approved', '承認された CIBA のトークンを受け取る', '利用者が認証を承認した後で、クライアントが auth_req_id を引き換える。', 200, 'アクセストークンと ID トークンを返す'),
  ciba('token', 'token-ciba-declined', 'CIBA の認証拒否を受け取る', '利用者が認証を拒否した後で、クライアントが auth_req_id の結果を問い合わせる。', 400, 'access_denied を返す', 'access_denied'),
  ciba('token', 'token-ciba-used', '使用済みの auth_req_id を引き換え直す', '既にトークンを受け取った auth_req_id で再度引き換えを試す。', 400, 'invalid_grant を返す', 'invalid_grant'),
  ciba('token', 'token-ciba-expired', 'CIBA の認証期限切れを確認する', '発行時に指定された有効期間を過ぎてから auth_req_id をポーリングする。', 400, 'expired_token を返す', 'expired_token'),
];
