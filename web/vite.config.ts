import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Teste no celular via `cloudflared tunnel --url http://localhost:5173`.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});
