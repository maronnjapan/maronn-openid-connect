import { createHighlighter } from 'shiki';

/** Load the official grammars and bundled themes once for the whole data build. */
export function createSourceHighlighter() {
  return createHighlighter({ langs: ['typescript', 'tsx'], themes: ['github-light', 'github-dark'] });
}

/** Tokenize the complete file before slicing functions, preserving multiline comments and strings. */
export function highlightSource(highlighter, { path, code }) {
  const light = highlighter.getTheme('github-light');
  const dark = highlighter.getTheme('github-dark');
  const dual = (a, b) => `light-dark(${a}, ${b})`;
  const tokens = highlighter.codeToTokensWithThemes(code, {
    lang: path.endsWith('.tsx') ? 'tsx' : 'typescript',
    themes: { light: 'github-light', dark: 'github-dark' },
  });
  return {
    code,
    foreground: dual(light.fg, dark.fg),
    background: dual(light.bg, dark.bg),
    tokens: tokens.map((line) => line.map((token) => ({
      content: token.content,
      color: dual(token.variants.light.color ?? light.fg, token.variants.dark.color ?? dark.fg),
    }))),
  };
}
