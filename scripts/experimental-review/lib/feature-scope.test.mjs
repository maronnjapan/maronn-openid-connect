import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  kebabToCamel,
  camelToPascal,
  countFeatureMentions,
  parseEnabledFeatures,
  parseOutputDir,
  countLines,
  parseSpecName,
} from './feature-scope.mjs';

test('kebabToCamel', async (t) => {
  await t.test('should convert token-exchange to tokenExchange', () => {
    assert.equal(kebabToCamel('token-exchange'), 'tokenExchange');
  });

  await t.test('should keep a single-word id unchanged', () => {
    assert.equal(kebabToCamel('par'), 'par');
  });
});

test('camelToPascal', async (t) => {
  await t.test('should convert tokenExchange to TokenExchange', () => {
    assert.equal(camelToPascal('tokenExchange'), 'TokenExchange');
  });

  await t.test('should convert par to Par', () => {
    assert.equal(camelToPascal('par'), 'Par');
  });
});

test('countFeatureMentions', async (t) => {
  await t.test('should not match par inside params or parse', () => {
    assert.equal(countFeatureMentions('const params = parse(input);', 'par'), 0);
  });

  await t.test('should match the exact kebab id as a word', () => {
    assert.equal(countFeatureMentions("enable: ['par']", 'par'), 1);
  });

  await t.test('should match the uppercase spec name in comments', () => {
    assert.equal(countFeatureMentions('// PAR (RFC 9126)', 'par'), 1);
  });

  await t.test('should match a feature-config property access', () => {
    assert.equal(countFeatureMentions('if (features.par) {', 'par'), 1);
  });

  await t.test('should match camelCase identifiers that start with the feature id', () => {
    assert.equal(countFeatureMentions('parStore, parConfig', 'par'), 2);
  });

  await t.test('should match PascalCase identifiers that start with the feature id', () => {
    assert.equal(countFeatureMentions('throw new ParError();', 'par'), 1);
  });

  await t.test('should not match PascalCase words that merely share the prefix letters', () => {
    assert.equal(countFeatureMentions('new ParseError(); params;', 'par'), 0);
  });

  await t.test('should count each mention on a line once even when rules overlap', () => {
    // "par" is matched by both the word rule and the camel-identifier rule.
    assert.equal(countFeatureMentions('const par = 1;', 'par'), 1);
  });

  await t.test('should match the hyphenated id inside a longer file name', () => {
    assert.equal(
      countFeatureMentions("import x from './token-exchange-request.js';", 'token-exchange'),
      1,
    );
  });

  await t.test('should match camelCase mentions of a hyphenated id', () => {
    assert.equal(countFeatureMentions('features.tokenExchange = true;', 'token-exchange'), 1);
  });

  await t.test('should match PascalCase mentions of a hyphenated id', () => {
    assert.equal(countFeatureMentions('TokenExchangeRequest', 'token-exchange'), 1);
  });

  await t.test('should match compound jarm identifiers', () => {
    assert.equal(countFeatureMentions('const jarmConfig = {};', 'jarm'), 1);
  });

  await t.test('should count multiple distinct mentions across lines', () => {
    const content = "features.jarm\n// JARM final\njarmResponseModeStep('query.jwt')";
    assert.equal(countFeatureMentions(content, 'jarm'), 3);
  });

  await t.test('should return 0 for unrelated content', () => {
    assert.equal(countFeatureMentions('const refreshToken = issue();', 'jarm'), 0);
  });
});

test('parseEnabledFeatures', async (t) => {
  await t.test('should extract every --enable value from a generate script', () => {
    const script =
      'maronn-oidc generate hono --enable par --enable token-exchange --enable transaction-binding --enable jarm --output ./src/oidc-provider';
    assert.deepEqual(parseEnabledFeatures(script), [
      'par',
      'token-exchange',
      'transaction-binding',
      'jarm',
    ]);
  });

  await t.test('should return an empty list when nothing is enabled', () => {
    assert.deepEqual(
      parseEnabledFeatures('maronn-oidc generate express --output ./src/oidc-provider'),
      [],
    );
  });

  await t.test('should return an empty list for a missing script', () => {
    assert.deepEqual(parseEnabledFeatures(undefined), []);
  });
});

test('parseOutputDir', async (t) => {
  await t.test('should extract the --output value from a generate script', () => {
    assert.equal(
      parseOutputDir('maronn-oidc generate hono --enable par --output ./src/oidc-provider'),
      'src/oidc-provider',
    );
  });

  await t.test('should return null when no --output is present', () => {
    assert.equal(parseOutputDir('maronn-oidc generate hono'), null);
  });

  await t.test('should return null for a missing script', () => {
    assert.equal(parseOutputDir(undefined), null);
  });
});

test('countLines', async (t) => {
  await t.test('should count newline-terminated lines', () => {
    assert.equal(countLines('a\nb\nc\n'), 3);
  });

  await t.test('should count a final line without trailing newline', () => {
    assert.equal(countLines('a\nb'), 2);
  });

  await t.test('should return 0 for empty content', () => {
    assert.equal(countLines(''), 0);
  });
});

test('parseSpecName', async (t) => {
  await t.test('should extract the 準拠仕様 value from a specification document', () => {
    const spec = [
      '# Experimental機能仕様書: Pushed Authorization Requests (PAR)',
      '',
      '- **機能名**: Pushed Authorization Requests (PAR)',
      '- **準拠仕様**: RFC 9126 - OAuth 2.0 Pushed Authorization Requests',
    ].join('\n');
    assert.equal(parseSpecName(spec), 'RFC 9126 - OAuth 2.0 Pushed Authorization Requests');
  });

  await t.test('should return null when the document has no 準拠仕様 line', () => {
    assert.equal(parseSpecName('# 仕様書\n本文のみ\n'), null);
  });

  await t.test('should return null for missing content', () => {
    assert.equal(parseSpecName(undefined), null);
  });
});
