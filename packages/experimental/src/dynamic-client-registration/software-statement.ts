/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591) — software statement
 * （§2.3 / §3.1.1）の適用。
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * software statement は、ソフトウェアの発行者が署名した JWT で、クライアント
 * メタデータの集合をひとまとめに主張する。どの発行者を信頼し、どう署名を
 * 確かめるかは RFC 7591 の対象外で（§2.3「信頼の基準は本仕様の範囲外」）、
 * 本機能は検証を持たない。検証は OP の設定に渡した関数の責務で、その関数が
 * 返した主張（VerifiedSoftwareStatement）を applySoftwareStatement が平文の
 * メタデータへ優先して重ねる（§3.1.1 MUST）。検証関数が無い OP は statement
 * を無視する（§3.1.1 は対応しない AS が無視することを許す）。
 */

import { defineOwnProperty } from './metadata-values.js';

/**
 * 検証に成功した software statement。OP の設定に渡した検証関数が返す。
 *
 * metadata は、statement が主張するクライアントメタデータ。ここに残した
 * JWT の標準クレーム（iss / exp など）は validateClientMetadata が理解しない
 * メタデータとして無視するので、取り除く必要はない。RFC 7591 が statement
 * の中身に定める必須項目は無く、本機能も中身を検査しない。
 */
export interface VerifiedSoftwareStatement {
  metadata: Record<string, unknown>;
}

/**
 * 検証済み software statement のメタデータを、平文のメタデータへ適用する。
 *
 * RFC 7591 §3.1.1: software statement のメタデータは平文の同名メタデータに優先する。
 * 返すオブジェクトは software_statement メンバーに元の JWT 文字列を持ち、
 * validateClientMetadata がそれを応答へ返す（§3.2.1 の MUST）。statement の
 * 中に software_statement という名のクレームがあっても、外側の JWT 文字列が勝つ。
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
