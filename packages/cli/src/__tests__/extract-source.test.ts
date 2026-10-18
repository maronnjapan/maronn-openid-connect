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
});
