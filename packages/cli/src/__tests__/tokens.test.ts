import { describe, expect, it } from 'vitest';
import { codeMaskOf, tokenize } from '../extract/tokens.js';

describe('tokenize', () => {
  it('should read a slash after a value as a division and after an operator as a regular expression', () => {
    const source = 'a / b; x.replace(/"/g, "&quot;")';
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.map((token) => token.type)).toEqual(['word', 'punct', 'word', 'punct', 'word', 'punct', 'word', 'punct', 'regex', 'punct', 'string', 'punct']);
  });

  it('should tokenize the code inside a template literal in place', () => {
    const source = '`a${f(x)}b`';
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.map((token) => token.text)).toEqual(['`a${', 'f', '(', 'x', ')', '}b`']);
  });

  it('should keep reading past a JSX closing tag and an apostrophe of a JSX text', () => {
    const source = "<p>Don't</p>; next()";
    const { tokens } = tokenize(source, 0, source.length);
    expect(tokens.slice(-4).map((token) => token.text)).toEqual([';', 'next', '(', ')']);
  });

  it('should collect the comments apart from the tokens', () => {
    const source = '// first\na(); /* second */';
    const { tokens, comments } = tokenize(source, 0, source.length);
    expect(comments.map((comment) => comment.text)).toEqual(['// first', '/* second */']);
    expect(tokens.map((token) => token.text)).toEqual(['a', '(', ')', ';']);
  });
});

describe('codeMaskOf', () => {
  it('should mark strings, comments, regular expressions and template text as not code', () => {
    const source = "f('x'); // c\ng(/'/g, `t${h()}`)";
    const mask = codeMaskOf(source);
    const code = [...source].filter((_char, index) => mask[index] === 1).join('');
    expect(code.replace(/\s/g, '')).toEqual('f();g(,h())');
  });
});
