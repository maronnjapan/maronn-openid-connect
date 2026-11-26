import type { LiveRecord, StoreAccess } from '@maronn-openid-connect/live-op/api';
import { recordOf } from '../lib/live';
import { changersOf, changeWords, collectionWord, shortKey, valueRows } from '../lib/records';

/** The fields of a record, one row each, a time with how it stands to the OP's clock (Unix seconds). */
export function RecordValue({ value, now }: { value: unknown; now: number }) {
  return (
    <table className="req-table store-value">
      <tbody>
        {valueRows(value, now).map((row) => (
          <tr key={row.name}>
            <th className="mono">{row.name}</th>
            <td>
              <code className="mono">{row.text}</code>
              {row.time !== undefined ? <span className="req-note">{row.time}</span> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A button that opens an exchange of the workspace by its id (in the flow of its endpoint). */
export function ExchangeLink({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className="link small mono" onClick={() => onOpen(id)} title={`リクエスト ${id} を、そのエンドポイントのフローで開く`}>
      {id}
    </button>
  );
}

/** Where a record of the workspace came from, on one line: the exchange that stored it and those that changed it after (each once, changersOf), each to open, or the OP's configuration. */
export function Provenance({ record, onOpen }: { record: LiveRecord; onOpen: (id: string) => void }) {
  const changed = changersOf(record);
  if (record.addedBy === undefined && changed.length === 0) return <span className="req-note">（OP の設定で登録したもの）</span>;
  return (
    <span className="req-note store-provenance">
      （{record.addedBy !== undefined ? (
        <>
          <ExchangeLink id={record.addedBy} onOpen={onOpen} /> で保存
        </>
      ) : (
        '保存したリクエストは記録に残っていない'
      )}
      {changed.length > 0 ? (
        <>
          、
          {changed.map((id, at) => (
            <span key={id}>
              {at > 0 ? '・' : ''}
              <ExchangeLink id={id} onOpen={onOpen} />
            </span>
          ))}{' '}
          で変更
        </>
      ) : null}
      ）
    </span>
  );
}

/** A record the workspace holds, to open: its key and where it came from on one line, then its fields as they are now. */
export function RecordItem({ record, now, words, onOpen }: { record: LiveRecord; now: number; words?: string; onOpen: (id: string) => void }) {
  return (
    <details>
      <summary>
        <span className="store-what">{collectionWord(record.collection)}</span> <code className="mono">{shortKey(record.key)}</code>
        {words !== undefined ? <span className="req-note">{words}</span> : null}
        <Provenance record={record} onOpen={onOpen} />
      </summary>
      <RecordValue value={record.value} now={now} />
    </details>
  );
}

/** What the records a request read are shown with (see StoredReads). */
export interface StoredReadsProps {
  /** The records read, in the order read. */
  reads: StoreAccess['read'];
  /** The records the workspace holds now (LiveState.records), to say where each came from; undefined while they are read. */
  records: readonly LiveRecord[] | undefined;
  /** The OP's clock when the request ran, in Unix seconds. */
  now: number;
  onOpen: (id: string) => void;
}

/**
 * The records of the OP a request read, in the order read, each with
 * whether the OP held it: a record the workspace still holds opens to its
 * fields (as they are now) and names the exchange that stored it; a
 * collection the request went through whole, with how many records it
 * holds now.
 */
export function StoredReads({ reads, records, now, onOpen }: StoredReadsProps) {
  return (
    <section className="store" aria-label="このリクエストが読んだ、OP の保存済みの情報">
      <h5 className="store-title">このリクエストが読んだ、OP の保存済みの情報</h5>
      {reads.length === 0 ? <p className="note">OP が保存している情報は読んでいません。</p> : null}
      <ul className="store-list">
        {reads.map((read, at) => {
          if (read.key === undefined) {
            const all = records?.filter((record) => record.collection === read.collection) ?? [];
            return (
              <li key={at} className="store-item">
                <span className="store-what">{collectionWord(read.collection)}（すべて）</span>
                <span className="req-note">を調べた{records !== undefined ? `（いまは ${all.length} 件）` : ''}</span>
              </li>
            );
          }
          if (read.member !== undefined) {
            return (
              <li key={at} className="store-item">
                <span className="store-what">{collectionWord(read.collection)}</span> <code className="mono">{shortKey(read.key)}</code> の <code className="mono">{shortKey(read.member)}</code>
                {read.found ? <span className="req-note">を持っていた</span> : <span className="store-missing">OP に無い</span>}
              </li>
            );
          }
          const record = read.found ? recordOf(records, read.collection, read.key) : undefined;
          return (
            <li key={at} className="store-item">
              {record !== undefined ? (
                <RecordItem record={record} now={now} onOpen={onOpen} />
              ) : (
                <>
                  <span className="store-what">{collectionWord(read.collection)}</span> <code className="mono">{shortKey(read.key)}</code>
                  {read.found ? <span className="req-note">OP が持っていた（いまは持っていない）</span> : <span className="store-missing">OP に無い</span>}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The records a request stored, changed or removed, each with its fields as the request left them, and for one the workspace holds, the exchanges that stored and changed it. */
export function StoredWrites({ wrote, records, now, onOpen }: { wrote: StoreAccess['wrote']; records: readonly LiveRecord[] | undefined; now: number; onOpen: (id: string) => void }) {
  return (
    <section className="store" aria-label="このリクエストが保存・変更・削除したもの">
      <h5 className="store-title">このリクエストが保存・変更・削除したもの</h5>
      {wrote.length === 0 ? <p className="note">ありません。</p> : null}
      <ul className="store-list">
        {wrote.map((change, at) => {
          const record = recordOf(records, change.collection, change.key);
          return (
            <li key={at} className="store-item">
              <details>
                <summary>
                  <span className="store-what">{collectionWord(change.collection)}</span> <code className="mono">{shortKey(change.key)}</code>
                  <span className="req-note">{changeWords(change)}</span>
                  {record !== undefined ? <Provenance record={record} onOpen={onOpen} /> : null}
                </summary>
                <RecordValue value={change.change === 'removed' ? change.before : change.value} now={now} />
              </details>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
