// @ts-check
import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://theoven.app',
  integrations: [
    starlight({
      title: 'Oven',
      description:
        'The batteries-included Bun framework. Express-simple, FastAPI-smart, everything configurable.',
      logo: { src: './src/assets/oven.svg', replacesTitle: false },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/hiteshchoudhary/theoven' },
      ],
      editLink: {
        baseUrl: 'https://github.com/hiteshchoudhary/theoven/edit/main/apps/web/',
      },
      customCss: ['./src/styles/theme.css'],
      // FastAPI's docs win by being a guided path, not an API dump. The sidebar follows that:
      // learn it, then look things up.
      sidebar: [
        { label: 'Start here', items: [{ autogenerate: { directory: 'start' } }] },
        {
          label: 'Tutorial',
          items: [
            { label: '1. Your first route', slug: 'tutorial/first-route' },
            { label: '2. Validation', slug: 'tutorial/validation', badge: 'Planned' },
            { label: '3. Errors', slug: 'tutorial/errors' },
          ],
        },
        { label: 'Guides', items: [{ autogenerate: { directory: 'guides' } }] },
        { label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
      lastUpdated: true,
      pagination: true,
    }),
  ],
})
