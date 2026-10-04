import type { Metadata } from 'next';
import { ErrorView } from '../_oidc-provider/error-view';

// The Authorization Endpoint, the login / consent steps and the Google callback
// send the browser here with error / error_description in the query, so the
// page renders per request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Error',
  // An error screen is never a search result.
  robots: { index: false },
};

interface OidcErrorPageProps {
  searchParams: Promise<{ error?: string; error_description?: string }>;
}

/**
 * The OP's own error page (OIDC Core 1.0 §3.1.2.2).
 *
 * Errors that must not be redirected to the client end up here: an unknown
 * client_id, an unregistered redirect_uri, a transaction this browser may not
 * continue, a consent POST without a decision, a failed Google callback. It is
 * drawn by ErrorView (_oidc-provider/error-view.tsx), like the not-found and
 * error screens of the login and consent pages.
 */
export default async function OidcErrorPage({ searchParams }: OidcErrorPageProps) {
  const { error, error_description: errorDescription } = await searchParams;

  return <ErrorView error={error ?? 'invalid_request'} description={errorDescription} />;
}
