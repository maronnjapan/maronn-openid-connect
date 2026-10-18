/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../test-support/context.js';
import { renderView } from '../../views.js';
import { deviceViews } from './views.js';

describe('deviceViews', () => {
  describe('Default views', () => {
    // RFC 8628 §3.3.1: the user_code of verification_uri_complete is untrusted input.
    it('should render the code entry form with the pre-filled user_code escaped', async () => {
      const views = deviceViews(contextOf());

      const html = await renderView(<views.deviceVerificationPage userCode={'"><script>x</script>'} />).text();

      expect(html).toContain('<form method="post" action="/device">');
      expect(html).toContain('value="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
      expect(html).not.toContain('<script>');
    });

    it('should render the sign-in form with the user_code, csrf_token and the attempts left', async () => {
      const views = deviceViews(contextOf());

      const html = await renderView(
        <views.deviceLoginPage userCode="BCDF-GHJK" csrfToken="csrf-1" error="Invalid credentials" remainingAttempts={4} />,
      ).text();

      expect(html).toContain('<form method="post" action="/device/login">');
      expect(html).toContain('<input type="hidden" name="user_code" value="BCDF-GHJK"/>');
      expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-1"/>');
      expect(html).toContain('Invalid credentials. Attempts remaining: 4');
    });

    // RFC 8628 §5.4: the user_code is repeated so the End-User can compare it with the device.
    it('should render the approval screen with the user_code, the client, the scopes and both decisions', async () => {
      const views = deviceViews(contextOf());

      const html = await renderView(
        <views.deviceApprovalPage userCode="BCDF-GHJK" csrfToken="csrf-1" clientId="tv-app" scopes={['openid', 'email']} />,
      ).text();

      expect(html).toContain('Confirm that your device is showing this code: <strong>BCDF-GHJK</strong>');
      expect(html).toContain('Client <strong>tv-app</strong>');
      expect(html).toContain('<ul><li>openid</li><li>email</li></ul>');
      expect(html).toContain('<button type="submit" name="decision" value="approve">Approve</button>');
      expect(html).toContain('<button type="submit" name="decision" value="deny">Deny</button>');
    });

    it('should render the completed screen for a denial', async () => {
      const views = deviceViews(contextOf());

      const html = await renderView(<views.deviceCompletedPage approved={false} clientId="tv-app" />).text();

      expect(html).toContain('<p>You denied <strong>tv-app</strong>.</p>');
    });
  });

  it('should use a view the app replaced and the defaults for the others', async () => {
    const views = deviceViews(
      contextOf(undefined, { views: { deviceCompletedPage: () => <p>custom completed</p> } }),
    );

    expect(await renderView(<views.deviceCompletedPage approved={true} clientId="tv-app" />).text()).toBe(
      '<p>custom completed</p>',
    );
    expect(await renderView(<views.deviceVerificationPage />).text()).toContain('<h1>Device Activation</h1>');
  });
});
