import { describe, expect, it } from 'vitest';
import { parseJsDoc } from '../extract/functions.js';
import { buildFunctionFlow } from '../extract/function-flow.js';
import { jsDocSummaryAbove } from '../extract/meta.js';
import { isWideCharacter, joinLines, joinLinesFlat, lineSeparator } from '../extract/prose.js';

describe('isWideCharacter', () => {
  it('should tell kana, kanji and full-width punctuation from ASCII', () => {
    expect(['あ', 'ア', '漢', '。', '（', 'Ａ'].map(isWideCharacter)).toEqual([true, true, true, true, true, true]);
    expect(['a', '`', '1', ' ', '(', '.'].map(isWideCharacter)).toEqual([false, false, false, false, false, false]);
  });
});

describe('lineSeparator', () => {
  it('should join Japanese without a space, English and code spans with one, and keep the break of a list item', () => {
    expect(lineSeparator('トークンを返す。', '期限切れなら拒否する。')).toBe('');
    expect(lineSeparator('トークンを', '返す。')).toBe('');
    expect(lineSeparator('鍵の ID は', '`kid` で示す。')).toBe(' ');
    expect(lineSeparator('返す。', '`kid` は鍵の ID である。')).toBe('');
    expect(lineSeparator('`kid` は', '（鍵の ID）')).toBe('');
    expect(lineSeparator('Return the token.', 'Refuse an expired one.')).toBe(' ');
    expect(lineSeparator('対応する方式:', '- `client_secret_basic`')).toBe('\n');
  });
});

describe('joinLines', () => {
  it('should trim the lines and leave out the empty ones', () => {
    expect(joinLines(['  クライアントを認証する。 ', '', ' 失敗なら投げる。'])).toBe('クライアントを認証する。失敗なら投げる。');
    expect(joinLines(['First line.', 'Still first.'])).toBe('First line. Still first.');
    expect(joinLinesFlat(['方式:', '- a', '- b'])).toBe('方式: - a - b');
  });
});

describe('the texts the map shows', () => {
  it('should read a Japanese JSDoc written one sentence per line without spaces in the sentences', () => {
    const doc = parseJsDoc(
      '/**\n * 提示されたクライアント認証情報を検証し、\n * 認証済みのクライアントを返す。\n *\n * 方式は次の二つである。\n * - `client_secret_basic`\n * - `client_secret_post`\n *\n * 二つ目の段落。\n * 続きの文。\n * @throws {TokenError} `invalid_client`: 登録されていない\n *   クライアントのとき\n */',
    );
    expect(doc.summary).toBe('提示されたクライアント認証情報を検証し、認証済みのクライアントを返す。');
    expect(doc.description).toBe('方式は次の二つである。\n- `client_secret_basic`\n- `client_secret_post`\n\n二つ目の段落。続きの文。');
    expect(doc.tags.get('throws')).toEqual(['{TokenError} `invalid_client`: 登録されていないクライアントのとき']);
  });

  it('should read the summary of an endpoint without spaces in a Japanese sentence', () => {
    const source = '/**\n * 認可リクエストを検証し、\n * ログイン画面へ進める。\n *\n * 詳細。\n */\nexport const endpoint = defineEndpoint({});';
    expect(jsDocSummaryAbove(source, source.indexOf('export'))).toBe('認可リクエストを検証し、ログイン画面へ進める。');
  });

  it('should join the lines of a comment above a statement without spaces in a Japanese sentence', () => {
    const source = [
      'function f(c) {',
      '  // 提示された client_id のクライアントを',
      '  // 登録済みのクライアントから探す。',
      '  const client = g(c);',
      '  /*',
      '   * 見つからなければ',
      '   * 失敗する。',
      '   */',
      '  return h(client);',
      '}',
    ].join('\n');
    const start = source.indexOf('{');
    const flow = buildFunctionFlow({
      source,
      body: { start, end: source.length },
      name: 'f',
      parameters: 'c',
      resolve: (name) => (name === 'g' || name === 'h' ? `core:x.ts#${name}` : undefined),
    });
    expect(flow?.nodes.map((node) => node.note).filter((note) => note !== undefined)).toEqual([
      '提示された client_id のクライアントを登録済みのクライアントから探す。',
      '見つからなければ失敗する。',
    ]);
  });
});
