import type { PreparedPremises, PremiseRecord, PremiseStep, StoreChange, StoreRead } from '@maronn-openid-connect/map-sandbox';
import { changeWords, collectionWord, originOf, premiseRecordOf, recordsIn, shortKey, stepLine, stepNumber, valueRows } from '../lib/premises';
import { statusLine, statusTone } from '../lib/requests';
import type { PremisesState } from './useRequests';

/** The fields of a record, one row each, a time with how it stands to the clock of the premises. */
function RecordValue({ value, now }: { value: unknown; now: number }) {
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

/** A request of the premises: its number, method and path, status, what it sent (the query, the form, the cookies, the client of its credentials), where it was sent next, and the records it wrote; marked where it stored or changed the record read. */
export function StepItem({ index, step, did }: { index: number; step: PremiseStep; did?: 'added' | 'changed' | undefined }) {
  const line = stepLine(step);
  return (
    <li className={`store-step${did !== undefined ? ' store-step-did' : ''}`}>
      <p className="req-line">
        <span className="store-num">{stepNumber(index)}</span>
        <span className="req-method">{line.method}</span>
        <code className="req-path">{line.path}</code>
        <span className={`req-status req-${statusTone(line.status)}`}>→ {statusLine({ status: line.status })}</span>
        {did !== undefined ? <span className="store-did">{did === 'added' ? 'ここで保存' : 'ここで変更'}</span> : null}
      </p>
      {(
        [
          ['クエリ', line.query],
          ['フォーム', line.form],
        ] as const
      ).map(([label, fields]) =>
        fields.length > 0 ? (
          <p key={label} className="store-sent">
            <span className="store-sent-label">{label}</span>
            {fields.map(([name, value], at) => (
              <span key={at} className="mono">
                {name}={shortKey(value, 48)}
              </span>
            ))}
          </p>
        ) : null,
      )}
      {line.cookies.length > 0 ? <p className="req-note mono">Cookie: {line.cookies.map(([name, value]) => `${name}=${shortKey(value, 24)}`).join('; ')}</p> : null}
      {line.client !== undefined ? <p className="req-note">Basic の client_id: {line.client}</p> : null}
      {line.setCookies.length > 0 ? <p className="req-note mono">Set-Cookie: {line.setCookies.map(([name, value]) => (value === undefined ? `${name}（消す）` : `${name}=${shortKey(value, 24)}`)).join('; ')}</p> : null}
      {line.location !== undefined ? <p className="req-note">Location: {shortKey(line.location, 96)}</p> : null}
      {step.wrote.length > 0 ? (
        <p className="req-note">
          {step.wrote.map((change, at) => (
            <span key={at}>
              {at > 0 ? '、' : ''}
              {collectionWord(change.collection)} <code className="mono">{shortKey(change.key, 24)}</code> {changeWords(change)}
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

/** Where a record of the premises came from: the requests of its grant up to the one that stored it (and those that changed it after), or the OP's configuration. */
function Origin({ premises, record, made }: { premises: PreparedPremises; record: PremiseRecord; made: boolean }) {
  const origin = originOf(premises, record);
  if (origin === undefined) return <p className="note">OP の設定で登録したもので、リクエストでは作っていません。</p>;
  return (
    <div className="store-origin">
      <p className="note">
        グラント <code className="mono">{origin.grant}</code> のリクエストを地図の OP で動かして保存したものです（{made ? 'このページで前提を作り直したときに動かしたもの' : '地図のビルドが前提を作るときに動かしたもの'}）。
      </p>
      <ol className="store-steps">
        {origin.steps.map(({ index, step, did }) => (
          <StepItem key={index} index={index} step={step} did={did} />
        ))}
      </ol>
    </div>
  );
}

/** The words of where a record came from, on one line: the request that stored it (and the last that changed it), or the configuration. */
function originWords(premises: PreparedPremises, record: PremiseRecord): string {
  const origin = originOf(premises, record);
  if (origin === undefined) return 'OP の設定で登録';
  const words = (index: number) => {
    const line = stepLine(premises.steps[index] as PremiseStep);
    return `${stepNumber(index)} ${line.method} ${line.path}`;
  };
  const changed = record.changedBy ?? [];
  return `${words(record.addedBy as number)} で保存${changed.length > 0 ? `、${words(changed[changed.length - 1] as number)} で変更` : ''}`;
}

/** A record of the premises a request read or wrote, to open: its key, where it came from on one line, then its fields and the requests that stored it; `words` follows the key (what the request did to it). */
function RecordItem({ premises, record, words, made }: { premises: PreparedPremises; record: PremiseRecord; words?: string; made: boolean }) {
  return (
    <details>
      <summary>
        <span className="store-what">{collectionWord(record.collection)}</span> <code className="mono">{shortKey(record.key)}</code>
        {words !== undefined ? <span className="req-note">{words}</span> : null}
        <span className="req-note">（{originWords(premises, record)}）</span>
      </summary>
      <RecordValue value={record.value} now={premises.now} />
      <Origin premises={premises} record={record} made={made} />
    </details>
  );
}

/** What the props of the records a request reads are (see StoredReads). */
export interface StoredReadsProps {
  /** The records read, in the order read. */
  reads: readonly StoreRead[];
  premises: PremisesState;
  /** The heading of the list. */
  title: string;
  /** What the list is of, when it is not of the request as written. */
  note?: string | undefined;
}

/**
 * The records of the OP a request reads, each with what the OP held: the
 * record (its fields), and the requests that stored it, or that the OP held
 * none; a collection it went through whole, with how many records it held.
 */
export function StoredReads({ reads, premises, title, note }: StoredReadsProps) {
  const ready = premises.kind === 'ready' ? premises.premises : undefined;
  return (
    <section className="store" aria-label={title}>
      <h5 className="store-title">{title}</h5>
      {note !== undefined ? <p className="note">{note}</p> : null}
      {reads.length === 0 ? <p className="note">OP が保存している情報は読みません。</p> : null}
      <ul className="store-list">
        {reads.map((read, at) => {
          const record = read.key === undefined ? undefined : premiseRecordOf(ready, read.collection, read.key);
          if (read.key === undefined) {
            const records = recordsIn(ready, read.collection);
            return (
              <li key={at} className="store-item">
                <span className="store-what">{collectionWord(read.collection)}（すべて）</span>
                <span className="req-note">を調べた{ready !== undefined ? `（OP が持っているのは ${records.length} 件）` : ''}</span>
                {ready !== undefined && records.length > 0 ? (
                  <ul className="store-list store-walk">
                    {records.map((record) => (
                      <li key={record.key} className="store-item">
                        <RecordItem premises={ready} record={record} made={premises.kind === 'ready' && premises.made === true} />
                      </li>
                    ))}
                  </ul>
                ) : null}
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
          if (!read.found) {
            return (
              <li key={at} className="store-item">
                <span className="store-what">{collectionWord(read.collection)}</span> <code className="mono">{shortKey(read.key)}</code>
                <span className="store-missing">OP に無い</span>
              </li>
            );
          }
          return (
            <li key={at} className="store-item">
              {ready !== undefined && record !== undefined ? (
                <RecordItem premises={ready} record={record} made={premises.kind === 'ready' && premises.made === true} />
              ) : (
                <>
                  <span className="store-what">{collectionWord(read.collection)}</span> <code className="mono">{shortKey(read.key)}</code>
                  <span className="req-note">OP が持っていた{premises.kind === 'failed' ? `（前提を読み込めませんでした: ${premises.message}）` : premises.kind === 'loading' ? '（前提を読み込んでいます…）' : ''}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The records a request run stored, changed or removed, each with its fields as they were left, and for one the premises held, where it came from. */
export function StoredWrites({ wrote, now, premises }: { wrote: readonly StoreChange[]; now: number; premises: PremisesState }) {
  const ready = premises.kind === 'ready' ? premises.premises : undefined;
  return (
    <section className="store" aria-label="このリクエストが保存・変更・削除したもの">
      <h5 className="store-title">このリクエストが保存・変更・削除したもの</h5>
      {wrote.length === 0 ? <p className="note">ありません。</p> : null}
      <ul className="store-list">
        {wrote.map((change, at) => (
          <li key={at} className="store-item">
            <details>
              <summary>
                <span className="store-what">{collectionWord(change.collection)}</span> <code className="mono">{shortKey(change.key)}</code>
                <span className="req-note">{changeWords(change)}</span>
                {ready !== undefined && premiseRecordOf(ready, change.collection, change.key) !== undefined ? <span className="req-note">（{originWords(ready, premiseRecordOf(ready, change.collection, change.key) as PremiseRecord)}）</span> : null}
              </summary>
              <RecordValue value={change.change === 'removed' ? change.before : change.value} now={now} />
              {ready !== undefined && premiseRecordOf(ready, change.collection, change.key) !== undefined ? <Origin premises={ready} record={premiseRecordOf(ready, change.collection, change.key) as PremiseRecord} made={premises.kind === 'ready' && premises.made === true} /> : null}
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
