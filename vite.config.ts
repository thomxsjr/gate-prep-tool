import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  root: 'src/web',
  // The static build serves a snapshot from public/; the local build has a
  // real API and needs no public assets.
  publicDir: mode === 'static' ? resolve(import.meta.dirname, 'public') : false,
  define: {
    'import.meta.env.VITE_STATIC': JSON.stringify(mode === 'static' ? '1' : '0'),
  },
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5177,
    // Reachable from a phone on the same network. Local only — nothing leaves.
    host: '0.0.0.0',
    proxy: {
      '/api': { target: `http://localhost:${process.env.PORT ?? 5178}`, changeOrigin: true },
    },
  },
}));
