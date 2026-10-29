import { describe, expect, it } from 'vitest';
import { applySoftwareStatement } from './software-statement.js';

const STATEMENT = 'eyJhbGciOiJSUzI1NiJ9.e30.sig';

describe('applySoftwareStatement', () => {
  // RFC 7591 §3.1.1: the asserted values win; §3.2.1: the statement is kept for the response.
  it('should let the asserted metadata take precedence over the plain metadata and keep the statement', () => {
    const merged = applySoftwareStatement(
      { redirect_uris: ['https://app.example.com/cb'], client_name: 'Plain Name', scope: 'openid' },
      STATEMENT,
      { metadata: { client_name: 'Asserted Name', software_id: 'sw-1' } },
    );
    expect(merged).toEqual({
      redirect_uris: ['https://app.example.com/cb'],
      client_name: 'Asserted Name',
      scope: 'openid',
      software_id: 'sw-1',
      software_statement: STATEMENT,
    });
  });

  // RFC 7591 defines no required claim inside a statement: whatever the verifier returns is applied as is.
  it('should apply every asserted claim without requiring or dropping any', () => {
    const merged = applySoftwareStatement({ redirect_uris: ['https://app.example.com/cb'] }, STATEMENT, {
      metadata: { iss: 'https://publisher.example.com', exp: 1_790_812_800, tenant_id: 'acme' },
    });
    expect(merged).toEqual({
      redirect_uris: ['https://app.example.com/cb'],
      iss: 'https://publisher.example.com',
      exp: 1_790_812_800,
      tenant_id: 'acme',
      software_statement: STATEMENT,
    });
  });

  it('should keep the outer statement when the asserted claims carry a software_statement of their own', () => {
    const merged = applySoftwareStatement({ redirect_uris: [] }, STATEMENT, {
      metadata: { software_statement: 'inner.statement.sig' },
    });
    expect(merged['software_statement']).toBe(STATEMENT);
  });

  it('should build a new object with the Object prototype', () => {
    const plain = JSON.parse('{"redirect_uris":["https://app.example.com/cb"],"__proto__":{"polluted":true}}') as Record<
      string,
      unknown
    >;
    const merged = applySoftwareStatement(plain, STATEMENT, { metadata: {} });
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    // The key stays an inert own data property that validateClientMetadata ignores as unknown metadata.
    expect(Object.getOwnPropertyDescriptor(merged, '__proto__')?.value).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
  });
});
