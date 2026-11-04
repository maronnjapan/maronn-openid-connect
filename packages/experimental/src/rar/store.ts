/**
 * Rich Authorization Requests (RAR) — RFC 9396
 *
 * Experimental: このモジュールの API は安定していない。破壊的変更があり得る。
 *
 * 承認前（transactionId キー）と承認後（grantId キー）の authorization details を
 * 保持するストア契約と、動作確認用の in-memory 実装。
 */

import type { AuthorizationDetail } from './authorization-details.js';

/**
 * 利用者が実装するストア契約。
 *
 * キーは transactionId か grantId で、どちらも外部へ出ない不透明な識別子である。
 * 永続ストア実装では、キーをクエリ文字列へ埋め込まず、必ずパラメータ化した
 * 問い合わせを使うこと。`expiresAt`（UNIX エポックミリ秒）を渡されたら、その時刻を
 * 過ぎたエントリを返してはならない。
 */
export interface RarDetailsStore {
  /** details をキーに紐付けて保存する。`expiresAt` はエポックミリ秒の失効時刻。 */
  set(key: string, details: readonly AuthorizationDetail[], expiresAt?: number): Promise<void>;
  /** キーに紐づく details を返す。無いか失効していれば `undefined` を返す。 */
  get(key: string): Promise<readonly AuthorizationDetail[] | undefined>;
  /** キーに紐づく details を削除する。 */
  delete(key: string): Promise<void>;
}

/**
 * details をメモリに置くストアを作って返す。
 *
 * 動作確認のためのもので、本番では永続的なストア（Redis、KV、データベースなど）に
 * 置き換える。`set` を呼ぶたびに失効したエントリを削除する（書き込み時の lazy
 * eviction）ので、放置されたストアが際限なく大きくならない。`get` は失効した
 * エントリを削除してから `undefined` を返す。
 */
export function createInMemoryRarDetailsStore(): RarDetailsStore {
  const records = new Map<string, { details: readonly AuthorizationDetail[]; expiresAt?: number }>();
  const evictExpired = (): void => {
    const now = Date.now();
    for (const [key, record] of records) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        records.delete(key);
      }
    }
  };
  return {
    async set(key, details, expiresAt): Promise<void> {
      evictExpired();
      records.set(key, { details, expiresAt });
    },
    async get(key): Promise<readonly AuthorizationDetail[] | undefined> {
      const record = records.get(key);
      if (record === undefined) return undefined;
      if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) {
        records.delete(key);
        return undefined;
      }
      return record.details;
    },
    async delete(key): Promise<void> {
      records.delete(key);
    },
  };
}
