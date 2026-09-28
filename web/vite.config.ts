import path from 'node:path'
import { createRequire } from 'node:module'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// IMPL-118 (R-10:REC-8) — Motion+ (`motion-plus` = @motionplus/core, registry
// privado da Motion) é OPCIONAL: instalado (com MOTION_TOKEN), o pacote real é
// usado; ausente (clone limpo, CI de forks, deploy sem token), os ALIASES abaixo
// ligam os substitutos locais de `src/motion-plus-fallback/` — `splitText` por
// Intl.Segmenter (≤ 3 KB min) e stub de `AnimateView`. Assim `npm ci && npm run
// web:build` passa SEM MOTION_TOKEN (o pacote é `optionalDependencies`) e o
// sourcemap não arrasta um byte do pacote privado. Só estes dois módulos do
// Motion+ são usados pela UI; um terceiro subpath importado no futuro cai na
// resolução normal e exige o pacote (ou um alias novo aqui).
const SEM_MOTION_PLUS = (() => {
  try {
    createRequire(import.meta.url).resolve('motion-plus');
    return false;
  } catch {
    return true;
  }
})();

const FALLBACK_DIR = path.resolve(import.meta.dirname, './src/motion-plus-fallback');

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(import.meta.dirname, './src') },
      // Ordem importa: o subpath mais específico antes do pacote (o alias de
      // string é prefixo + substituição literal).
      ...(SEM_MOTION_PLUS
        ? [
            { find: 'motion-plus/animate-view', replacement: path.join(FALLBACK_DIR, 'animate-view.ts') },
            { find: 'motion-plus', replacement: path.join(FALLBACK_DIR, 'split-text.ts') },
          ]
        : []),
    ],
  },
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