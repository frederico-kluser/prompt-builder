// IMPL-118 (R-10:REC-8) — tipos do pacote privado `motion-plus` para o build
// SEM MOTION_TOKEN. Declarações ambientais AUTOCONTIDAS (sem imports dentro do
// `declare module`, que o skipLibCheck degrada para any): resolvem 'motion-plus'
// e 'motion-plus/animate-view' mesmo sem o pacote instalado (senão `tsc -b` cai
// com TS2307 antes do Vite poder aplicar o alias do fallback). As assinaturas
// cobrem exatamente o uso dos componentes vendored do Motion UI (stagger-reveal
// → `splitText`; skeleton → `AnimateView`) — o fallback de runtime é
// `./split-text.ts` / `./animate-view.ts` (mesmas formas).

declare module 'motion-plus' {
  /** Reparte o texto do elemento em spans de palavra agrupados por linha. */
  export function splitText(
    el: HTMLElement,
    options?: { lineClass?: string; wordClass?: string },
  ): { lines: HTMLSpanElement[]; words: HTMLSpanElement[]; chars: HTMLSpanElement[] };
}

declare module 'motion-plus/animate-view' {
  export function AnimateView(props: {
    name: string;
    update?: object;
    children?: import('react').ReactNode;
  }): import('react').ReactElement;
}