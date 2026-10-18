/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../../test-support/context.js';
import { renderView } from '../../views.js';
import { logoutViews } from './views.js';

describe('logoutViews', () => {
  describe('Default views', () => {
    // RP-Initiated Logout 1.0 §2: the End-User confirms, posting only the csrf_token back.
    it('should render the confirmation form posting the csrf_token to /logout/approve', async () => {
      const views = logoutViews(contextOf());

      const html = await renderView(<views.logoutConfirmationPage csrfToken="csrf-1" />).text();

      expect(html).toContain('<p>Do you want to log out of the OpenID Provider?</p>');
      expect(html).toContain('<form method="post" action="/logout/approve">');
      expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-1"/>');
    });

    it('should render the logged-out screen', async () => {
      const views = logoutViews(contextOf());

      const html = await renderView(<views.logoutCompletedPage />).text();

      expect(html).toContain('<h1>Logged out</h1><p>You have been logged out.</p>');
    });
  });

  it('should use a view the app replaced and the defaults for the others', async () => {
    const views = logoutViews(contextOf(undefined, { views: { logoutCompletedPage: () => <p>bye</p> } }));

    expect(await renderView(<views.logoutCompletedPage />).text()).toBe('<p>bye</p>');
    expect(await renderView(<views.logoutConfirmationPage csrfToken="csrf-1" />).text()).toContain('<h1>Log out</h1>');
  });
});
