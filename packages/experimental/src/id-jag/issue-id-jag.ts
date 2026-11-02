/**
 * Identity Assertion Authorization Grant (ID-JAG) の発行 — IdP 側
 * draft-ietf-oauth-identity-assertion-authz-grant-04 §3 / §4.3
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 既存トークンエンドポイントの Token Exchange grant（RFC 8693）のうち、
 * `requested_token_type=urn:ietf:params:oauth:token-type:id-jag` の要求を処理する。
 * subject_token として自 OP 発行の ID トークン（設定により refresh token も。
 * draft §4.3 の MAY）を受け取り、検証のうえで別トラストドメインのリソース AS
 * 宛ての署名付き authorization grant JWT（ID-JAG）を発行する。
 * actor_token の受理を有効化すると、発行する ID-JAG に `act` claim
 * （RFC 8693 §4.1 / draft §3.1 OPTIONAL）を記録できる。actor_token の種別は
 * RFC 8693 §3 が定義する token type identifier を一律に受け、内容検証はすべて
 * デプロイ側リゾルバ（{@link IdJagActorTokenResolver}）が担う。
 *
 * 「合成関数＋ステップ関数」の二層構成とし、CLI 生成コードは
 * ステップ関数を順に呼び出して検証を差し替え・削除できるようにする。
 * 既存の token-exchange 機能とは grant_type URN を共有するが、コードは共有
 * しない（experimental 機能同士の独立性優先。重複を許容する方針）。
 *
 * ID-JAG の署名は JARM の応答 JWT と同じく Web Crypto API による自前の
 * compact JWS 組み立てで行い、core の非公開な低レベル署名ヘルパーには
 * 依存しない（core 無変更の維持）。
 */
import {
  IdTokenHintError,
  TokenError,
  generateRandomString,
  isPublicTokenClient,
  resolveRefreshToken,
  validateIdTokenHint,
  validateRefreshTokenClient,
  validateRefreshTokenExpiration,
  validateRefreshTokenSession,
  validateRefreshTokenUnused,
  type AuthenticationSessionResolver,
  type JwkSet,
  type RefreshTokenInfo,
  type RefreshTokenResolver,
  type SigningKey,
  type TokenClientInfo,
  type TokenRequestParams,
} from '@maronn-openid-connect/core';
import {
  ACTOR_TOKEN_INVALID_DESCRIPTION,
  IdJagError,
  SUBJECT_TOKEN_INVALID_DESCRIPTION,
} from './errors.js';

/** RFC 8693 §2.1: token exchange の grant type 識別子（発行側のディスパッチ条件）。 */
export const TOKEN_EXCHANGE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';

/** ID-JAG draft §4.3: 要求する token type 識別子。 */
export const ID_JAG_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:id-jag';

/** RFC 8693 §3: OIDC ID トークンの token type 識別子。subject と actor の既定種別。 */
export const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';

/**
 * RFC 8693 §3: refresh token の token type 識別子。
 *
 * ID-JAG draft §4.3 は「実装は Identity Assertion を MUST で受け、refresh token を
 * MAY で追加受理してよい」と定める。受理すると、ID トークンの期限が切れても
 * SSO をやり直さずに新しい ID-JAG を要求できる（draft §4.3.2 / §4.4.3）。
 * 本機能では {@link IdJagIssuanceContext.refreshTokenResolver} を注入した
 * ときだけこの種別を受ける。
 */
export const TOKEN_TYPE_REFRESH_TOKEN = 'urn:ietf:params:oauth:token-type:refresh_token';

/** RFC 8693 §3: access token の token type 識別子。 */
export const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

/** RFC 7519 §9 / RFC 8693 §3: 汎用 JWT の token type 識別子。 */
export const TOKEN_TYPE_JWT = 'urn:ietf:params:oauth:token-type:jwt';

/** RFC 8693 §3: SAML 1.1 assertion の token type 識別子。 */
export const TOKEN_TYPE_SAML1 = 'urn:ietf:params:oauth:token-type:saml1';

/** RFC 8693 §3: SAML 2.0 assertion の token type 識別子。 */
export const TOKEN_TYPE_SAML2 = 'urn:ietf:params:oauth:token-type:saml2';

/**
 * actor_token として受理する token type identifier（RFC 8693 §3 / RFC 7519 §9）。
 *
 * RFC 8693 は actor_token_type に「トークンの種別を示す識別子」を求めるだけで、
 * 種別ごとの処理規則を定めない。本機能もこの一覧を種別で区別せず一律に受け、
 * どの種別も同じ経路（{@link IdJagIssuanceContext.actorTokenResolver}）で
 * 内容を検証する。一覧に無い識別子は invalid_request で拒否する。
 */
export const ACTOR_TOKEN_TYPES_SUPPORTED = [
  TOKEN_TYPE_ACCESS_TOKEN,
  TOKEN_TYPE_REFRESH_TOKEN,
  TOKEN_TYPE_ID_TOKEN,
  TOKEN_TYPE_JWT,
  TOKEN_TYPE_SAML1,
  TOKEN_TYPE_SAML2,
] as const;

/**
 * ID-JAG draft §3.1: JOSE ヘッダーの `typ` 値。
 * RFC 8725 §3.11 の explicit typing により、ID トークンなど他種の JWT との
 * 取り違え（token confusion）を受領側が構造的に拒否できる。
 */
export const ID_JAG_JWT_TYP = 'oauth-id-jag+jwt';

/**
 * ID-JAG draft §7.2 / §8: authorization grant profile の識別子。
 * discovery の `authorization_grant_profiles_supported` に載せる値。
 */
export const ID_JAG_GRANT_PROFILE = 'urn:ietf:params:oauth:grant-profile:id-jag';

/**
 * ID-JAG の署名アルゴリズム。
 *
 * draft は alg を規定しないため、本 OP の必須アルゴリズムである RS256 に固定する
 * （JARM の応答 JWT と同じ設計）。{@link createIdJagJwt} に渡す `signingKey` は
 * RS256 鍵でなければならない。生成コードは登録鍵セットから
 * `selectSigningKeyByAlg(keys, 'RS256')` で選ぶこと。
 */
const ID_JAG_SIGNING_ALG = 'RS256';

/** RS256 に対応する Web Crypto のアルゴリズム名。 */
const WEB_CRYPTO_ALGORITHM = 'RSASSA-PKCS1-v1_5';

/**
 * RFC 8693 §4.1 の `act` claim 値。
 *
 * 発行側の値は {@link IdJagActorTokenResolver} が返したもの。ネストした `act` は、
 * リゾルバが委譲チェーンを返したときの発行と、他の IdP が発行した ID-JAG を
 * 受領側で扱うときに現れる。
 */
export interface IdJagActor {
  sub: string;
  act?: IdJagActor;
}

/** {@link IdJagActorTokenResolver} に渡される入力。 */
export interface IdJagActorTokenResolverInput {
  /** リクエストの actor_token。構造検証（非空・対応規則）のみ済みで内容は未検証 */
  actorToken: string;
  /** リクエストの actor_token_type（{@link ACTOR_TOKEN_TYPES_SUPPORTED} のいずれか） */
  actorTokenType: string;
  /** 認証済みクライアントの client_id（actor_token の帰属確認に使える） */
  clientId: string;
  /** 自 OP の issuer。自 OP 発行トークンを検証するリゾルバが期待 iss に使える */
  issuer: string;
  /** 自 OP の JWKS。自 OP 発行 JWT を検証するリゾルバが署名検証に使える */
  jwks: JwkSet;
}

/**
 * actor_token の内容検証を担うデプロイ側フック。
 *
 * ライブラリはリクエスト構造（{@link IdJagIssuanceContext.allowActorTokens} の gate、
 * RFC 8693 §2.1 の対応規則、非空、{@link ACTOR_TOKEN_TYPES_SUPPORTED} への所属）と
 * 戻り値の構造だけを検証し、トークン内容の検証（署名・失効・帰属）はこのリゾルバの
 * 責務とする。受理したすべての種別が同じようにここへ来る（種別による分岐は
 * ライブラリ側に無い）。ID トークンの actor を検証する実装は
 * {@link resolveIdJagActor} をそのまま使える。
 *
 * 戻り値の契約:
 * - `IdJagActor`（`{ sub, act? }` のチェーン）— 検証済み actor。構造検証と
 *   正規化（`sub` / `act` 以外の属性の除去）を通ってから act claim になる
 * - `null` — 無効な actor_token。固定文言の invalid_request になる
 * - `IdJagError` を投げる — そのままエラー応答になる（エラー内容の細分化は
 *   オラクルになり得るため、固定文言方針の維持を推奨）
 * - その他の例外 — リゾルバの実装バグ・依存障害として伝播し、生成コードの
 *   共通 catch が server_error（500）にする
 */
export type IdJagActorTokenResolver = (
  input: IdJagActorTokenResolverInput,
) => Promise<IdJagActor | null> | IdJagActor | null;

/** 検証済みの ID-JAG 発行リクエストパラメータ（draft §4.3）。 */
export interface ParsedIdJagIssuanceParams {
  subjectToken: string;
  /** subject_token の種別。受理した URN がそのまま入る */
  subjectTokenType: typeof TOKEN_TYPE_ID_TOKEN | typeof TOKEN_TYPE_REFRESH_TOKEN;
  /** リソース AS の issuer identifier（RFC 8414 §2）。draft §4.3 で REQUIRED */
  audience: string;
  /** 空白区切りの要求 scope。省略時は undefined（scope クレームを発行しない） */
  scope?: string;
  /** RFC 8707 §2 のリソース識別子。省略時は undefined */
  resource?: string;
  /** actor のトークン。actor 受理が有効なときだけ設定され得る */
  actorToken?: string;
  /**
   * actor_token の種別。`actorToken` と常に対で設定される（RFC 8693 §2.1 の
   * 対応規則を parse が強制する）。値は {@link ACTOR_TOKEN_TYPES_SUPPORTED} のいずれか
   */
  actorTokenType?: string;
}

/** {@link parseIdJagIssuanceParams} の受理ポリシー。既定はどちらも無効（安全側）。 */
export interface IdJagIssuanceParseOptions {
  /**
   * refresh token の subject_token（draft §4.3 の MAY）を受けるか。
   * 生成コードは `idJagConfig.allowRefreshTokenSubjects` と resolver の有無から渡す。
   */
  allowRefreshTokenSubjects?: boolean;
  /**
   * actor_token を受けるか。draft §4.3 は actor_token の処理規則を定義しない
   * （§9.7: 将来の拡張）ため、本機能の actor 対応は draft の範囲外の拡張であり、
   * 明示的に有効化したときだけ受ける。無効時の存在は invalid_request。
   */
  allowActorTokens?: boolean;
}

/** subject_token（ID トークン）の検証で得た発行素材。 */
export interface IdJagSubject {
  /** ID トークンの sub。ID-JAG の sub にそのまま引き継ぐ（draft §3.1） */
  sub: string;
  /** ID トークンの auth_time（存在する場合のみ。draft §3.1 OPTIONAL） */
  authTime?: number;
  /** ID トークンの acr（存在する場合のみ） */
  acr?: string;
  /** ID トークンの amr（存在する場合のみ） */
  amr?: string[];
}

/** ID-JAG のクレームセット（draft §3.1）。 */
export interface IdJagClaims {
  iss: string;
  sub: string;
  aud: string;
  client_id: string;
  jti: string;
  exp: number;
  iat: number;
  scope?: string;
  resource?: string;
  auth_time?: number;
  acr?: string;
  amr?: string[];
  /** RFC 8693 §4.1 / draft §3.1 OPTIONAL: subject の代理として振る舞う actor */
  act?: IdJagActor;
}

/** RFC 8693 §2.2.1 / draft §4.3.4 の成功レスポンスボディ。 */
export interface IdJagIssuanceResponse {
  /** ID-JAG 本体。アクセストークンではないが §2.2.1 の歴史的経緯でこの名前になる */
  access_token: string;
  issued_token_type: typeof ID_JAG_TOKEN_TYPE;
  /** 発行物がアクセストークンではないため常に N_A（draft §4.3.4 REQUIRED） */
  token_type: 'N_A';
  expires_in: number;
  scope: string;
}

/** ID-JAG 発行処理のコンテキスト。 */
export interface IdJagIssuanceContext {
  /** フォームボディのパラメータ（application/x-www-form-urlencoded） */
  params: Record<string, string>;
  /** 認証済みクライアント（分岐前の共有認証パイプラインが解決したもの） */
  client: TokenClientInfo;
  /** 自 OP（IdP）の issuer。ID-JAG の iss になり、subject_token の期待 iss にもなる */
  issuer: string;
  /** subject_token（ID トークン）の署名検証に使う自 OP の JWKS */
  jwks: JwkSet;
  /** ID-JAG の署名鍵。RS256 鍵であること */
  signingKey: SigningKey;
  /** ID-JAG を発行してよいリソース AS issuer の許可リスト。既定は空（安全側） */
  allowedAudiences: string[];
  /** 許可する scope の上限リスト。undefined は素通し（リソース AS 側ポリシーに委ねる） */
  allowedScopes?: string[];
  /** ID-JAG の有効期間（秒） */
  lifetimeSeconds: number;
  /**
   * refresh token の subject_token（draft §4.3 MAY）を受けるときに注入する。
   * 未注入なら subject_token_type=refresh_token は invalid_request で拒否される。
   * 検証は通常の refresh_token grant と同じ core のステップ関数で行う（draft §4.3.3）。
   */
  refreshTokenResolver?: RefreshTokenResolver;
  /**
   * online refresh token（ログインセッション束縛）の生存確認に使う。
   * `refreshTokenResolver` を注入するときは、通常の refresh grant と同じ resolver を
   * 渡すこと。未注入のまま online RT が提示されると fail-closed で拒否される。
   */
  authenticationSessionResolver?: AuthenticationSessionResolver;
  /**
   * actor_token を受けて `act` claim を発行するか。既定 false（安全側）。
   * draft §4.3 に actor の処理規則は無く、§9.7 の指針に沿った本機能独自の拡張なので、
   * 明示的な有効化を要求する。false の間は `actorTokenResolver` を注入していても
   * actor_token を受けない（単一の親スイッチ）。
   */
  allowActorTokens?: boolean;
  /**
   * actor_token の内容検証を担うデプロイ側フック。受理したすべての種別が
   * このフックを通る。未注入なら actor_token は固定文言で拒否される。
   * ID トークンを検証する実装は {@link resolveIdJagActor} を使える。
   */
  actorTokenResolver?: IdJagActorTokenResolver;
  /** 現在時刻。テストと決定的な期限計算のために注入できる */
  now?: Date;
}

/**
 * リクエストが ID-JAG の発行を求めるなら true を返す。
 *
 * `grant_type` がトークン交換の URN（`urn:ietf:params:oauth:grant-type:token-exchange`）で、`requested_token_type` が ID-JAG の種類（`urn:ietf:params:oauth:token-type:id-jag`）のときだけ true を返す。
 * `requested_token_type` は、前後の空白を除いてから比べる。
 *
 * 生成されたコードは、リクエストをどちらの処理に回すかを決めるために、既存のトークン交換の分岐より前にこの関数を呼ぶ。
 * そうすることで、両方の機能を同時に有効にしても、リクエストが正しい側で処理される。
 *
 * @spec ID-JAG draft §4.3
 */
export function matchesIdJagIssuanceRequest(params: Record<string, string>): boolean {
  return (
    params['grant_type'] === TOKEN_EXCHANGE_GRANT_TYPE &&
    optional(params['requested_token_type']) === ID_JAG_TOKEN_TYPE
  );
}

/**
 * クライアントが ID-JAG を要求できなければ例外を投げる。
 *
 * クライアントの `grantTypes` にトークン交換のグラントタイプ（`urn:ietf:params:oauth:grant-type:token-exchange`）がないとき、またはパブリッククライアントのときに、`unauthorized_client` の {@link IdJagError} を投げる。
 *
 * ID-JAG draft §9.1 は、この仕様をコンフィデンシャルクライアントに限ることを推奨（SHOULD）しており、この機能はそれをパブリッククライアントの拒否まで強めている（トークン交換の機能と同じ設計上の判断）。
 * ID-JAG はユーザーの同意なしに発行されるので、発行を要求できる相手を縛るものはクライアント認証しかないためである。
 *
 * @throws {IdJagError} `unauthorized_client`: トークン交換のグラントタイプが登録されていないとき、またはパブリッククライアントのとき
 * @spec ID-JAG draft §9.1
 */
export function authorizeIdJagIssuanceClient(client: TokenClientInfo): void {
  // `grantTypes` が登録されていなければ、`['authorization_code']` として扱う（OpenID Connect Dynamic Client Registration 1.0 §2、RFC 7591 §2）。
  // そのため、ID-JAG を要求できるのは、トークン交換の URN を明示的に登録したクライアントだけである。
  const grantTypes = client.grantTypes ?? ['authorization_code'];
  if (!grantTypes.includes(TOKEN_EXCHANGE_GRANT_TYPE)) {
    throw new IdJagError(
      'unauthorized_client',
      'The client is not authorized to use the token-exchange grant type',
    );
  }
  if (isPublicTokenClient(client)) {
    throw new IdJagError(
      'unauthorized_client',
      'Public clients are not allowed to request an ID-JAG',
    );
  }
}

/**
 * パラメータを検証し、ID-JAG の発行に必要な値を返す。
 *
 * 次のどれかに当てはまるときは、`invalid_request` の {@link IdJagError} を投げる。
 * - `subject_token`、`subject_token_type`、`audience` のどれかがない。
 * - `subject_token_type` が、受け付ける種類（ID トークン。`allowRefreshTokenSubjects` が true ならリフレッシュトークンも）でない。
 * - `resource` が、フラグメントのない絶対 URI でない。
 * - `allowActorTokens` が true でないのに、`actor_token` か `actor_token_type` がある。
 * - `allowActorTokens` が true で、`actor_token` と `actor_token_type` の片方だけがある、または `actor_token_type` が {@link ACTOR_TOKEN_TYPES_SUPPORTED} にない。
 * - `authorization_details` がある。
 *
 * パラメータの値は前後の空白を取り除いて使い、空文字列や空白だけの値は、送られなかったものとして扱う（トークン交換の機能と同じ規則）。
 * 受け付けるサブジェクトの種類とアクターの可否は {@link IdJagIssuanceParseOptions} で決まり、既定ではどちらも無効である（ID トークンのサブジェクトだけを受け付ける）。
 *
 * @throws {IdJagError} `invalid_request`: 上のどれかに当てはまるとき
 * @spec ID-JAG draft §4.3
 */
export function parseIdJagIssuanceParams(
  params: Record<string, string>,
  options: IdJagIssuanceParseOptions = {},
): ParsedIdJagIssuanceParams {
  const subjectToken = optional(params['subject_token']);
  if (subjectToken === undefined) {
    throw new IdJagError('invalid_request', 'subject_token is required');
  }

  const subjectTokenType = optional(params['subject_token_type']);
  if (subjectTokenType === undefined) {
    throw new IdJagError('invalid_request', 'subject_token_type is required');
  }
  // 受け付けるサブジェクトの種類を決める。
  // ID-JAG draft §4.3 では、アイデンティティアサーション（この機能では ID トークン）の受け付けは必須（MUST）で、リフレッシュトークンは任意（MAY）である。
  // `saml2` は、この OP が SAML を発行しないので受け付けない（この機能の対象外）。
  const supportedSubjectTypes: string[] = [
    TOKEN_TYPE_ID_TOKEN,
    ...(options.allowRefreshTokenSubjects === true ? [TOKEN_TYPE_REFRESH_TOKEN] : []),
  ];
  if (!supportedSubjectTypes.includes(subjectTokenType)) {
    throw new IdJagError(
      'invalid_request',
      `Unsupported subject_token_type for ID-JAG issuance. Only ${supportedSubjectTypes.join(' or ')} is supported.`,
    );
  }

  // `audience` がなければ `invalid_request` を投げる（ID-JAG draft §4.3 で必須）。
  // RFC 8693 では任意（OPTIONAL）だが、このプロファイルが必須に強めており、値は ID-JAG の `aud` クレームになる。
  const audience = optional(params['audience']);
  if (audience === undefined) {
    throw new IdJagError('invalid_request', 'audience is required');
  }

  const resource = optional(params['resource']);
  if (resource !== undefined && !isAbsoluteUriWithoutFragment(resource)) {
    // `resource` がフラグメントのない絶対 URI でなければ、`invalid_request` を投げる（RFC 8707 §2。クエリは含んでもよい）。
    throw new IdJagError(
      'invalid_request',
      'resource must be an absolute URI without a fragment component',
    );
  }

  const actorToken = optional(params['actor_token']);
  const actorTokenType = optional(params['actor_token_type']);
  if (options.allowActorTokens !== true) {
    // アクターを受け付けない設定では、`actor_token` と `actor_token_type` を拒否する。
    // ID-JAG draft §4.3 は `actor_token` を送れることだけを定め、処理の規則を定めていない（§9.7 で将来の拡張としている）。
    // 規則を有効にしていない設定で受け取ると、委譲の権限を実際より大きく示すおそれがあるので、明示的に拒否して安全側に倒す。
    if (actorToken !== undefined || actorTokenType !== undefined) {
      throw new IdJagError(
        'invalid_request',
        'actor_token is not supported for ID-JAG issuance',
      );
    }
  } else {
    // `actor_token_type` は、`actor_token` があるときは必須（REQUIRED）で、ないときは含めてはならない（MUST NOT、RFC 8693 §2.1）。
    if (actorToken !== undefined && actorTokenType === undefined) {
      throw new IdJagError(
        'invalid_request',
        'actor_token_type is required when actor_token is present',
      );
    }
    if (actorToken === undefined && actorTokenType !== undefined) {
      throw new IdJagError(
        'invalid_request',
        'actor_token_type must not be present without actor_token',
      );
    }
    // RFC 8693 §3 が定めるトークンの種類の識別子を、種類で区別せずに受け付ける。
    // ここで検証するのはリクエストの形までで、トークンの内容はリゾルバが検証する。
    if (
      actorTokenType !== undefined &&
      !(ACTOR_TOKEN_TYPES_SUPPORTED as readonly string[]).includes(actorTokenType)
    ) {
      throw new IdJagError(
        'invalid_request',
        `Unsupported actor_token_type for ID-JAG issuance. Supported values are ${ACTOR_TOKEN_TYPES_SUPPORTED.join(', ')}.`,
      );
    }
  }

  // `authorization_details`（RFC 9396）には対応していないので、明示的に拒否する（この機能の対象外）。
  // 無視して発行すると、要求より狭い権限の ID-JAG が、要求どおりに発行されたと誤解されるおそれがある。
  if (optional(params['authorization_details']) !== undefined) {
    throw new IdJagError(
      'invalid_request',
      'authorization_details is not supported for ID-JAG issuance',
    );
  }

  return {
    subjectToken,
    subjectTokenType: subjectTokenType as ParsedIdJagIssuanceParams['subjectTokenType'],
    audience,
    scope: optional(params['scope']),
    resource,
    // 組み合わせは検証済みなので、`actorToken` があれば `actorTokenType` も必ずある。
    ...(actorToken === undefined
      ? {}
      : { actorToken, actorTokenType: actorTokenType as string }),
  };
}

/**
 * ID トークンを検証し、サブジェクト情報を返す。
 *
 * `subject_token` の ID トークンの検証は、core の `validateIdTokenHint()` に任せる。
 * 署名（事前に登録した JWKS の鍵だけを使い、`kid` か `alg` で鍵を選ぶ）、`iss`、`aud`、`exp` と `iat`（許容する時刻のずれは 60 秒）を検証し、`alg: none` と、外部から鍵を取得するヘッダー（`jku`、`jwk`、`x5u`、`x5c`）を拒否する。
 *
 * `aud` には、認証したクライアントの `client_id` を期待する。
 * ID-JAG draft §4.3.3 は、IdP がアサーションを検証し、その `aud` がクライアント認証の `client_id` と一致することを確かめるよう求めている（MUST）。
 * ほかのクライアント宛てに発行された ID トークンを持ち込めないようにするためである。
 *
 * 返すのは `sub` と、ID トークンにあるときだけ `auth_time`、`acr`、`amr` の値である。
 *
 * 失敗の理由は、レスポンスから区別できない（説明は {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} で固定）。
 * core が `IdTokenHintError` 以外の例外を投げたときは、そのまま投げる。
 *
 * @throws {IdJagError} `invalid_request`: ID トークンの検証に失敗したとき（説明は固定）
 * @spec ID-JAG draft §4.3.3
 */
export async function resolveIdJagSubject(options: {
  subjectToken: string;
  issuer: string;
  clientId: string;
  jwks: JwkSet;
}): Promise<IdJagSubject> {
  let payload: { sub: string; [key: string]: unknown };
  try {
    payload = await validateIdTokenHint(options.subjectToken, {
      expectedIss: options.issuer,
      expectedAud: options.clientId,
      jwks: options.jwks,
    });
  } catch (error) {
    if (error instanceof IdTokenHintError) {
      throw new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION);
    }
    throw error;
  }

  // `auth_time`、`acr`、`amr` は、ID トークンにあるときだけ ID-JAG に引き継ぐ（ID-JAG draft §3.1 の OPTIONAL）。
  // リソース側の認可サーバーが、認証の状況を評価するときに使う。
  const authTime = typeof payload['auth_time'] === 'number' ? payload['auth_time'] : undefined;
  const acr = typeof payload['acr'] === 'string' ? payload['acr'] : undefined;
  const amr =
    Array.isArray(payload['amr']) && payload['amr'].every((v) => typeof v === 'string')
      ? (payload['amr'] as string[])
      : undefined;

  return {
    sub: payload.sub,
    ...(authTime === undefined ? {} : { authTime }),
    ...(acr === undefined ? {} : { acr }),
    ...(amr === undefined ? {} : { amr }),
  };
}

/**
 * リフレッシュトークンを検証し、サブジェクト情報を返す。
 *
 * `subject_token` がリフレッシュトークンのときに使う（ID-JAG draft §4.3.2）。
 * ID-JAG draft §4.3.3 は、このとき IdP が通常の `refresh_token` グラントと同じ方法で検証するよう求めている（MUST）。
 * この関数は core の `refresh_token` グラントの関数を使って、ストアにあること（この OP が発行し、失効していないこと）、ローテーション済みでないこと、認証したクライアントに発行されたこと、期限切れでないこと、オンラインのリフレッシュトークンならログインのセッションが続いていることを確かめる。
 *
 * ローテーション済みのトークンを再び提示されたときは、`refresh_token` グラントと同じく、リゾルバが `revokeTokensByGrantId()` を持っていれば同じグラントのトークンをまとめて失効させてから拒否する。
 *
 * リフレッシュトークン自体は消費しない（ローテーションしない）。
 * この交換は `refresh_token` グラントではなく、クライアントは同じリフレッシュトークンで ID-JAG を繰り返し要求できる（ID-JAG draft §4.4.3 が想定する使い方）。
 *
 * サブジェクトの情報は、リフレッシュトークンに保存された値（`subject`、`authTime`、`acr`、`amr`）から組み立てる。
 * これは、新しいアイデンティティアサーションを発行するときと同じようにサブジェクトのクレームを取得するという ID-JAG draft §4.3.3 の推奨（SHOULD）に当たり、ID トークンのときと同じ情報が得られる。
 * ただし、`openid` スコープを持たないグラントのリフレッシュトークンは拒否する。
 * ID トークン（アイデンティティアサーション）を発行しえないグラントのトークンは、ID トークンの代わりにならないためである。
 *
 * 失敗の理由は、レスポンスから区別できない（説明は {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} で固定）。
 * core が `TokenError` 以外の例外を投げたときは、そのまま投げる。
 *
 * @throws {IdJagError} `invalid_request`: リフレッシュトークンの検証に失敗したとき、またはグラントが `openid` スコープを持たないとき（説明は固定）
 * @spec ID-JAG draft §4.3.3
 * @spec ID-JAG draft §4.4.3
 */
export async function resolveIdJagSubjectFromRefreshToken(options: {
  refreshToken: string;
  clientId: string;
  refreshTokenResolver: RefreshTokenResolver;
  authenticationSessionResolver?: AuthenticationSessionResolver;
  now?: Date;
}): Promise<IdJagSubject> {
  let info: RefreshTokenInfo;
  try {
    const resolved = await resolveRefreshToken(
      {
        grant_type: 'refresh_token',
        refresh_token: options.refreshToken,
      } as TokenRequestParams,
      options.refreshTokenResolver,
    );
    info = resolved.refreshTokenInfo;

    // ローテーション済みのトークンが再び提示されたら、盗まれた兆候とみなし、同じグラントのトークンを失効させてから拒否する（OAuth 2.1 §4.3.1）。
    // `refresh_token` グラントと同じ処理である。
    await validateRefreshTokenUnused(info, options.refreshTokenResolver);
    validateRefreshTokenClient(info, options.clientId);
    validateRefreshTokenExpiration(
      info,
      Math.floor((options.now ?? new Date()).getTime() / 1000),
    );
    // オンラインのリフレッシュトークンは、ログインのセッションが続いている間だけ有効である（`refresh_token` グラントと同じ判定）。
    // セッションのリゾルバが渡されていないのにオンラインのトークンが提示されたら、確かめられないので拒否する。
    await validateRefreshTokenSession(info, options.authenticationSessionResolver);
  } catch (error) {
    if (error instanceof TokenError) {
      throw invalidSubjectToken();
    }
    throw error;
  }

  if (!info.scope.includes('openid')) {
    throw invalidSubjectToken();
  }

  return {
    sub: info.subject,
    authTime: info.authTime,
    ...(info.acr === undefined ? {} : { acr: info.acr }),
    ...(info.amr === undefined ? {} : { amr: info.amr }),
  };
}

/**
 * ID トークンのアクターを検証し、`act` の値を返す。
 *
 * {@link IdJagActorTokenResolver} の実装の一つで、特別な経路ではない。
 * 生成されたコードは既定のリゾルバとしてこの関数を呼ぶが、利用者が差し替えられる。
 *
 * ID-JAG draft §4.3 は `actor_token` の処理の規則を定めず、§9.7 が拡張の指針を示すだけなので、この実装は §9.7 の指針に従って次のように決めている:
 * - `actor_token` は、サブジェクトと同じく、この OP が発行した ID トークンで、`aud` が認証したクライアントと一致すること。
 *   関係のないトークンや、より信頼できないトークンを持ち込んで、アクターの権限を実際より大きく見せられないようにする。
 * - `act` に入れるのは、アクターの `sub` だけにする。
 *   不要な属性を、別のドメインに渡さない。
 * - `sub`（リソースオーナー）と `act`（アクター）は、クレームの構造で区別する。
 *
 * 検証は、{@link resolveIdJagSubject} と同じく core の `validateIdTokenHint()` に任せる。
 * 失敗の理由は、レスポンスから区別できない（説明は {@link ACTOR_TOKEN_INVALID_DESCRIPTION} で固定）。
 *
 * @throws {IdJagError} `invalid_request`: ID トークンの検証に失敗したとき（説明は固定）
 * @spec ID-JAG draft §9.7
 */
export async function resolveIdJagActor(options: {
  actorToken: string;
  issuer: string;
  clientId: string;
  jwks: JwkSet;
}): Promise<IdJagActor> {
  let payload: { sub: string; [key: string]: unknown };
  try {
    payload = await validateIdTokenHint(options.actorToken, {
      expectedIss: options.issuer,
      expectedAud: options.clientId,
      jwks: options.jwks,
    });
  } catch (error) {
    if (error instanceof IdTokenHintError) {
      throw new IdJagError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION);
    }
    throw error;
  }
  return { sub: payload.sub };
}

/**
 * `actor_token` をリゾルバで検証し、`act` の値を返す。
 *
 * 受け付けたどの種類の `actor_token` も、同じようにこの関数を通る（種類による場合分けはライブラリにない）。
 * ライブラリが検証するのは、リクエストの形（解析済み）と、リゾルバが返した値の形までである。
 * トークンの内容（署名、失効、誰のトークンか）は、{@link IdJagActorTokenResolver} の約束どおりリゾルバが検証する。
 *
 * リゾルバが返した値は形を確かめながら写し、`sub` と `act` 以外の属性は `act` クレームに入れない（ID-JAG draft §9.7 の、開示を最小にする指針）。
 * 入れ子の `act`（`actor_token` 自体が委譲で発行されたとき）は、そのまま発行できる。
 *
 * リゾルバが渡されていない設定では、どの `actor_token` も内容を検証できないので、固定の説明で拒否する。
 *
 * @throws {IdJagError} `invalid_request`: リゾルバが渡されていないとき、またはリゾルバが `null` を返したとき（説明は固定）。
 *   リゾルバ自身が投げた `IdJagError` も、そのまま投げる。
 * @throws {Error} リゾルバが不正な形のアクターを返したとき（利用者側の誤り）。
 *   生成されたコードの共通の `catch` が `server_error` にする。
 * @spec ID-JAG draft §9.7
 */
export async function resolveIdJagActorToken(options: {
  actorToken: string;
  actorTokenType: string;
  clientId: string;
  issuer: string;
  jwks: JwkSet;
  resolver?: IdJagActorTokenResolver;
}): Promise<IdJagActor> {
  if (options.resolver === undefined) {
    throw new IdJagError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION);
  }
  const resolved = await options.resolver({
    actorToken: options.actorToken,
    actorTokenType: options.actorTokenType,
    clientId: options.clientId,
    issuer: options.issuer,
    jwks: options.jwks,
  });
  if (resolved === null) {
    throw new IdJagError('invalid_request', ACTOR_TOKEN_INVALID_DESCRIPTION);
  }
  const actor = copyActorChain(resolved);
  if (actor === undefined) {
    throw new Error(
      'The actorTokenResolver returned a malformed actor: sub must be a non-empty string at every level of the act chain',
    );
  }
  return actor;
}

/**
 * アクターの連鎖を、形を確かめながら写して返す。
 *
 * リゾルバが返した値の検証を兼ねる。
 * 各階層の `sub`（空でない文字列）と、同じ形の入れ子の `act` だけを写し、ほかの属性は捨てる。
 * どこかの階層の形が崩れていれば、`undefined` を返す。
 */
function copyActorChain(value: unknown): IdJagActor | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const sub = record['sub'];
  if (typeof sub !== 'string' || sub.length === 0) {
    return undefined;
  }
  if (record['act'] === undefined) {
    return { sub };
  }
  const act = copyActorChain(record['act']);
  return act === undefined ? undefined : { sub, act };
}

/**
 * `audience` が許可されていなければ例外を投げる。
 *
 * 次のときに `invalid_target` の {@link IdJagError} を投げる。
 * - `audience` が、この OP 自身の `issuer` と同じとき。
 *   ID-JAG draft §9.3 は、IdP が自分の発行した ID-JAG に対して同じドメインの中でアクセストークンを発行することを禁じており、自分の `issuer` を宛先とする要求はその禁じられた構成そのものである。
 *   受け取る側の `iss` の検証と合わせて、二重に防ぐ。
 * - `audience` が許可リスト（`allowedAudiences`、既定は空）にないとき。
 *   このときの `error_description` は固定の文言にし、リストの内容や、どこまで一致したかを返さない。
 *
 * `issuer` の識別子どうしは、文字列の完全一致で比べる（RFC 8414 §2）。
 *
 * @throws {IdJagError} `invalid_target`: `audience` がこの OP の `issuer` と同じとき、または許可リストにないとき
 * @spec ID-JAG draft §9.3
 */
export function validateIdJagAudience(options: {
  audience: string;
  issuer: string;
  allowedAudiences: string[];
}): void {
  if (options.audience === options.issuer) {
    // 利用者が自分で直せる設定の誤りなので、この場合だけ理由を説明に書く。
    // この OP の `issuer` は公開されている情報なので、理由を返しても、隠したい情報を推測する手がかりにはならない。
    throw new IdJagError(
      'invalid_target',
      'The requested audience must belong to a different trust domain than this authorization server',
    );
  }
  if (!options.allowedAudiences.includes(options.audience)) {
    throw new IdJagError(
      'invalid_target',
      'The requested audience is not allowed for ID-JAG issuance',
    );
  }
}

/**
 * 要求された `scope` を検証し、ID-JAG に入れる値を返す。
 *
 * `allowedScopes` が設定されていれば、要求された値がすべてその中にあるときだけ、要求された値（重複を除いたもの）を返す。
 * 一つでもなければ、`invalid_scope` の {@link IdJagError} を投げる。
 * `allowedScopes` が設定されていなければ、要求された値をそのまま返す。
 *
 * ID-JAG draft §4.3.3 では、IdP はポリシーを評価し、要求の一部だけを許可してもよい。
 * 設定されていないときに要求をそのまま許すのは、`scope` の意味がリソース側の認可サーバーのドメインに属し、受け取る側でも同じ絞り込みの方針が働くためである（設計上の判断で、機能の仕様書の設定値の節に説明がある）。
 *
 * @returns ID-JAG に入れる `scope`
 * @throws {IdJagError} `invalid_scope`: `allowedScopes` にない値を要求したとき
 * @spec ID-JAG draft §4.3.3
 */
export function validateIdJagScope(
  requestedScope: string | undefined,
  allowedScopes: string[] | undefined,
): string[] {
  const requested = splitScope(requestedScope);
  if (allowedScopes === undefined) {
    return requested;
  }
  for (const value of requested) {
    if (!allowedScopes.includes(value)) {
      throw new IdJagError(
        'invalid_scope',
        'The requested scope exceeds the scopes allowed for ID-JAG issuance',
      );
    }
  }
  return requested;
}

/**
 * 発行する ID-JAG のクレームを組み立てて返す。
 *
 * クレームは次のように決める。
 * - `iss` はこの OP の `issuer`、`sub` はサブジェクトの `sub`、`aud` は `audience` である。
 * - `client_id` は、交換を要求した認証済みのクライアントの `client_id` である。
 *   ID-JAG draft §5 は、リソース側の認可サーバーで別の `client_id` を使う対応付けも認めているが、この機能は両方の認可サーバーで同じ `client_id` を使う前提に固定している（この機能の対象外）。
 * - `jti` は 32 バイト（256 ビット）の乱数である。
 *   受け取る側はリプレイの拒否には使わないが（ID-JAG draft §4.4.3 の再提示を許すため）、グラントごとの追跡やログの突き合わせに使える。
 * - `iat` は発行時刻（`now`、既定は現在時刻）、`exp` はそれに `lifetimeSeconds` を足した時刻である。
 * - `scope` は、空の配列のときはクレーム自体を入れない（ID-JAG draft §3.1 の OPTIONAL）。
 * - `resource`、`auth_time`、`acr`、`amr`、`act` は、値があるときだけ入れる。
 *
 * @throws {RangeError} `lifetimeSeconds` が正の整数でないとき（設定の誤り）
 * @spec ID-JAG draft §3.1
 */
export function buildIdJagClaims(options: {
  issuer: string;
  subject: IdJagSubject;
  audience: string;
  clientId: string;
  scope: string[];
  resource?: string;
  /** actor 受理時のみ（{@link resolveIdJagActor} の戻り値）。act claim になる */
  actor?: IdJagActor;
  lifetimeSeconds: number;
  now?: Date;
}): IdJagClaims {
  if (!Number.isInteger(options.lifetimeSeconds) || options.lifetimeSeconds <= 0) {
    throw new RangeError(
      `lifetimeSeconds must be a positive integer, received ${options.lifetimeSeconds}`,
    );
  }
  const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1000);
  return {
    iss: options.issuer,
    sub: options.subject.sub,
    aud: options.audience,
    client_id: options.clientId,
    jti: generateRandomString(32),
    exp: issuedAt + options.lifetimeSeconds,
    iat: issuedAt,
    ...(options.scope.length === 0 ? {} : { scope: options.scope.join(' ') }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
    ...(options.subject.authTime === undefined ? {} : { auth_time: options.subject.authTime }),
    ...(options.subject.acr === undefined ? {} : { acr: options.subject.acr }),
    ...(options.subject.amr === undefined ? {} : { amr: options.subject.amr }),
    ...(options.actor === undefined ? {} : { act: options.actor }),
  };
}

/**
 * クレームに署名し、ID-JAG の JWT にして返す。
 *
 * JOSE ヘッダーは `{ alg: 'RS256', typ: 'oauth-id-jag+jwt', kid }` である。
 * `typ` は、受け取る側が必ず検証する項目（ID-JAG draft §4.4.1、RFC 8725 §3.11）なので、必ず付ける。
 * `kid` を入れるのは、受け取る側が IdP の JWKS から鍵を一つに決められるようにするためである。
 *
 * @param options.signingKey 署名鍵で、RS256 の鍵を渡す。
 *   ヘッダーの `alg` は常に RS256 である。
 *   ECDSA の鍵を渡すと Web Crypto が署名を拒否し、返す `Promise` が失敗する。
 *   ハッシュの違う RSA の鍵（RS384 など）は拒否されず、`alg` と合わない署名の JWT ができる。
 * @returns JWS のコンパクト形式の文字列
 * @spec ID-JAG draft §4.4.1
 * @spec RFC 8725 §3.11
 */
export async function createIdJagJwt(options: {
  claims: IdJagClaims;
  signingKey: SigningKey;
}): Promise<string> {
  const encodedHeader = base64UrlFromJson({
    alg: ID_JAG_SIGNING_ALG,
    typ: ID_JAG_JWT_TYP,
    kid: options.signingKey.keyId,
  });
  const encodedPayload = base64UrlFromJson(options.claims as unknown as Record<string, unknown>);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    WEB_CRYPTO_ALGORITHM,
    options.signingKey.privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

/**
 * 発行した ID-JAG の成功レスポンスのボディを返す。
 *
 * `access_token` に ID-JAG を入れ、`issued_token_type` は ID-JAG の種類（`urn:ietf:params:oauth:token-type:id-jag`）にする。
 * 発行するのはアクセストークンではないので、`token_type` は常に `N_A` にする。
 *
 * `scope` は、ID-JAG draft では要求と同じなら省略してよい（OPTIONAL）が、同じかどうかを判定する場合分けを避けるために常に入れる（トークン交換の機能と同じ設計上の判断）。
 * `scope` なしで発行したときは、空文字列になる。
 * `refresh_token` は返さない（ID-JAG draft §4.3.4 の SHOULD NOT）。
 *
 * @spec RFC 8693 §2.2.1
 * @spec ID-JAG draft §4.3.4
 */
export function buildIdJagIssuanceResponse(options: {
  idJag: string;
  expiresIn: number;
  scope: string[];
}): IdJagIssuanceResponse {
  return {
    access_token: options.idJag,
    issued_token_type: ID_JAG_TOKEN_TYPE,
    token_type: 'N_A',
    expires_in: options.expiresIn,
    scope: options.scope.join(' '),
  };
}

/**
 * リクエストを検証して ID-JAG を発行し、ボディを返す。
 *
 * クライアントの確認、パラメータの検証、`subject_token` の検証（ID トークンかリフレッシュトークン）、`actor_token` の検証（あるとき）、`audience` と `scope` の検証、クレームの組み立て、署名、レスポンスの組み立てを、この順に行う。
 * それぞれ、このファイルのほかの関数を呼ぶだけである。
 * リフレッシュトークンの `subject_token` は `refreshTokenResolver` が渡されているときだけ、`actor_token` は `allowActorTokens` が true のときだけ受け付ける。
 *
 * ID-JAG はストアに保存しない。
 * 署名付きで内容が完結したグラントであり、受け取る側が署名と `exp` で検証するためである。
 *
 * @throws {IdJagError} どれかの検証に失敗したとき
 * @throws {RangeError} `lifetimeSeconds` が正の整数でないとき
 * @spec ID-JAG draft §4.3
 */
export async function processIdJagIssuanceRequest(
  context: IdJagIssuanceContext,
): Promise<IdJagIssuanceResponse> {
  // クライアントが ID-JAG を要求できるかを、最初に確かめる。
  // 要求できないクライアントには、`subject_token` が有効であるかどうかも判定させず、トークンの状態を推測する手がかりを与えない。
  authorizeIdJagIssuanceClient(context.client);

  const parsed = parseIdJagIssuanceParams(context.params, {
    allowRefreshTokenSubjects: context.refreshTokenResolver !== undefined,
    allowActorTokens: context.allowActorTokens === true,
  });

  const subject =
    parsed.subjectTokenType === TOKEN_TYPE_REFRESH_TOKEN
      ? await resolveIdJagSubjectFromRefreshToken({
          refreshToken: parsed.subjectToken,
          clientId: context.client.clientId,
          // 解析でリフレッシュトークンのサブジェクトを受け付けたのなら、リゾルバは渡されている。
          refreshTokenResolver: context.refreshTokenResolver as RefreshTokenResolver,
          ...(context.authenticationSessionResolver === undefined
            ? {}
            : { authenticationSessionResolver: context.authenticationSessionResolver }),
          ...(context.now === undefined ? {} : { now: context.now }),
        })
      : await resolveIdJagSubject({
          subjectToken: parsed.subjectToken,
          issuer: context.issuer,
          clientId: context.client.clientId,
          jwks: context.jwks,
        });

  // `actor_token`（この機能の拡張）は、サブジェクトを検証した後に検証する。
  // `act` は誰がサブジェクトの代わりに動くかの記録であり、アクターがいても `sub` は変わらない（RFC 8693 §4.1）。
  // トークンの種類によらず、同じリゾルバを通す。
  const actor =
    parsed.actorToken === undefined
      ? undefined
      : await resolveIdJagActorToken({
          actorToken: parsed.actorToken,
          // 組み合わせは検証済みなので、`actorToken` があれば `actorTokenType` もある。
          actorTokenType: parsed.actorTokenType as string,
          clientId: context.client.clientId,
          issuer: context.issuer,
          jwks: context.jwks,
          ...(context.actorTokenResolver === undefined
            ? {}
            : { resolver: context.actorTokenResolver }),
        });

  validateIdJagAudience({
    audience: parsed.audience,
    issuer: context.issuer,
    allowedAudiences: context.allowedAudiences,
  });

  const scope = validateIdJagScope(parsed.scope, context.allowedScopes);

  const claims = buildIdJagClaims({
    issuer: context.issuer,
    subject,
    audience: parsed.audience,
    clientId: context.client.clientId,
    scope,
    ...(parsed.resource === undefined ? {} : { resource: parsed.resource }),
    ...(actor === undefined ? {} : { actor }),
    lifetimeSeconds: context.lifetimeSeconds,
    ...(context.now === undefined ? {} : { now: context.now }),
  });

  const idJag = await createIdJagJwt({
    claims,
    signingKey: context.signingKey,
  });

  return buildIdJagIssuanceResponse({
    idJag,
    expiresIn: context.lifetimeSeconds,
    scope,
  });
}

/**
 * 前後の空白を除いた値か、`undefined` を返す。
 *
 * `value` が `undefined` のときと、前後の空白を除くと空文字列になるときは、`undefined`（指定なし）を返す。
 */
function optional(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * `subject_token` が無効だというエラーを作って返す。
 *
 * `invalid_request` の {@link IdJagError} を作り、投げずに返す。
 * 説明（`error_description`）は常に固定の {@link SUBJECT_TOKEN_INVALID_DESCRIPTION} で、無効な理由を含まない。
 *
 * @spec RFC 8693 §2.2.2
 */
function invalidSubjectToken(): IdJagError {
  return new IdJagError('invalid_request', SUBJECT_TOKEN_INVALID_DESCRIPTION);
}

/**
 * `scope` の文字列を値の配列に分けて返す。
 *
 * 空白（タブや改行を含む）で区切り、空の要素を除き、重複は最初に現れた順で一つずつ残す。
 * `scope` が `undefined` なら、空の配列を返す。
 */
function splitScope(scope: string | undefined): string[] {
  if (scope === undefined) return [];
  return [...new Set(scope.split(/\s+/).filter((value) => value.length > 0))];
}

/**
 * フラグメントのない絶対 URI なら true を返す。
 *
 * `#` を含む値と、`URL` として解析できない値には false を返す。
 * クエリは含んでもよい。
 * `resource` はフラグメントのない絶対 URI（RFC 3986 §4.3）でなければならないという、RFC 8707 §2 の規則を確かめるために使う。
 *
 * @spec RFC 8707 §2
 * @spec RFC 3986 §4.3
 */
function isAbsoluteUriWithoutFragment(value: string): boolean {
  if (value.includes('#')) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol.length > 0;
}

/** バイト列をパディングなしの base64url にして返す。 */
function base64UrlFromBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * オブジェクトを JSON にし、base64url にして返す。
 *
 * JSON 文字列を UTF-8 のバイト列にしてから、パディングなしの base64url にする。
 */
function base64UrlFromJson(value: Record<string, unknown>): string {
  return base64UrlFromBytes(new TextEncoder().encode(JSON.stringify(value)));
}
