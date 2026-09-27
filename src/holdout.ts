// Split anti-overfit de holdout, portado do prompt-arena (`server/studio/holdout.mjs`).
// A fatia de holdout fica FORA da seleção: ao fim do treino o campeão final e o
// controle rodam nela de novo e uma regressão nela bloqueia a promoção.
//
// IMPL-050 (R-04:REC-5) — guardas de poder: com 5 cenários o poder para Δ = 10
// p.p. é ~10–14% (nada é decidido), então o piso virou ABSOLUTO em 10 cenários
// e o ratio default subiu para 0,3. Abaixo do piso o split NÃO é holdout — é
// "confirmação fraca" (a palavra "validado" fica bloqueada: sem poder, não há
// confirmação a declarar). Com o piso de 10 e o teto de ratio 0,5, seleções com
// menos de 20 cenários nunca produzem holdout — exatamente o limiar da pesquisa.

/**
 * Mínimo de cenários em holdout para o gate final significar algo. Abaixo
 * disso 1 cenário balança o judge-score em ≥100/n pontos e a "regressão" é
 * ruído. Piso ABSOLUTO (IMPL-050): a fatia só se chama holdout com n ≥ 10.
 */
export const MIN_HOLDOUT_SCENARIOS = 10;
/** Fração default reservada para holdout (IMPL-050: era 0,2 — 5 cenários em 25). */
export const HOLDOUT_RATIO_DEFAULT = 0.3;
/** Teto da fração reservada (metade da seleção: treinar também é preciso). */
export const HOLDOUT_RATIO_MAX = 0.5;

/**
 * Força da confirmação final (IMPL-050): `holdout` só com o piso cumprido;
 * `confirmacao-fraca` com fatia curta demais para decidir; `nenhum` sem fatia.
 */
export type HoldoutStrength = 'holdout' | 'confirmacao-fraca' | 'nenhum';

export function holdoutStrength(n: number): HoldoutStrength {
  if (n >= MIN_HOLDOUT_SCENARIOS) return 'holdout';
  return n > 0 ? 'confirmacao-fraca' : 'nenhum';
}

/**
 * Tamanho da fatia de holdout: `max(ratio·n, MIN_HOLDOUT_SCENARIOS)`, limitado
 * a n/2. O piso de 10 é absoluto — por isso seleções com n < 20 nunca formam
 * holdout (o teto de 0,5 não deixa 10 cenários fora do treino).
 */
export function holdoutSplitSize(n: number, holdoutRatio: number): number {
  const total = Math.max(0, Math.floor(n));
  const ratio = Number.isFinite(holdoutRatio)
    ? Math.min(Math.max(holdoutRatio, 0), HOLDOUT_RATIO_MAX)
    : HOLDOUT_RATIO_DEFAULT;
  if (ratio === 0 || total === 0) return 0;
  return Math.min(Math.floor(total / 2), Math.max(Math.round(ratio * total), MIN_HOLDOUT_SCENARIOS));
}

/**
 * Divide a seleção pinada em fatias de treino + holdout.
 *
 * Split intercalado determinístico (índices espalhados pela seleção inteira)
 * para que AMBAS as fatias amostrem a seleção inteira, em vez de um bloco
 * contíguo de cabeça/cauda. A fatia sai com {@link holdoutSplitSize} cenários;
 * quando ela fica abaixo de {@link MIN_HOLDOUT_SCENARIOS} o split NÃO é
 * holdout — tudo treina e `strength` marca `confirmacao-fraca` (IMPL-050: o
 * chamador marca `holdoutSkipped` e nunca escreve "validado").
 *
 * @param items        os cenários pinados da run
 * @param holdoutRatio fração a reservar (clamp em [0, 0.5]; 0 desliga o holdout)
 */
export function splitHoldout<T>(
  items: T[],
  holdoutRatio: number = HOLDOUT_RATIO_DEFAULT,
): { train: T[]; holdout: T[]; reserved: T[]; strength: HoldoutStrength } {
  const list = Array.isArray(items) ? items : [];
  const alvo = holdoutSplitSize(list.length, holdoutRatio);
  const reserved: T[] = [];
  const train: T[] = [];
  if (alvo > 0) {
    const escolhidos = new Set<number>();
    for (let j = 0; j < alvo; j += 1) {
      // Último item do (j+1)-ésimo bloco de n/alvo: espalha sem sobrepor
      // (alvo ≤ n/2 ⇒ espaçamento ≥ 2 ⇒ índices sempre distintos).
      escolhidos.add(Math.min(list.length - 1, Math.ceil(((j + 1) * list.length) / alvo) - 1));
    }
    list.forEach((item, i) => {
      if (escolhidos.has(i)) reserved.push(item);
      else train.push(item);
    });
  } else {
    train.push(...list);
  }

  const strength = holdoutStrength(reserved.length);
  // Pouco poder para confiar ⇒ sem holdout: a seleção inteira treina e a
  // confirmação final fica rotulada "confirmação fraca" (nunca "holdout").
  return {
    train: strength === 'holdout' ? train : list.slice(),
    holdout: strength === 'holdout' ? reserved : [],
    reserved,
    strength,
  };
}

/**
 * Texto honesto da confirmação do campeão contra sobreajuste (IMPL-050).
 *
 * ⚠️ A palavra "validado" SÓ aparece quando o holdout é forte (n ≥ 10) e de
 * fato rodou — abaixo do piso, ou pulado, o texto sai como "confirmação fraca"
 * e nunca traz "validado" (a asserção vive em `test/holdout-power-guards.test.ts`).
 */
export function holdoutConfirmationText(
  n: number,
  opts: { skipped?: boolean; strength?: HoldoutStrength } = {},
): string {
  const strength = opts.strength ?? holdoutStrength(n);
  if (!opts.skipped && strength === 'holdout') {
    return `validado em holdout intocado (n=${n} cenários, α=0,05 unilateral)`;
  }
  if (opts.skipped && strength === 'holdout') {
    return `confirmação fraca: holdout (n=${n} cenários) pulado por orçamento/cancelamento — sem confirmação contra sobreajuste`;
  }
  if (strength === 'confirmacao-fraca') {
    return `confirmação fraca: holdout com n=${n} < ${MIN_HOLDOUT_SCENARIOS} cenários — sem confirmação contra sobreajuste`;
  }
  return (
    `confirmação fraca: sem confirmação de holdout (abaixo do piso de ${MIN_HOLDOUT_SCENARIOS} cenários ou pulado) ` +
    `— campeão sem confirmação contra sobreajuste`
  );
}
