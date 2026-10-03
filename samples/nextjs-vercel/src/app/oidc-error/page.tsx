// The Authorization Endpoint and the login / consent steps send the browser here
// with error / error_description in the query, so the page renders per request.
export const dynamic = 'force-dynamic';

interface OidcErrorPageProps {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}

/**
 * The OP's own error page (OIDC Core 1.0 §3.1.2.2).
 *
 * Errors that must not be redirected to the client end up here: an unknown
 * client_id, an unregistered redirect_uri, a transaction this browser may not
 * continue, a consent POST without a decision. React escapes the values, so a
 * crafted error_description cannot inject markup. Customize this page freely.
 */
export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {
  const { error, error_description: errorDescription } = await searchParams;

  return (
    <main>
      <h1>Error</h1>
      <p>{error ?? 'invalid_request'}</p>
      {errorDescription ? <p>{errorDescription}</p> : null}
    </main>
  );
}
