import { describe, expect, it } from 'vitest';
import {
  buildClearedSessionCookie,
  buildClearedTransactionCookie,
  buildSessionCookie,
  buildTransactionCookie,
  isSameOriginFormPost,
  parseSessionId,
  parseTransactionId,
} from './cookies.js';

const ISSUER = 'https://op.example.com';

describe('parseSessionId', () => {
  it('should return the session_id value among other cookies', () => {
    expect(parseSessionId('theme=dark; session_id=abc123; lang=en')).toBe('abc123');
  });

  it('should return undefined when the Cookie header is missing', () => {
    expect(parseSessionId(null)).toBeUndefined();
  });

  it('should return undefined for a cookie whose name only ends with session_id', () => {
    expect(parseSessionId('old_session_id=abc123')).toBeUndefined();
  });
});

describe('buildSessionCookie', () => {
  // OIDC Core 1.0 §3.1.2.3: SameSite=Lax keeps the cookie on the cross-site redirect back to /authorize.
  it('should build an HttpOnly, Secure, SameSite=Lax cookie on Path=/', () => {
    expect(buildSessionCookie('abc123')).toBe('session_id=abc123; HttpOnly; Secure; SameSite=Lax; Path=/');
  });
});

describe('buildClearedSessionCookie', () => {
  // RP-Initiated Logout 1.0 §2: the cookie goes away together with the store entry.
  it('should build a session_id cookie that expires immediately', () => {
    expect(buildClearedSessionCookie()).toBe('session_id=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  });
});

describe('buildTransactionCookie', () => {
  it('should build a __Host- cookie whose Max-Age is the transaction TTL', () => {
    expect(buildTransactionCookie('txn-1', 600)).toBe(
      '__Host-oidc_txn=txn-1; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600',
    );
  });
});

describe('buildClearedTransactionCookie', () => {
  it('should build a __Host- cookie that expires immediately with Secure and Path=/', () => {
    expect(buildClearedTransactionCookie()).toBe(
      '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });
});

describe('parseTransactionId', () => {
  it('should return the transaction id among other cookies', () => {
    expect(parseTransactionId('session_id=abc; __Host-oidc_txn=txn-1')).toBe('txn-1');
  });

  it('should return undefined for a cleared transaction cookie', () => {
    expect(parseTransactionId('__Host-oidc_txn=')).toBeUndefined();
  });

  it('should return undefined when the Cookie header has no transaction cookie', () => {
    expect(parseTransactionId('session_id=abc')).toBeUndefined();
  });

  it('should return undefined when the Cookie header is missing', () => {
    expect(parseTransactionId(null)).toBeUndefined();
  });
});

describe('isSameOriginFormPost', () => {
  describe('Sec-Fetch-Site', () => {
    it('should accept same-origin', () => {
      expect(isSameOriginFormPost({ origin: null, secFetchSite: 'same-origin' }, ISSUER)).toBe(true);
    });

    // A user-initiated request (a reload) that no other site can trigger.
    it('should accept none', () => {
      expect(isSameOriginFormPost({ origin: null, secFetchSite: 'none' }, ISSUER)).toBe(true);
    });

    it('should reject same-site even when Origin matches the issuer', () => {
      expect(isSameOriginFormPost({ origin: ISSUER, secFetchSite: 'same-site' }, ISSUER)).toBe(false);
    });

    it('should reject cross-site', () => {
      expect(isSameOriginFormPost({ origin: null, secFetchSite: 'cross-site' }, ISSUER)).toBe(false);
    });
  });

  describe('Origin', () => {
    it('should accept the origin of an issuer that has a path', () => {
      expect(
        isSameOriginFormPost({ origin: 'https://op.example.com', secFetchSite: null }, 'https://op.example.com/tenant'),
      ).toBe(true);
    });

    it('should reject the origin of a sibling subdomain', () => {
      expect(isSameOriginFormPost({ origin: 'https://evil.example.com', secFetchSite: null }, ISSUER)).toBe(false);
    });

    it('should reject the opaque origin null', () => {
      expect(isSameOriginFormPost({ origin: 'null', secFetchSite: null }, ISSUER)).toBe(false);
    });
  });

  // A request from a non-browser HTTP client: the cookie and csrf_token still apply.
  it('should accept a request without Sec-Fetch-Site and Origin', () => {
    expect(isSameOriginFormPost({ origin: null, secFetchSite: null }, ISSUER)).toBe(true);
  });
});
