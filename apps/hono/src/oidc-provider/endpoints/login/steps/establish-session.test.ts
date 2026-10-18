import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { providerContext } from '../../../../test-support/context.js';
import { establishBrowserSession } from './establish-session.js';

describe('establishBrowserSession', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.500Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // OIDC Core 1.0 §3.1.2.3 / §2: auth_time is the login time in whole seconds.
  it('should store a browser session for the subject with the login time in seconds', async () => {
    const { c, db } = await providerContext();

    const { sessionId, authTime } = await establishBrowserSession(c, 'alice');

    expect(authTime).toBe(1767225600);
    expect(db.browserSessions.get(sessionId)).toEqual({ subject: 'alice', authTime: 1767225600 });
  });

  it('should mint an unguessable base64url session id of 32 random bytes', async () => {
    const { c } = await providerContext();

    const { sessionId } = await establishBrowserSession(c, 'alice');

    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('should mint a new session id for every login', async () => {
    const { c, db } = await providerContext();

    const first = await establishBrowserSession(c, 'alice');
    const second = await establishBrowserSession(c, 'alice');

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(db.browserSessions.size).toBe(2);
  });
});
