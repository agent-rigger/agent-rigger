import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

export default defineConfig({
  // Org-root deployment (site-deploy-github-pages): served at the domain root by
  // the agent-rigger.github.io mirror, so no `base` path. Setting `site` lets the
  // sitemap integration emit absolute URLs (the missing-`site` build WARN is gone).
  site: 'https://agent-rigger.github.io',
  integrations: [
    starlight({
      title: 'agent-rigger',
      description: "The harness package manager for teams — describe your AI coding assistants' "
        + 'setup once in a versioned catalog, then install, check, and update it reproducibly on '
        + 'every machine.',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/agent-rigger/agent-rigger' },
      ],
      components: {
        // Add a locale-aware "Docs" link to the header, alongside the social icons.
        SocialIcons: './src/components/SocialIcons.astro',
      },
      customCss: ['./src/styles/custom.css'],
      defaultLocale: 'root',
      locales: {
        root: { label: 'English', lang: 'en' },
        fr: { label: 'Français', lang: 'fr' },
      },
      sidebar: [
        {
          label: 'Start here',
          translations: { fr: 'Pour commencer' },
          items: [
            { slug: 'start/what-is-agent-rigger' },
            { slug: 'start/installation' },
            { slug: 'start/getting-started' },
            { slug: 'start/sandbox' },
          ],
        },
        {
          label: 'Concepts',
          translations: { fr: 'Concepts' },
          items: [
            { slug: 'concepts/core-concepts' },
            { slug: 'concepts/artifact-natures' },
            { slug: 'concepts/trust-and-security' },
            { slug: 'concepts/one-source-many-assistants' },
            { slug: 'concepts/safety-and-reversibility' },
            { slug: 'concepts/versioning-and-provenance' },
          ],
        },
        {
          label: 'Guides — use your rig',
          translations: { fr: 'Guides — utiliser votre rig' },
          items: [
            { slug: 'guides/install-from-catalog' },
            { slug: 'guides/update-artifacts' },
            { slug: 'guides/remove-artifacts' },
            { slug: 'guides/ci-and-scripts' },
            { slug: 'guides/ad-hoc-install' },
            { slug: 'guides/multiple-catalogs' },
            { slug: 'guides/choose-assistant' },
            { slug: 'guides/mcp-secrets' },
            { slug: 'guides/doctor' },
          ],
        },
        {
          label: 'Guides — author a catalog',
          translations: { fr: 'Guides — créer un catalog' },
          items: [
            { slug: 'authoring/create-a-catalog' },
            { slug: 'authoring/skills' },
            { slug: 'authoring/agents' },
            { slug: 'authoring/guardrails' },
            { slug: 'authoring/hooks' },
            { slug: 'authoring/packs' },
            { slug: 'authoring/release' },
          ],
        },
        {
          label: 'Reference',
          translations: { fr: 'Référence' },
          items: [
            {
              label: 'CLI',
              translations: { fr: 'CLI' },
              items: [
                { slug: 'reference/cli/overview' },
                { slug: 'reference/cli/init' },
                { slug: 'reference/cli/install' },
                { slug: 'reference/cli/check' },
                { slug: 'reference/cli/update' },
                { slug: 'reference/cli/remove' },
                { slug: 'reference/cli/ls' },
                { slug: 'reference/cli/doctor' },
                { slug: 'reference/cli/catalog' },
                { slug: 'reference/cli/resource-verbs' },
              ],
            },
            { slug: 'reference/exit-codes' },
            { slug: 'reference/catalog-schema' },
            { slug: 'reference/catalog-layout' },
            { slug: 'reference/natures-matrix' },
            { slug: 'reference/configuration' },
            { slug: 'reference/hook-events' },
            { slug: 'reference/platforms' },
            { slug: 'reference/glossary' },
          ],
        },
      ],
      plugins: [starlightLinksValidator()],
    }),
  ],
});
