import { useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type MutableRefObject, type RefObject } from 'react';
import { cardPlace } from '../lib/camera';
import type { Mark } from '../lib/changes';
import type { CardAction, DiagramRow } from '../lib/diagram';
import { Badge, Inline } from './ChangeParts';

/** A row of a card: a way the box ends the flow, or what its region does with an exception, in full. */
export interface CardRow {
  full: string;
  tone: DiagramRow['tone'];
  /** The chosen way runs it. */
  on: boolean;
}

/** What the card of a box or a region says, in full, in the order it says it. */
export interface CardContent {
  /** What the card describes, for its label: the title of the box, the words of the region. */
  name: string;
  /** The code, first ('' for none): monospace, whole. */
  code: string;
  /** Then the whole text, `code` set in code; absent for none. */
  text?: string;
  /** How the box ends the flow itself, as the outline tags it: 終わり (a return), 失敗 (a throw). */
  tag?: '終わり' | '失敗';
  /** Then every row in full. */
  rows: CardRow[];
  /** The badge of the pull request, and what it means. */
  mark?: Mark;
  /** The chosen way does not run it. */
  off: boolean;
  /** The buttons: one that names a row (a step it opens in place, a call of its side to look inside) goes with that row, the others at the end. */
  actions: CardAction[];
}

export interface DiagramCardProps {
  /** The element's id, for the aria-describedby of the box it describes. */
  id: string;
  content: CardContent;
  /** The element the card describes (a box, the label of a region), which it is placed beside. */
  anchor: () => Element | null;
  /** Holds the function that places the card again: the diagram calls it whenever the view moves. */
  follow: MutableRefObject<(() => void) | null>;
  /** The card's element, for the diagram to tell what is inside it and to give it the focus. */
  cardRef: RefObject<HTMLDivElement | null>;
  /** A button is pressed, from the keyboard or not, where the pointer is on the screen. */
  onAction: (action: CardAction, keyboard: boolean, at: { x: number; y: number }) => void;
  /** The pointer comes onto the card, or leaves it: a card shown by hovering stays while the pointer is on it. */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Tab past the last button (forward) or Shift+Tab before the first: returns whether the diagram took the focus. */
  onTabOut: (forward: boolean) => boolean;
}

/** The words of a button. */
function actionWords(action: CardAction): string {
  if (action.kind === 'open') return `中の流れを見る（${action.name}）`;
  return action.open ? 'その場で畳む' : 'その場で開く';
}

/** The aria-label of a button: what it does, and to what. */
function actionLabel(action: CardAction, name: string, row: CardRow | undefined): string {
  if (action.kind === 'open') return `${row === undefined ? '' : `${row.full} の `}${action.name} の中の流れを見る（図がその関数に移る）`;
  if (row !== undefined) return `${row.full} の中をその場で開く`;
  return `${name} を${action.open ? 'その場で畳む' : 'その場で開く'}`;
}

/**
 * The card of a box or of the label of a region: everything the one line of
 * the box leaves out, in full (its code first, then its whole text, every
 * row, the badge and what it means), and the buttons that go further: look
 * inside each function it calls, open or fold a step in place. It is drawn
 * over the diagram's area at the screen's scale, beside its box without
 * covering it and inside the area (see cardPlace), and follows the box when
 * the view moves.
 */
export function DiagramCard({ id, content, anchor, follow, cardRef, onAction, onPointerEnter, onPointerLeave, onTabOut }: DiagramCardProps) {
  const local = useRef<HTMLDivElement | null>(null);
  // Place the card after every render and whenever the view moves.
  useLayoutEffect(() => {
    const place = () => {
      const element = local.current;
      const target = anchor();
      const layer = element?.offsetParent;
      if (element == null || target == null || layer == null) return;
      const area = layer.getBoundingClientRect();
      const box = target.getBoundingClientRect();
      const at = cardPlace({ width: area.width, height: area.height }, { x: box.left - area.left, y: box.top - area.top, width: box.width, height: box.height }, { width: element.offsetWidth, height: element.offsetHeight });
      element.style.left = `${Math.round(at.x)}px`;
      element.style.top = `${Math.round(at.y)}px`;
      element.style.visibility = 'visible';
    };
    place();
    follow.current = place;
    return () => {
      if (follow.current === place) follow.current = null;
    };
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const buttons = [...(local.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const edge = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
    if (edge !== undefined && document.activeElement === edge && onTabOut(!event.shiftKey)) event.preventDefault();
  };
  const press = (action: CardAction) => (event: MouseEvent<HTMLButtonElement>) => onAction(action, event.detail === 0, { x: event.clientX, y: event.clientY });
  const button = (action: CardAction, row?: CardRow) => (
    <button key={`${action.kind}-${action.kind === 'toggle' ? `${action.step}-${action.row ?? ''}` : action.node}`} type="button" className={action.kind === 'open' && action.row === undefined ? 'card-action primary' : 'card-action'} aria-label={actionLabel(action, content.name, row)} onClick={press(action)}>
      {actionWords(action)}
    </button>
  );
  const atEnd = content.actions.filter((action) => action.row === undefined);
  return (
    <div
      ref={(element) => {
        local.current = element;
        cardRef.current = element;
      }}
      id={id}
      className="diagram-card"
      role="group"
      aria-label={`${content.name} の詳細`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      {content.code !== '' ? <pre className="card-code mono">{content.code}</pre> : null}
      {content.text !== undefined || content.tag !== undefined ? (
        <p className="card-text">
          {content.tag !== undefined ? <span className={`tag tag-${content.tag === '失敗' ? 'error' : 'end'}`}>{content.tag}</span> : null}
          {content.text !== undefined ? <Inline text={content.text} /> : null}
        </p>
      ) : null}
      {content.rows.length > 0 ? (
        <ul className="card-rows">
          {content.rows.map((row, index) => (
            <li key={index} className={`tone-${row.tone} ${row.on ? 'on' : 'off'}`}>
              <Inline text={row.full} />
              {content.actions.filter((action) => action.row === index).map((action) => button(action, row))}
            </li>
          ))}
        </ul>
      ) : null}
      {content.mark !== undefined ? (
        <p className="card-mark">
          <Badge mark={content.mark} /> {content.mark.title}
        </p>
      ) : null}
      {content.off ? <p className="card-off">選んだ道筋では通らない</p> : null}
      {atEnd.length > 0 ? <div className="card-actions">{atEnd.map((action) => button(action))}</div> : null}
    </div>
  );
}
