import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// BASE_PATH='' for Cloudflare Pages (root deployment)
// BASE_PATH is unset for GitHub Pages (defaults to repo name as subpath)
const base =
  process.env.BASE_PATH !== undefined
    ? process.env.BASE_PATH
    : '/maronn-oidc';

/** @type {import('astro').AstroUserConfig} */
export default defineConfig({
  site: 'https://maronnjapan.github.io',
  base,
  integrations: [
    starlight({
      title: 'Maronn OIDC',
      description:
        'Lightweight OpenID Connect / OAuth 2.1 provider library for rapidly verifying specs in PoC.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/maronnjapan/maronn-oidc',
        },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'introduction' },
            { label: 'Quick Start', slug: 'quick-start' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            {
              label: 'Authorization Code Flow',
              slug: 'concepts/authorization-code-flow',
            },
            { label: 'PKCE', slug: 'concepts/pkce' },
            { label: 'ID Token', slug: 'concepts/id-token' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'CLI Guide', slug: 'guides/cli' },
            { label: 'Using core', slug: 'guides/core' },
          ],
        },
        {
          label: 'Reference',
          items: [{ label: 'Features', slug: 'reference/features' }],
        },
        // Experimental 機能は安定機能と混在させず、独立セクションにまとめる。
        {
          label: 'Experimental',
          items: [
            { label: 'Experimental機能とは', slug: 'experimental' },
            { label: 'PAR (RFC 9126)', slug: 'experimental/par' },
          ],
        },
      ],
    }),
  ],
});
