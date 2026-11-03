import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceHighlighter, highlightSource } from './highlight.mjs';

describe('source highlighting', () => {
  let highlighter;
  beforeAll(async () => { highlighter = await createSourceHighlighter(); });
  afterAll(() => highlighter?.dispose());

  it('preserves TypeScript text and derives distinct syntax colors from the bundled themes', () => {
    const code = 'const value: string = "hello"; // comment\n';
    const result = highlightSource(highlighter, { path: 'example.ts', code });
    expect(result.code).toBe(code);
    expect(result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
    const tokens = result.tokens[0];
    const colors = ['const', 'string', '"hello"', '// comment'].map((content) => tokens.find((token) => token.content === content)?.color);
    expect(colors.every((color) => color?.startsWith('light-dark('))).toBe(true);
    expect(new Set(colors).size).toBeGreaterThanOrEqual(3);
    expect(result.background).toBe(`light-dark(${highlighter.getTheme('github-light').bg}, ${highlighter.getTheme('github-dark').bg})`);
  });

  it('recognizes TSX and keeps multiline comment context when function lines are selected', () => {
    const code = '/** docs\n * const stays a comment\n */\nexport function View() {\n  return <div title="<tag>">text</div>;\n}\n';
    const result = highlightSource(highlighter, { path: 'view.tsx', code });
    expect(result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
    expect(result.tokens[1]).toHaveLength(1);
    expect(result.tokens[1][0].color).toBe(result.tokens[0][0].color);
    const tag = result.tokens[4].find((token) => token.content === 'div');
    const attribute = result.tokens[4].find((token) => token.content === 'title');
    expect(tag).toBeDefined();
    expect(attribute).toBeDefined();
    expect(tag.color).not.toBe(attribute.color);
    expect(result.tokens[4].some((token) => token.content === '"<tag>"')).toBe(true);
  });
});
