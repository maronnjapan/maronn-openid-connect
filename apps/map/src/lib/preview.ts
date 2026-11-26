/**
 * The flow view follows the request the editor shows (FlowRequest.tsx):
 * when the reader writes on it, the page asks the live OP what it would do
 * (`POST /__live/preview`, run on a copy of the workspace's state, nothing
 * kept) and the playback follows that exchange as it follows one sent. This
 * module decides when the editor's request is taken up, what the flow does
 * for it, which request it is read against (the one before the edits), and
 * how the result names a preview; nothing here touches the DOM or fetches.
 */
import { draftProblem, liveRequestOf, type RequestDraft } from './run';

/** How long the flow waits after an edit of the request before it previews it, in milliseconds: one preview for a burst of typing. */
export const PREVIEW_DELAY = 400;

/** The key of the request a draft sends: two drafts with the same key send the same request to the live OP (liveRequestOf). */
export function requestKey(draft: RequestDraft): string {
  const { method, path, headers, body } = liveRequestOf(draft);
  return JSON.stringify([method, path, headers, body ?? null]);
}

/** Where the request the editor shows is written from: an exchange of the workspace the reader opened, the request prepared for a case, or nothing (a blank request). */
export type DraftBase = 'exchange' | 'case' | 'blank';

/**
 * When the flow takes up the request the editor shows (see previewPlan):
 * the key that starts the wait again whenever it changes, how long it
 * waits, and whether it lets go of the preview instead (`release`: the
 * editor shows no request of its own, a blank one nobody wrote on, so the
 * flow goes back to what it showed before the first preview).
 */
export interface PreviewPlan {
  key: string;
  delay: number;
  release?: true;
}

/** What the editor shows, for previewPlan. */
export interface PreviewInput {
  draft: RequestDraft;
  /** The request the editor started from (the case's, the exchange's, or the blank one), before the reader wrote on it. */
  start: RequestDraft;
  base: DraftBase;
  /** The reader wrote on the request it started from (and has not gone back with 元のリクエストに戻す). */
  edited: boolean;
  /** The key of what the request was written from (a case and its revision, an exchange, a blank request): a new start is taken up even when its request is the same. */
  origin: string;
  /** The request cannot be run here: a framework the live OP does not run, a case that needs what is outside it, an OP the page cannot reach. */
  blocked: boolean;
}

/**
 * Whether and when the flow takes up the request the editor shows: after
 * an edit, once the reader stops typing (PREVIEW_DELAY); at once for the
 * request prepared for a case, and for that of an exchange opened, as it
 * is (whose recorded way the flow follows again when the reader comes back
 * to it, see editorFollow). A blank request nobody wrote on, or one written
 * back to blank, is no request: the flow lets go of the preview it shows
 * (`release`), at once on 元のリクエストに戻す and after the pause when
 * the reader typed it back. Nothing for a request that cannot be run or
 * sent (draftProblem).
 */
export function previewPlan({ draft, start, base, edited, origin, blocked }: PreviewInput): PreviewPlan | undefined {
  const delay = edited ? PREVIEW_DELAY : 0;
  const problem = draftProblem(draft);
  if (base === 'blank' && (!edited || (problem === undefined && requestKey(draft) === requestKey(start)))) return { key: `${origin}\nrelease`, delay, release: true };
  if (blocked || problem !== undefined) return undefined;
  return { key: `${origin}\n${requestKey(draft)}`, delay };
}

/**
 * The request the flow reads the editor's request against, to show where
 * the edits make its way part (useRun.ts RequestRun.show): the request the
 * editor started from, when the reader wrote on it into another request
 * and both can be sent. None for a request written from blank (there is no
 * request before the edits), nor for the request as it started.
 */
export function comparedStart({ draft, start, base, edited }: Pick<PreviewInput, 'draft' | 'start' | 'base' | 'edited'>): RequestDraft | undefined {
  if (!edited || base === 'blank' || draftProblem(draft) !== undefined || draftProblem(start) !== undefined) return undefined;
  return requestKey(draft) === requestKey(start) ? undefined : start;
}

/**
 * What the flow does for the request the editor shows (by its key, see
 * requestKey):
 *
 * - `wait`: a preview of that request is under way
 * - `stay`: the run shows that request already (it was sent, opened or previewed last, or is being sent). The playback does not take its way again on its own when the reader left it (took another side): an edit typed and undone in the pause previews nothing, and only a preview or このリクエストの道筋に戻す follows a way again
 * - `recorded`: the request is one sent or opened since the case or the way was picked: the flow follows the exchange it was recorded as again, without asking the OP
 * - `preview`: the OP previews it, and the flow follows what it would do
 */
export type EditorFollow = 'wait' | 'stay' | 'recorded' | 'preview';

/** What the flow stands for when the editor's request changes (see editorFollow). */
export interface FollowedNow {
  /** The key of the request a preview is under way for. */
  pending?: string | undefined;
  /** The request the run shows (being sent, sent, opened or previewed). */
  shown?: { key: string } | undefined;
  /** The keys of the requests sent or opened since the case or the way was picked. */
  recorded: { has: (key: string) => boolean };
}

/** What the flow does for the request the editor shows (see EditorFollow). */
export function editorFollow(key: string, now: FollowedNow): EditorFollow {
  if (now.pending === key) return 'wait';
  if (now.shown?.key === key) return 'stay';
  if (now.recorded.has(key)) return 'recorded';
  return 'preview';
}

/**
 * What to do with the editor's request while a request is being sent (or
 * an exchange read): nothing is previewed until it lands, so the run shown
 * stays the send under way; the request held is previewed once it lands,
 * unless it is the one sent. Undefined: nothing to preview after.
 */
export function heldAfterSend<T>(draft: T, key: string, sending: string | undefined): T | undefined {
  return key === sending ? undefined : draft;
}

/** The id of the exchange the run shows, when the workspace keeps it (sent or opened); undefined for a preview, which it does not keep, and while nothing is shown. */
export function keptExchangeId(run: { status: string; preview?: boolean | undefined; exchange?: { id: string } | undefined } | undefined): string | undefined {
  return run?.status === 'done' && run.preview !== true ? run.exchange?.id : undefined;
}

/** What the result of the request says when the reader wrote the request into a form that cannot be sent (draftProblem): the response shown is of the request before. */
export const STALE_WORDS = 'この結果は書き換える前のリクエストのものです。いまのリクエストは送れない形なので、試算していません。';

/** Whether the result shown is of the request before the reader's last edits: the reader wrote on the request and it cannot be sent (draftProblem), so nothing took its place. */
export function staleResult(draft: RequestDraft, edited: boolean, shown: boolean): boolean {
  return shown && edited && draftProblem(draft) !== undefined;
}

/** What the request panel says when the editor's request could not be previewed: the OP out of reach in its own words, else what the OP said, for a request edited or as a case prepared it. */
export function previewFailureWords(problem: { message: string; unreachable: boolean }): string {
  return problem.unreachable ? problem.message : `このリクエストを試算できませんでした（${problem.message}）。フローは前の道筋のままです。`;
}

/** How the result of the request names what it shows: a preview, an exchange the reader opened, or a request sent. */
export function resultLabel(shown: { opened: boolean; preview?: boolean | undefined }): { label: string; note?: string } {
  if (shown.preview === true) return { label: '送る前の試算', note: '（地図の OP の今の状態のコピーで動かしました。OP の状態は変えていません）' };
  return { label: shown.opened ? '開いたリクエスト' : '実行したリクエスト' };
}

/** What the line under the response says of the way the playback follows: the way a request took (or would take, for a preview), the ending it reached, and the decisions taken on an assumed side. */
export function replayWords(preview: boolean, ending: string | undefined, assumed: number): string {
  const way = preview ? 'このリクエストを送ると通る道筋を再生しています' : 'このリクエストが通った道筋を再生しています';
  return `${way}${ending !== undefined ? `（${ending}）` : ''}。${assumed > 0 ? `規則で読めない分岐 ${assumed} 個は、仮の側へ進みます。` : ''}`;
}

/** What the result says of a request that ran nothing of the endpoint's root (the router or a middleware answered it): there is no way to play. */
export function notRanWords(preview: boolean, status: number | undefined): string {
  const why = status === undefined ? 'OP は応答せずに失敗しました' : `${status} はルーティングかミドルウェアが返しました`;
  return preview
    ? `このリクエストを送っても、エンドポイントの処理は動きません（${why}）。再生する道筋はありません。`
    : `このリクエストではエンドポイントの処理は動いていません（${why}）。再生する道筋はありません。`;
}
