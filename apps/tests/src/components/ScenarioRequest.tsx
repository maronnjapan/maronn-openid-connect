import type { LiveExchange, PreparedScenario } from '@maronn-openid-connect/live-op/api';
import { LiveOpClient, readerWorkspace } from '@maronn-openid-connect/live-op/client';
import { requestScenario, requestText, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useState } from 'react';
import { reasonPhrase, requestBlock, responseBlock, statusTone } from '../lib/exchange';
import { exampleRequestOf, exchangeResponse, mapExchangeLink, outcomeDifferences } from '../lib/live';
import { HttpView } from './CaseFlow';
import { Words } from './ui';

/** The client of the reader's workspace on the map's OP, at the origin the page is served from (the OP answers at its root). */
function liveClient(): LiveOpClient {
  return new LiveOpClient(readerWorkspace(), location.origin);
}

/** What the OP answered the case's request with, side by side with what the case expects, and the link that replays it on the map. */
function LiveAnswer({ exchange, scenario, framework }: { exchange: LiveExchange; scenario: RequestScenario; framework: string }) {
  // The map's OP is the OP of hono: its answer is read against what the case expects of hono.
  const expected = requestScenario(scenario.id, 'hono')?.expected ?? scenario.expected;
  const differences = outcomeDifferences(expected, exchange, location.origin);
  const response = exchangeResponse(exchange);
  return (
    <div className="scenario-request">
      <h3 className="flow-part-title">地図の OP の応答</h3>
      {exchange.status === undefined ? (
        <p className="result-line result-error" role="alert">OP が応答せずに例外を投げました（{exchange.thrown ?? '理由なし'}）</p>
      ) : (
        <p className={`result-line result-${statusTone(exchange.status)}`}>
          <span className="result-status num">{exchange.status} {reasonPhrase(exchange.status, exchange.response?.statusText)}</span>
          {exchange.error === undefined ? null : <code>{exchange.error}</code>}
        </p>
      )}
      {differences.length === 0 ? (
        <p className="result-detail">期待する応答のとおり</p>
      ) : (
        <>
          <p className="result-detail">期待する応答と違う</p>
          <ul className="result-detail" aria-label="期待との違い">
            {differences.map(({ what, expected: want, actual }) => <li key={what}>{what}：期待 <code>{want}</code>、実際 <code>{actual}</code></li>)}
          </ul>
        </>
      )}
      {response === undefined ? null : <HttpView block={responseBlock(response)} label="地図の OP の応答" />}
      <div className="scenario-actions">
        <a href={mapExchangeLink(framework, scenario.endpoint, exchange.id)}>この交換を map のフローで開く</a>
        <span className="flow-part-note">交換 {exchange.id}{framework === 'nextjs' ? '（地図の OP は Hono の OP）' : ''}</span>
      </div>
    </div>
  );
}

/** Prepare the case's request on the map's OP, show it with the requests that prepared it, and send it there to see the real answer. */
export function ScenarioRequest({ scenario, framework }: { scenario: RequestScenario; framework: string }) {
  const [prepared, setPrepared] = useState<PreparedScenario | Error>();
  const [revision, setRevision] = useState(0);
  const [copy, setCopy] = useState('');
  const [sent, setSent] = useState<LiveExchange | Error | 'sending'>();
  useEffect(() => {
    let active = true;
    liveClient().prepare(scenario.id).then(
      (value) => {
        if (active) setPrepared(value);
      },
      (error: unknown) => {
        if (active) setPrepared(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      active = false;
    };
  }, [scenario.id, revision]);

  /** Prepare the case again on the workspace: a new request, made by new requests. */
  function regenerate() {
    setPrepared(undefined);
    setSent(undefined);
    setCopy('');
    setRevision((current) => current + 1);
  }

  /** Send the prepared request to the map's OP and keep the exchange it was recorded as. */
  async function send(request: PreparedScenario['request']) {
    setSent('sending');
    try {
      setSent(await liveClient().run(request));
    } catch (error) {
      setSent(error instanceof Error ? error : new Error(String(error)));
    }
  }

  const shown = prepared === undefined || prepared instanceof Error ? undefined : exampleRequestOf(prepared.request, location.host);
  return (
    <section className="case-flow" aria-labelledby="scenario-title">
      <h2 id="scenario-title" className="check-title">{scenario.title}</h2>
      <p className="scenario-purpose"><Words text={scenario.purpose} /></p>
      {scenario.external === undefined ? null : <p className="flow-part-note">{scenario.external}</p>}
      <div className="scenario-request">
        <h3 className="flow-part-title">地図の OP で準備したリクエスト</h3>
        {prepared === undefined ? (
          <p className="flow-part-note" role="status">地図の OP でリクエストを準備しています…</p>
        ) : prepared instanceof Error || shown === undefined ? (
          <>
            <p className="note" role="alert">リクエストを準備できませんでした（{prepared instanceof Error ? prepared.message : '理由なし'}）</p>
            <button type="button" className="text-button" onClick={regenerate}>準備し直す</button>
          </>
        ) : (
          <>
            <HttpView block={requestBlock(shown)} label="地図の OP で準備したリクエスト" />
            <div className="scenario-actions">
              {scenario.external === undefined ? (
                <button type="button" className="text-button" disabled={sent === 'sending'} onClick={() => void send(prepared.request)}>
                  {sent === 'sending' ? '送っています…' : '地図の OP で送る'}
                </button>
              ) : null}
              <button type="button" className="text-button" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(requestText(shown));
                  setCopy('リクエストをコピーしました。');
                } catch {
                  setCopy('リクエストをコピーできませんでした。');
                }
              }}>HTTP リクエストをコピー</button>
              <button type="button" className="text-button" onClick={regenerate}>準備し直す</button>
              <a href={`../#${framework}--${encodeURIComponent(scenario.endpoint)};r=${encodeURIComponent(scenario.id)}`}>このケースを map で開く</a>
              <span className="flow-part-note" role="status">{copy}</span>
            </div>
            {prepared.steps.length === 0 && (prepared.notes ?? []).length === 0 ? null : (
              <details className="scenario-details">
                <summary>準備に送ったリクエスト（{prepared.steps.length} 件）</summary>
                <p className="flow-part-note">コード、トークン、Cookie、CSRF トークンは、どれもこのリクエストに地図の OP が返した値です。ワークスペースの状態は残るので、同じコードは二度使えません。</p>
                <ol>
                  {prepared.steps.map((step) => (
                    <li key={step.id}>
                      <code>{step.method} {step.path.split('?')[0]}</code> → <code>{step.status ?? '例外'}</code>
                      {step.error === undefined ? null : <> <code>{step.error}</code></>}
                    </li>
                  ))}
                </ol>
                {(prepared.notes ?? []).length === 0 ? null : <ul>{(prepared.notes ?? []).map((note) => <li key={note}>{note}</li>)}</ul>}
              </details>
            )}
          </>
        )}
      </div>
      {sent === undefined || sent === 'sending' ? null : sent instanceof Error ? (
        <p className="note" role="alert">地図の OP に送れませんでした（{sent.message}）</p>
      ) : (
        <LiveAnswer exchange={sent} scenario={scenario} framework={framework} />
      )}
      <div className="scenario-request">
        <h3 className="flow-part-title">期待する応答</h3>
        <p className={`result-line result-${statusTone(scenario.expected.status)}`}>
          <span className="result-status num">{scenario.expected.status} {reasonPhrase(scenario.expected.status)}</span>
          {scenario.expected.error === undefined ? null : <code>{scenario.expected.error}</code>}
          <Words text={scenario.expected.description} />
        </p>
      </div>
    </section>
  );
}
