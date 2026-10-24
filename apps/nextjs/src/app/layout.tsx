import type { ReactNode } from 'react';

/**
 * The root layout of this app (Next.js refuses to build pages without one).
 *
 * The CLI does not copy it (extract.json excludes app/layout.tsx): the
 * generated pages render inside the root layout of the project they are
 * generated into.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
