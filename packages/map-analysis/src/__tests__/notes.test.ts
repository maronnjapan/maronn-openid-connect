import { describe, expect, it } from 'vitest';
import type { FrameChangeEntry } from '../model.js';
import { attachNotes, draftHeading, draftSections, draftTestSections, isNote, parseNote, referencesOf, resolveReference, withoutComments } from '../notes.js';
import { noteName } from '../draft.js';

function entry(id: string, name: string, kind: FrameChangeEntry['kind'] = 'modified', extra: Partial<FrameChangeEntry> = {}): FrameChangeEntry {
  const root = id.slice(0, id.indexOf(':'));
  return { id, name, package: root, module: id.slice(id.indexOf(':') + 1, id.indexOf('#') === -1 ? undefined : id.indexOf('#')), line: 1, kind, summary: [], counts: {}, reach: [], documented: false, required: false, ...extra };
}

describe('isNote', () => {
  it('should take the Markdown files of the notes directory except its README', () => {
    expect(isNote('apps/map/changes/claims.md')).toBe(true);
    expect(isNote('apps/map/changes/README.md')).toBe(false);
    expect(isNote('apps/map/README.md')).toBe(false);
  });
});

describe('referencesOf', () => {
  it('should take the names of a heading, with backticks, () and the words after them left out', () => {
    expect(referencesOf('`verifyClientSecret()`, core:resolveClient の変更')).toEqual(['verifyClientSecret', 'core:resolveClient']);
  });
});

describe('parseNote', () => {
  it('should read the title, the summary and the sections, the ids of a heading from its HTML comment, and leave out the comments of the text', () => {
    const note = parseNote(
      [
        '# クレーム名のアロウリスト',
        '',
        'claims で要求できる名前を絞る。',
        '',
        '## verifyClientSecret <!-- core:client-auth.ts#verifyClientSecret -->',
        '',
        '<!-- 自動要約: 条件を足した -->',
        '',
        '## token <!-- endpoint:token -->',
        '',
        '<!-- 自動要約: 条件を足した -->',
        'refresh_token の前で拒否する。',
        '',
        '```md',
        '## not a heading',
        '```',
        '',
        '## 背景',
        '',
        '漏れていた。',
      ].join('\n'),
    );
    expect(note.title).toBe('クレーム名のアロウリスト');
    expect(note.summary).toBe('claims で要求できる名前を絞る。');
    expect(note.sections.map((section) => [section.heading, section.references, section.byId, section.text])).toEqual([
      ['verifyClientSecret', ['core:client-auth.ts#verifyClientSecret'], true, ''],
      ['token', ['endpoint:token'], true, 'refresh_token の前で拒否する。\n\n```md\n## not a heading\n```'],
      ['背景', ['背景'], false, '漏れていた。'],
    ]);
  });

  it('should leave nothing of a text of HTML comments only', () => {
    expect(withoutComments('<!-- a -->\n\n<!-- b -->\n')).toBe('');
  });
});

describe('the reason not to change the tests', () => {
  it('should read the line apart from the text, with a half or a full width colon, and take an empty one as no reason', () => {
    const note = parseNote(['# t', '', '## buildTokenResponse', '', '`scope` の空白を落とした。', '', 'テストを変えない理由: レスポンスの形は変えていない。', '', '## verifyClientSecret', '', 'テストを変えない理由：', '', '## sign', '', 'テストを変えない理由：既存の 3 件が同じ期待で通る。'].join('\n'));
    expect(note.sections.map((section) => [section.heading, section.text, section.reason])).toEqual([
      ['buildTokenResponse', '`scope` の空白を落とした。', 'レスポンスの形は変えていない。'],
      ['verifyClientSecret', '', undefined],
      ['sign', '', '既存の 3 件が同じ期待で通る。'],
    ]);
  });

  it('should give a frame the reason of a section that names it, without counting the reason as the explanation of the change', () => {
    const frames = [entry('core:a.ts#sign', 'sign'), entry('core:b.ts#verify', 'verify')];
    const note = { file: 'apps/map/changes/x.md', ...parseNote(['## sign', '', 'テストを変えない理由: 形は同じ。', '', '## verify', '', '短い秘密を拒む。'].join('\n')) };
    attachNotes(frames, [note], [], () => entry('core:z.ts#z', 'z'));
    expect(frames.map((frame) => [frame.id, frame.documented, frame.testReason])).toEqual([
      ['core:a.ts#sign', false, { text: '形は同じ。', note: 'apps/map/changes/x.md' }],
      ['core:b.ts#verify', true, undefined],
    ]);
  });

  it('should draft the related tests in a comment and an empty reason line, in a new section or in one of its own', () => {
    const tests = new Map([['core:a.ts#sign', { related: ['should sign the ID token', 'should reject a token -->'] }]]);
    expect(draftSections([{ id: 'core:a.ts#sign', name: 'sign', summary: ['条件 `x` を足した'], reach: [] }], tests)).toBe(
      [
        '## sign <!-- core:a.ts#sign -->',
        '',
        '<!-- 自動要約: 条件 `x` を足した -->',
        '<!-- 届く先: なし -->',
        '<!-- なぜ変えたか、何に気をつけるかを書く（何を変えたかとどこに効くかは地図が出す） -->',
        '',
        '<!-- 関連するテスト（2）: should sign the ID token / should reject a token - ->。どれかを変えるか、変えない理由を次の行に書く -->',
        'テストを変えない理由:',
        '',
      ].join('\n'),
    );
    expect(draftTestSections([{ id: 'core:b.ts#verify', name: 'verify' }], new Map())).toBe(
      ['## verify <!-- core:b.ts#verify -->', '', '<!-- 関連するテスト: なし。テストを足すか、テストを足さない理由を次の行に書く -->', 'テストを変えない理由:', ''].join('\n'),
    );
  });
});

describe('resolveReference', () => {
  const entries = [entry('core:client-auth.ts#verifyClientSecret', 'verifyClientSecret'), entry('hono:oidc-provider/client.ts#verifyClientSecret', 'verifyClientSecret'), entry('endpoint:token', 'token')];
  it('should find an entry by its id, its name, its name in a root, and the end of its module', () => {
    expect(resolveReference('endpoint:token', entries).map((found) => found.id)).toEqual(['endpoint:token']);
    expect(resolveReference('verifyClientSecret', entries)).toHaveLength(2);
    expect(resolveReference('core:verifyClientSecret', entries).map((found) => found.id)).toEqual(['core:client-auth.ts#verifyClientSecret']);
    expect(resolveReference('client.ts#verifyClientSecret', entries).map((found) => found.id)).toEqual(['hono:oidc-provider/client.ts#verifyClientSecret']);
    expect(resolveReference('token', entries).map((found) => found.id)).toEqual(['endpoint:token']);
  });
});

describe('attachNotes', () => {
  it('should give the sections to the frames they name, count a section of comments only as no explanation, warn of a bare name that names two, and add the functions the diff did not change as noted', () => {
    const frames = [
      entry('core:client-auth.ts#verifyClientSecret', 'verifyClientSecret'),
      entry('hono:oidc-provider/client.ts#verifyClientSecret', 'verifyClientSecret'),
      entry('endpoint:token', 'token', 'modified', { body: true }),
      entry('core:a.ts#untouched', 'untouched'),
    ];
    const note = {
      file: 'apps/map/changes/x.md',
      ...parseNote(['## verifyClientSecret', '', '定数時間で比べる。', '', '## token <!-- endpoint:token -->', '', '<!-- 自動要約 -->', '', '## resolveClient', '', '呼び方を変えた。', '', '## 背景', '', '理由。', '', '## missingName', '', 'x'].join('\n')),
    };
    const catalog = [{ id: 'core:client.ts#resolveClient', name: 'resolveClient', package: 'core', module: 'client.ts' }];
    const result = attachNotes(frames, [note], catalog, (named) => entry(named.id, named.name, 'noted'));
    expect(frames.map((frame) => [frame.id, frame.documented, frame.noteLine])).toEqual([
      ['core:client-auth.ts#verifyClientSecret', true, '定数時間で比べる。'],
      ['hono:oidc-provider/client.ts#verifyClientSecret', true, '定数時間で比べる。'],
      ['endpoint:token', false, undefined],
      ['core:a.ts#untouched', false, undefined],
      ['core:client.ts#resolveClient', true, '呼び方を変えた。'],
    ]);
    expect(result.ambiguous).toEqual([{ file: 'apps/map/changes/x.md', reference: 'verifyClientSecret', matches: ['core:client-auth.ts#verifyClientSecret', 'hono:oidc-provider/client.ts#verifyClientSecret'] }]);
    expect(result.unmatched.map((section) => section.heading)).toEqual(['背景', 'missingName']);
    expect(result.unknown).toEqual([{ file: 'apps/map/changes/x.md', reference: 'missingName' }]);
  });
});

describe('the draft of a note', () => {
  it('should head a section with the name and the id, put what the map computed in comments, and leave the reason to the author', () => {
    expect(draftHeading({ id: 'endpoint:token', name: 'token' })).toBe('## token <!-- endpoint:token -->');
    const text = draftSections([{ id: 'core:a.ts#f', name: 'f', summary: ['条件 `x` を足した'], reach: [{ source: 'hono', frameworks: ['hono'], endpoint: 'token', frames: [], decisions: {}, via: [], features: [], target: 's0' }] }]);
    expect(text).toBe(['## f <!-- core:a.ts#f -->', '', '<!-- 自動要約: 条件 `x` を足した -->', '<!-- 届く先: hono:token -->', '<!-- なぜ変えたか、何に気をつけるかを書く（何を変えたかとどこに効くかは地図が出す） -->', ''].join('\n'));
    // The draft read back is a section with no explanation yet.
    expect(parseNote(text).sections[0]).toMatchObject({ references: ['core:a.ts#f'], text: '' });
  });

  it('should name a new note after the branch', () => {
    expect(noteName('claude/apps-map-endpoint-design-6cgqgy')).toBe('apps-map-endpoint-design-6cgqgy.md');
    expect(noteName('feature/x y')).toBe('x-y.md');
  });
});
