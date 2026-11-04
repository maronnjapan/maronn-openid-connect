/**
 * Rich Authorization Requests (RAR) — RFC 9396
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * `authorization_details` パラメータの構造検証と、OP 運用者が注入する型定義
 * （type ごとの validator と同意表示文の生成関数）との突き合わせ。
 * ここにあるのは純関数だけで、HTTP やストアには触れない。
 */

/** RFC 9396 §3: 認可リクエストのパラメータ名。 */
export const AUTHORIZATION_DETAILS_PARAM = 'authorization_details';

/**
 * RFC 9396 §2 の authorization details オブジェクト。
 *
 * `type` だけが必須で（§2）、共通フィールド（§2.2）はすべて任意である。
 * 型固有フィールドはインデックスシグネチャで不透明に保持し、解釈は型定義へ委ねる。
 */
export interface AuthorizationDetail {
  readonly type: string;
  readonly locations?: readonly string[];
  readonly actions?: readonly string[];
  readonly datatypes?: readonly string[];
  readonly identifier?: string;
  readonly privileges?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * OP 運用者が type ごとに注入する定義。
 *
 * RFC 9396 §5 は「理解しない type を含むリクエストを拒否しなければならない」とし、
 * 「理解する」の中身を OP に委ねている。この定義を登録した type だけが受理される。
 */
export interface AuthorizationDetailTypeDefinition {
  /** この定義が受け持つ `type` の値。 */
  readonly type: string;
  /**
   * 型固有の検証。違反したら `RarError('invalid_authorization_details')` を投げる。
   * message は固定の ASCII 文言とし、入力値を含めないこと（RFC 9396 §13）。
   */
  validate(detail: AuthorizationDetail): void;
  /**
   * 同意画面に出す表示行。プレーン文字列だけを返し、HTML を組み立てない
   * （エスケープは view 層に委ねる）。金額や宛先など安全上重要なフィールドは
   * すべて文言に含める責任を持つ（RFC 9396 §3.1 / §13）。
   */
  describe(detail: AuthorizationDetail): readonly string[];
}

/** RFC 9396 §5 / §14.6 のエラーコード。authorization / token 両エンドポイントで使う。 */
export type RarErrorCode = 'invalid_authorization_details';

/**
 * `authorization_details` の検証失敗。
 *
 * message は呼び出し側が固定 ASCII 文言で渡す契約で、details の内容
 * （type 名を含む）を反映してはならない（RFC 9396 §13 の機微データ考慮）。
 */
export class RarError extends Error {
  readonly code: RarErrorCode = 'invalid_authorization_details';

  constructor(message: string) {
    super(message);
    this.name = 'RarError';
  }
}

/** `parseAuthorizationDetailsInput` の上限値。DoS 対策（RFC 9396 §11.4 参照）。 */
export interface AuthorizationDetailsLimits {
  /** パラメータの UTF-8 バイト長の上限（TextEncoder 基準）。 */
  readonly maxBytes: number;
  /** 配列の要素数の上限。 */
  readonly maxEntries: number;
}

/** 共通フィールド（RFC 9396 §2.2）のうち、文字列配列でなければならないもの。 */
const STRING_ARRAY_COMMON_FIELDS = ['locations', 'actions', 'datatypes', 'privileges'] as const;

/**
 * `authorization_details` の入力を検証して、パース済みの配列を返す。失敗は `RarError` で投げる。
 *
 * クエリ / PAR 経由の文字列と、Request Object 経由のパース済み JSON 値の両方を受ける。
 * - 文字列: 生文字列の UTF-8 バイト長を検査してから `JSON.parse` する。
 * - それ以外: `JSON.stringify` した文字列でバイト長を測り、配列であることを検査する
 *   （stringify できない値、文字列でも配列でもない値は拒否する）。
 *
 * 検査は、バイト長 → 配列であること → 空でなく要素数が上限以下 → 各要素が
 * プレーンなオブジェクト → `type` が非空文字列（§2 REQUIRED）→ 共通フィールドの型
 * （§2.2）の順に行う。型定義との突き合わせ（§5）は `validateAuthorizationDetails()` が行う。
 *
 * @spec RFC 9396 §2
 * @spec RFC 9396 §2.2
 * @spec RFC 9396 §3
 * @throws {RarError} 入力がどれかの検査に違反したとき。message は固定 ASCII 文言で、入力値を含まない。
 */
export function parseAuthorizationDetailsInput(
  input: unknown,
  limits: AuthorizationDetailsLimits,
): AuthorizationDetail[] {
  const parsed = typeof input === 'string'
    ? parseFromString(input, limits)
    : measureParsedInput(input, limits);
  if (!Array.isArray(parsed)) {
    throw new RarError('authorization_details must be a JSON array');
  }
  if (parsed.length === 0) {
    throw new RarError('authorization_details must not be empty');
  }
  if (parsed.length > limits.maxEntries) {
    throw new RarError('authorization_details has too many entries');
  }
  for (const entry of parsed) {
    assertAuthorizationDetailShape(entry);
  }
  return parsed as AuthorizationDetail[];
}

/**
 * 文字列の入力をバイト長検査のうえ JSON としてパースして返す。失敗は `RarError` で投げる。
 *
 * バイト長は生文字列の UTF-8 表現（TextEncoder 基準）で測る。
 *
 * @spec RFC 9396 §3
 * @throws {RarError} バイト長が上限を超えるか、JSON としてパースできないとき。
 */
function parseFromString(input: string, limits: AuthorizationDetailsLimits): unknown {
  if (new TextEncoder().encode(input).length > limits.maxBytes) {
    throw new RarError('authorization_details is too large');
  }
  try {
    return JSON.parse(input);
  } catch {
    throw new RarError('authorization_details must be valid JSON');
  }
}

/**
 * パース済みの入力（Request Object 経由）のバイト長を JSON 表現で測り、そのまま返す。失敗は `RarError` で投げる。
 *
 * `JSON.stringify` できない値（undefined、関数、循環参照を含む値）は拒否する。
 *
 * @spec RFC 9396 §3
 * @throws {RarError} JSON にできない値か、バイト長が上限を超えるとき。
 */
function measureParsedInput(input: unknown, limits: AuthorizationDetailsLimits): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new RarError('authorization_details must be a JSON value');
  }
  if (typeof serialized !== 'string') {
    throw new RarError('authorization_details must be a JSON value');
  }
  if (new TextEncoder().encode(serialized).length > limits.maxBytes) {
    throw new RarError('authorization_details is too large');
  }
  return input;
}

/**
 * 配列の 1 要素が authorization details オブジェクトの形であることを確かめる。違反は `RarError` で投げる。
 *
 * プレーンなオブジェクトであること、`type` が非空文字列であること（§2 REQUIRED）、
 * 共通フィールドが存在するなら §2.2 の型（`locations` / `actions` / `datatypes` /
 * `privileges` は文字列配列、`identifier` は文字列）であることを検査する。
 * 同じ `type` の要素が複数あってもよい（§2 MAY）。
 *
 * @spec RFC 9396 §2
 * @spec RFC 9396 §2.2
 * @throws {RarError} 要素がオブジェクトでない、`type` が欠落・空・非文字列、共通フィールドの型が違うとき。
 */
function assertAuthorizationDetailShape(entry: unknown): asserts entry is AuthorizationDetail {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new RarError('authorization_details entries must be JSON objects');
  }
  const detail = entry as Record<string, unknown>;
  if (typeof detail['type'] !== 'string' || detail['type'].length === 0) {
    throw new RarError('authorization_details entries must have a non-empty type');
  }
  for (const field of STRING_ARRAY_COMMON_FIELDS) {
    const value = detail[field];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new RarError('authorization_details common fields must have the RFC 9396 types');
    }
  }
  if (detail['identifier'] !== undefined && typeof detail['identifier'] !== 'string') {
    throw new RarError('authorization_details common fields must have the RFC 9396 types');
  }
}

/**
 * すべての要素を登録済みの型定義と突き合わせ、未知の type と型固有の違反を `RarError` で拒否する。
 *
 * 型定義が一つも無ければ、どの要素も未知 type として拒否される（fail-closed。§5 の
 * MUST refuse）。型定義の `validate` が投げた `RarError` はそのまま伝え、それ以外の
 * 例外は握りつぶさずそのまま伝える（呼び出し側が `server_error` として扱う）。
 *
 * @spec RFC 9396 §5
 * @throws {RarError} 要素の `type` に対応する型定義が無いか、型定義の `validate` が違反を見つけたとき。
 */
export function validateAuthorizationDetails(
  details: readonly AuthorizationDetail[],
  types: readonly AuthorizationDetailTypeDefinition[],
): void {
  for (const detail of details) {
    const definition = types.find((candidate) => candidate.type === detail.type);
    if (definition === undefined) {
      throw new RarError('authorization_details contains an unsupported type');
    }
    definition.validate(detail);
  }
}

/**
 * 同意画面向けの表示行を、要素の順に型定義の `describe` で組み立てて返す。
 *
 * 対応する型定義が無い要素があれば `RarError` を投げる（表示できない要素を黙って
 * 落とすと、エンドユーザーが見ていない権限が承認されてしまうため）。
 * 返す値はプレーン文字列の配列で、エスケープは呼び出し側の view 層に委ねる。
 *
 * @spec RFC 9396 §3.1
 * @throws {RarError} 要素の `type` に対応する型定義が無いとき。
 */
export function describeAuthorizationDetails(
  details: readonly AuthorizationDetail[],
  types: readonly AuthorizationDetailTypeDefinition[],
): readonly string[] {
  const lines: string[] = [];
  for (const detail of details) {
    const definition = types.find((candidate) => candidate.type === detail.type);
    if (definition === undefined) {
      throw new RarError('authorization_details contains an unsupported type');
    }
    lines.push(...definition.describe(detail));
  }
  return lines;
}
