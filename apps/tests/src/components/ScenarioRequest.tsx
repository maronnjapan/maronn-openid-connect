import { generateRequestScenario, requestText, type GeneratedRequestScenario, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useState } from 'react';
import { reasonPhrase, requestBlock, statusTone } from '../lib/exchange';
import { HttpView } from './CaseFlow';
import { Words } from './ui';

/** Generate the request for the active purpose and show what is needed to send it. */
export function ScenarioRequest({ scenario }: { scenario: RequestScenario }) {
  const [generated, setGenerated] = useState<GeneratedRequestScenario | Error>();
  const [copy, setCopy] = useState('');
  useEffect(() => {
    let active = true;
    generateRequestScenario(scenario.id).then(
      (value) => {
        if (active) setGenerated(value);
      },
      (error: unknown) => {
        if (active) setGenerated(error instanceof Error ? error : new Error(String(error)));
      },
    );
    return () => {
      active = false;
    };
  }, [scenario.id]);

  return (
    <section className="case-flow" aria-labelledby="scenario-title">
      <h2 id="scenario-title" className="check-title">{scenario.title}</h2>
      <p className="scenario-purpose"><Words text={scenario.purpose} /></p>
      <div className="scenario-request">
        <h3 className="flow-part-title">生成したリクエスト</h3>
        {generated === undefined ? (
          <p className="flow-part-note" role="status">リクエストを生成しています…</p>
        ) : generated instanceof Error ? (
          <p className="note" role="alert">リクエストを生成できませんでした（{generated.message}）</p>
        ) : (
          <>
            <HttpView block={requestBlock(generated.request)} label="生成したリクエスト" />
            <div className="scenario-actions">
              <button type="button" className="text-button" onClick={async () => {
                try {
                  await navigator.clipboard.writeText(requestText(generated.request));
                  setCopy('リクエストをコピーしました。');
                } catch {
                  setCopy('リクエストをコピーできませんでした。');
                }
              }}>HTTP リクエストをコピー</button>
              <span className="flow-part-note" role="status">{copy}</span>
            </div>
            <details className="scenario-details">
              <summary>クライアント設定と PKCE</summary>
              <p className="flow-part-note">このリクエスト例で使うクライアントの登録情報です。</p>
              <pre>{JSON.stringify(generated.registration, null, 2)}</pre>
              <p className="flow-part-note">認可コードの交換で使う <code>code_verifier</code> です。</p>
              <pre>{generated.codeVerifier}</pre>
            </details>
          </>
        )}
      </div>
      <div className="scenario-request">
        <h3 className="flow-part-title">期待する応答</h3>
        <p className={`result-line result-${statusTone(scenario.expected.status)}`}>
          <span className="result-status num">{scenario.expected.status} {reasonPhrase(scenario.expected.status)}</span>
          <Words text={scenario.expected.description} />
        </p>
      </div>
    </section>
  );
}
