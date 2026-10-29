/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — software statement
 * （§2.3 / §3.1.1）の検証と適用。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * software statement は、ソフトウェアの発行者（publisher）が署名した JWT で、
 * クライアントメタデータの集合をひとまとめに主張する。OP は発行者の公開鍵で
 * 署名を検証し（§3.1.1）、主張されたメタデータを平文の値へ優先して適用する。
 * 署名検証は core 公開の parseRequestObject（compact JWS の解析と JWKS による
 * 検証）に委ね、software statement 固有の判断（発行者の承認、iss の必須、
 * exp / nbf、JWT 標準クレームの除去）だけをここに持つ。
 */

import { parseRequestObject, type JwkSet } from '@maronn-openid-connect/core';
import { defineOwnProperty, isJsonObject } from './metadata-values.js';
import { ClientRegistrationError } from './registration-error.js';

/** この OP が software statement を受け入れる発行者。 */
export interface SoftwareStatementPublisher {
  /** software statement の iss クレームと一致する発行者識別子。 */
  issuer: string;
  /** 署名検証に使う発行者の公開鍵。RSA 鍵には alg（RS256 など）が要る。 */
  jwks: JwkSet;
  /**
   * この発行者に受理する JWS アルゴリズム。省略時は RS256 と ES256
   * （RFC 7591 §2.3 は RS256 を推奨する）。none は受理しない。
   */
  algorithms?: readonly string[];
}

export interface VerifySoftwareStatementOptions {
  /** 承認した発行者。空なら、どの software statement も unapproved_software_statement になる。 */
  publishers: readonly SoftwareStatementPublisher[];
  /** 現在時刻（ミリ秒）。省略時は Date.now。 */
  now?: () => number;
}

/** 検証に成功した software statement。 */
export interface VerifiedSoftwareStatement {
  /** 発行者（iss クレーム）。 */
  issuer: string;
  /**
   * software statement が主張するクライアントメタデータ。JWT の標準クレーム
   * （iss / sub / aud / exp / nbf / iat / jti）は含まない。
   */
  metadata: Record<string, unknown>;
}

/** RFC 7591 §2.3 は RS256 を推奨する。core が検証できる RSA / EC の代表値を既定にする。 */
export const DEFAULT_SOFTWARE_STATEMENT_ALGORITHMS: readonly string[] = ['RS256', 'ES256'];

/** RFC 7519 §4.1 の登録済みクレーム。クライアントメタデータではないので適用しない。 */
const JWT_REGISTERED_CLAIMS = ['iss', 'sub', 'aud', 'exp', 'nbf', 'iat', 'jti'];

function invalidStatement(description: string): ClientRegistrationError {
  return new ClientRegistrationError('invalid_software_statement', description);
}

/**
 * software statement を検証し、主張されたメタデータを返す。
 *
 * 1. compact JWS（3 セグメント）で、ペイロードが iss を持つ JSON オブジェクトであること。
 *    違反は invalid_software_statement
 * 2. iss が publishers のいずれかと一致すること。一致しなければ
 *    unapproved_software_statement（RFC 7591 §3.2.2）
 * 3. その発行者の鍵と許可アルゴリズムで署名が検証できること。失敗は
 *    invalid_software_statement。文言は固定で、ヘッダの alg や kid を反映しない
 * 4. exp があれば未来、nbf があれば現在以前であること
 *
 * iss は署名検証の前に読む（どの鍵で検証するかを決めるため）が、返す値はすべて
 * 検証後のペイロードから取る。
 */
export async function verifySoftwareStatement(
  softwareStatement: string,
  options: VerifySoftwareStatementOptions,
): Promise<VerifiedSoftwareStatement> {
  const segments = softwareStatement.split('.');
  if (segments.length !== 3) {
    throw invalidStatement('software_statement must be a JWS compact serialization');
  }
  const unverifiedPayload = decodeJsonSegment(segments[1] as string);
  const issuer = unverifiedPayload['iss'];
  if (typeof issuer !== 'string' || issuer.length === 0) {
    throw invalidStatement('software_statement must carry an iss claim');
  }

  const publisher = options.publishers.find((candidate) => candidate.issuer === issuer);
  if (publisher === undefined) {
    throw new ClientRegistrationError(
      'unapproved_software_statement',
      'the issuer of the software_statement is not approved by this authorization server',
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = await parseRequestObject(softwareStatement, {
      jwks: publisher.jwks,
      supportedSigningAlgs: [...(publisher.algorithms ?? DEFAULT_SOFTWARE_STATEMENT_ALGORITHMS)].filter(
        (alg) => alg !== 'none',
      ),
      allowUnsigned: false,
    });
  } catch {
    throw invalidStatement('the signature of the software_statement could not be verified');
  }

  const nowSeconds = Math.floor((options.now ?? Date.now)() / 1000);
  const exp = payload['exp'];
  if (exp !== undefined && (typeof exp !== 'number' || exp <= nowSeconds)) {
    throw invalidStatement('the software_statement has expired');
  }
  const nbf = payload['nbf'];
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > nowSeconds)) {
    throw invalidStatement('the software_statement is not yet valid');
  }

  const metadata: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(payload)) {
    if (JWT_REGISTERED_CLAIMS.includes(name)) continue;
    defineOwnProperty(metadata, name, value);
  }
  return { issuer: payload['iss'] as string, metadata };
}

/**
 * 検証済み software statement のメタデータを、平文のメタデータへ適用する。
 *
 * RFC 7591 §3.1.1: software statement のメタデータは平文の同名メタデータに優先する。
 * 返すオブジェクトは software_statement メンバーに元の JWT 文字列を持ち、
 * validateClientMetadata がそれを応答へ返す（§3.2.1 の MUST）。
 */
export function applySoftwareStatement(
  metadata: Readonly<Record<string, unknown>>,
  softwareStatement: string,
  verified: VerifiedSoftwareStatement,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(metadata)) {
    if (name === 'software_statement') continue;
    defineOwnProperty(merged, name, value);
  }
  for (const [name, value] of Object.entries(verified.metadata)) {
    defineOwnProperty(merged, name, value);
  }
  merged['software_statement'] = softwareStatement;
  return merged;
}

/** base64url の JSON セグメントをオブジェクトとして読む。読めなければ invalid_software_statement。 */
function decodeJsonSegment(segment: string): Record<string, unknown> {
  let decoded: unknown;
  try {
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    decoded = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw invalidStatement('software_statement must be a JWS compact serialization');
  }
  if (!isJsonObject(decoded)) {
    throw invalidStatement('software_statement must be a JWS compact serialization');
  }
  return decoded;
}
