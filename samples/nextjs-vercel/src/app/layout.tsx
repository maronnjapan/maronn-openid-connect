import type { ReactNode } from 'react';

/**
 * The root layout of this sample (Next.js refuses to build pages without one).
 *
 * It belongs to the project, not to the generated code: `maronn-oidc generate`
 * never writes app/layout.tsx, so the generated pages render inside it.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
