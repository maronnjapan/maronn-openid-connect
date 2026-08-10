/**
 * OAuth 2.0 Device Authorization Grant — RFC 8628
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * デバイス認可レコードのストア契約。
 */

/** RFC 8628 §3.4: トークンリクエストの grant_type 値。 */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/**
 * RFC 8628 §6.1 が推奨する base-20 文字種。
 *
 * 視覚的に紛らわしい文字（母音・0/1/O/I 等）を除いてあり、ユーザーが別デバイスの
 * 画面から書き写す前提の user_code に適する。母音を含まないため、偶発的に意味の
 * ある単語が生成されることもない。
 */
export const USER_CODE_CHARSET = 'BCDFGHJKLMNPQRSTVWXZ';

/** RFC 8628 §6.1: 20^8 ≈ 2.6×10^10 のエントロピーを確保する文字数。 */
export const USER_CODE_LENGTH = 8;

/** 表示形式 `XXXX-XXXX` のハイフン位置（先頭からの文字数）。 */
export const USER_CODE_GROUP_SIZE = 4;

/** デバイス認可レコードの状態（RFC 8628 §3.5 の状態機械）。 */
export type DeviceAuthorizationStatus = 'pending' | 'approved' | 'denied';

/**
 * デバイス認可エンドポイントが発行したレコード。
 *
 * `deviceCode` は認可コード同等の機密として扱う（RFC 8628 §5.2）。ログ出力・
 * エラーメッセージへの混入は禁止する。
 */
export interface DeviceAuthorizationRecord {
  /** 256bit ランダム。デバイスがトークンエンドポイントへ提示する。 */
  deviceCode: string;
  /** 正規化済み照合キー（例 'WDJBMJHT'）。ストアの検索キーになる。 */
  userCode: string;
  /** 表示形式（例 'WDJB-MJHT'）。ユーザーへの提示と承認画面の再表示に使う。 */
  userCodeDisplay: string;
  /** device_code の発行先クライアント（RFC 8628 §3.4 の紐付け）。 */
  clientId: string;
  /** 要求 scope（offline_access ポリシー適用後）。 */
  scope: string[];
  status: DeviceAuthorizationStatus;
  createdAt: Date;
  expiresAt: Date;
  /** 現在の要求ポーリング間隔（秒）。slow_down のたびに +5 される（§3.5）。 */
  interval: number;
  lastPolledAt: Date | null;
  /** user_code 照合成功時に発行・回転する CSRF トークン。多層防御。 */
  csrfToken: string | null;
  /**
   * bindingSecret の SHA-256 ハッシュ。生値はブラウザの HttpOnly Cookie にのみ
   * 存在するため、ストアが漏洩しても Cookie を再構成できない。
   */
  bindingHash: string | null;
  /** デバイス用ログインの失敗回数（レコード単位）。 */
  loginAttempts: number;
  /** 承認時のみ設定される認証済み subject。 */
  subject?: string;
  /** 承認時のみ設定される認証時刻（epoch 秒）。 */
  authTime?: number;
  /** 承認時のみ設定される承認済み scope。 */
  approvedScope?: string[];
  /** 承認時のみ設定される grant 識別子（revocation の grant 単位失効に使う）。 */
  grantId?: string;
}

/**
 * 利用者が実装するストア契約。
 *
 * `deviceCode` / `userCode` はいずれも外部入力由来の不透明値として扱うこと。
 * 永続ストア実装ではキーをクエリ文字列へ連結せず、必ずパラメータ化した
 * 問い合わせを使う。
 */
export interface DeviceAuthorizationStore {
  save(record: DeviceAuthorizationRecord): Promise<void>;
  findByDeviceCode(deviceCode: string): Promise<DeviceAuthorizationRecord | null>;
  /** 正規化済みキー（{@link normalizeUserCode} の出力）で照合する。 */
  findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null>;
  /**
   * レコードを更新する。
   *
   * `lastPolledAt` / `interval` の read-modify-write が atomic でない実装では、
   * 並行ポーリング時にポーリング間隔の強制が甘くなり得る。ただし認可状態の遷移
   * （pending → approved / denied）と {@link DeviceAuthorizationStore.consume}
   * による単回使用が守られていればセキュリティ特性は保たれる。
   */
  update(record: DeviceAuthorizationRecord): Promise<void>;
  delete(deviceCode: string): Promise<void>;
  /**
   * 取得と同時に削除する（トークン発行時の単回使用強制）。
   *
   * 取得と削除は atomic でなければならない。atomic でない実装は同一 device_code の
   * 並行リデンプションを許してしまう（PAR store の consume と同じ要件）。
   *
   * 期限切れレコードの掃除: 期限切れは原則トークンエンドポイントのポーリング時に
   * `expired_token` 応答とともに削除されるが、ポーリングを止めたデバイスのレコードは
   * 残る。ストア実装は `expiresAt` から十分な猶予（目安: TTL と同程度）を置いた後に
   * 期限切れレコードを自主的に破棄してよい。破棄後のポーリングは `expired_token`
   * ではなく `invalid_grant` になるが、クライアントはどちらのエラーでもフローを
   * 終了するため相互運用上の問題はない。
   */
  consume(deviceCode: string): Promise<DeviceAuthorizationRecord | null>;
}
