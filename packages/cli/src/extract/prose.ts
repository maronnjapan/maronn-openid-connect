/**
 * The text of a comment as `maronn-oidc explain` and the provider map show it:
 * the lines of a JSDoc paragraph, a tag or a comment joined into one string.
 *
 * English joins wrapped lines with a space. Japanese puts no space between
 * words, so a sentence written one per line (or wrapped between two kana)
 * joins without one: a space in the middle of a Japanese sentence would show
 * in the map. A line that starts a list item (`- `, `1. `) keeps its line
 * break, for the texts that show their lines (the description of a function).
 */

/** Whether a character takes two columns: CJK, kana, Hangul and the full-width forms. */
export function isWideCharacter(char: string): boolean {
  return /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char);
}

/** Japanese punctuation a line may end with, after which the next line follows without a space. */
const ENDS_WITH_PUNCTUATION = /[。、，．：；！？）」』】〕｝〉》]$/;
/** Japanese punctuation a line may start with, before which the previous line ends without a space. */
const STARTS_WITH_PUNCTUATION = /^[（「『【〔｛〈《。、，．：；！？）」』】〕｝〉》]/;
/** The marker of a list item at the start of a line. */
const LIST_ITEM = /^(?:[-*•・]|\d+[.)])\s/;

/**
 * What goes between two lines of one text: a line break before a list item,
 * nothing next to Japanese punctuation or between two wide characters, a space
 * otherwise (English, or Japanese next to a code span).
 */
export function lineSeparator(before: string, after: string): string {
  if (LIST_ITEM.test(after)) return '\n';
  if (ENDS_WITH_PUNCTUATION.test(before) || STARTS_WITH_PUNCTUATION.test(after)) return '';
  const last = [...before].pop() ?? '';
  const first = [...after][0] ?? '';
  return isWideCharacter(last) && isWideCharacter(first) ? '' : ' ';
}

/** Join the lines of one text (see the module comment), each trimmed; empty lines are left out. */
export function joinLines(lines: readonly string[]): string {
  let text = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    text = text === '' ? line : `${text}${lineSeparator(text, line)}${line}`;
  }
  return text;
}

/** Join the lines of one text into a single line: the list items of joinLines follow a space instead of a line break. */
export function joinLinesFlat(lines: readonly string[]): string {
  return joinLines(lines).replace(/\n/g, ' ');
}
