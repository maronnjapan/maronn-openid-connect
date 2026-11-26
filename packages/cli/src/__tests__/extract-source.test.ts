import { describe, it, expect } from 'vitest';
import { identifiersIn } from '../extract/source.js';

describe('identifiersIn', () => {
  it('should read an identifier that a spread starts', () => {
    expect([...identifiersIn('const grants = [...tokenGrantsOf(features)];')]).toEqual([
      'const',
      'grants',
      'tokenGrantsOf',
      'features',
    ]);
  });

  it('should not read the name of a property access', () => {
    expect([...identifiersIn('config.issuer')]).toEqual(['config']);
  });

  it('should not read what comments and strings say', () => {
    expect([...identifiersIn("// hidden\nconst label = 'hidden too';")]).toEqual(['const', 'label']);
  });

  // A name read only inside `${…}` is read: removing the block that defines it would break the output.
  it('should read the expressions of a template literal and not its text', () => {
    expect([...identifiersIn('const message = `Parameter "${sanitize(key)}" must not be repeated`;')]).toEqual([
      'const',
      'message',
      'sanitize',
      'key',
    ]);
  });

  it('should read nested templates, object literals inside an expression, and the code after the template', () => {
    expect([...identifiersIn('f(`a${g({ x: `b${inner}` })}c`, after);')]).toEqual(['f', 'g', 'x', 'inner', 'after']);
  });

  it('should read the names after a quote that no quote closes on its line, as in a regex literal', () => {
    expect([...identifiersIn("if (/['\"]/.test(raw)) return rejectQuoted(raw);")]).toEqual(['if', 'raw', 'return', 'rejectQuoted']);
  });

  it('should not take the // of a URL in a template literal for a comment', () => {
    expect([...identifiersIn('const url = `https://${host}/token`; next(url);')]).toEqual(['const', 'url', 'host', 'next']);
  });
});
