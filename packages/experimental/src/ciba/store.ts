/**
 * OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Core 1.0 —
 * Poll モード
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 認証リクエストレコードとログイントランザクションのストア契約。
 */

/** CIBA Core 1.0 §10.1: トークンリクエストの grant_type 値。 */
export const CIBA_GRANT_TYPE = 'urn:openid:params:grant-type:ciba';

/**
 * ログイントランザクションの TTL（秒）。
 *
 * 既存の auth transaction の TTL / Cookie Max-Age と同値の 600 秒に固定し、
 * 設定面を増やさない（仕様の設計判断）。
 */
export const CIBA_LOGIN_TRANSACTION_TTL_SECONDS = 600;

/** 認証リクエストレコードの状態（CIBA §11 の状態機械）。 */
export type CibaStatus = 'pending' | 'approved' | 'denied';

/**
 * バックチャネル認証エンドポイントが発行したレコード。
 *
 * `authReqId` は認可コード同等の機密として扱う（CIBA §7.3）。ログ出力・
 * エラーメッセージへの混入は禁止する。
 */
export interface CibaAuthenticationRequestRecord {
  /** 256bit Base64URL。クライアントがトークンエンドポイントへ提示する。 */
  authReqId: string;
  /** auth_req_id の発行先クライアント（CIBA §11 の紐付け）。 */
  clientId: string;
  /** login_hint 解決結果（リクエスト受理時点で確定）。 */
  subject: string;
  /** 要求 scope（offline_access ポリシー適用後）。 */
  scope: string[];
  /** CIBA §7.1 binding_message。承認画面に表示する（表示時エスケープ必須）。 */
  bindingMessage?: string;
  /** CIBA §7.1 acr_values。advisory として保存するのみ。 */
  acrValues?: string;
  status: CibaStatus;
  createdAt: Date;
  expiresAt: Date;
  /** 現在の要求ポーリング間隔（秒）。slow_down のたびに +5 される（§11）。 */
  interval: number;
  lastPolledAt: Date | null;
  /** 認証デバイス UI の一覧表示時に発行・回転する CSRF トークン。 */
  csrfToken: string | null;
  /** 承認時のみ設定される認証時刻（epoch 秒）。 */
  authTime?: number;
  /** 承認時のみ設定される承認済み scope。 */
  approvedScope?: string[];
  /** 承認時のみ設定される grant 識別子（revocation の grant 単位失効に使う）。 */
  grantId?: string;
}

/**
 * 利用者が実装する認証リクエストレコードのストア契約。
 *
 * `authReqId` は外部入力由来の不透明値として扱うこと。永続ストア実装では
 * キーをクエリ文字列へ連結せず、必ずパラメータ化した問い合わせを使う。
 */
export interface CibaAuthenticationRequestStore {
  save(record: CibaAuthenticationRequestRecord): Promise<void>;
  /**
   * `auth_req_id` のレコードを返す。
   *
   * レコードがないとき（消費済みや削除済みのときを含む）は `null` を返す。
   */
  findByAuthReqId(authReqId: string): Promise<CibaAuthenticationRequestRecord | null>;
  /**
   * サブジェクト宛ての、保留中で期限内のレコードを返す。
   *
   * 状態が `pending` で、有効期限を過ぎていないレコードだけを返す。
   * 認証デバイスの画面で保留中のリクエストを一覧にするときと、サブジェクトごとの保留中のリクエスト数を数えるときに使う。
   */
  listPendingBySubject(subject: string): Promise<CibaAuthenticationRequestRecord[]>;
  /**
   * 同じ `authReqId` のレコードを渡したものに置き換える。
   *
   * `lastPolledAt` と `interval` の読み出しから書き込みまでを不可分に行わない実装では、並行してポーリングされたときに、ポーリングの間隔を守らせきれないことがある。
   * ただし、状態の遷移（`pending` から `approved` か `denied` へ）と、{@link CibaAuthenticationRequestStore.consume} による一度だけの使用が守られていれば、セキュリティ上の性質は保たれる。
   */
  update(record: CibaAuthenticationRequestRecord): Promise<void>;
  delete(authReqId: string): Promise<void>;
  /**
   * `auth_req_id` のレコードを返すと同時に削除する。
   *
   * トークンを発行するときに、`auth_req_id` を一度しか使えないようにするために使う。
   * レコードがなければ `null` を返す。
   *
   * 取り出しと削除は不可分でなければならない。
   * 不可分でない実装では、同じ `auth_req_id` を並行して引き換えたリクエストが、それぞれトークンを得てしまう。
   * デバイス認可グラントのストアの `consume` と同じ要件である。
   *
   * 期限切れのレコードは、通常はトークンエンドポイントがポーリングに `expired_token` で応答するときに削除されるが、ポーリングをやめたクライアントのレコードは残る。
   * ストアの実装は、`expiresAt` から十分な猶予（目安は有効期間と同じくらい）を置いたあとで、期限切れのレコードを自分で破棄してよい。
   * 破棄したあとのポーリングは `expired_token` ではなく `invalid_grant` になるが、クライアントはどちらのエラーでもフローを終えるので、相互運用の問題は起きない。
   */
  consume(authReqId: string): Promise<CibaAuthenticationRequestRecord | null>;
}

/**
 * 認証デバイス UI のログイントランザクション。
 *
 * ログイン CSRF 防御（binding Cookie のハッシュ照合）と資格情報試行の計数の
 * 錨になる。`id` / `csrfToken` は hidden フィールドで運び、`bindingHash` の
 * 生値（bindingSecret）はブラウザの HttpOnly Cookie にのみ存在する。
 */
export interface CibaLoginTransactionRecord {
  /** 256bit Base64URL。hidden フィールドで運ぶ。 */
  id: string;
  /** 256bit Base64URL。hidden フィールドで運ぶ。 */
  csrfToken: string;
  /** bindingSecret（Cookie 生値）の SHA-256 Base64URL。生値は保存しない。 */
  bindingHash: string;
  /** ログイン失敗回数（トランザクション単位）。 */
  loginAttempts: number;
  expiresAt: Date;
}

/** ログイントランザクションのストア契約。 */
export interface CibaLoginTransactionStore {
  /** ログイントランザクションを新しく保存する。 */
  save(record: CibaLoginTransactionRecord): Promise<void>;
  /**
   * `id` のログイントランザクションを返す。
   *
   * ないときは `null` を返す。
   */
  findById(id: string): Promise<CibaLoginTransactionRecord | null>;
  /**
   * ログイントランザクションを渡したレコードで置き換える。
   *
   * ログインの失敗回数を記録するときなどに使う。
   */
  update(record: CibaLoginTransactionRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * 認証リクエストのレコードをメモリに置くストアを作る。
 *
 * 動作確認のためのもので、本番では永続的なストア（Redis、KV、データベースなど）に置き換える。
 * `consume` は取り出しと削除を 1 つの同期処理で行うので、不可分であるという要件を満たす。
 * `save` を呼ぶたびに、有効期限から 600 秒を過ぎたレコードを削除する。
 */
export function createInMemoryCibaAuthenticationRequestStore(): CibaAuthenticationRequestStore {
  const records = new Map<string, CibaAuthenticationRequestRecord>();
  // 有効期限を過ぎてから、有効期間 1 つ分に当たる 600 秒を待って、レコードを破棄する。
  // 期限切れのあとも 600 秒は `expired_token` を返せるようにしつつ、放置されたストアが際限なく大きくならないようにする。
  const evictionGraceMs = 600 * 1000;
  const evictExpired = (): void => {
    const cutoff = Date.now() - evictionGraceMs;
    for (const [authReqId, record] of records) {
      if (record.expiresAt.getTime() < cutoff) {
        records.delete(authReqId);
      }
    }
  };
  return {
    async save(record: CibaAuthenticationRequestRecord): Promise<void> {
      evictExpired();
      records.set(record.authReqId, record);
    },
    async findByAuthReqId(authReqId: string): Promise<CibaAuthenticationRequestRecord | null> {
      return records.get(authReqId) ?? null;
    },
    async listPendingBySubject(subject: string): Promise<CibaAuthenticationRequestRecord[]> {
      const now = Date.now();
      const pending: CibaAuthenticationRequestRecord[] = [];
      for (const record of records.values()) {
        if (
          record.subject === subject &&
          record.status === 'pending' &&
          record.expiresAt.getTime() > now
        ) {
          pending.push(record);
        }
      }
      return pending;
    },
    async update(record: CibaAuthenticationRequestRecord): Promise<void> {
      records.set(record.authReqId, record);
    },
    async delete(authReqId: string): Promise<void> {
      records.delete(authReqId);
    },
    async consume(authReqId: string): Promise<CibaAuthenticationRequestRecord | null> {
      const record = records.get(authReqId) ?? null;
      // 読み取りと同時に削除し、同じ `auth_req_id` のリプレイで 2 つ目のトークンを得られないようにする（CIBA §11）。
      records.delete(authReqId);
      return record;
    },
  };
}

/**
 * ログイントランザクションをメモリに置くストアを作る。
 *
 * 動作確認のためのもので、本番では永続的なストアに置き換える。
 * `save` を呼ぶたびに、有効期限を過ぎたログイントランザクションを削除する。
 */
export function createInMemoryCibaLoginTransactionStore(): CibaLoginTransactionStore {
  const records = new Map<string, CibaLoginTransactionRecord>();
  const evictExpired = (): void => {
    const now = Date.now();
    for (const [id, record] of records) {
      if (record.expiresAt.getTime() < now) {
        records.delete(id);
      }
    }
  };
  return {
    async save(record: CibaLoginTransactionRecord): Promise<void> {
      evictExpired();
      records.set(record.id, record);
    },
    async findById(id: string): Promise<CibaLoginTransactionRecord | null> {
      return records.get(id) ?? null;
    },
    async update(record: CibaLoginTransactionRecord): Promise<void> {
      records.set(record.id, record);
    },
    async delete(id: string): Promise<void> {
      records.delete(id);
    },
  };
}
