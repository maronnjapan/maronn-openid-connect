import { useState } from 'react';
import type { ExchangeSummary } from '@maronn-openid-connect/live-op/api';
import { endpointForPath, exchangesFor, SOURCE_WORDS } from '../lib/live';
import { shortKey } from '../lib/records';
import { statusLine, statusTone } from '../lib/requests';
import { useExchanges } from './useLive';

/** How many exchanges the list shows before the reader asks for more. */
const SHOWN = 12;

/** The OP's clock at a time (Unix milliseconds) as the list writes it: the time of day in the reader's locale. */
function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('ja-JP', { hour12: false });
}

/** What the list of the recent requests shows and opens (see RecentExchanges). */
export interface RecentExchangesProps {
  /** The endpoints of the OP, to say which endpoint a request's path is for. */
  endpoints: ReadonlyArray<{ id: string; path: string; label?: string }>;
  /** The endpoint of the flow shown. */
  endpoint: string;
  /** The exchange the flow view replays, marked in the list. */
  current: string | undefined;
  /** Open an exchange: in this flow when it is of this endpoint, else in the flow of its own. */
  onOpen: (summary: ExchangeSummary) => void;
}

/**
 * The requests the reader's workspace answered, the newest first: those the
 * page sent, those a case's preparation or a grant sent, and those a
 * browser tab or a client sent to the OP over HTTP, each with how it came,
 * its method and path, its status and OAuth error, and the OP's clock when
 * it came. Those of this endpoint (its sub-paths too) or all of them. The
 * list is read again every few seconds while it shows; opening one shows
 * its request and replays the way it took, without sending it again.
 */
export function RecentExchanges({ endpoints, endpoint, current, onOpen }: RecentExchangesProps) {
  const [open, setOpen] = useState(true);
  const [all, setAll] = useState(false);
  const [more, setMore] = useState(false);
  const { list, problem, fetching, refresh } = useExchanges(open);
  const shown = list === undefined ? [] : exchangesFor(list, endpoints, all ? undefined : endpoint);
  const visible = more ? shown : shown.slice(0, SHOWN);
  return (
    <details className="req-recent" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>最近のリクエスト{list !== undefined ? `（${shown.length}）` : ''}</summary>
      <div className="req-recent-tools">
        <span className="seg" role="group" aria-label="どのリクエストを並べるか">
          <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>
            このエンドポイント
          </button>
          <button type="button" aria-pressed={all} onClick={() => setAll(true)}>
            すべて
          </button>
        </span>
        <button type="button" className="link small" onClick={refresh} disabled={fetching}>
          {fetching ? '読み込んでいます…' : '読み直す'}
        </button>
        <span className="note">5 秒ごとに読み直します</span>
      </div>
      {problem !== undefined ? <p className="note req-problem">{problem}</p> : null}
      {list !== undefined && shown.length === 0 ? <p className="note">{all ? 'このワークスペースは、まだリクエストを受けていません。' : 'このエンドポイントへのリクエストは、まだありません。'}</p> : null}
      <ol className="req-recent-list">
        {visible.map((item) => {
          const target = endpointForPath(endpoints, item.path);
          const elsewhere = target !== undefined && target.id !== endpoint;
          return (
            <li key={item.id} className={item.id === current ? 'current' : undefined}>
              <button type="button" className="req-recent-item" disabled={target === undefined} aria-current={item.id === current ? 'true' : undefined} onClick={() => onOpen(item)} title={target === undefined ? 'どのエンドポイントのリクエストか分かりません' : elsewhere ? `${target.label ?? target.id} のフローで開く` : 'このリクエストの道筋を再生する（送り直さない）'}>
                <span className="req-recent-head">
                  <span className="mono store-num">{item.id}</span>
                  <span className={`req-source req-source-${item.source}`}>{SOURCE_WORDS[item.source]}</span>
                  <span className="req-at">{timeOf(item.at)}</span>
                  {elsewhere ? <span className="req-note req-elsewhere">→ {target.label ?? target.id}</span> : null}
                </span>
                <span className="req-line">
                  <span className="req-method">{item.method}</span>
                  <code className="req-path">{shortKey(item.path, 72)}</code>
                  {item.status !== undefined ? <span className={`req-status req-${statusTone(item.status)}`}>{statusLine({ status: item.status })}</span> : <span className="req-status req-error">応答なし</span>}
                  {item.error !== undefined ? <code className="mono req-error-code">{item.error}</code> : null}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {shown.length > visible.length ? (
        <button type="button" className="link small" onClick={() => setMore(true)}>
          ほか {shown.length - visible.length} 件も出す
        </button>
      ) : null}
    </details>
  );
}
