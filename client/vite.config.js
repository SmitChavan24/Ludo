import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA so users can "install" the game to their home screen — important for the
// mobile-first Indian audience (no app store needed).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'CoinLudo — Play & Win',
        short_name: 'CoinLudo',
        description: 'Multiplayer Ludo with a coin wallet.',
        theme_color: '#0f1226',
        background_color: '#0f1226',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
});
