/**
 * Pushed Authorization Requests (PAR) — RFC 9126
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * ストア契約と、request_uri の URN 形式に関する定義。
 */

/**
 * RFC 9126 §2.2: 認可サーバーが返す `request_uri` の推奨形式。
 * 本実装はこの URN 形式のみを発行・受理する（URL 形式は非対応）。
 */
export const PAR_REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';

/**
 * PAR エンドポイントが受け付けたリクエストの保存レコード。
 *
 * `params` は PAR エンドポイントが受領した認可リクエストパラメータをそのまま保持する
 * （`client_id` は認証済みクライアントの値に正規化済み）。認可エンドポイントは
 * このパラメータを展開して通常の認可リクエストとして処理する（RFC 9126 §4）。
 */
export interface PushedAuthorizationRecord {
  /** `urn:ietf:params:oauth:request_uri:<reference-value>` */
  requestUri: string;
  /** PAR エンドポイントで認証・解決されたクライアントID（RFC 9126 §2.2 の紐付け MUST） */
  clientId: string;
  /** 受領した認可リクエストパラメータ */
  params: Record<string, string>;
  createdAt: Date;
  expiresAt: Date;
}

/**
 * 利用者が実装するストア契約。
 *
 * `get` を提供しないのは意図的で、「読むだけ」の操作を契約から排除して
 * 単回使用（RFC 9126 §7.3）を型レベルで強制するため。
 */
export interface PushedAuthorizationRequestStore {
  /** レコードを保存する。同じ requestUri で二度呼ばれることは想定しない。 */
  save(record: PushedAuthorizationRecord): Promise<void>;
  /**
   * 取得と同時に削除する（単回使用。RFC 9126 §7.3 の SHOULD を本実装では必須運用にする）。
   * 存在しない場合は null を返す。
   *
   * requestUri は不透明なキーとして扱うこと。URN 前置詞の一致は呼び出し側で検証済みだが、
   * 値そのものは外部入力（認可エンドポイントのクエリ）由来である。永続ストア実装では
   * キーをクエリ文字列へ埋め込まず、必ずパラメータ化した問い合わせを使うこと。
   *
   * 取得と削除は atomic でなければならない。atomic でない実装は同一 request_uri の
   * 並行使用（リプレイ）を許してしまう。
   */
  consume(requestUri: string): Promise<PushedAuthorizationRecord | null>;
}
