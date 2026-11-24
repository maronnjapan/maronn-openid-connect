import { generateRequestScenario, requestText, type GeneratedRequestScenario, type RequestScenario } from '@maronn-openid-connect/test-catalog/premises';
import { useEffect, useState } from 'react';

type RequestResult =
  | { id: string; revision: number; generated: GeneratedRequestScenario }
  | { id: string; revision: number; error: string };

/** Generate a fresh request for the selected case and discard older selections' results. */
export function useRequestCase(scenario: RequestScenario | undefined) {
  const id = scenario?.id;
  const [selection, setSelection] = useState({ id, revision: 0 });
  if (selection.id !== id) setSelection({ id, revision: selection.revision + 1 });
  const { revision } = selection;
  const [result, setResult] = useState<RequestResult>();
  useEffect(() => {
    if (id === undefined) return;
    let active = true;
    generateRequestScenario(id).then(
      (generated) => { if (active) setResult({ id, revision, generated }); },
      (error: unknown) => { if (active) setResult({ id, revision, error: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { active = false; };
  }, [id, revision]);
  return {
    revision,
    result: selection.id === id && result?.id === id && result?.revision === revision ? result : undefined,
    regenerate: () => setSelection((current) => ({ id, revision: current.revision + 1 })),
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
          <p><strong>期待する応答</strong> <code>{selected.expected.status}</code> {selected.expected.description}</p>
          {result === undefined ? <p role="status">リクエストを生成しています…</p> : 'error' in result ? (
            <p role="alert">リクエストを生成できませんでした（{result.error}）</p>
          ) : compact ? (
            <details>
              <summary>HTTP リクエストとクライアント設定</summary>
              <RequestExample key={result.revision} generated={result.generated} />
            </details>
          ) : <RequestExample key={result.revision} generated={result.generated} />}
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

/** The generated HTTP message and the client settings needed to run it. */
function RequestExample({ generated }: { generated: GeneratedRequestScenario }) {
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
      <details>
        <summary>送信に使うクライアント設定</summary>
        <p className="note">検証先の OP に同じクライアント ID とリダイレクト URI を登録します。署名付きのケースでは公開鍵も登録します。</p>
        <pre aria-label="クライアント登録情報">{JSON.stringify(generated.registration, null, 2)}</pre>
        <p className="note">認可コードの交換に使う <code>code_verifier</code> <code>{generated.codeVerifier}</code></p>
      </details>
    </>
  );
}
