// IMPL-118 (R-10:REC-8) — substituto do `splitText` do Motion+ (pacote privado
// @motionplus/core) para o build SEM MOTION_TOKEN: utilitário próprio sobre
// `Intl.Segmenter` (zero dependência nova, ≤ 3 KB min — ver o teste de bytes em
// test/motion-optional.test.ts), ligado por alias do Vite quando o pacote
// privado não está instalado (`optionalDependencies`).
//
// Contrato do consumidor (stagger-reveal): `splitText(el, { lineClass,
// wordClass })` devolve `{ lines }` — spans de PALAVRA (classe `wordClass`)
// dentro de spans de LINHA (classe `lineClass`), na ordem de leitura. As
// linhas vêm agrupadas por medida real (offsetTop), para a coreografia animar
// linha a linha como no original.
//
// Acessibilidade (critério do item): o anúncio por leitor de tela fica IGUAL ao
// do título não partido — `aria-label` com o texto COMPLETO é preservado quando
// existe e criado quando falta; o conteúdo repartido nunca some do anúncio.

/** Opções usadas pelo stagger-reveal (subconjunto suportado). */
export interface SplitTextOptions {
  lineClass?: string;
  wordClass?: string;
}

/** Mesma forma do splitText real (motion-plus-dom): `chars` fica VAZIO — o
 *  subconjunto suportado cobre `lines`/`words`, que é o que a UI anima. */
export interface SplitTextResult {
  lines: HTMLSpanElement[];
  words: HTMLSpanElement[];
  chars: HTMLSpanElement[];
}

/**
 * Parte o texto em tokens de palavra (pontuação colada à palavra anterior;
 * CJK segmenta por palavra mesmo sem espaços) e em separadores de espaço.
 * Sem `Intl.Segmenter` cai no split por espaço — o texto continua legível.
 */
export function segmentWords(text: string): Array<{ text: string; space: boolean }> {
  const out: Array<{ text: string; space: boolean }> = [];
  const push = (t: string, space: boolean) => {
    if (!t) return;
    const ultimo = out[out.length - 1];
    if (ultimo && ultimo.space === space && !space) ultimo.text += t; // pontuação cola
    else out.push({ text: t, space });
  };
  const SegmenterCtor = (globalThis as { Intl?: { Segmenter?: new (l?: string, o?: { granularity?: string }) => { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> } } }).Intl?.Segmenter;
  if (!SegmenterCtor) {
    for (const t of text.split(/(\s+)/)) push(t, /^\s+$/.test(t));
    return out;
  }
  const segmenter = new SegmenterCtor(undefined, { granularity: 'word' });
  for (const { segment, isWordLike } of segmenter.segment(text)) {
    if (isWordLike) out.push({ text: segment, space: false });
    else if (/^\s+$/.test(segment)) out.push({ text: segment, space: true });
    else push(segment, false); // pontuação/símbolo: cola à palavra anterior
  }
  return out;
}

/**
 * Reparte o elemento em spans de palavra agrupados em spans de linha, medindo o
 * layout real. Idempotente por construção a partir de texto: o chamador pode
 * repor `textContent` antes de re-rodar (é o que o stagger-reveal faz).
 */
export function splitText(el: HTMLElement, opts: SplitTextOptions = {}): SplitTextResult {
  const doc = el.ownerDocument;
  const original = el.getAttribute('aria-label') ?? el.textContent ?? '';
  // Anúncio igual ao do título inteiro (aria-label com o texto COMPLETO).
  if (!el.getAttribute('aria-label')) el.setAttribute('aria-label', original);

  const parts = segmentWords(el.textContent ?? '');
  el.textContent = '';
  const words: HTMLSpanElement[] = [];
  /** Posição de cada palavra na fila plana de filhos (com os espaços pelo meio). */
  const positions: number[] = [];
  for (const part of parts) {
    if (part.space) {
      el.appendChild(doc.createTextNode(part.text));
      continue;
    }
    const w = doc.createElement('span');
    if (opts.wordClass) w.className = opts.wordClass;
    // Inline-block ANTES de medir: cada palavra mede como unidade e quebra como
    // quebrava (o consumidor re-aplica o mesmo display para o layout assentar).
    w.style.display = 'inline-block';
    w.textContent = part.text;
    el.appendChild(w);
    words.push(w);
    positions.push(el.childNodes.length - 1);
  }

  // Linhas = palavras consecutivas com o mesmo offsetTop (a medida real do
  // wrap). Cada linha embala o INTERVALO plano [primeira..última] — os espaços
  // ENTRE palavras da mesma linha viajam juntos (sem eles as palavras colavam).
  const flat = Array.from(el.childNodes);
  const linhas: HTMLSpanElement[] = [];
  let topo: number | null = null;
  let abertos: number[] = [];
  const fecharLinha = () => {
    if (abertos.length === 0) return;
    const linha = doc.createElement('span');
    if (opts.lineClass) linha.className = opts.lineClass;
    linha.style.display = 'block';
    for (let i = positions[abertos[0]]; i <= positions[abertos[abertos.length - 1]]; i += 1) {
      linha.appendChild(flat[i]);
    }
    linhas.push(linha);
    abertos = [];
  };
  for (const [i, w] of words.entries()) {
    const t = w.offsetTop;
    if (topo !== null && t !== topo) fecharLinha();
    topo = t;
    abertos.push(i);
  }
  fecharLinha();
  // Repõe a ordem com as linhas embaladas; os espaços entre LINHAS não têm
  // valor visual (as linhas são blocos) e caem aqui.
  el.replaceChildren(...linhas);
  return { lines: linhas, words, chars: [] };
}