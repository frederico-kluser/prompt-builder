// BENCHMARK DE VISÃO — família React95 (Windows 95).
//
// O app é React de verdade (React 18 + react95 4), empacotado num IIFE offline
// por `scripts/vision-react95-build.mjs`; este HTML só carrega o bundle. Os
// controles são anotados no BUILD (`autoAnnotate`): o que está clicável na
//quele estado da tela vira a verdade, em ordem de documento.
import type { SceneSpec } from '../scene-types.js';

export const REACT95_SCENES: SceneSpec[] = [
  {
    id: 'react95-painel',
    family: 'react95',
    title: 'Painel de pedidos em Windows 95 (React95)',
    theme: 'light',
    tags: ['desktop', 'react95', 'tabela'],
    htmlFile: 'html/react95.html',
    autoAnnotate: 'r95',
    tasks: [
      { instruction: 'Clique no botão "Novo".', action: 'click', target: { label: 'Novo', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique na aba "Clientes".', action: 'click', target: { label: 'Clientes', type: 'button', nth: 0 }, difficulty: 'easy' },
      { instruction: 'Clique em "Confirmar envio" no diálogo.', action: 'click', target: { label: 'Confirmar envio', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique em "Imprimir romaneio" no menu aberto.', action: 'click', target: { label: 'Imprimir romaneio', type: 'menuitem' }, difficulty: 'medium' },
    ],
  },
];
