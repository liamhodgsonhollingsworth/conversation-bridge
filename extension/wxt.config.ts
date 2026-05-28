import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-svelte'],
  runner: {
    startUrls: [],
    openDevtools: false,
  },
  manifest: ({ browser }) => ({
    name: 'Conversation Bridge',
    description: 'Capture conversations and relay them to user-configured endpoints via a transparency-based trust handshake.',
    permissions: ['storage', 'alarms', 'tabs', 'activeTab'],
    host_permissions: [
      'http://localhost:*/*',
      'http://127.0.0.1:*/*',
      'https://claude.ai/*',
      'https://*.anthropic.com/*',
    ],
    // Optional permissions the user grants per-connection at runtime
    optional_host_permissions: ['<all_urls>'],
    ...(browser === 'firefox' && {
      browser_specific_settings: {
        gecko: {
          id: 'conversation-bridge@liamhodgsonhollingsworth.dev',
          strict_min_version: '109.0',
        },
      },
    }),
  }),
});
