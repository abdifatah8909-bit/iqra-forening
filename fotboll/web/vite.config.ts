import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  // The demo build is packed into a single HTML file (scripts/inline-demo.mjs).
  ...(mode === 'demo'
    ? {
        base: './',
        build: {
          outDir: 'dist-demo',
          assetsInlineLimit: 100_000,
          cssCodeSplit: false,
          rollupOptions: { output: { inlineDynamicImports: true } },
        },
      }
    : {}),
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Nidaamka UKCS',
        short_name: 'UKCS',
        description: 'Nidaamka Ururka Kubadda Cagta Soomaaliyeed: football administration',
        theme_color: '#1e5aa8',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached; data lives in IndexedDB, so /api is never cached here.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
      },
    }),
  ],
  server: {
    proxy: { '/api': 'http://localhost:3000' },
  },
}));
