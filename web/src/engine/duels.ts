// Duelos round-robin (Critério 2, portado do prompt-arena): depois do juiz
// pointwise, cada PAR de candidatos é julgado head-to-head contra a REFERÊNCIA,
// nas DUAS ordens (desacordo => empate — cancela viés de posição), e o placar
// Copeland (vitória 1, empate 0.5) vira o placement da etapa. O round-robin é
// QUADRÁTICO (C(n,2) pares × 2 ordens, no modelo mais caro do pipeline), então
// só duelam um BRACKET: normalmente os FINALISTAS globais da run (`duelists`,
// escolhidos por `pickFinalists` depois de todas as etapas); sem eles, o bracket
// por etapa do `selectDuelists` (controle + K−1 melhores no pointwise). Toda
// falha degrada para empate/ausência de duelos — NUNCA derruba a run.

import { chatCompletion } from './openrouter';
import type {
  CompetitorResponse,
  Contestant,
  DuelOutcome,
  ReasoningLevel,
  StageDuels,
  StageSpec,
  Verdict,
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

// Head do prompt de duelo — fixa o contrato do veredito head-to-head (portado).
const DUEL_HEAD = `Você é um juiz técnico estrito decidindo um DUELO DIRETO entre DUAS respostas candidatas para a MESMA tarefa. Um modelo mais forte já produziu a RESPOSTA DE REFERÊNCIA (correta). Decida qual candidato alcança melhor o MESMO resultado e intenção da referência; ignore redação, estilo e tamanho. Os rótulos A/B são neutros e a ordem não significa nada. Responda APENAS com um objeto JSON {"winner": "A"|"B"|"tie", "explanation": "<uma frase curta>"} — "tie" SOMENTE quando ambos alcançam resultado genuinamente equivalente (ou falham igualmente).`;

function buildDuelUserPrompt(
  stage: StageSpec,
  reference: string,
  textA: string,
  textB: string,
): string {
  const rubricBlock = stage.rubric?.trim()
    ? `\nRUBRICA DA ETAPA (critério de corretude):\n${stage.rubric.trim()}\n`
    : '';
  return `REFERÊNCIA (resposta correta):
${reference}

PERGUNTA DO USUÁRIO:
${stage.question}
${rubricBlock}
Candidato A:
${textA || '(vazio)'}

Candidato B:
${textB || '(vazio)'}

Qual candidato alcança melhor o resultado e a intenção da referência — A, B ou tie?`;
}

// Mesmo helper do judge.ts (extrai o objeto JSON mesmo com markdown ao redor).
function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) return match[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

/**
 * Parse tolerante da resposta do duelo: JSON primeiro; fallback por regex
 * (TIE/EMPATE => tie; senão o 1º A ou B isolado). Lixo degrada para 'tie' —
 * nunca inventa um vencedor.
 */
function parseDuelVerdict(text: string): { winner: 'A' | 'B' | 'tie'; explanation: string } {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    parsed = null;
  }
  const p = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const raw = typeof p?.winner === 'string' ? p.winner.trim().toUpperCase() : '';
  let winner: 'A' | 'B' | 'tie' | null =
    raw === 'A' || raw === 'B' ? raw : raw === 'TIE' || raw === 'EMPATE' ? 'tie' : null;
  if (!winner) {
    const up = (text || '').toUpperCase();
    if (/\bTIE\b|\bEMPATE\b/.test(up)) {
      winner = 'tie';
    } else {
      const a = /\bA\b/.exec(up);
      const b = /\bB\b/.exec(up);
      winner = a && (!b || a.index < b.index) ? 'A' : b ? 'B' : 'tie';
    }
  }
  const explanation =
    (typeof p?.explanation === 'string' && p.explanation.trim().slice(0, 300)) || '';
  return { winner, explanation };
}

export interface RunStageDuelsOptions {
  stage: StageSpec;
  responses: CompetitorResponse[];
  contestants: Contestant[];
  /** Juiz dos duelos (orquestrador passa judgeModelIds[0]). */
  judgeModelId: string;
  /** Contestant de controle — entra no bracket SEMPRE. Ausente => sem vaga garantida. */
  controlId?: string;
  /** Tamanho do bracket (controle + K−1 melhores). 0 = round-robin completo. */
  topK: number;
  /** Duelistas já escolhidos (finalistas globais). Quando presente, IGNORA topK/controlId. */
  duelists?: string[];
  apiKey: string;
  reasoningLevel?: ReasoningLevel;
  timeoutMs?: number;
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
    controlId,
    topK,
    duelists,
    apiKey,
    reasoningLevel,
    timeoutMs,
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
    points: Object.fromEntries(okIds.map((id) => [id, 0])),
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

  // UMA apresentação ordenada (first => rótulo A, second => rótulo B).
  const judgeOnce = async (
    firstId: string,
    secondId: string,
  ): Promise<{ winner: 'A' | 'B' | 'tie'; explanation: string }> => {
    try {
      const result = await chatCompletion({
        apiKey,
        modelId: judgeModelId,
        messages: [
          { role: 'system', content: DUEL_HEAD },
          {
            role: 'user',
            content: buildDuelUserPrompt(
              stage,
              reference,
              textById.get(firstId) ?? '',
              textById.get(secondId) ?? '',
            ),
          },
        ],
        temperature: 0,
        maxTokens: 512,
        timeoutMs,
        responseFormatJson: true,
        reasoningLevel,
      });
      return parseDuelVerdict(result.text);
    } catch (err) {
      // Ordem falhou => ESSA ordem vira empate (nunca inventa vencedor).
      return {
        winner: 'tie',
        explanation: `(juiz falhou: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)})`,
      };
    }
  };

  // Todos os pares em paralelo (o limitador global do openrouter gateia a
  // concorrência — sem cap local). Cada par é julgado 2× EM PARALELO, nas duas
  // ordens; os vencedores são convertidos para os termos REAIS do par ('a' = o
  // primeiro do par): acordo => vencedor, desacordo => empate.
  const duels: DuelOutcome[] = await Promise.all(
    pairs.map(async ([a, b]) => {
      // ORACULO (aditivo): scores deterministicos divergentes decidem o par
      // sem LLM (mesma regra de src/duels.ts §19.1).
      const oracleA = oracleScoresByContestant?.[a];
      const oracleB = oracleScoresByContestant?.[b];
      const oracleDecides =
        typeof oracleA === 'number' && typeof oracleB === 'number' && oracleA !== oracleB;
      if (oracleDecides) {
        const winner = oracleA > oracleB ? 'a' : 'b';
        const explanation = `(decidido pelo oráculo: ${oracleA} vs ${oracleB})`;
        const duel: DuelOutcome = {
          a,
          b,
          order1: { winner, explanation },
          order2: { winner, explanation },
          outcome: winner,
        };
        onPair?.(duel);
        return duel;
      }
      if (!reference) {
        // Sem gabarito, o juiz LLM nao teria regua: par que o oraculo nao
        // separou vira empate honesto (nunca inventa vencedor).
        const duel: DuelOutcome = {
          a,
          b,
          order1: { winner: 'tie', explanation: '(sem gabarito: só o oráculo decide)' },
          order2: { winner: 'tie', explanation: '(sem gabarito: só o oráculo decide)' },
          outcome: 'tie',
        };
        onPair?.(duel);
        return duel;
      }
      const [v1, v2] = await Promise.all([judgeOnce(a, b), judgeOnce(b, a)]);
      const o1 = v1.winner === 'A' ? 'a' : v1.winner === 'B' ? 'b' : 'tie';
      const o2 = v2.winner === 'A' ? 'b' : v2.winner === 'B' ? 'a' : 'tie';
      const duel: DuelOutcome = {
        a,
        b,
        order1: { winner: o1, explanation: v1.explanation },
        order2: { winner: o2, explanation: v2.explanation },
        outcome: combineDuelOrders(o1, o2),
      };
      onPair?.(duel);
      return duel;
    }),
  );

  const { points, placementById, order } = standingsFromDuels(ids, duels);

  // Fora do bracket (não selecionado): placement = bracketSize + 1, pontos 0.
  const inBracket = new Set(ids);
  const blindRank = blindRankMap(okIds, seed);
  const outsiders = okIds
    .filter((id) => !inBracket.has(id))
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (blindRank.get(a) ?? 0) - (blindRank.get(b) ?? 0));
  const placementByContestant: Record<string, number> = { ...placementById };
  const allPoints: Record<string, number> = { ...points };
  for (const id of outsiders) {
    placementByContestant[id] = ids.length + 1;
    allPoints[id] = 0;
  }

  return {
    placementByContestant,
    order: [...order, ...outsiders],
    points: allPoints,
    duels,
    topK: topKGravado,
  };
}
