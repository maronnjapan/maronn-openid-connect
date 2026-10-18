/** @jsxImportSource hono/jsx */
import { describe, expect, it } from 'vitest';
import { createViews, defaultViews, renderView, type LoginPageParams } from './views.js';

async function AsyncGreeting() {
  await Promise.resolve();
  return <p>resolved later</p>;
}

describe('renderView', () => {
  it('should answer 200 text/html with the HTML of the element', async () => {
    const response = renderView(<p>hello</p>);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=UTF-8');
    expect(await response.text()).toBe('<p>hello</p>');
  });

  it('should answer with the status of init', () => {
    expect(renderView(<p>locked</p>, { status: 429 }).status).toBe(429);
  });

  it('should stream the HTML of a view that contains an async component once it resolves', async () => {
    const response = renderView(
      <div>
        <AsyncGreeting />
      </div>,
    );

    expect(await response.text()).toBe('<div><p>resolved later</p></div>');
  });
});

describe('createViews', () => {
  it('should return the default views when nothing is overridden', () => {
    expect(createViews()).toBe(defaultViews);
  });

  it('should replace only the overridden views', () => {
    const loginPage = (params: LoginPageParams) => <p>{params.csrfToken}</p>;

    const views = createViews({ loginPage });

    expect(views.loginPage).toBe(loginPage);
    expect(views.consentPage).toBe(defaultViews.consentPage);
    expect(views.errorPage).toBe(defaultViews.errorPage);
  });
});

describe('defaultViews', () => {
  describe('loginPage', () => {
    // OIDC Core 1.0 §3.1.2.1: login_hint is unauthenticated input that pre-fills the form.
    it('should escape login_hint in the username field', async () => {
      const html = await renderView(
        defaultViews.loginPage({ csrfToken: 'csrf-1', loginHint: '"><script>alert(1)</script>' }),
      ).text();

      expect(html).toContain('value="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"');
      expect(html).not.toContain('<script>');
    });

    it('should embed the csrf_token and show the failure with the attempts left', async () => {
      const html = await renderView(
        defaultViews.loginPage({ csrfToken: 'csrf-1', error: 'Invalid credentials', remainingAttempts: 3 }),
      ).text();

      expect(html).toContain('<input type="hidden" name="csrf_token" value="csrf-1"/>');
      expect(html).toContain('<p style="color: red;">Invalid credentials. Attempts remaining: 3</p>');
    });
  });

  describe('consentPage', () => {
    // OIDC Core 1.0 §3.1.2.4: the decision values the consent step accepts are approve and deny.
    it('should list the scopes and offer the approve and deny decisions', async () => {
      const html = await renderView(
        defaultViews.consentPage({ csrfToken: 'csrf-1', clientId: 'client-1', scopes: ['openid', 'email'] }),
      ).text();

      expect(html).toContain('<strong>client-1</strong>');
      expect(html).toContain('<ul><li>openid</li><li>email</li></ul>');
      expect(html).toContain('<button type="submit" name="action" value="approve">Approve</button>');
      expect(html).toContain('<button type="submit" name="action" value="deny">Deny</button>');
    });
  });
});
