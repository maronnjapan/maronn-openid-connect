/**
 * A case as a request going through the endpoint, top to bottom, the way
 * the RFCs tell a flow: ① the request a measured API test sent that took
 * the case's way (例 1 / 3 when several did), ② the steps it went through,
 * in order, as a vertical flow of numbered boxes joined by arrows, each with
 * its kind, the values it reads and hands on, what happened in it (ここで
 * 応答, ここで失敗, …), the decisions it met and the functions it ran, and
 * ③ the response it got.
 *
 * Without an example (no measured run, or no recorded request took the
 * way): why there is none, the case's own steps with the conditions of its
 * way where their step is, and how the case ends in words.
 *
 * The step the playback of the case is at (the timeline on the left) is
 * lit here too.
 */
import type { CaseCondition, CaseExample, EndpointCase, OutlineEndpoint } from '@maronn-openid-connect/test-catalog/model';
import { Fragment, useState } from 'react';
import { HOW_LABELS, looseConditions, NO_EXAMPLE_NOTES, noExampleReason, resultWords, STEP_KIND_LABELS, waySteps, type WayStep } from '../lib/cases';
import { KIND_LABELS } from '../lib/data';
import { errorCodeOf, jsonLines, reasonPhrase, requestBlock, responseBlock, statusTone, type HttpBlock, type HttpLine, type Piece } from '../lib/exchange';
import { titleOf } from '../lib/filter';
import { formatCount } from '../lib/format';
import { formatCode, withoutPanel } from '../lib/route';
import { stepHasCode } from '../lib/targets';
import { useApp } from './app-context';
import { CodeButton } from './CodeRefs';
import { StatusIcon, Words } from './ui';

/** Which long values of a block are open, by id, and how to open or close one. */
interface Opened {
  open: ReadonlySet<string>;
  toggle: (id: string) => void;
}

/**
 * A long value shortened in the middle (`head…tail`), its whole text on
 * hover. A click on it opens it too, so a phone need not scroll to the
 * button at the end of its line (which is what the keyboard and a screen
 * reader use).
 */
function LongValue({ piece, opened }: { piece: Extract<Piece, { kind: 'long' }>; opened: Opened }) {
  return (
    <span className={`http-long${piece.tone === undefined ? '' : ` tok-${piece.tone}`}`} title={piece.text} onClick={() => opened.toggle(piece.id)}>
      {piece.head}
      <span className="http-ellipsis" aria-hidden="true">
        …
      </span>
      <span className="visually-hidden">（{formatCount(piece.text.length - piece.head.length - piece.tail.length)} 文字を省略）</span>
      {piece.tail}
    </span>
  );
}

/** At the end of the line of a long value: a `JWT` tag on a JWT, and a button that opens the value under the line. */
function LongControls({ piece, opened }: { piece: Extract<Piece, { kind: 'long' }>; opened: Opened }) {
  const open = opened.open.has(piece.id);
  return (
    <span className="http-controls">
      {piece.jwt !== undefined && <span className="jwt-tag">JWT</span>}
      <button type="button" className="http-toggle" aria-expanded={open} onClick={() => opened.toggle(piece.id)}>
        {open ? '畳む' : piece.jwt !== undefined ? '中身を見る' : '全体を見る'}
      </button>
    </span>
  );
}

/** What an open long value shows under its line: its whole text, and for a JWT its decoded header and payload. */
function Expanded({ piece, opened }: { piece: Extract<Piece, { kind: 'long' }>; opened: Opened }) {
  return (
    <div className="http-expand">
      <span className="http-expand-label">全体（{formatCount(piece.text.length)} 文字）</span>
      <span className="http-full">{piece.text}</span>
      {piece.jwt !== undefined && (
        <>
          <span className="http-expand-label">ヘッダー（デコードしただけで、署名は検証していません）</span>
          <div className="http-json">
            <Lines lines={jsonLines(piece.jwt.header, `${piece.id}.header`)} opened={opened} />
          </div>
          {piece.jwt.payload !== undefined && (
            <>
              <span className="http-expand-label">ペイロード</span>
              <div className="http-json">
                <Lines lines={jsonLines(piece.jwt.payload, `${piece.id}.payload`, true)} opened={opened} />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** Some lines of a block: each with its pieces (the controls of its long values at its end), the note under it, and the long values of it that are open. */
function Lines({ lines, opened }: { lines: readonly HttpLine[]; opened: Opened }) {
  return (
    <>
      {lines.map((line, index) => {
        const longs = line.pieces.filter((piece): piece is Extract<Piece, { kind: 'long' }> => piece.kind === 'long');
        const open = longs.filter((piece) => opened.open.has(piece.id));
        return (
          <Fragment key={index}>
            <div className="http-line">
              {line.pieces.map((piece, at) =>
                piece.kind === 'long' ? (
                  <LongValue key={at} piece={piece} opened={opened} />
                ) : (
                  <span key={at} className={piece.tone === undefined ? undefined : `tok-${piece.tone}`}>
                    {piece.text}
                  </span>
                ),
              )}
              {longs.map((piece) => (
                <LongControls key={piece.id} piece={piece} opened={opened} />
              ))}
            </div>
            {line.note !== undefined && <div className="http-note">↳ {line.note}</div>}
            {open.map((piece) => (
              <Expanded key={piece.id} piece={piece} opened={opened} />
            ))}
          </Fragment>
        );
      })}
    </>
  );
}

/** A request or a response as the RFCs show one: a block of code that scrolls sideways inside itself, the notes of how it is shown under it. */
function HttpView({ block, label }: { block: HttpBlock; label: string }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const opened: Opened = {
    open,
    toggle: (id) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setOpen(next);
    },
  };
  return (
    <figure className="http" aria-label={label}>
      <div className="http-scroll">
        <div className="http-code">
          <Lines lines={block.head} opened={opened} />
          {block.body.length > 0 && (
            <>
              <div className="http-line http-blank" aria-hidden="true">
                {' '}
              </div>
              <Lines lines={block.body} opened={opened} />
            </>
          )}
        </div>
      </div>
      {block.notes.length > 0 && <figcaption className="http-notes">{block.notes.join(' ')}</figcaption>}
    </figure>
  );
}

/** The test that sent a request: its result, its kind and its title in the page's language; choosing it opens the test in the panel. */
function SentBy({ id }: { id: string }) {
  const { db, view, go, lang } = useApp();
  const entry = db.byId.get(id);
  if (entry === undefined) return <span className="muted">テスト {id}（一覧にありません）</span>;
  return (
    <button type="button" className="example-test" title={`${entry.file}:${entry.lines[0]}`} onClick={() => go({ ...withoutPanel(view), test: id })}>
      <StatusIcon status={entry.result} />
      <span className="badge">{KIND_LABELS[entry.kind]}</span>
      <span className="example-test-title">{titleOf(entry, lang)}</span>
    </button>
  );
}

/** A decision and the side taken, as the outline words them: `refreshTokenRequest ?? …` → `null または undefined`. */
function Decision({ condition }: { condition: CaseCondition }) {
  return (
    <li className="way-decision">
      <span className="way-decision-text">{condition.code ? <code>{condition.text}</code> : <Words text={condition.text} />}</span>
      <span className="way-decision-arrow" aria-hidden="true">
        →
      </span>
      <span className="visually-hidden">、通った側: </span>
      <span className={`way-decision-side${condition.side === '失敗する' ? ' way-decision-fails' : ''}`}>{condition.side}</span>
    </li>
  );
}

/** A function a step ran, by name: choosing it opens its code in the panel (when the data has it). */
function FunctionRef({ id }: { id: string }) {
  const { db, view, go } = useApp();
  const fn = db.functions[id];
  const name = fn?.name ?? id.slice(id.lastIndexOf('#') + 1);
  if (fn?.code === undefined) {
    return (
      <code className="way-call way-call-static" title={id}>
        {name}
      </code>
    );
  }
  return (
    <button type="button" className="way-call" title={`${fn.package}:${fn.module} のコードを見る`} onClick={() => go({ ...withoutPanel(view), code: formatCode({ kind: 'fn', id }) })}>
      {name}
    </button>
  );
}

/** Some values a step reads or hands on, each as code, under a word that says which. */
function Values({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <span className="way-io-part">
      <span className="way-io-label">{label}</span>
      {values.map((value) => (
        <code key={value} className="way-value">
          {value}
        </code>
      ))}
    </span>
  );
}

/** One box of the steps: its number, label and kind, what it reads and hands on, what happened in it, and the decisions and functions of it. */
function WayStepBox({ item, index, next, playing, endpointKey }: { item: WayStep; index: number; next: WayStep | undefined; playing: boolean; endpointKey: string }) {
  const { db } = useApp();
  const kind = item.step?.kind;
  const consumes = item.step?.consumes ?? [];
  // A step that failed hands nothing on.
  const produces = item.how === 'failed' ? [] : (item.step?.produces ?? []);
  // The arrow to the next box is the way of a failure when this box failed (or hands a failure on), as an error edge of a flowchart.
  const errorEdge = next !== undefined && (item.how === 'failed' || next.how === 'caught');
  return (
    <li className={`way-step way-step-${item.how}${playing ? ' way-step-playing' : ''}`} aria-current={playing ? 'step' : undefined}>
      <div className="way-step-box">
        <div className="way-step-head">
          <span className="way-step-no num" aria-hidden="true">
            {index + 1}
          </span>
          <span className="way-step-label">
            <span className="visually-hidden">ステップ {index + 1}: </span>
            {item.label}
          </span>
          {kind !== undefined && <span className={`kind-tag kind-${kind}`}>{STEP_KIND_LABELS[kind]}</span>}
          {item.step !== undefined && stepHasCode(db, item.step) && <CodeButton target={{ kind: 'step', key: endpointKey, step: item.id }} label={`「${item.label}」のコードを見る`} className="way-step-code" />}
        </div>
        {item.how !== 'ran' && (
          <p className={`way-how way-how-${item.how}`}>
            <span aria-hidden="true">{item.how === 'answered' ? '■' : item.how === 'failed' ? '✕' : '↩'}</span> {HOW_LABELS[item.how]}
            {item.error !== undefined && (
              <>
                : <code>{item.error}</code>
              </>
            )}
          </p>
        )}
        {(consumes.length > 0 || produces.length > 0) && (
          <p className="way-io">
            {consumes.length > 0 && <Values label="読む" values={consumes} />}
            {consumes.length > 0 && produces.length > 0 && (
              <span className="way-io-arrow" aria-hidden="true">
                →
              </span>
            )}
            {produces.length > 0 && <Values label="渡す" values={produces} />}
          </p>
        )}
        {item.decisions.length > 0 && (
          <ul className="way-decisions" aria-label="判断と、通った側">
            {item.decisions.map((condition, at) => (
              <Decision key={at} condition={condition} />
            ))}
          </ul>
        )}
        {item.calls.length > 0 && (
          <p className="way-calls">
            <span className="way-io-label">実行した関数</span>
            {item.calls.map((id) => (
              <FunctionRef key={id} id={id} />
            ))}
          </p>
        )}
      </div>
      {next !== undefined && (
        <span className={`way-edge${errorEdge ? ' way-edge-error' : ''}`} aria-hidden="true">
          {errorEdge && <span className="way-edge-label">失敗</span>}
        </span>
      )}
    </li>
  );
}

/** The heading of a part of the flow: its number in a circle and its name. */
function PartTitle({ no, children }: { no: number; children: string }) {
  return (
    <h3 className="flow-part-title">
      <span className="flow-part-no num" aria-hidden="true">
        {no}
      </span>
      {children}
    </h3>
  );
}

/** ① The request: the test that sent it and 例 n / m, then the request; without an example, why there is none. */
function RequestPart({ chosen, example, index, onIndex, reason }: { chosen: EndpointCase; example: CaseExample | undefined; index: number; onIndex: (index: number) => void; reason: string }) {
  const examples = chosen.examples ?? [];
  const count = chosen.exampleCount ?? examples.length;
  return (
    <li className="flow-part">
      <PartTitle no={1}>リクエスト</PartTitle>
      {example === undefined ? (
        <div className="flow-empty">
          <p>このケースを通ったリクエストの例はありません。</p>
          <p className="flow-empty-note">
            <Words text={reason} />
          </p>
        </div>
      ) : (
        <>
          <div className="example-bar">
            <span className="example-from">
              送ったテスト <SentBy id={example.test} />
            </span>
            {(examples.length > 1 || count > examples.length) && (
              <span className="example-nav" role="group" aria-label="リクエストの例">
                {examples.length > 1 && (
                  <>
                    <button type="button" className="example-step" aria-label="前の例" disabled={index === 0} onClick={() => onIndex(index - 1)}>
                      ‹
                    </button>
                    <span className="example-count num" aria-live="polite">
                      例 {index + 1} / {examples.length}
                    </span>
                    <button type="button" className="example-step" aria-label="次の例" disabled={index >= examples.length - 1} onClick={() => onIndex(index + 1)}>
                      ›
                    </button>
                  </>
                )}
                {count > examples.length && <span className="example-total">この道筋を通ったリクエストは全部で {formatCount(count)} 件</span>}
              </span>
            )}
          </div>
          <HttpView key={`request:${index}`} block={requestBlock(example.request)} label="リクエスト" />
        </>
      )}
    </li>
  );
}

/** ② The steps the request went through, as a vertical flow; without an example, the conditions of the way that are in no step above them. */
function StepsPart({ endpoint, chosen, way, measured, playing }: { endpoint: OutlineEndpoint; chosen: EndpointCase; way: readonly WayStep[]; measured: boolean; playing: string | undefined }) {
  // A request's steps say the decisions it met; the case's own conditions stand in for them only without one.
  const loose = measured ? [] : looseConditions(chosen);
  return (
    <li className="flow-part">
      <PartTitle no={2}>ステップ</PartTitle>
      <p className="flow-part-note">
        通るステップ <strong className="num">{formatCount(way.length)}</strong> 個を、リクエストが届く順に並べています。
      </p>
      {loose.length > 0 && (
        <div className="way-loose">
          <span className="way-io-label">ステップの外の判断</span>
          <ul className="way-decisions">
            {loose.map((condition, at) => (
              <Decision key={at} condition={condition} />
            ))}
          </ul>
        </div>
      )}
      {way.length === 0 ? (
        <p className="flow-empty-note">このケースが通るステップは、処理の流れにありません。</p>
      ) : (
        <ol className="way-steps">
          {way.map((item, index) => (
            <WayStepBox key={`${item.id}:${index}`} item={item} index={index} next={way[index + 1]} playing={playing === item.id} endpointKey={endpoint.key} />
          ))}
        </ol>
      )}
    </li>
  );
}

/** ③ The result: the status and the OAuth error of the response, then the response; without an example, how the case ends in words. */
function ResultPart({ chosen, example, index }: { chosen: EndpointCase; example: CaseExample | undefined; index: number }) {
  if (example === undefined) {
    const failed = chosen.end !== 'response';
    return (
      <li className="flow-part">
        <PartTitle no={3}>結果</PartTitle>
        <p className={`result-line result-${failed ? 'error' : 'ok'}`}>
          <span aria-hidden="true">{failed ? '✕' : '■'}</span> {resultWords(chosen)}
        </p>
        {chosen.failure !== undefined && (
          <p className="result-detail">
            失敗: <code>{chosen.failure.error}</code>（<code>{chosen.failure.name}</code> から）
          </p>
        )}
      </li>
    );
  }
  const { response } = example;
  const tone = statusTone(response.status);
  const error = errorCodeOf(response);
  return (
    <li className="flow-part">
      <PartTitle no={3}>結果</PartTitle>
      <p className={`result-line result-${tone}`}>
        <span className="result-status num">
          {response.status} {reasonPhrase(response.status, response.statusText)}
        </span>
        <span>{tone === 'ok' ? '応答した' : tone === 'redirect' ? 'リダイレクトで応答した' : 'エラーで応答した'}</span>
        {error !== undefined && (
          <span>
            error: <code>{error}</code>
          </span>
        )}
      </p>
      <HttpView key={`response:${index}`} block={responseBlock(response)} label="応答" />
    </li>
  );
}

/** A case as a request going through the endpoint (see the module comment). */
export function CaseFlow({ endpoint, cases, chosen, playing }: { endpoint: OutlineEndpoint; cases: readonly EndpointCase[]; chosen: EndpointCase; playing: string | undefined }) {
  const { db } = useApp();
  const [index, setIndex] = useState(0);
  const examples = chosen.examples ?? [];
  const at = Math.min(index, Math.max(0, examples.length - 1));
  const example = examples[at];
  const way = waySteps(endpoint, chosen, example);
  const reason = NO_EXAMPLE_NOTES[noExampleReason(db.index.measured === true, cases)];
  return (
    <section className="case-flow" aria-labelledby="case-flow-title">
      <h2 id="case-flow-title" className="check-title">
        <span className="check-title-label">このケースの流れ</span>
        <span className="check-title-name">
          <Words text={chosen.name} />
        </span>
      </h2>
      <ol className="flow-parts">
        <RequestPart chosen={chosen} example={example} index={at} onIndex={setIndex} reason={reason} />
        <StepsPart endpoint={endpoint} chosen={chosen} way={way} measured={example !== undefined} playing={playing} />
        <ResultPart chosen={chosen} example={example} index={at} />
      </ol>
    </section>
  );
}
