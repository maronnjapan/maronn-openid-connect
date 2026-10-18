/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../test-support/context.js';
import { renderView } from '../../views.js';
import { cibaViews } from './views.js';

describe('cibaViews', () => {
  describe('Default views', () => {
    it('should render the sign-in form with the login transaction id, csrf_token and the attempts left', async () => {
      const views = cibaViews(contextOf());

      const html = await renderView(
        <views.cibaLoginPage loginTransactionId="txn-1" csrfToken="csrf-1" error="Invalid credentials" remainingAttempts={2} />,
      ).text();

      expect(html).toContain('<form method="post" action="/ciba/login">');
      expect(html).toContain('<input type="hidden" name="login_transaction_id" value="txn-1"/>');
      expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-1"/>');
      expect(html).toContain('Invalid credentials. Attempts remaining: 2');
    });

    it('should say there is nothing to review when no request is pending', async () => {
      const views = cibaViews(contextOf());

      const html = await renderView(<views.cibaPendingRequestsPage requests={[]} />).text();

      expect(html).toContain('<p>No pending sign-in requests.</p>');
      expect(html).not.toContain('<form');
    });

    // CIBA Core 1.0 §7.1: binding_message is client-supplied text shown for comparison.
    it('should render each pending request with its scopes, expiry and an escaped binding_message', async () => {
      const views = cibaViews(contextOf());

      const html = await renderView(
        <views.cibaPendingRequestsPage
          requests={[
            {
              authReqId: 'req-1',
              clientId: 'call-center',
              scopes: ['openid', 'email'],
              bindingMessage: '<b>W4SCT</b>',
              expiresInSeconds: 90,
              csrfToken: 'csrf-1',
            },
          ]}
        />,
      ).text();

      expect(html).toContain('Client <strong>call-center</strong>');
      expect(html).toContain('<ul><li>openid</li><li>email</li></ul>');
      expect(html).toContain('<strong>&lt;b&gt;W4SCT&lt;/b&gt;</strong>');
      expect(html).toContain('This request expires in 90 seconds.');
      expect(html).toContain('<input type="hidden" name="auth_req_id" value="req-1"/>');
      expect(html).toContain('<button type="submit" name="decision" value="deny">Deny</button>');
    });

    it('should render the completed screen for an approval', async () => {
      const views = cibaViews(contextOf());

      const html = await renderView(<views.cibaCompletedPage approved={true} clientId="call-center" />).text();

      expect(html).toContain('<p>You approved <strong>call-center</strong>.</p>');
    });
  });

  it('should use a view the app replaced and the defaults for the others', async () => {
    const views = cibaViews(contextOf(undefined, { views: { cibaLoginPage: () => <p>custom login</p> } }));

    expect(await renderView(<views.cibaLoginPage loginTransactionId="txn-1" csrfToken="csrf-1" />).text()).toBe(
      '<p>custom login</p>',
    );
    expect(await renderView(<views.cibaPendingRequestsPage requests={[]} />).text()).toContain('<h1>Sign-in Requests</h1>');
  });
});
