import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  root: 'src/web',
  publicDir: false,
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
});
