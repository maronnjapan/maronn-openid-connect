import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { CodeIndex, LinkTarget, SourceDocument } from '../types';
import { LINK_KIND_WORDS, linksByLine, segmentsOf } from '../lib/links';
import { featureSourceLines } from '../lib/source';
import { FeatureBadge } from './FeatureBadge';

/** Whether the page is used by touch only (no Ctrl/⌘ to hold): there a tap on a name follows it. */
function touchOnly(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
}

/**
 * The highlighted lines of a source file (all of it, or the lines of a
 * frame) with its names linked as in an editor: holding Ctrl (⌘ on a Mac)
 * underlines the names that go somewhere, and a click follows one (on a
 * touch screen a tap does). The place to show (`focus`) is marked and
 * scrolled into view.
 */
export function SourceView({ index, document, label, start, end, range, focus, reveal = 0, onLink }: {
  /** The files and the features of the map. */
  index: CodeIndex;
  document: SourceDocument;
  /** What the code is, for the screen reader (`authenticateTokenClient() のコード`). */
  label: string;
  /** The lines to show; without them the whole file. */
  start?: number | undefined;
  end?: number | undefined;
  /** Lines to mark (the frame the reader opened, in its whole file). */
  range?: [number, number] | undefined;
  focus?: { line: number; column?: number | undefined; length?: number | undefined } | undefined;
  /** A count the page raises each time the reader goes to a place, so the place is shown again even when it is the one already focused (scrolled away from since). */
  reveal?: number;
  /** The reader follows a name: the declaration it goes to, and where the name is. */
  onLink: (target: LinkTarget, at: { line: number; column: number }) => void;
}) {
  const box = useRef<HTMLPreElement>(null);
  const [armed, setArmed] = useState(false);
  const touch = useMemo(touchOnly, []);
  const lines = featureSourceLines(document.code, document.features, start, end);
  const links = useMemo(() => linksByLine(document.links), [document]);

  // Ctrl / ⌘ held anywhere on the page arms the links, as in an editor.
  useEffect(() => {
    const update = (event: KeyboardEvent) => setArmed(event.ctrlKey || event.metaKey);
    const disarm = () => setArmed(false);
    window.addEventListener('keydown', update);
    window.addEventListener('keyup', update);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', update);
      window.removeEventListener('keyup', update);
      window.removeEventListener('blur', disarm);
    };
  }, []);

  // Show the place: its line a third of the way down the box.
  useLayoutEffect(() => {
    const element = box.current;
    if (element === null) return;
    const line = focus === undefined ? null : element.querySelector<HTMLElement>(`[data-line="${focus.line}"]`);
    if (line === null) {
      element.scrollTop = 0;
      return;
    }
    element.scrollTop = Math.max(0, line.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop - element.clientHeight / 3);
  }, [focus?.line, focus?.column, document, start, end, range?.[0], reveal]);

  /** Follow the name under a click, when Ctrl / ⌘ is held or the screen is touch only. */
  const follow = (event: MouseEvent<HTMLPreElement>) => {
    if (!(event.ctrlKey || event.metaKey || touch)) return;
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-link]');
    if (element === null) return;
    const [line, column] = (element.dataset['link'] ?? '').split(':').map(Number) as [number, number];
    const link = links.get(line)?.find((candidate) => candidate.column === column);
    const target = link === undefined ? undefined : document.links?.targets[link.target];
    if (target === undefined) return;
    event.preventDefault();
    onLink(target, { line, column });
  };

  return (
    <pre
      ref={box}
      className={`source-code${armed || touch ? ' source-links-armed' : ''}`}
      style={{ color: document.foreground, '--source-background': document.background } as CSSProperties}
      tabIndex={0}
      aria-label={label}
      onClick={follow}
      onMouseMove={(event) => {
        if (armed !== (event.ctrlKey || event.metaKey)) setArmed(event.ctrlKey || event.metaKey);
      }}
    >
      <code>
        {lines.map((line) => {
          const focused = focus?.line === line.number;
          const marked = range !== undefined && range[0] <= line.number && line.number <= range[1];
          return (
            <span key={line.number} data-line={line.number} className={`source-line${line.features.length > 0 ? ' source-feature-line' : ''}${marked ? ' source-line-range' : ''}${focused ? ' source-line-focus' : ''}`} title={line.features.length === 0 ? undefined : `${line.features.join('、')} の実装`}>
              <span className="source-line-number" aria-hidden="true">
                {line.number}
              </span>
              <span>
                {document.tokens[line.number - 1] === undefined
                  ? line.text
                  : segmentsOf(document.tokens[line.number - 1] ?? [], links.get(line.number)).map((segment, position) => {
                      const pieces = segment.pieces.map((piece, part) => (
                        <span key={part} className="source-token" style={{ color: piece.color }}>
                          {piece.content}
                        </span>
                      ));
                      if (segment.link === undefined) return <span key={position}>{pieces}</span>;
                      const target = document.links?.targets[segment.link.target];
                      const here = focused && focus?.column === segment.link.column;
                      const where = target === undefined ? '' : `${index.sources[target.file]?.path ?? target.file}:${target.line}`;
                      return (
                        <span key={position} className={`source-link${here ? ' source-link-focus' : ''}`} data-link={`${line.number}:${segment.link.column}`} title={target === undefined ? undefined : `${LINK_KIND_WORDS[target.kind]} ${target.name} · ${where}（Ctrl/⌘ + クリックで移る）`}>
                          {pieces}
                        </span>
                      );
                    })}
                {line.starts.map((feature) => (
                  <span key={feature} className="source-feature-label">
                    <FeatureBadge features={index.features} feature={feature} implementation />
                  </span>
                ))}
                {'\n'}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}
