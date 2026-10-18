/**
 * The layout of the OP's error screens: the error page (oidc-error/page.tsx)
 * and the not-found.tsx / error.tsx of the login and consent pages all render
 * it, so every way the browser stops on the OP looks the same. Restyle it here.
 */
import type { ReactNode } from 'react';

interface ErrorViewProps {
  /** The error code: an OAuth error, or one of the OP's own. */
  error: string;
  /** Text for the End-User. React escapes it, so it cannot inject markup. */
  description?: string;
  /** Anything the screen adds below the message, such as a retry button. */
  children?: ReactNode;
}

export function ErrorView({ error, description, children }: ErrorViewProps) {
  return (
    <main>
      <h1>Error</h1>
      <p>{error}</p>
      {description ? <p>{description}</p> : null}
      {children}
    </main>
  );
}
