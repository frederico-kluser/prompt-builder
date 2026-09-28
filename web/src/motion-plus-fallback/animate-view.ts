// IMPL-118 (R-10:REC-8) — stub do `AnimateView` do Motion+ (pacote privado) para
// o build SEM MOTION_TOKEN, ligado por alias do Vite quando o pacote não está
// instalado. O original orquestra a view transition (morph de shell a shell);
// o stub mantém o CONTRATO de uso do skeleton: envolve os filhos no
// `view-transition-name` e anima o alvo `update` (a máscara `--wipe`) com o
// motion (MIT, dependência de sempre). Degrada a coreografia, nunca a função:
// o handoff continua a acontecer pela CSS `::view-transition-*` do componente.

import { animate } from 'motion';
import { createElement, useEffect, useRef, type ReactElement, type ReactNode } from 'react';

export interface AnimateViewProps {
  /** Nome partilhado da view transition (skeleton e conteúdo usam o mesmo). */
  name: string;
  /** Alvo de animação aplicado ao wrapper (ex.: o custom property `--wipe`). */
  update?: object;
  children?: ReactNode;
}

export function AnimateView({ name, update, children }: AnimateViewProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ref.current || !update) return;
    const controls = animate(ref.current, update as Parameters<typeof animate>[1]);
    return () => controls.stop();
  }, [update]);
  return createElement('div', { ref, style: { viewTransitionName: name } }, children);
}