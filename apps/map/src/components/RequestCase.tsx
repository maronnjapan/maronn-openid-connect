import { useEffect, useState } from 'react';
import type { ExchangeSummary, PreparedScenario } from '@maronn-openid-connect/live-op/api';
import { requestText, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { statusLine, statusTone } from '../lib/requests';
import { liveClient, liveProblem, notifyLiveChanged } from './useLive';

/** The preparations sent, by the hook that asked, the case and the revision: an effect run again for the same ones (React's development checks run each twice) takes the one sent, as a preparation sends requests that change the workspace. */
const preparing = new Map<string, Promise<PreparedScenario>>();

/** Prepare a case once for a key (see preparing). */
function prepareOnce(key: string, id: string): Promise<PreparedScenario> {
  let pending = preparing.get(key);
  if (pending === undefined) {
    pending = liveClient().prepare(id);
    preparing.set(key, pending);
    pending.then(notifyLiveChanged, () => undefined);
  }
  return pending;
}

/** A case prepared on the reader's workspace, or why it could not be. */
export type RequestCaseResult = { id: string; revision: number; prepared: PreparedScenario } | { id: string; revision: number; error: string };

/**
 * Prepare the request of the selected case on the reader's workspace of the
 * live OP (`POST /__live/scenario`): the OP answers the requests that lead
 * up to it (an authorization, a login, a code exchanged…), and gives the
 * request to send, its values the workspace's own. Prepared again on asking
 * (`regenerate`), and only where the map runs requests (`runnable`).
 */
export function useRequestCase(scenario: RequestScenario | undefined, runnable: boolean) {
  const id = runnable ? scenario?.id : undefined;
  const [selection, setSelection] = useState({ id, revision: 0 });
  const same = selection.id === id;
  if (!same) setSelection({ id, revision: selection.revision + 1 });
  const { revision } = selection;
  const [asker] = useState(() => Math.random().toString(36).slice(2));
  const [result, setResult] = useState<RequestCaseResult>();
  useEffect(() => {
    if (id === undefined) return undefined;
    let active = true;
    prepareOnce(`${asker}:${id}:${revision}`, id).then(
        (prepared) => {
          if (active) setResult({ id, revision, prepared });
        },
        (error: unknown) => {
          if (active) setResult({ id, revision, error: liveProblem(error) });
        },
      );
    return () => {
      active = false;
    };
  }, [asker, id, revision]);
  return {
    revision,
    result: same && result?.id === id && result?.revision === revision ? result : undefined,
    regenerate: () => setSelection((current) => ({ ...current, revision: current.revision + 1 })),
  };
}

/** What a case panel shows and what it tells the trace (see RequestCase). */
export interface RequestCaseProps {
  scenarios: readonly RequestScenario[];
  selected: RequestScenario | undefined;
  result: RequestCaseResult | undefined;
  /** Why the map does not run this case's request (Next.js); undefined where it does. */
  unrunnable: string | undefined;
  testsUrl: string;
  compact: boolean;
  onSelect: (id: string) => void;
  onRegenerate: () => void;
  onTry?: (() => void) | undefined;
  /** Open an exchange of the preparation in the flow of its endpoint. */
  onOpenExchange: (summary: ExchangeSummary) => void;
}

/** The purpose of an endpoint's case, the response it expects, and the request prepared for it on the live OP with the requests that prepared it. */
export function RequestCase({ scenarios, selected, result, unrunnable, testsUrl, compact, onSelect, onRegenerate, onTry, onOpenExchange }: RequestCaseProps) {
  return (
    <section className="request-case" aria-label="想定リクエスト">
      <label className="flow-way">
        <span className="flow-label">想定リクエスト</span>
        <select value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
          <option value="">目的からケースを選ぶ</option>
          {scenarios.map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.title}
            </option>
          ))}
        </select>
      </label>
      {selected !== undefined ? (
        <div className="request-case-detail" key={selected.id}>
          <p>{selected.purpose}</p>
          <p>
            <strong>期待する応答</strong> <code>{selected.expected.status}</code> {selected.expected.error === undefined ? null : <><code>{selected.expected.error}</code> </>}
            {selected.expected.description}
          </p>
          {selected.external === undefined ? null : <p className="note">{selected.external}</p>}
          {unrunnable !== undefined ? (
            <p className="note">{unrunnable}</p>
          ) : result === undefined ? (
            <p role="status">地図の OP で、このケースのリクエストを準備しています…</p>
          ) : 'error' in result ? (
            <p role="alert" className="req-problem">リクエストを準備できませんでした（{result.error}）</p>
          ) : compact ? (
            <details>
              <summary>準備したリクエスト（準備に {result.prepared.steps.length} 件のリクエスト）</summary>
              <PreparedRequest key={result.revision} prepared={result.prepared} onOpenExchange={onOpenExchange} />
            </details>
          ) : (
            <PreparedRequest key={result.revision} prepared={result.prepared} onOpenExchange={onOpenExchange} />
          )}
          <div className="request-case-actions">
            {onTry !== undefined ? (
              <button type="button" className="code-button" onClick={onTry}>
                地図の OP で試す
              </button>
            ) : null}
            {unrunnable === undefined ? (
              <button type="button" className="code-button" onClick={onRegenerate} title="地図の OP で、準備のリクエストからもう一度送る">
                準備し直す
              </button>
            ) : null}
            <a href={testsUrl}>このケースを tests で見る</a>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The request prepared for a case, as HTTP, to copy; the requests that prepared it on the workspace, each to open in its endpoint's flow; and what the preparation did besides requests (the clock moved on). */
function PreparedRequest({ prepared, onOpenExchange }: { prepared: PreparedScenario; onOpenExchange: (summary: ExchangeSummary) => void }) {
  const { request, steps, notes = [] } = prepared;
  const text = requestText({ method: request.method, path: request.path, host: location.host, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
  const [copyStatus, setCopyStatus] = useState('');
  async function copyRequest() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus('コピーしました');
    } catch {
      setCopyStatus('リクエスト欄から直接コピーできます');
    }
  }
  return (
    <>
      <pre tabIndex={0} aria-label="準備した HTTP リクエスト">
        {text}
      </pre>
      <div className="request-case-actions">
        <button type="button" className="code-button" onClick={() => void copyRequest()}>
          リクエストをコピー
        </button>
        <span role="status">{copyStatus}</span>
      </div>
      {notes.length > 0 ? (
        <ul className="plain note">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      ) : null}
      {steps.length === 0 ? null : (
        <details>
          <summary>準備に送ったリクエスト（{steps.length} 件。押すとそのエンドポイントのフローで道筋を見られる）</summary>
          <ol className="case-steps">
            {steps.map((step) => (
              <li key={step.id}>
                <button type="button" className="link small case-step" onClick={() => onOpenExchange(step)} title="このリクエストを、そのエンドポイントのフローで開く">
                  <span className="mono store-num">{step.id}</span> <code>{step.method} {step.path.split('?')[0]}</code>
                  {step.status !== undefined ? <span className={`req-status req-${statusTone(step.status)}`}> → {statusLine({ status: step.status })}</span> : null}
                  {step.error !== undefined ? <code className="mono req-error-code"> {step.error}</code> : null}
                </button>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}
