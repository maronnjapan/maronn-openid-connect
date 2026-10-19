/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { contextOf } from '../../test-support/context.js';
import { createViews, type FormPostPageParams } from '../views.js';
import { respondToClient } from './authorization-response.js';

const TRANSACTION_COOKIE = '__Host-oidc_txn=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';

describe('respondToClient', () => {
  describe('Redirect', () => {
    it('should redirect the browser to the location with the cookies attached', () => {
      const response = respondToClient(
        contextOf(),
        { method: 'redirect', location: 'https://rp.example.com/callback?code=code-1' },
        [TRANSACTION_COOKIE],
      );

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('https://rp.example.com/callback?code=code-1');
      expect(response.headers.getSetCookie()).toEqual([TRANSACTION_COOKIE]);
    });
  });

  describe('Form post', () => {
    // OAuth 2.0 Form Post Response Mode §2 / Appendix A.
    it('should answer 200 with the form page, forbid storing it and attach the cookies', async () => {
      const response = respondToClient(
        contextOf(),
        { method: 'form_post', action: 'https://rp.example.com/callback', fields: { code: 'code-1' } },
        [TRANSACTION_COOKIE],
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
      expect(response.headers.get('Cache-Control')).toBe('no-cache, no-store');
      expect(response.headers.get('Pragma')).toBe('no-cache');
      expect(response.headers.getSetCookie()).toEqual([TRANSACTION_COOKIE]);
      expect(await response.text()).toContain(
        '<form method="post" action="https://rp.example.com/callback"><input type="hidden" name="code" value="code-1"/>',
      );
    });

    it('should render the form page of the views of the request context', async () => {
      const views = createViews({
        formPostPage: (params: FormPostPageParams) => (
          <form action={params.action}>{Object.keys(params.fields).join(',')}</form>
        ),
      });

      const response = respondToClient(contextOf(undefined, { views }), {
        method: 'form_post',
        action: 'https://rp.example.com/callback',
        fields: { code: 'code-1', iss: 'https://op.example.com' },
      });

      expect(await response.text()).toBe('<form action="https://rp.example.com/callback">code,iss</form>');
      expect(response.headers.getSetCookie()).toEqual([]);
    });
  });
});
