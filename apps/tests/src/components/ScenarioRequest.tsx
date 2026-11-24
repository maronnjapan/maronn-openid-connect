import type { PreparedRequestScenario } from '@maronn-openid-connect/map-sandbox';
import { prepareRequestScenarioInSandbox } from '@maronn-openid-connect/map-sandbox/browser';
import { requestText, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useState } from 'react';
import { reasonPhrase, requestBlock, statusTone } from '../lib/exchange';
import { HttpView } from './CaseFlow';
import { Words } from './ui';

/** Generate the request for the active purpose and show what is needed to send it. */
export function ScenarioRequest({ scenario, framework }: { scenario: RequestScenario; framework: string }) {
  const [prepared, setPrepared] = useState<PreparedRequestScenario | Error>();
  const [revision, setRevision] = useState(0);
  const [copy, setCopy] = useState('');
  useEffect(() => {
    let active = true;
    prepareRequestScenarioInSandbox(scenario.id, framework).then(
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
  }, [scenario.id, framework, revision]);

  /** Recreate the preparation and the request using the selected case. */
  function regenerate() {
    setPrepared(undefined);
    setCopy('');
    setRevision((current) => current + 1);
  }

  return (
    <section className="case-flow" aria-labelledby="scenario-title">
      <h2 id="scenario-title" className="check-title">{scenario.title}</h2>
      <p className="scenario-purpose"><Words text={scenario.purpose} /></p>
      {scenario.external === undefined ? null : <p className="flow-part-note">{scenario.external}</p>}
      <div className="scenario-request">
        <h3 className="flow-part-title">生成したリクエスト</h3>
        {prepared === undefined ? (
          <p className="flow-part-note" role="status">リクエストを生成しています…</p>
        ) : prepared instanceof Error ? (
          <>
            <p className="note" role="alert">リクエストを生成できませんでした（{prepared.message}）</p>
            <button type="button" className="text-button" onClick={regenerate}>再生成</button>
          </>
        ) : (
          <>
            <HttpView block={requestBlock(prepared.generated.request)} label="生成したリクエスト" />
            <div className="scenario-actions">
              <button type="button" className="text-button" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(requestText(prepared.generated.request));
                  setCopy('リクエストをコピーしました。');
                } catch {
                  setCopy('リクエストをコピーできませんでした。');
                }
              }}>HTTP リクエストをコピー</button>
              <button type="button" className="text-button" onClick={regenerate}>再生成</button>
              <a href={`../#${framework}--${encodeURIComponent(scenario.endpoint)};r=${encodeURIComponent(scenario.id)}`}>このケースを map で開く</a>
              <span className="flow-part-note" role="status">{copy}</span>
            </div>
            {prepared.premises.steps.length === 0 ? null : (
              <details className="scenario-details">
                <summary>準備に使ったリクエスト（{prepared.premises.steps.length} 件）</summary>
                <p className="flow-part-note">ここで発行したコードやトークンは、地図の OP が準備した状態で使えます。</p>
                <ol>
                  {prepared.premises.steps.map(({ request, response }, index) => <li key={index}><code>{request.method} {new URL(request.url).pathname}</code> → <code>{response.status}</code></li>)}
                </ol>
              </details>
            )}
            {prepared.generated.registration === undefined && prepared.generated.codeVerifier === undefined ? null : (
              <details className="scenario-details">
                <summary>クライアント設定と PKCE</summary>
                {prepared.generated.registration === undefined ? null : <pre aria-label="クライアント登録情報">{JSON.stringify(prepared.generated.registration, null, 2)}</pre>}
                {prepared.generated.codeVerifier === undefined ? null : <><p className="flow-part-note">認可コードの交換で使う <code>code_verifier</code> です。</p><pre>{prepared.generated.codeVerifier}</pre></>}
              </details>
            )}
          </>
        )}
      </div>
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
