'use client'; // Error boundaries must be Client Components.

import { ErrorView } from '../_oidc-provider/error-view';

/**
 * Error boundary of the consent page (Next.js error.js): the screen for an
 * exception nobody expected while rendering the page — a store outage, a bug.
 * Expected outcomes never land here: they call notFound(). The consent
 * decision is a Route Handler (decision/route.ts), which this boundary does
 * not cover.
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
