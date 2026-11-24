import type { PreparedRequestScenario } from '@maronn-openid-connect/map-sandbox';
import { prepareRequestScenarioInSandbox } from '@maronn-openid-connect/map-sandbox/browser';
import { requestText, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useState } from 'react';

type RequestResult =
  | { id: string; framework: string; revision: number; prepared: PreparedRequestScenario }
  | { id: string; framework: string; revision: number; error: string };

/** Generate a fresh request for the selected case and discard older selections' results. */
export function useRequestCase(scenario: RequestScenario | undefined, framework: string) {
  const id = scenario?.id;
  const [selection, setSelection] = useState({ id, framework, revision: 0 });
  const sameSelection = selection.id === id && selection.framework === framework;
  if (!sameSelection) setSelection({ id, framework, revision: selection.revision + 1 });
  const { revision } = selection;
  const [result, setResult] = useState<RequestResult>();
  useEffect(() => {
    if (id === undefined) return;
    let active = true;
    prepareRequestScenarioInSandbox(id, framework).then(
      (prepared) => { if (active) setResult({ id, framework, revision, prepared }); },
      (error: unknown) => { if (active) setResult({ id, framework, revision, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { active = false; };
  }, [id, framework, revision]);
  return {
    revision,
    result: sameSelection && result?.id === id && result?.framework === framework && result?.revision === revision ? result : undefined,
    regenerate: () => setSelection((current) => ({ ...current, revision: current.revision + 1 })),
  };
}

/** The purpose, generated HTTP request and expected response of an endpoint case. */
export function RequestCase({ scenarios, selected, result, testsUrl, compact, onSelect, onRegenerate, onTry }: {
  scenarios: readonly RequestScenario[];
  selected: RequestScenario | undefined;
  result: RequestResult | undefined;
  testsUrl: string;
  compact: boolean;
  onSelect: (id: string) => void;
  onRegenerate: () => void;
  onTry?: () => void;
}) {
  return (
    <section className="request-case" aria-label="想定リクエスト">
      <label className="flow-way">
        <span className="flow-label">想定リクエスト</span>
        <select value={selected?.id ?? ''} onChange={(event) => onSelect(event.target.value)}>
          <option value="">目的からケースを選ぶ</option>
          {scenarios.map((scenario) => <option key={scenario.id} value={scenario.id}>{scenario.title}</option>)}
        </select>
      </label>
      {selected !== undefined ? (
        <div className="request-case-detail" key={selected.id}>
          <p>{selected.purpose}</p>
          <p><strong>期待する応答</strong> <code>{selected.expected.status}</code> {selected.expected.error === undefined ? null : <><code>{selected.expected.error}</code> </>}{selected.expected.description}</p>
          {selected.external === undefined ? null : <p className="note">{selected.external}</p>}
          {result === undefined ? <p role="status">リクエストを生成しています…</p> : 'error' in result ? (
            <p role="alert">リクエストを生成できませんでした（{result.error}）</p>
          ) : compact ? (
            <details>
              <summary>生成した HTTP リクエスト</summary>
              <RequestExample key={result.revision} prepared={result.prepared} />
            </details>
          ) : <RequestExample key={result.revision} prepared={result.prepared} />}
          <div className="request-case-actions">
            {onTry !== undefined ? <button type="button" className="code-button" onClick={onTry}>地図の OP で試す</button> : null}
            <button type="button" className="code-button" onClick={onRegenerate}>再生成</button>
            <a href={testsUrl}>このケースを tests で見る</a>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** The generated HTTP message and the preparation used to create it. */
function RequestExample({ prepared: { generated, premises } }: { prepared: PreparedRequestScenario }) {
  const text = requestText(generated.request);
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
      <pre tabIndex={0} aria-label="生成した HTTP リクエスト">{text}</pre>
      <div className="request-case-actions">
        <button type="button" className="code-button" onClick={() => void copyRequest()}>リクエストをコピー</button>
        <span role="status">{copyStatus}</span>
      </div>
      {premises.steps.length === 0 ? null : (
        <details>
          <summary>準備に使ったリクエスト（{premises.steps.length} 件）</summary>
          <ol>
            {premises.steps.map(({ request, response }, index) => <li key={index}><code>{request.method} {new URL(request.url).pathname}</code> → <code>{response.status}</code></li>)}
          </ol>
        </details>
      )}
      {generated.registration === undefined && generated.codeVerifier === undefined ? null : (
        <details>
          <summary>送信に使うクライアント設定</summary>
          {generated.registration === undefined ? null : <pre aria-label="クライアント登録情報">{JSON.stringify(generated.registration, null, 2)}</pre>}
          {generated.codeVerifier === undefined ? null : <p className="note">認可コードの交換に使う <code>code_verifier</code> <code>{generated.codeVerifier}</code></p>}
        </details>
      )}
    </>
  );
}
