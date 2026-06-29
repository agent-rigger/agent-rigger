// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';

// GitHub Pages project site: https://agent-rigger.github.io/agent-rigger/
// For a user/org page or a custom domain, set base to '/' and site accordingly.
export default defineConfig({
  site: 'https://agent-rigger.github.io',
  base: '/agent-rigger',
  integrations: [
    starlight({
      title: 'agent-rigger',
      description:
        'The harness package manager for teams. Pin, share and audit your AI coding setup so it never drifts.',
      tagline: 'Your team’s AI harness drifts. Pin it.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/agent-rigger/agent-rigger',
        },
      ],
      customCss: ['./src/styles/landing.css'],
      sidebar: [
        { label: 'Get started', link: '/getting-started/' },
        { label: 'Concepts', link: '/concepts/' },
        { label: 'Commands', link: '/commands/' },
        { label: 'Security', link: '/security/' },
      ],
    }),
  ],
});
