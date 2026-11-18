import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

const repository = 'https://github.com/zluggish/zluggish';

const config: Config = {
  title: 'Zluggish',
  tagline: 'A self-hosted, open-source Zwift server',
  favicon: 'zluggish.svg',
  url: 'https://docs.zluggish.com',
  baseUrl: '/',
  trailingSlash: true,
  organizationName: 'zluggish',
  projectName: 'zluggish',
  // The repository's media/ folder holds the logo and the screenshots.
  staticDirectories: ['../../media'],
  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: { hooks: { onBrokenMarkdownLinks: 'throw' } },
  i18n: { defaultLocale: 'en', locales: ['en'] },
  presets: [
    [
      'classic',
      {
        docs: {
          path: '../../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // A string editUrl would add the ../../docs path from the site folder to the URL.
          editUrl: ({ docPath }) => `${repository}/edit/main/docs/${docPath}`,
        },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      } satisfies Preset.Options,
    ],
  ],
  themeConfig: {
    colorMode: { respectPrefersColorScheme: true },
    navbar: {
      title: 'Zluggish',
      logo: { alt: 'Zluggish', src: 'zluggish.svg' },
      items: [
        { href: 'https://zluggish.com/', label: 'zluggish.com', position: 'right' },
        { href: repository, label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      links: [
        {
          title: 'Documentation',
          items: [
            { label: 'Install', to: '/install/requirements/' },
            { label: 'Use', to: '/usage/web-app/' },
            { label: 'Reference', to: '/reference/configuration/' },
            { label: 'Troubleshooting', to: '/troubleshooting/password-recovery/' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'Discord', href: 'https://discord.gg/GMdn8F8' },
            { label: 'Strava club', href: 'https://www.strava.com/clubs/zoffline' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'GitHub', href: repository },
            { label: 'Changelog', href: `${repository}/blob/main/CHANGELOG` },
            { label: 'License (AGPL-3.0)', href: `${repository}/blob/main/LICENSE` },
          ],
        },
      ],
      copyright:
        'Zluggish is an independent community project. It is not affiliated with, endorsed by, or supported by Zwift, Inc. Zwift is a trademark of Zwift, Inc.',
    },
    prism: {
      theme: prismThemes.oneLight,
      darkTheme: prismThemes.oneDark,
      additionalLanguages: ['bash', 'powershell', 'ini'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
