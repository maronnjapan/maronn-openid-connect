/**
 * The code of a file of the data with line numbers and highlighting: a
 * range of it (a test with a little context, a function, an endpoint, a
 * helper, a step definition) or the whole file with the range marked and
 * scrolled into view; with `mark` (the file page) the whole file with a
 * test's lines marked. The text of a file is fetched once, when a view first
 * needs it, and highlighted once.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { codeWindow, inRange, type CodeMode } from '../lib/lines';
import { highlight, languageOf, type Token } from '../lib/tokenize';
import { useSource } from './app-context';
import { Segmented } from './ui';

/** A test's lines among its describe, or a range of code shown alone. */
export type CodeScope = 'test' | 'range';

const MODES: Record<CodeScope, ReadonlyArray<{ value: CodeMode; label: string }>> = {
  test: [
    { value: 'range', label: 'このテストだけ' },
    { value: 'file', label: 'ファイル全体' },
  ],
  range: [
    { value: 'range', label: 'この範囲だけ' },
    { value: 'file', label: 'ファイル全体' },
  ],
};

/** The highlighted lines of the files already shown, so opening another test of a file reads it once. */
const highlighted = new Map<string, Token[][]>();

function linesOf(path: string, text: string): Token[][] {
  let lines = highlighted.get(path);
  if (lines === undefined) {
    lines = highlight(text, languageOf(path));
    if (lines.length > 1 && lines[lines.length - 1]?.length === 0) lines.pop();
    highlighted.set(path, lines);
  }
  return lines;
}

export function CodeView({ path, lines, mark, fill, scope = 'test', caption }: { path: string; lines?: [number, number]; mark?: [number, number]; fill?: boolean; scope?: CodeScope; caption?: ReactNode }) {
  const source = useSource(path);
  const [mode, setMode] = useState<CodeMode>('range');
  const body = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => (source === undefined || source instanceof Error ? undefined : linesOf(path, source.text)), [path, source]);
  const shown: CodeMode = lines === undefined ? 'file' : mode;
  const span = tokens === undefined ? undefined : lines === undefined ? codeWindow(mark, tokens.length, 'file') : codeWindow(lines, tokens.length, shown, scope === 'test' ? { context: 3, markRange: true } : {});
  const from = span?.mark?.[0];
  const to = span?.mark?.[1];

  // Scroll the box, not the page, to put the first marked line near its top: measured in the box, wherever the box is (the panel is fixed).
  useLayoutEffect(() => {
    const box = body.current;
    if (box === null) return;
    const first = box.querySelector<HTMLElement>('.line-on');
    if (first === null) {
      box.scrollTop = 0;
      return;
    }
    const offset = first.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTop = Math.max(offset - 48, 0);
  }, [from, to, shown, tokens]);

  if (source instanceof Error) {
    return (
      <div className="code code-missing">
        {caption !== undefined && <div className="code-bar">{caption}</div>}
        <p className="note code-note">{source.message}</p>
      </div>
    );
  }
  return (
    <div className={`code${fill === true ? ' code-fill' : ''}`}>
      {(lines !== undefined || caption !== undefined) && (
        <div className="code-bar">
          {caption !== undefined && <div className="code-caption">{caption}</div>}
          {lines !== undefined && <Segmented size="small" label="コードの範囲" options={MODES[scope]} value={mode} onChange={setMode} />}
        </div>
      )}
      {span?.outside === true && lines !== undefined && (
        <p className="note code-note">
          {lines[0]}–{lines[1]} 行はファイルの外です（データを作った後にファイルが変わりました）。ファイル全体を表示します。
        </p>
      )}
      <div className={`code-body${shown === 'file' ? ' code-long' : ''}`} ref={body} tabIndex={0} aria-label={`${path} のコード`}>
        {tokens === undefined || span === undefined ? (
          <p className="note code-loading">コードを読み込んでいます…</p>
        ) : (
          <pre>
            {tokens.slice(span.start - 1, span.end).map((line, offset) => {
              const number = span.start + offset;
              return (
                <div key={number} className={inRange(number, span.mark) ? 'line line-on' : 'line'}>
                  <span className="line-no" aria-hidden="true">
                    {number}
                  </span>
                  <span className="line-text">
                    {line.map((token, index) =>
                      token.type === 'plain' ? (
                        token.text
                      ) : (
                        <span key={index} className={`tok-${token.type}`}>
                          {token.text}
                        </span>
                      ),
                    )}
                  </span>
                </div>
              );
            })}
          </pre>
        )}
      </div>
    </div>
  );
}
