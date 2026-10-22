// BENCHMARK DE VISÃO — família Material 3 (Google).
//
// Página estática com os WEB COMPONENTS oficiais `@material/web`
// (`<md-filled-button>`, `<md-outlined-text-field>`, `<md-filter-chip>`, ...),
// tema claro e ícones Material Symbols. Anotação automática no build.
import type { SceneSpec } from '../scene-types.js';

export const MATERIAL_SCENES: SceneSpec[] = [
  {
    id: 'material-painel',
    family: 'material',
    title: 'Painel de operações em Material 3',
    theme: 'light',
    tags: ['dashboard', 'material', 'modal'],
    htmlFile: 'html/material.html',
    autoAnnotate: 'md',
    tasks: [
      { instruction: 'Clique em "Novo pedido".', action: 'click', target: { label: 'Novo pedido', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique em "Filtrar".', action: 'click', target: { label: 'Filtrar', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Clique em "Confirmar envio".', action: 'click', target: { label: 'Confirmar envio', type: 'button' }, difficulty: 'easy' },
      { instruction: 'Marque a caixa "Com nota emitida".', action: 'click', target: { label: 'Com nota emitida', type: 'checkbox' }, difficulty: 'medium' },
      { instruction: 'Clique em "Exportar CSV".', action: 'click', target: { label: 'Exportar CSV', type: 'button' }, difficulty: 'medium' },
    ],
  },
];
