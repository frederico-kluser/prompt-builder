// Duelos round-robin (Critério 2, portado do prompt-arena): depois do juiz
// pointwise, cada PAR de candidatos é julgado head-to-head contra a REFERÊNCIA,
// nas DUAS ordens (desacordo => empate — cancela viés de posição), e o placar
// taxa de vitória ((vitória 1 + empate 0.5) / disputados) vira o placement da etapa. O round-robin é
// QUADRÁTICO (C(n,2) pares × 2 ordens, no modelo mais caro do pipeline), então
// só duelam um BRACKET: normalmente os FINALISTAS globais da run (`duelists`,
// escolhidos por `pickFinalists` depois de todas as etapas); sem eles, o bracket
// por etapa do `selectDuelists` (controle + K−1 melhores no pointwise). Falha
// NUNCA derruba a run e NUNCA vira empate: o duelo sem resultado vai para
// `failedDuels`, fora do placar (IMPL-004).

import { chatCompletion } from './openrouter';
import { ROLE_MAX_TOKENS } from './roleLimits';
import { callJudgeWithRetry, JUDGE_TEMPERATURE, withReminder, type JudgeAttempt } from '../../../src/engine/judgeRetry.js';
import { isJudgeCutKind } from '../../../src/engine/truncation.js';
import { buildDuelPrompt, DUEL_SCHEMA, parseDuelVerdict } from '../../../src/engine/duelPrompt.js';
import type {
  CompetitorResponse,
  Contestant,
  DuelFailure,
  DuelOutcome,
  JudgeConfidence,
  JudgeEngine,
  JevJudgeConfig,
  ReasoningLevel,
  RunCtx,
  StageDuels,
  StageSpec,
  Verdict,
  VerdictError,
} from './types';

import {
  blindRankMap,
  combineDuelOrders,
  mulberry32,
  pickFinalists,
  seedFromId,
  selectDuelists,
  standingsFromDuels,
  VERDICT_SCORE,
} from '../../../src/engine/duelCore.js';
// Re-export do núcleo puro (F0): fonte única em `src/engine/duelCore.ts`.
export {
  blindRankMap,
  combineDuelOrders,
  mulberry32,
  pickFinalists,
  seedFromId,
  selectDuelists,
  standingsFromDuels,
  VERDICT_SCORE,
} from '../../../src/engine/duelCore.js';

// Prompt + parse do juiz de duelo: fonte ÚNICA em `src/engine/duelPrompt.ts`
// (IMPL-006 — marcador aleatório por ordem, INSTRUÇÕES anti-injeção, JSON
// estrito com canário). Reexportados para os consumidores/testes.
export { buildDuelPrompt, parseDuelVerdict, DUEL_HEAD, DUEL_SCHEMA } from '../../../src/engine/duelPrompt.js';

// Juiz JEV das ordens de duelo: fonte única em `src/jevJudge.ts` (shim).
import { judgeDuelOrderJev } from './jevJudge';

export interface RunStageDuelsOptions {
  stage: StageSpec;
  responses: CompetitorResponse[];
  contestants: Contestant[];
  /** Juiz dos duelos (orquestrador passa judgeModelIds[0]). */
  judgeModelId: string;
  /**
   * Motor do juiz do duelo: `jev` = modelo de decisão (choice a_melhor/
   * b_melhor/empate, escalando para o `judgeModelId` nas bandas hitl/abstain);
   * `llm`/ausente = juiz LLM clássico. Espelho de src/duels.ts — o default
   * `jev` é aplicado pelo orquestrador (`RunConfigBase.judgeEngine`).
   */
  judgeEngine?: JudgeEngine;
  /** Config do juiz JEV (modelo de decisão + bandas de ação). */
  jevJudge?: JevJudgeConfig;
  /** Contestant de controle — entra no bracket SEMPRE. Ausente => sem vaga garantida. */
  controlId?: string;
  /** Tamanho do bracket (controle + K−1 melhores). 0 = round-robin completo. */
  topK: number;
  /** Duelistas já escolhidos (finalistas globais). Quando presente, IGNORA topK/controlId. */
  duelists?: string[];
  apiKey: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
  /** Sinal de abort + ledger de custo (espelho de src/duels.ts). */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /** Vereditos do juiz pointwise (refJudge) — ordenam o bracket. Ausente => score −1. */
  verdictByContestant?: Record<string, Verdict>;
  /**
   * Score do ORÁCULO por contestant (aditivo — ver src/duels.ts §19.1): quando
   * AMBOS os lados de um par têm score e os scores diferem, o vencedor é
   * decidido PELO ORÁCULO (maior score), sem chamada LLM. É o que faz os
   * duelos das etapas ground-truth (F1.4) serem determinísticos e gratuitos.
   */
  oracleScoresByContestant?: Record<string, number>;
  /** Dispara a CADA par resolvido (progresso durante a fase mais longa da etapa). */
  onPair?: (duel: DuelOutcome) => void;
}

/**
 * Roda os duelos round-robin da etapa e devolve o StageDuels completo.
 * Só respostas `status === 'ok'` duelam. Sem referência na etapa => sem duelos
 * (`duels: []`, pontos zerados, placement 1 para todos) — quem chama só chama
 * com gabarito, mas degradar é mais seguro que quebrar a run. Quem ficou fora
 * do bracket recebe placement = bracketSize + 1 (abaixo de TODO duelista — o
 * placement médio agregado não pode premiar uma variante que só pontuou onde se
 * classificou). `order`/placements/pontos cobrem TODOS os contestants com
 * resposta ok, bracket ou não.
 */
export async function runStageDuels(opts: RunStageDuelsOptions): Promise<StageDuels> {
  const {
    stage,
    responses,
    contestants,
    judgeModelId,
    judgeEngine,
    jevJudge,
    controlId,
    topK,
    duelists,
    apiKey,
    reasoningLevel,
    timeoutMs,
    ctx,
    maxPricePerMTok,
    verdictByContestant,
    oracleScoresByContestant,
    onPair,
  } = opts;

  // Finalistas globais mandam: quando vêm de fora, o bracket é fixo para TODAS
  // as etapas (mesmos duelistas em todo lugar) e o `topK` gravado só documenta
  // o tamanho da final.
  const topKGravado = duelists?.length ? duelists.length : topK;

  // Só respostas ok duelam; dedup defensivo (a 1ª ocorrência do id vence).
  const textById = new Map<string, string>();
  for (const r of responses ?? []) {
    if (r.status !== 'ok' || textById.has(r.contestantId)) continue;
    textById.set(r.contestantId, r.text);
  }
  const okIds = [...textById.keys()];
  // Fallback: no variation/training o controle é o prompt original.
  const control = controlId ?? contestants.find((c) => c.isOriginal)?.id;

  const semDuelos = (placement: number): StageDuels => ({
    placementByContestant: Object.fromEntries(okIds.map((id) => [id, placement])),
    order: [...okIds],
    winRate: Object.fromEntries(okIds.map((id) => [id, 0])),
    duels: [],
    topK: topKGravado,
  });

  // Sem gabarito TEXTUAL os duelos so acontecem decididos pelo ORACULO (scores
  // deterministicos: ground-truth F1.4). Sem gabarito e sem oraculo => degrada.
  const reference = stage.reference?.trim() ?? '';
  const temOracle =
    oracleScoresByContestant !== undefined && Object.keys(oracleScoresByContestant).length > 0;
  if (!reference && !temOracle) return semDuelos(1);

  // Seed estável derivada do CONTEÚDO da etapa: mesma pergunta => mesmos pares.
  const seed = seedFromId(stage.question);
  const scoreOf = (id: string): number => {
    const v = verdictByContestant?.[id];
    return v ? VERDICT_SCORE[v] : -1;
  };
  const bracket = duelists?.length
    ? duelists.filter((id) => textById.has(id))
    : selectDuelists(
        okIds.map((id) => ({ id, score: scoreOf(id) })),
        control,
        topK,
        seed,
      );
  // Bracket com menos de 2 não forma par — placement 1 para quem duelaria.
  if (bracket.length < 2) return semDuelos(1);

  // Pareamento cego e determinístico (a ordem dos pares não pode vazar identidade).
  const rank = blindRankMap(bracket, seed);
  const ids = [...bracket].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  const pairs: [string, string][] = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) pairs.push([ids[i], ids[j]]);
  }

  // UMA apresentação ordenada (first => rótulo A, second => rótulo B), com a
  // re-tentativa SELETIVA do juiz (timeout 1×; saída inválida => 1 pedido com
  // lembrete). Orçamento/cancelamento SOBEM de dentro de callJudgeWithRetry:
  // sem isso, dinheiro estourado viraria duelo "sem resultado" em TODA a final.
  const llmJudgeOnce = (
    firstId: string,
    secondId: string,
  ): Promise<
    JudgeAttempt<{ winner: 'A' | 'B' | 'tie'; explanation: string; canary: string; confianca?: JudgeConfidence }>
  > => {
    // Marcador + canário sorteados AQUI: cada ORDEM é um veredito próprio.
    const prompt = buildDuelPrompt(
      stage,
      reference,
      textById.get(firstId) ?? '',
      textById.get(secondId) ?? '',
    );
    return callJudgeWithRetry({
      call: async (reminder) =>
        // Resultado INTEIRO (texto + finish_reason): o truncamento e checado antes do parse (IMPL-015).
        await chatCompletion({
          apiKey,
          modelId: judgeModelId,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: withReminder(prompt.user, reminder) },
          ],
          temperature: JUDGE_TEMPERATURE,
          // Teto TOTAL com sala p/ raciocinio (IMPL-016, espelho de src/duels.ts).
          maxTokens: ROLE_MAX_TOKENS.duel,
          timeoutMs,
          responseFormatJson: true,
          responseSchema: { name: 'veredito_duelo', schema: DUEL_SCHEMA },
          reasoningLevel,
          // Papel 'duel' no ledger (IMPL-021): sem isto o gateway contaria o
          // duelo como 'competitor' (o default de role).
          role: 'duel',
          signal: ctx?.signal,
          sink: ctx?.sink,
          maxPricePerMTok,
        }),
      parse: (text) => parseDuelVerdict(text, prompt.guard.canary),
      formatReminder: prompt.formatReminder,
      signal: ctx?.signal,
    });
  };

  // JUÍZ JEV nas ordens de duelo (espelho de src/duels.ts; o default `jev` é
  // aplicado pelo orquestrador): uma decisão tipada por ordem — `choice`
  // a_melhor/b_melhor/empate sobre o par. Banda `auto` decide sozinha;
  // hitl/abstain/falha escalam para o juiz LLM do par (`fallback`).
  const judgeOnce = (
    firstId: string,
    secondId: string,
  ): Promise<
    JudgeAttempt<{ winner: 'A' | 'B' | 'tie'; explanation: string; canary: string; confianca?: JudgeConfidence }>
  > =>
    judgeEngine === 'jev'
      ? judgeDuelOrderJev({
          apiKey,
          stage,
          reference,
          textA: textById.get(firstId) ?? '',
          textB: textById.get(secondId) ?? '',
          jevJudge,
          ctx,
          timeoutMs,
          fallback: () => llmJudgeOnce(firstId, secondId),
        })
      : llmJudgeOnce(firstId, secondId);

  // Todos os pares em paralelo (o limitador global do openrouter gateia a
  // concorrência — sem cap local). Cada par é julgado 2× EM PARALELO, nas duas
  // ordens; os vencedores são convertidos para os termos REAIS do par ('a' = o
  // primeiro do par): acordo => vencedor, desacordo => empate.
  // Exceção — ORÁCULO (§19.1): quando ambos os lados têm score de oráculo e os
  // scores diferem, o par é decidido PELO ORÁCULO (maior score), SEM chamada
  // LLM. As duas ordens espelham o MESMO resultado ('a'/'b').
  // IMPL-004: par sem resultado legítimo (ordem que falhou, ou sem régua) vai
  // para `failedDuels` e NÃO pontua — antes a ordem que falhava virava empate.
  type Julgado = { ok: true; duel: DuelOutcome } | { ok: false; failure: DuelFailure };
  const julgados: Julgado[] = await Promise.all(
    pairs.map(async ([a, b]): Promise<Julgado> => {
      const oracleA = oracleScoresByContestant?.[a];
      const oracleB = oracleScoresByContestant?.[b];
      const temAmbos = typeof oracleA === 'number' && typeof oracleB === 'number';
      if (temAmbos && oracleA !== oracleB) {
        const winner = oracleA > oracleB ? 'a' : 'b';
        const explanation = `(decidido pelo oráculo: ${oracleA} vs ${oracleB})`;
        const duel: DuelOutcome = {
          a,
          b,
          order1: { winner, explanation },
          order2: { winner, explanation },
          outcome: winner,
          source: 'ground-truth',
        };
        onPair?.(duel);
        return { ok: true, duel };
      }
      if (!reference) {
        // Sem gabarito o juiz LLM não teria régua. Oráculo EMPATADO é empate
        // legítimo (a régua determinística disse "iguais"); faltar o score de
        // um lado é falta de régua — sem resultado, nunca um empate imputado.
        if (temAmbos) {
          const explanation = `(empate no oráculo: ${oracleA} vs ${oracleB})`;
          const duel: DuelOutcome = {
            a,
            b,
            order1: { winner: 'tie', explanation },
            order2: { winner: 'tie', explanation },
            outcome: 'tie',
            source: 'ground-truth',
          };
          onPair?.(duel);
          return { ok: true, duel };
        }
        const error: VerdictError = {
          kind: 'no_reference',
          message: 'Sem gabarito e sem score de oráculo para os dois lados — duelo sem régua.',
        };
        return { ok: false, failure: { a, b, error } };
      }
      const [v1, v2] = await Promise.all([judgeOnce(a, b), judgeOnce(b, a)]);
      const o1 = v1.ok ? (v1.value.winner === 'A' ? 'a' : v1.value.winner === 'B' ? 'b' : 'tie') : undefined;
      const o2 = v2.ok ? (v2.value.winner === 'A' ? 'b' : v2.value.winner === 'B' ? 'a' : 'tie') : undefined;
      if (!v1.ok || !v2.ok || !o1 || !o2) {
        // Ordem com saida CORTADA (IMPL-015) tem precedencia no motivo: o duelo
        // fica SEM resultado (nunca empate) e o evento `judge.truncated` a ve.
        const erros = [v1, v2].flatMap((v) => (v.ok ? [] : [v.error]));
        const falha = erros.find((e) => isJudgeCutKind(e.kind)) ?? erros[0];
        // IMPL-014: a ordem que FALHOU com resposta (ex.: cortada) também deixa
        // os sinais de fim — é ela que explica o duelo sem resultado.
        const f1 = !v1.ok ? v1.finish : undefined;
        const f2 = !v2.ok ? v2.finish : undefined;
        return {
          ok: false,
          failure: {
            a,
            b,
            ...(v1.ok && o1
              ? {
                  order1: {
                    winner: o1,
                    explanation: v1.value.explanation,
                    ...(v1.value.canary ? { canary: v1.value.canary } : {}),
                    ...(v1.value.confianca ? { confidence: v1.value.confianca } : {}),
                    ...(v1.finish ?? {}),
                  },
                }
              : {}),
            ...(v2.ok && o2
              ? {
                  order2: {
                    winner: o2,
                    explanation: v2.value.explanation,
                    ...(v2.value.canary ? { canary: v2.value.canary } : {}),
                    ...(v2.value.confianca ? { confidence: v2.value.confianca } : {}),
                    ...(v2.finish ?? {}),
                  },
                }
              : {}),
            error: falha ?? { kind: 'judge_failed', message: 'Ordem do duelo sem resultado.' },
            ...(f1 || f2
              ? { failedOrderFinish: { ...(f1 ? { order1: f1 } : {}), ...(f2 ? { order2: f2 } : {}) } }
              : {}),
          },
        };
      }
      const duel: DuelOutcome = {
        a,
        b,
        order1: {
          winner: o1,
          explanation: v1.value.explanation,
          ...(v1.value.canary ? { canary: v1.value.canary } : {}),
          ...(v1.value.confianca ? { confidence: v1.value.confianca } : {}),
          // IMPL-014: sinais de fim da chamada desta ordem (+ artefato, IMPL-117).
          ...(v1.finish ?? {}),
        },
        order2: {
          winner: o2,
          explanation: v2.value.explanation,
          ...(v2.value.canary ? { canary: v2.value.canary } : {}),
          ...(v2.value.confianca ? { confidence: v2.value.confianca } : {}),
          // IMPL-014: sinais de fim da chamada desta ordem (+ artefato, IMPL-117).
          ...(v2.finish ?? {}),
        },
        outcome: combineDuelOrders(o1, o2),
        source: 'judge',
      };
      onPair?.(duel);
      return { ok: true, duel };
    }),
  );
  const duels = julgados.flatMap((j) => (j.ok ? [j.duel] : []));
  const failedDuels = julgados.flatMap((j) => (j.ok ? [] : [j.failure]));

  const { winRate, placementById, order } = standingsFromDuels(ids, duels);

  // Fora do bracket (não selecionado): placement = bracketSize + 1, taxa 0.
  const inBracket = new Set(ids);
  const blindRank = blindRankMap(okIds, seed);
  const outsiders = okIds
    .filter((id) => !inBracket.has(id))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (blindRank.get(a) ?? 0) - (blindRank.get(b) ?? 0));
  const placementByContestant: Record<string, number> = { ...placementById };
  const allWinRate: Record<string, number> = { ...winRate };
  for (const id of outsiders) {
    placementByContestant[id] = ids.length + 1;
    allWinRate[id] = 0;
  }

  return {
    placementByContestant,
    order: [...order, ...outsiders],
    winRate: allWinRate,
    duels,
    ...(failedDuels.length > 0 ? { failedDuels } : {}),
    topK: topKGravado,
  };
}
