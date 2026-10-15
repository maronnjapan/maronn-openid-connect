import { isSafeDisplayUri } from '@maronn-openid-connect/core';
import { clientResolver } from '../_oidc-provider/provider';
import { requireTransaction } from '../_oidc-provider/transaction';
import { consentAction } from './actions';

// The page renders the transaction named by this browser's transaction cookie,
// so it must always render dynamically (never from a static cache).
export const dynamic = 'force-dynamic';

/** Display metadata the consent screen shows about the requesting client. */
interface ClientDisplay {
  clientName?: string;
  clientUri?: string;
  policyUri?: string;
  tosUri?: string;
}

/**
 * Display metadata of the requesting client
 * (OIDC Dynamic Client Registration 1.0 §2 / RFC 7591 §2: client_name /
 * client_uri / policy_uri / tos_uri).
 *
 * The screen renders without it, so an unknown client or a resolver failure
 * falls back to the clientId-only display instead of failing the page: by the
 * time the browser is here, /authorize has already validated the client, and
 * the End-User is better served by a degraded screen than by an error page.
 *
 * Each URI is kept only when isSafeDisplayUri() (core) accepts its scheme
 * (http/https): these values become links in the End-User's browser, where
 * javascript:/data:/custom schemes execute or navigate.
 *
 * The registered logo_uri is deliberately not loaded: an <img> whose URL the
 * client registered opens a default phishing surface (a spoofed well-known
 * logo lends this screen false trust), widens CSP img-src to arbitrary hosts,
 * and leaks the End-User's IP to a third-party server on every consent view.
 * Render a logo only from a customized page after weighing those.
 */
async function loadClientDisplay(clientId: string): Promise<ClientDisplay> {
  const safeUri = (uri: string | undefined) =>
    uri !== undefined && isSafeDisplayUri(uri) ? uri : undefined;
  try {
    const client = await clientResolver.findClient(clientId);
    if (!client) return {};
    return {
      clientName: client.clientName,
      clientUri: safeUri(client.clientUri),
      policyUri: safeUri(client.policyUri),
      tosUri: safeUri(client.tosUri),
    };
  } catch {
    return {};
  }
}

/**
 * Consent page (React Server Component).
 *
 * A real Next.js page, so the consent UI can be built with JSX and React
 * components. The form posts to the consentAction Server Action (actions.ts).
 * Keep the hidden csrf_token field when customizing it: neither the URL nor the
 * form names the transaction — the browser's transaction cookie does — and the
 * action accepts the token only for that transaction.
 *
 * A browser with no live transaction renders not-found.tsx (see
 * requireTransaction() in _oidc-provider/transaction.ts).
 */
export default async function ConsentPage() {
  const { transaction } = await requireTransaction();

  const scopes = transaction.scope.split(' ').filter(Boolean);

  // OIDC Dynamic Client Registration 1.0 §2: client_name identifies the client
  // to the End-User. The name is self-asserted, so the clientId stays visible
  // next to it — a spoofed display name alone must not pass as identification
  // (RFC 6749 §10.2).
  const display = await loadClientDisplay(transaction.clientId);
  const clientLinks = [
    display.clientUri ? { href: display.clientUri, label: 'Website' } : undefined,
    display.policyUri ? { href: display.policyUri, label: 'Privacy Policy' } : undefined,
    display.tosUri ? { href: display.tosUri, label: 'Terms of Service' } : undefined,
  ].filter((link): link is { href: string; label: string } => link !== undefined);
  return (
    <main>
      <h1>Authorize Application</h1>
      <p>
        Client{' '}
        {display.clientName ? (
          <>
            <strong>{display.clientName}</strong> (<code>{transaction.clientId}</code>)
          </>
        ) : (
          <strong>{transaction.clientId}</strong>
        )}{' '}
        is requesting access to the following scopes:
      </p>
      <ul>
        {scopes.map((scope) => (
          <li key={scope}>{scope}</li>
        ))}
      </ul>
      {clientLinks.length > 0 ? (
        <ul>
          {clientLinks.map((link) => (
            <li key={link.label}>
              <a href={link.href} target="_blank" rel="noopener noreferrer">
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {/*
        The submit buttons carry the authorization decision (OIDC Core 1.0
        §3.1.2.4). consentAction accepts exactly 'approve' and 'deny' and rejects
        everything else, so keep both values when customizing this markup:
        renaming 'approve' makes every approval fail with an error page.
      */}
      <form action={consentAction}>
        <input type="hidden" name="csrf_token" value={transaction.csrfToken} />
        <button type="submit" name="action" value="approve">
          Approve
        </button>
        <button type="submit" name="action" value="deny">
          Deny
        </button>
      </form>
    </main>
  );
}
