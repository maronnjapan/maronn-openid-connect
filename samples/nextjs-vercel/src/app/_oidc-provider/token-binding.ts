/**
 * Sender-constrained tokens: the key a token is bound to.
 *
 * A feature that binds tokens to a key of the client (dpop, RFC 9449) hands a
 * TokenBinding to the steps that issue and store the tokens. They put its
 * confirmation (cnf, RFC 7800) into the access token and into the stored
 * records, and its token_type into the token response; the introspection
 * endpoint reports both from the stored record (RFC 9449 §6.2). Without a
 * binding the tokens are Bearer tokens, as they are in a provider without such
 * a feature.
 *
 * An authorization request can be bound to a key too (dpop_jkt, RFC 9449
 * §10): the transaction keeps its cnf, and the code issued from it carries
 * the same cnf to the token endpoint.
 */
import type { IntrospectionResponse } from '@maronn-openid-connect/core';

/** The key an access token (and the refresh token issued with it) is bound to. */
export interface TokenBinding {
  /** The confirmation claim of the access token and of its stored record (RFC 7800 §3.1), e.g. { jkt } for DPoP (RFC 9449 §6.1). */
  readonly cnf: Readonly<Record<string, string>>;
  /** The token_type of the token response (RFC 6749 §7.1) and of the introspection response (RFC 7662 §2.2), e.g. 'DPoP'. */
  readonly tokenType: string;
  /** The confirmation of the refresh token issued with the access token, when the refresh token is bound too (a public client's, RFC 9449 §5). */
  readonly refreshTokenCnf?: Readonly<Record<string, string>>;
}

/** What a binding adds to a stored token or grant record. */
export interface TokenBindingRecord {
  cnf?: Readonly<Record<string, string>>;
  tokenType?: string;
}

/** The token_type of a token that is not bound to a key (RFC 6750 §4). */
export const BEARER_TOKEN_TYPE = 'Bearer';

/**
 * トークンレスポンスの `token_type` を返す。
 *
 * 鍵に束縛したトークンには束縛の `tokenType`（DPoP なら `DPoP`）を、束縛していないトークンには `Bearer` を返す。
 *
 * @spec RFC 6749 §5.1
 * @spec RFC 9449 §5
 */
export function tokenTypeOf(binding: TokenBinding | undefined): string {
  return binding?.tokenType ?? BEARER_TOKEN_TYPE;
}

/**
 * アクセストークンのペイロードに加える確認のクレーム（`cnf`）を返す。
 *
 * 束縛していないトークンには、何も加えない空のオブジェクトを返す。
 * 返した値は、署名する前のペイロードに展開する。
 *
 * @spec RFC 7800 §3.1
 * @spec RFC 9449 §6.1
 */
export function accessTokenClaimsOf(binding: TokenBinding | undefined): { cnf?: Readonly<Record<string, string>> } {
  return binding === undefined ? {} : { cnf: binding.cnf };
}

/**
 * 保存するアクセストークンのレコードに加える、束縛の確認と `token_type` を返す。
 *
 * イントロスペクションは、このレコードの `cnf` と `tokenType` を返す（RFC 9449 §6.2）。
 * UserInfo エンドポイントのような保護されたリソースは、`cnf` でトークンを提示の仕方と照らし合わせる。
 * 束縛していないトークンには、空のオブジェクトを返す。
 *
 * @spec RFC 9449 §6.2
 */
export function accessTokenRecordOf(binding: TokenBinding | undefined): TokenBindingRecord {
  return binding === undefined ? {} : { cnf: binding.cnf, tokenType: binding.tokenType };
}

/**
 * 保存するリフレッシュトークンのレコードに加える、束縛の確認を返す。
 *
 * リフレッシュトークンを束縛するのは、束縛が `refreshTokenCnf` を持つときだけである（パブリッククライアントのリフレッシュトークン。RFC 9449 §5）。
 * それ以外には、空のオブジェクトを返す。
 *
 * @spec RFC 9449 §5
 */
export function refreshTokenRecordOf(binding: TokenBinding | undefined): TokenBindingRecord {
  return binding?.refreshTokenCnf === undefined ? {} : { cnf: binding.refreshTokenCnf };
}

/**
 * レコード（トランザクション、認可コード、トークン）が持つ束縛の確認（`cnf`）を返す。
 *
 * `cnf` がないか、JSON のオブジェクトでなければ `undefined` を返す。
 * 認可リクエストを束縛した鍵（DPoP の `dpop_jkt`、RFC 9449 §10）を、トランザクションから認可コードへ引き継ぐのに使う。
 *
 * @spec RFC 7800 §3.1
 * @spec RFC 9449 §10
 */
export function confirmationOf(record: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const cnf = (record as { cnf?: unknown }).cnf;
  return typeof cnf === 'object' && cnf !== null && !Array.isArray(cnf) ? (cnf as Record<string, string>) : undefined;
}

/**
 * レコードの束縛の確認（`cnf`）を、別のレコードに展開できる形で返す。
 *
 * 認可トランザクションの `cnf`（DPoP の `dpop_jkt` の鍵。RFC 9449 §10）を、そこから発行する認可コードのレコードへ引き継ぐのに使う。
 * `cnf` のないレコードには、空のオブジェクトを返す。
 *
 * @spec RFC 9449 §10
 */
export function confirmationRecordOf(record: unknown): TokenBindingRecord {
  const cnf = confirmationOf(record);
  return cnf === undefined ? {} : { cnf };
}

/**
 * 有効なアクセストークンのイントロスペクションのレスポンスに、束縛の確認と `token_type` を加えて返す。
 *
 * 保存したレコードに `cnf` があれば、`cnf` とレコードの `tokenType` を返す（DPoP で束縛したトークンは `token_type` が `DPoP`。RFC 9449 §6.2）。
 * `cnf` のないトークンは、`response` をそのまま返す。
 * core の `IntrospectionResponse` は `token_type` に `Bearer` と `refresh_token` しか認めないので、加えた値の型だけを広げて返す。
 *
 * @spec RFC 9449 §6.2
 * @spec RFC 7662 §2.2
 */
export function withTokenBinding(response: IntrospectionResponse, record: unknown): IntrospectionResponse {
  const cnf = confirmationOf(record);
  if (!response.active || cnf === undefined) return response;
  const tokenType = (record as TokenBindingRecord).tokenType ?? response.token_type;
  return { ...response, token_type: tokenType, cnf } as IntrospectionResponse;
}
