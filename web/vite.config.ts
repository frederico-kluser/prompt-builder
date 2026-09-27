import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
  plugins: [tailwindcss(), react()],
  server: {
    allowedHosts: true,
    port: 5173,
    proxy: {
      // IMPL-024: 127.0.0.1 explícito — o backend agora ouve SÓ em 127.0.0.1 e
      // `localhost` pode resolver para ::1 primeiro. `changeOrigin: false` é o
      // que importa: a forma curta (string) do Vite liga `changeOrigin: true`,
      // que REESCREVE o Host para 127.0.0.1:3001 — com o `allowedHosts: true`
      // acima, uma página em DNS rebinding (Host: evil.com) passaria pelo proxy
      // e leria as runs. Com o Host original repassado, a allowlist do backend
      // decide (localhost passa; túnel/outro nome → PB_ALLOWED_HOSTS).
      '/v1': { target: 'http://127.0.0.1:3001', changeOrigin: false },
      '/health': { target: 'http://127.0.0.1:3001', changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
