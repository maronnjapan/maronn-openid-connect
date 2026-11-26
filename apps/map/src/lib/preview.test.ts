import { describe, expect, it } from 'vitest';
import { editorFollow, notRanWords, PREVIEW_DELAY, previewPlan, replayWords, requestKey, resultLabel } from './preview';
import { blankDraft, draftOfRequest, type RequestDraft } from './run';

/** The request a case prepares at the token endpoint: an authorization code with its PKCE verifier. */
const CODE: RequestDraft = draftOfRequest({
  method: 'POST',
  path: '/token',
  headers: [
    ['authorization', 'Basic Y2xpZW50LTE6c2VjcmV0'],
    ['content-type', 'application/x-www-form-urlencoded'],
  ],
  body: 'grant_type=authorization_code&code=c1&redirect_uri=https%3A%2F%2Frp.example.com%2Fcb&code_verifier=v1',
});

/** The same request with another value for one parameter. */
function withParam(draft: RequestDraft, name: string, value: string): RequestDraft {
  return { ...draft, params: draft.params.map((param) => (param.name === name ? { ...param, value } : param)) };
}

describe('requestKey', () => {
  it('should give the same key to drafts that send the same request, and another to any change of a value, a header or the body', () => {
    const same = { ...CODE, params: CODE.params.map((param) => ({ ...param })) };
    const keys = [
      requestKey(CODE),
      requestKey(same),
      requestKey(withParam(CODE, 'code_verifier', 'v2')),
      requestKey({ ...CODE, headers: [...CODE.headers, ['x-extra', '1']] }),
      requestKey({ ...CODE, params: [...CODE.params, { name: '', value: 'unnamed', in: 'form' }] }),
      requestKey({ ...CODE, body: 'raw', rawBody: 'grant_type=authorization_code' }),
    ];

    expect(keys[1]).toBe(keys[0]);
    // A row without a name sends nothing, so it sends the same request.
    expect(keys[4]).toBe(keys[0]);
    expect(new Set([keys[0], keys[2], keys[3], keys[5]]).size).toBe(4);
  });
});

describe('previewPlan', () => {
  it('should take up the request a case prepared at once, and an edit after a pause in the typing, keyed by where it started and the request', () => {
    const prepared = previewPlan({ draft: CODE, base: 'case', edited: false, origin: 'case:token-code:1', blocked: false });
    const edited = previewPlan({ draft: withParam(CODE, 'code_verifier', 'wrong'), base: 'case', edited: true, origin: 'case:token-code:1', blocked: false });
    const again = previewPlan({ draft: CODE, base: 'case', edited: false, origin: 'case:token-code:2', blocked: false });

    expect(prepared).toEqual({ key: `case:token-code:1\n${requestKey(CODE)}`, delay: 0 });
    expect(edited?.delay).toBe(PREVIEW_DELAY);
    expect(PREVIEW_DELAY).toBe(400);
    expect(edited?.key).not.toBe(prepared?.key);
    // Prepared again: the same request is taken up again, as the case's request now.
    expect(again?.key).not.toBe(prepared?.key);
  });

  it('should take up an exchange opened as it is (to follow it again when the reader comes back to it), but never a blank request nobody wrote on', () => {
    const blank = blankDraft('POST', '/token');
    const written = { ...blank, params: [{ name: 'grant_type', value: 'client_credentials', in: 'form' as const }] };

    expect(previewPlan({ draft: CODE, base: 'exchange', edited: false, origin: 'x:x3', blocked: false })?.delay).toBe(0);
    expect(previewPlan({ draft: blank, base: 'blank', edited: false, origin: 'blank', blocked: false })).toBeUndefined();
    expect(previewPlan({ draft: written, base: 'blank', edited: true, origin: 'blank', blocked: false })?.delay).toBe(PREVIEW_DELAY);
  });

  it('should take up nothing where the request cannot be run (Next.js, an OP out of reach) or sent (a body on a GET, a header name that is not one)', () => {
    const get = blankDraft('GET', '/userinfo');

    expect(previewPlan({ draft: CODE, base: 'case', edited: false, origin: 'case:token-code:1', blocked: true })).toBeUndefined();
    expect(previewPlan({ draft: { ...get, params: [{ name: 'a', value: '1', in: 'form' }] }, base: 'blank', edited: true, origin: 'blank', blocked: false })).toBeUndefined();
    expect(previewPlan({ draft: { ...CODE, headers: [['bad header', 'x']] }, base: 'case', edited: true, origin: 'case:token-code:1', blocked: false })).toBeUndefined();
  });
});

describe('editorFollow', () => {
  const recorded = new Set(['sent']);

  it('should wait for a preview under way of the same request, and stay on the request the playback follows', () => {
    expect(editorFollow('edited', { pending: 'edited', shown: { key: 'case', follow: true }, recorded })).toBe('wait');
    expect(editorFollow('case', { pending: 'edited', shown: { key: 'case', follow: true }, recorded })).toBe('stay');
    expect(editorFollow('sent', { shown: { key: 'sent', follow: true }, recorded })).toBe('stay');
  });

  it('should follow again the way of the request shown when the reader had left it, and the exchange of a request sent or opened before', () => {
    expect(editorFollow('case', { shown: { key: 'case', follow: false }, recorded })).toBe('resume');
    expect(editorFollow('sent', { shown: { key: 'edited', follow: true }, recorded })).toBe('recorded');
  });

  it('should preview any other request: one written on, the one a case prepared, one after a run that failed', () => {
    expect(editorFollow('edited', { shown: { key: 'case', follow: true }, recorded })).toBe('preview');
    expect(editorFollow('case', { recorded: new Set() })).toBe('preview');
    expect(editorFollow('edited', { pending: 'other', recorded })).toBe('preview');
  });
});

describe('resultLabel', () => {
  it('should name a preview as one, run on a copy of the OP\'s state that changed nothing, apart from a request sent or opened', () => {
    expect(resultLabel({ opened: false, preview: true })).toEqual({ label: '送る前の試算', note: '（地図の OP の今の状態のコピーで動かしました。OP の状態は変えていません）' });
    expect(resultLabel({ opened: false })).toEqual({ label: '実行したリクエスト' });
    expect(resultLabel({ opened: true })).toEqual({ label: '開いたリクエスト' });
  });
});

describe('replayWords', () => {
  it('should say the way a preview would take and the way a request took, with the ending and the decisions on an assumed side', () => {
    expect(replayWords(true, '失敗: TokenError(invalid_grant)（verifyPkceCodeVerifier から）', 0)).toBe('このリクエストを送ると通る道筋を再生しています（失敗: TokenError(invalid_grant)（verifyPkceCodeVerifier から））。');
    expect(replayWords(false, undefined, 2)).toBe('このリクエストが通った道筋を再生しています。規則で読めない分岐 2 個は、仮の側へ進みます。');
  });
});

describe('notRanWords', () => {
  it('should say a request ran nothing of the endpoint, as sent or as previewed', () => {
    expect(notRanWords(false, 405)).toBe('このリクエストではエンドポイントの処理は動いていません（405 はルーティングかミドルウェアが返しました）。再生する道筋はありません。');
    expect(notRanWords(true, undefined)).toBe('このリクエストを送っても、エンドポイントの処理は動きません（OP は応答せずに失敗しました）。再生する道筋はありません。');
  });
});
