/**
 * The code of the map as data with its colors: Shiki's TypeScript and TSX
 * grammars and its bundled github-light / github-dark themes, applied to a
 * whole file before any part of it is cut out, so a comment or a string that
 * spans lines keeps its color. The page carries no Shiki.
 */
import { createHighlighter, type Highlighter } from 'shiki';
import type { DiffHunk, SourceDocument } from './model.js';

/** Load the grammars and the themes once for the whole build. */
export function createSourceHighlighter(): Promise<Highlighter> {
  return createHighlighter({ langs: ['typescript', 'tsx'], themes: ['github-light', 'github-dark'] });
}

/** The tokens of a whole file with the colors of both themes (`light-dark(...)`). */
export function highlightSource(highlighter: Highlighter, { path, code }: { path: string; code: string }): SourceDocument {
  const light = highlighter.getTheme('github-light');
  const dark = highlighter.getTheme('github-dark');
  const dual = (a: string, b: string) => `light-dark(${a}, ${b})`;
  const tokens = highlighter.codeToTokensWithThemes(code, {
    lang: path.endsWith('.tsx') ? 'tsx' : 'typescript',
    themes: { light: 'github-light', dark: 'github-dark' },
  });
  return {
    code,
    foreground: dual(light.fg, dark.fg),
    background: dual(light.bg, dark.bg),
    tokens: tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        color: dual(token.variants['light']?.color ?? light.fg, token.variants['dark']?.color ?? dark.fg),
      })),
    ),
  };
}

/** The tokens of the lines of hunks, each from its revision (removed lines from the base, the others from the head). */
export function highlightHunks(hunks: readonly DiffHunk[], before: SourceDocument['tokens'] | undefined, after: SourceDocument['tokens'] | undefined): DiffHunk[] {
  return hunks.map((hunk) => {
    let base = hunk.base - 1;
    let head = hunk.head - 1;
    const tokens = hunk.lines.map((line) => {
      if (line[0] === '-') return before?.[base++] ?? [];
      if (line[0] === '+') return after?.[head++] ?? [];
      base += 1;
      return after?.[head++] ?? [];
    });
    return { ...hunk, tokens };
  });
}
