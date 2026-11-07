/**
 * The code of a test file with line numbers and highlighting. With a test's
 * lines it shows those lines with a little context, or the whole file with
 * them marked and scrolled into view; with `mark` (the file page) the whole
 * file with a test's lines marked and scrolled into view; without either,
 * the whole file.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { inRange, lineWindow } from '../lib/lines';
import { highlight, languageOf, type Token } from '../lib/tokenize';
import { useSource } from './app-context';
import { Segmented } from './ui';

type Mode = 'test' | 'file';

const MODES = [
  { value: 'test' as const, label: 'このテストだけ' },
  { value: 'file' as const, label: 'ファイル全体' },
];

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

export function CodeView({ path, lines, mark, fill }: { path: string; lines?: [number, number]; mark?: [number, number]; fill?: boolean }) {
  const source = useSource(path);
  const [mode, setMode] = useState<Mode>('test');
  const body = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => (source === undefined || source instanceof Error ? undefined : linesOf(path, source.text)), [path, source]);
  const shown = lines === undefined ? 'file' : mode;
  const marked = lines ?? mark;
  const range = tokens === undefined ? undefined : shown === 'file' ? { start: 1, end: tokens.length } : lineWindow(lines, tokens.length);
  const from = marked?.[0];
  const to = marked?.[1];

  // Scroll the box, not the page, to put the test's first line near its top.
  useLayoutEffect(() => {
    const box = body.current;
    if (box === null || from === undefined) return;
    const first = box.querySelector<HTMLElement>('.line-on');
    box.scrollTop = first === null ? 0 : Math.max(first.offsetTop - 48, 0);
  }, [from, to, shown, tokens]);

  if (source instanceof Error) return <p className="note">{source.message}</p>;
  return (
    <div className={`code${fill === true ? ' code-fill' : ''}`}>
      {lines !== undefined && (
        <div className="code-bar">
          <Segmented size="small" label="コードの範囲" options={MODES} value={mode} onChange={setMode} />
        </div>
      )}
      <div className={`code-body${shown === 'file' ? ' code-long' : ''}`} ref={body} tabIndex={0} aria-label={`${path} のコード`}>
        {tokens === undefined || range === undefined ? (
          <p className="note code-loading">コードを読み込んでいます…</p>
        ) : (
          <pre>
            {tokens.slice(range.start - 1, range.end).map((line, offset) => {
              const number = range.start + offset;
              return (
                <div key={number} className={inRange(number, marked) ? 'line line-on' : 'line'}>
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
