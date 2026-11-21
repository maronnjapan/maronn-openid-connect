import { useId, useState } from 'react';
import { basicCredentials, fileName, paramGroups, shortValue, statusLine, statusTone, testsLink, wayRequestsOf } from '../lib/requests';
import type { Selection, WayRequest } from '../types';
import type { RootRequestsState } from './useRequests';

/** A value of a request: cut in the middle when long, with a button that shows it whole. */
function Value({ value, label }: { value: string; label: string }) {
  const [open, setOpen] = useState(false);
  const short = shortValue(value);
  return (
    <span className="req-value">
      <code className="mono" title={short.cut && !open ? value : undefined}>
        {open || !short.cut ? value : short.text}
      </code>
      {short.cut ? (
        <button type="button" className="link small req-toggle" aria-expanded={open} aria-label={`「${label}」${open ? 'を畳む' : 'の全体を見る'}`} onClick={() => setOpen(!open)}>
          {open ? '畳む' : `全体（${value.length} 文字）`}
        </button>
      ) : null}
    </span>
  );
}

/** One request: the method, the path and the status, the parameters by where they were sent, the headers, and the test and the line of its code that sent it. */
function RequestView({ example, link }: { example: WayRequest; link: string }) {
  const groups = paramGroups(example.params);
  const tone = statusTone(example.status);
  return (
    <div className="req">
      <p className="req-line">
        <span className="req-method">{example.method}</span>
        <code className="req-path">{example.path}</code>
        <span className={`req-status req-${tone}`}>→ {statusLine(example)}</span>
      </p>
      {groups.length === 0 ? <p className="note">クエリとボディのパラメータはありません。</p> : null}
      {groups.map((group) => (
        <table key={group.in} className="req-table">
          <caption>{group.label}</caption>
          <tbody>
            {group.params.map((param, index) => (
              <tr key={`${param.name}:${index}`}>
                <th scope="row">
                  <code className="mono">{param.name}</code>
                </th>
                <td>
                  <Value value={param.value} label={param.name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}
      {example.headers.length > 0 ? (
        <table className="req-table req-headers">
          <caption>ヘッダー</caption>
          <tbody>
            {example.headers.map(([name, value], index) => {
              const credentials = name.toLowerCase() === 'authorization' ? basicCredentials(value) : undefined;
              return (
                <tr key={`${name}:${index}`}>
                  <th scope="row">
                    <code className="mono">{name}</code>
                  </th>
                  <td>
                    <Value value={value} label={name} />
                    {credentials !== undefined ? <span className="req-note">↳ client_id: <code className="mono">{credentials.client}</code></span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : null}
      <div className="req-from">
        <span className="flow-label">送ったテスト</span>
        <a href={link} title="テストの画面で、このテストのコードを、リクエストを送った行に印を付けて開く">
          {example.test.title}
        </a>
        <span className="req-at">
          {fileName(example.test.file)} {example.test.line} 行目
        </span>
        <code className="req-code mono">{example.test.code}</code>
      </div>
    </div>
  );
}

/** What the flow view shows of the request of the way played (see FlowRequest). */
export interface FlowRequestProps {
  /** The requests of the root (useRootRequests). */
  state: RootRequestsState;
  /** The ready-made way chosen; undefined for おまかせ or a way the reader chose side by side. */
  selection: Selection | undefined;
  /** The reader chose the sides of the way themselves. */
  custom: boolean;
  /** How many decisions the way played takes on an assumed side. */
  assumed: number;
  /** The framework the map shows: the requests of another source (express and fastify, generated from hono) say whose they are. */
  framework: string;
}

/**
 * The request of the way the flow view plays: for a ready-made way (a case
 * of the tests page), what the code of an API test actually sent that took
 * it, as the measured run recorded it: the method, the path and the status,
 * the parameters of its query and body (name and value), its headers, and
 * the test and the line of its code that sent it, which open the tests page
 * on that line. Several requests took the way: 例 n / m. Only requests a
 * line of their test sent are recorded for it (packages/test-catalog
 * sent.ts), so what is shown is always in the code of the test it names.
 * Without one, why there is none.
 */
export function FlowRequest({ state, selection, custom, assumed, framework }: FlowRequestProps) {
  const headingId = useId();
  const [index, setIndex] = useState(0);
  const [shownFor, setShownFor] = useState<Selection | undefined>(selection);
  // Another way starts at its first request.
  if (shownFor !== selection) {
    setShownFor(selection);
    setIndex(0);
  }
  const requests = state.kind === 'ready' ? state.requests : undefined;
  const way = wayRequestsOf(requests, selection);
  const examples = way?.examples ?? [];
  const at = Math.min(index, Math.max(0, examples.length - 1));
  const example = examples[at];

  let note: string | undefined;
  if (selection === undefined) {
    note = custom
      ? '自分で選んだ道筋には、対応するケースがありません。「道筋」からケースを選ぶと、そのケースを通ったテストが実際に送ったリクエストを表示します。'
      : `「道筋」からケースを選ぶと、そのケースを通ったテストが実際に送ったリクエストを表示します。${assumed > 0 ? `おまかせの道筋は、決まっていない分岐 ${assumed} 個を仮の側へ進みます。` : ''}`;
  } else if (state.kind === 'loading') note = '読み込んでいます…';
  else if (state.kind === 'failed') note = `リクエストの記録を読み込めませんでした: ${state.message}`;
  else if (state.kind === 'unmeasured') note = 'このビルドには、API テストを計測して実行した記録（MARONN_REACH=1）がありません。計測したビルド（CI のプレビュー）では、このケースを通ったテストが実際に送ったリクエストを表示します。';
  else if (state.kind === 'unrecorded') note = 'このエンドポイントには、テストのコードが送ったリクエストの記録がありません（記録するのは、hono のアプリへ API テストが送ったリクエストです）。';
  else if (example === undefined) note = 'このケースを通った、テストのコードが送ったリクエストの記録はありません。';

  return (
    <section className="flow-request" aria-labelledby={headingId}>
      <div className="flow-request-head">
        <h4 id={headingId}>リクエスト</h4>
        {examples.length > 1 ? (
          <span className="req-nav" role="group" aria-label="リクエストの例">
            {/* aria-disabled, not disabled: a button that turns disabled under the keyboard drops its focus to the page. */}
            <button type="button" className="icon req-step" aria-label="前の例" aria-disabled={at === 0} onClick={() => setIndex(Math.max(0, at - 1))}>
              ‹
            </button>
            <span className="req-count" aria-live="polite">
              例 {at + 1} / {examples.length}
            </span>
            <button type="button" className="icon req-step" aria-label="次の例" aria-disabled={at >= examples.length - 1} onClick={() => setIndex(Math.min(examples.length - 1, at + 1))}>
              ›
            </button>
          </span>
        ) : null}
      </div>
      {way !== undefined && requests !== undefined && requests.source !== framework ? <p className="note">{requests.source} のアプリへ送ったテストの記録です（{framework} の OP は {requests.source} の OP から生成したもので、このエンドポイントの処理は同じです）。</p> : null}
      {way !== undefined && way.count > examples.length ? <p className="note">このケースを通ったリクエストは全部で {way.count} 件（例は {examples.length} 件）</p> : null}
      {note !== undefined || example === undefined || requests === undefined || way === undefined ? <p className="note req-empty">{note}</p> : <RequestView key={`${way.id}:${at}`} example={example} link={testsLink(requests, way, example)} />}
    </section>
  );
}
