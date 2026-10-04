'use client'; // Error boundaries must be Client Components.

import { ErrorView } from '../_oidc-provider/error-view';

/**
 * Error boundary of the consent page (Next.js error.js): the screen for an
 * exception nobody expected while rendering the page or running consentAction —
 * a store outage, a bug. Expected outcomes never land here: they redirect to the
 * OP's error page or call notFound().
 *
 * In production Next.js withholds the error message from the browser and passes
 * error.digest instead, which matches the entry in the server log. retry()
 * fetches and renders the page again.
 */
export default function ConsentError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <ErrorView error="server_error" description={error.digest ? 'Reference: ' + error.digest : undefined}>
      <button type="button" onClick={() => retry()}>
        Try again
      </button>
    </ErrorView>
  );
}
