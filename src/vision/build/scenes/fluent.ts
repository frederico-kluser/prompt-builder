// BENCHMARK DE VISÃO — família Fluent UI (Microsoft, Windows 11/web).
//
// Página estática com os WEB COMPONENTS oficiais (`<fluent-button>`,
// `<fluent-text-input>`, `<fluent-checkbox>`, ...) e os tokens do tema claro.
// Anotação automática no build.
import type { SceneSpec } from '../scene-types.js';

export const FLUENT_SCENES: SceneSpec[] = [
  {
    id: 'fluent-painel',
    family: 'fluent',
    title: 'Console de operações em Fluent UI',
    theme: 'light',
    tags: ['dashboard', 'fluent', 'modal'],
    htmlFile: 'html/fluent.html',
    autoAnnotate: 'fluent',
    tasks: [
      { instruction: 'Clique em "Novo pedido".', action: 'click', target: { label: 'Novo pedido', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique em "Aplicar filtros".', action: 'click', target: { label: 'Aplicar filtros', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique em "Confirmar envio".', action: 'click', target: { label: 'Confirmar envio', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Marque a caixa "Balcão".', action: 'click', target: { label: 'Balcão', type: 'checkbox' }, difficulty: 'medium' },
      { instruction: 'Escolha o filtro de "Cliente".', action: 'select', target: { label: 'Cliente', type: 'select' }, text: 'Atacadão do Sul LTDA', difficulty: 'medium' },
    ],
  },
];
