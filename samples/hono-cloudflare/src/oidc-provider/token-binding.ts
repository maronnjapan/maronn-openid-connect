/**
 * Sender-constrained tokens: the key a token is bound to.
 *
 * A feature that binds tokens to a key of the client (dpop, RFC 9449) hands a
 * TokenBinding to the code that issues and stores the tokens. It puts the
 * confirmation (cnf, RFC 7800) into the access token and into the stored
 * records, and the token_type into the token response; the introspection
 * endpoint reports both from the stored access token record (RFC 9449 §6.2).
 * Without a binding the tokens are Bearer tokens, as they are in a provider
 * without such a feature.
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

/** What a binding adds to a stored token record. */
export interface TokenBindingRecord {
  cnf?: Readonly<Record<string, string>>;
  tokenType?: string;
}

/** The token_type of a token that is not bound to a key (RFC 6750 §4). */
export const BEARER_TOKEN_TYPE = 'Bearer';

/** The token_type of a token bound to a key with the jkt confirmation method of DPoP (RFC 9449 §6.1 / §6.2). */
export const DPOP_TOKEN_TYPE = 'DPoP';

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
 * 保存するアクセストークンのレコードに加える、束縛の確認（`cnf`）と `token_type` を返す。
 *
 * 不透明な文字列のトークンでも、イントロスペクションがこのレコードから `cnf` と `token_type` を返せるように（RFC 9449 §6.2）、また UserInfo エンドポイントのような保護されたリソースが `cnf` でトークンの提示の仕方と照らし合わせられるように、レコードに保存する。
 * 束縛していないトークンには、空のオブジェクトを返す。
 *
 * @spec RFC 9449 §6.2
 */
export function accessTokenRecordOf(binding: TokenBinding | undefined): TokenBindingRecord {
  return binding === undefined ? {} : { cnf: binding.cnf, tokenType: binding.tokenType };
}

/**
 * 保存するリフレッシュトークンのレコードに加える、束縛の確認（`cnf`）を返す。
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
 * レコード（保存したトークンなど）が持つ束縛の確認（`cnf`）を返す。
 *
 * `cnf` がないか、JSON のオブジェクトでなければ `undefined` を返す。
 * レコードはストアから読んだ値で、機能や独自のコードが書いたものもあるので、型を信じずに形を確かめる。
 *
 * @spec RFC 7800 §3.1
 * @spec RFC 9449 §6.2
 */
export function confirmationOf(record: unknown): Readonly<Record<string, string>> | undefined {
  if (typeof record !== 'object' || record === null) return undefined;
  const cnf = (record as { cnf?: unknown }).cnf;
  return typeof cnf === 'object' && cnf !== null && !Array.isArray(cnf) ? (cnf as Record<string, string>) : undefined;
}

/**
 * 有効なアクセストークンのイントロスペクションのレスポンスに、束縛の確認（`cnf`）と `token_type` を加えて返す。
 *
 * 保存したレコードに `cnf` があれば、`cnf` と、レコードの `tokenType`（DPoP で束縛したトークンは `DPoP`）を返す（RFC 9449 §6.2）。
 * レコードに `tokenType` がなくても、`cnf` が DPoP の確認のメソッド `jkt`（RFC 9449 §6.1）を持てば、`token_type` は `DPoP` にする。RFC 9449 §6.2 は、DPoP で束縛したトークンに `token_type` を返すなら `DPoP` でなければならないとしているためである。
 * 有効でないトークンのレスポンスと、`cnf` のないレコードのレスポンスは、そのまま返す。
 * core の `IntrospectionResponse` は `token_type` に `Bearer` と `refresh_token` しか認めないので、加えた値の型だけを広げて返す。
 *
 * @spec RFC 9449 §6.2
 * @spec RFC 7662 §2.2
 */
export function withTokenBinding(response: IntrospectionResponse, record: unknown): IntrospectionResponse {
  const cnf = confirmationOf(record);
  if (!response.active || cnf === undefined) return response;
  const storedTokenType = (record as TokenBindingRecord).tokenType;
  const derivedTokenType = typeof cnf.jkt === 'string' ? DPOP_TOKEN_TYPE : response.token_type;
  return { ...response, token_type: typeof storedTokenType === 'string' ? storedTokenType : derivedTokenType, cnf } as IntrospectionResponse;
}
