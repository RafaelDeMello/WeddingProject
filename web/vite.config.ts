import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Portas podem ser trocadas localmente em web/.env.local (não commitado),
  // ex.: WEB_PORT=5174 e API_PROXY_TARGET=http://localhost:3001.
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.WEB_PORT || 5173);
  const apiTarget = env.API_PROXY_TARGET || 'http://localhost:3000';

  return {
    plugins: [react()],
    server: {
      port,
      strictPort: true,
      // Teste no celular via `cloudflared tunnel --url http://localhost:<porta>`.
      allowedHosts: ['.trycloudflare.com'],
      proxy: {
        '/api': apiTarget,
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
