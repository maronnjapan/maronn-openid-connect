/**
 * The flow view follows the request the editor shows (FlowRequest.tsx):
 * when the reader writes on it, the page asks the live OP what it would do
 * (`POST /__live/preview`, run on a copy of the workspace's state, nothing
 * kept) and the playback follows that exchange as it follows one sent. This
 * module decides when the editor's request is taken up, what the flow does
 * for it, and how the result names a preview; nothing here touches the DOM
 * or fetches.
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

/** When the flow takes up the request the editor shows (see previewPlan): the key that starts the wait again whenever it changes, and how long it waits. */
export interface PreviewPlan {
  key: string;
  delay: number;
}

/** What the editor shows, for previewPlan. */
export interface PreviewInput {
  draft: RequestDraft;
  base: DraftBase;
  /** The reader wrote on the request it started from. */
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
 * to it, see editorFollow). Never for a blank request nobody wrote on, nor
 * for one that cannot be run or sent (draftProblem).
 */
export function previewPlan({ draft, base, edited, origin, blocked }: PreviewInput): PreviewPlan | undefined {
  if (blocked || draftProblem(draft) !== undefined) return undefined;
  if (base === 'blank' && !edited) return undefined;
  return { key: `${origin}\n${requestKey(draft)}`, delay: edited ? PREVIEW_DELAY : 0 };
}

/**
 * What the flow does for the request the editor shows (by its key, see
 * requestKey):
 *
 * - `wait`: a preview of that request is under way
 * - `stay`: the playback follows that request already (it was sent, opened or previewed last, or is being sent)
 * - `resume`: the playback shows that request's exchange but left its way (the reader took another side): it follows it again
 * - `recorded`: the request is one sent or opened since the case or the way was picked: the flow follows the exchange it was recorded as again, without asking the OP
 * - `preview`: the OP previews it, and the flow follows what it would do
 */
export type EditorFollow = 'wait' | 'stay' | 'resume' | 'recorded' | 'preview';

/** What the flow stands for when the editor's request changes (see editorFollow). */
export interface FollowedNow {
  /** The key of the request a preview is under way for. */
  pending?: string | undefined;
  /** The request the run shows (being sent, sent, opened or previewed) and whether the playback follows its way. */
  shown?: { key: string; follow: boolean } | undefined;
  /** The keys of the requests sent or opened since the case or the way was picked. */
  recorded: { has: (key: string) => boolean };
}

/** What the flow does for the request the editor shows (see EditorFollow). */
export function editorFollow(key: string, now: FollowedNow): EditorFollow {
  if (now.pending === key) return 'wait';
  if (now.shown?.key === key) return now.shown.follow ? 'stay' : 'resume';
  if (now.recorded.has(key)) return 'recorded';
  return 'preview';
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
