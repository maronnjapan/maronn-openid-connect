import { describe, expect, it } from 'vitest';
import { highlight, languageOf, tokenizeTs, type Token } from './tokenize';

/** The tokens of a line as `type:text`, the plain ones left out. */
function marked(line: Token[] | undefined): string[] {
  return (line ?? []).filter((token) => token.type !== 'plain').map((token) => `${token.type}:${token.text}`);
}

describe('languageOf', () => {
  it('should tell the language of a test file by its extension', () => {
    expect(languageOf('a/b.test.ts')).toBe('ts');
    expect(languageOf('a/b.test.mjs')).toBe('ts');
    expect(languageOf('a/b.spec.tsx')).toBe('ts');
    expect(languageOf('tests/features/a.feature')).toBe('gherkin');
    expect(languageOf('README.md')).toBe('plain');
  });
});

describe('TypeScript', () => {
  it('should read keywords, strings, numbers and comments', () => {
    const [line] = highlight("const status = await call('x'); // 405", 'ts');
    expect(marked(line)).toEqual(['keyword:const', 'keyword:await', "string:'x'", 'comment:// 405']);
  });

  it('should keep the text of a file as it is', () => {
    const text = "it('a', async () => {\n  expect(response.status).toBe(405);\n});\n";
    expect(tokenizeTs(text).map((token) => token.text).join('')).toBe(text);
    expect(highlight(text, 'ts')).toHaveLength(4);
  });

  it('should color a block comment on every line it spans', () => {
    const lines = highlight('/**\n * one\n */\nlet a = 1;', 'ts');
    expect(marked(lines[1])).toEqual(['comment: * one']);
    expect(marked(lines[3])).toEqual(['keyword:let', 'number:1']);
  });

  it('should read the code inside a template literal as code', () => {
    const [line] = highlight('`${TEST_ISSUER}/token?n=${count + 1}`', 'ts');
    expect(marked(line)).toEqual(['string:`', 'punct:${', 'punct:}', 'string:/token?n=', 'punct:${', 'number:1', 'punct:}', 'string:`']);
  });

  it('should read nested templates and braces inside a placeholder', () => {
    const text = '`a ${fn({ b: `c` })} d`';
    const tokens = tokenizeTs(text);
    expect(tokens.map((token) => token.text).join('')).toBe(text);
    expect(tokens.at(-1)).toEqual({ type: 'string', text: ' d`' });
  });

  it('should not read a property named like a keyword, a digit in a name or an escaped quote as anything else', () => {
    expect(marked(highlight('module.default.type', 'ts')[0])).toEqual([]);
    expect(marked(highlight('const v2 = x', 'ts')[0])).toEqual(['keyword:const']);
    expect(marked(highlight("'it\\'s' + 1", 'ts')[0])).toEqual(["string:'it\\'s'", 'number:1']);
  });

  it('should end an unclosed string at the end of its line', () => {
    const lines = highlight("const a = 'open\nconst b = 2;", 'ts');
    expect(marked(lines[1])).toEqual(['keyword:const', 'number:2']);
  });
});

describe('Gherkin', () => {
  const feature = [
    '@hono @id:flow',
    'Feature: Authorization code flow',
    '  # a comment',
    '  Scenario Outline: Return <what>',
    '    Given the user "testuser" can log in',
    '    Then the HTTP status is 200',
    '    And the body has:',
    '      """',
    '      Given not a step',
    '      """',
    '    Examples:',
    '      | what | code |',
  ].join('\n');
  const lines = highlight(feature, 'gherkin');

  it('should read the tags, the keywords and the comments', () => {
    expect(marked(lines[0])).toEqual(['tag:@hono', 'tag:@id:flow']);
    expect(marked(lines[1])).toEqual(['keyword:Feature:']);
    expect(marked(lines[2])).toEqual(['comment:  # a comment']);
    expect(marked(lines[3])).toEqual(['keyword:Scenario Outline:']);
    expect(marked(lines[10])).toEqual(['keyword:Examples:']);
  });

  it('should read the strings, numbers and placeholders of a step', () => {
    expect(marked(lines[4])).toEqual(['keyword:Given', 'string:"testuser"']);
    expect(marked(lines[5])).toEqual(['keyword:Then', 'number:200']);
  });

  it('should read a doc string as a string and a table with its pipes', () => {
    expect(marked(lines[8])).toEqual(['string:      Given not a step']);
    expect(marked(lines[11])).toEqual(['punct:|', 'punct:|', 'punct:|']);
  });

  it('should read placeholders in the title of an outline as plain', () => {
    expect(lines[3]?.map((token) => token.text).join('')).toBe('  Scenario Outline: Return <what>');
  });
});
