// BENCHMARK DE VISÃO — tipos do gerador de cenários.
//
// Um cenário é HTML NOSSO (o código vai para o dataset) + as tarefas de ação.
// Os controles levam `data-vision-id` (id estável), `data-vision-type` quando a
// tag não basta, `data-vision-label`/`data-vision-icon` para o nome e
// `data-vision-aliases` para sinônimos aceitos no placar.

import type { VisionAction, VisionElementType, VisionFamily } from '../../engine/vision/index.js';

export interface SceneTaskSpec {
  instruction: string;
  action: VisionAction;
  /** Alvo por id anotado à mão (cenários nossos). */
  targetId?: string;
  /**
   * Alvo SEMÂNTICO resolvido no build (cenários de framework anotados
   * automaticamente): casa por rótulo normalizado e, opcionalmente, tipo e
   * ocorrência. O build FALHA se casar 0 ou >1 (use `nth`).
   */
  target?: { label: string; type?: VisionElementType; nth?: number };
  text?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
}

export interface SceneSpec {
  id: string;
  family: VisionFamily;
  title: string;
  theme: 'light' | 'dark';
  tags?: string[];
  /** Documento HTML completo; caminhos de asset relativos a `data/vision/`. */
  html?: string;
  /** Alternativa ao `html`: arquivo em `src/vision/build/` (ex.: `html/react95.html`). */
  htmlFile?: string;
  /**
   * Prefixo da anotação AUTOMÁTICA (cenários de framework montados por JS ou
   * com muitos controles): o build marca o que está clicável agora.
   * Cenários nossos já vêm com `data-vision-id` no HTML.
   */
  autoAnnotate?: string;
  tasks: SceneTaskSpec[];
}

/** Anotação de um controle no HTML (documentação viva do cenário). */
export interface AnnotatedControl {
  id: string;
  type: VisionElementType;
  label?: string;
  icon?: string;
  aliases?: string[];
}
