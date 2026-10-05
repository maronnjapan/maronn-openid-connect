import { ErrorView } from '../_oidc-provider/error-view';

/**
 * Not-found screen of the consent page (Next.js not-found.js): rendered when the
 * page or consentAction calls notFound() because this browser is not in the middle
 * of an authorization request — there is no transaction cookie, or the
 * transaction it names is unknown, already finished, or expired. Next.js
 * answers it with HTTP 404. The End-User can only start over from the client
 * application.
 */
export default function ConsentNotFound() {
  return (
    <ErrorView
      error="transaction_not_found"
      description="This sign-in request was not found or has expired. Start again from the application."
    />
  );
}
