import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'yak-harness',
  tagline: 'a stateless cron reconciler between a GitHub Issues backlog and yak',
  favicon: 'img/yak-harness-logo.svg',

  future: {
    v4: true,
  },

  url: 'https://lchase.github.io',
  baseUrl: '/yak-harness/',

  // GitHub pages deployment config.
  organizationName: 'lchase',
  projectName: 'yak-harness',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/lchase/yak-harness/tree/main/docs-site/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'yak-harness',
      logo: {
        alt: 'yak-harness logo',
        src: 'img/yak-harness-logo-light.svg',
        srcDark: 'img/yak-harness-logo.svg',
      },
      items: [
        {
          href: 'https://github.com/lchase/yak-harness',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/lchase/yak-harness',
            },
            {
              label: 'yak',
              href: 'https://lchase.github.io/yak/',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} yak-harness. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
