// Registro dos cenários do benchmark de visão.
//
// Ordem = ordem do manifesto (e da seleção determinística). Cada família é um
// arquivo com o HTML REAL do framework + as tarefas de ação. Adicionar um
// cenário é adicionar aqui e rodar `npm run vision:build` — o dataset cresce
// por commit, nunca por geração em tempo de run.
import type { SceneSpec } from '../scene-types.js';
import { BOOTSTRAP_SCENES } from './bootstrap.js';
import { REACT95_SCENES } from './react95.js';
import { FLUENT_SCENES } from './fluent.js';
import { MATERIAL_SCENES } from './material.js';
import { MACOS_SCENES } from './macos.js';

export const SCENES: SceneSpec[] = [
  // Web (Bootstrap 5)
  ...BOOTSTRAP_SCENES,
  // Windows 95 (React95)
  ...REACT95_SCENES,
  // Fluent UI (web components)
  ...FLUENT_SCENES,
  // Material 3 (web components)
  ...MATERIAL_SCENES,
  // Desktop nativo (CSS próprio)
  ...MACOS_SCENES,
];
