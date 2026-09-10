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
  findByAuthReqId(authReqId: string): Promise<CibaAuthenticationRequestRecord | null>;
  /** 認証デバイス UI の一覧用。期限内・pending のレコードのみ返す。 */
  listPendingBySubject(subject: string): Promise<CibaAuthenticationRequestRecord[]>;
  /**
   * レコードを更新する。
   *
   * `lastPolledAt` / `interval` の read-modify-write が atomic でない実装では、
   * 並行ポーリング時にポーリング間隔の強制が甘くなり得る。ただし認可状態の遷移
   * （pending → approved / denied）と {@link CibaAuthenticationRequestStore.consume}
   * による単回使用が守られていればセキュリティ特性は保たれる。
   */
  update(record: CibaAuthenticationRequestRecord): Promise<void>;
  delete(authReqId: string): Promise<void>;
  /**
   * 取得と同時に削除する（トークン発行時の単回使用強制）。
   *
   * 取得と削除は atomic でなければならない。atomic でない実装は同一 auth_req_id の
   * 並行リデンプションを許してしまう（device store の consume と同じ要件）。
   *
   * 期限切れレコードの掃除: 期限切れは原則トークンエンドポイントのポーリング時に
   * `expired_token` 応答とともに削除されるが、ポーリングを止めたクライアントの
   * レコードは残る。ストア実装は `expiresAt` から十分な猶予（目安: TTL と同程度）を
   * 置いた後に期限切れレコードを自主的に破棄してよい。破棄後のポーリングは
   * `expired_token` ではなく `invalid_grant` になるが、クライアントはどちらの
   * エラーでもフローを終了するため相互運用上の問題はない。
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
  save(record: CibaLoginTransactionRecord): Promise<void>;
  findById(id: string): Promise<CibaLoginTransactionRecord | null>;
  update(record: CibaLoginTransactionRecord): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * インメモリの認証リクエストレコードストア。
 *
 * 動作確認用。本番では永続ストア（Redis / KV / database）に置き換えること。
 * consume は取得と削除を単一の同期処理で行うため atomic 要件を満たす。
 */
export function createInMemoryCibaAuthenticationRequestStore(): CibaAuthenticationRequestStore {
  const records = new Map<string, CibaAuthenticationRequestRecord>();
  // 期限切れから 1 TTL 相当の猶予を置いて自主破棄する（expired_token を
  // 返せる期間を 1 TTL 残しつつ、放置ストアが際限なく育たないようにする）。
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
      // 単回使用（CIBA §11）: 読み取りと同時に削除し、同じ auth_req_id の
      // リプレイが 2 本目のトークンを得られないようにする。
      records.delete(authReqId);
      return record;
    },
  };
}

/**
 * インメモリのログイントランザクションストア。
 *
 * 動作確認用。本番では永続ストアに置き換えること。
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
