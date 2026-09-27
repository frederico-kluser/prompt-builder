// Duelos round-robin (Critério 2, portado do prompt-arena): depois do juiz
// pointwise, cada PAR de candidatos é julgado head-to-head contra a REFERÊNCIA,
// nas DUAS ordens (desacordo => empate — cancela viés de posição), e o placar
// Copeland (vitória 1, empate 0.5) vira o placement da etapa. O round-robin é
// QUADRÁTICO (C(n,2) pares × 2 ordens, no modelo mais caro do pipeline), então
// só duelam um BRACKET: o controle (sempre — é a régua que toda variante tem de
// bater) + os K−1 melhores no pointwise. Toda falha degrada para empate/ausência
// de duelos — NUNCA derruba a run.

import { chatCompletion } from './openrouter.js';
import { ROLE_MAX_TOKENS } from './roleLimits.js';
import { isControlSignal } from './budget.js';
import { readArtifact } from './agent/store.js';
import type {
  CompetitorResponse,
  Contestant,
  DuelOutcome,
  ReasoningLevel,
  StageDuels,
  StageSpec,
  Verdict, RunCtx } from './types.js';

import {
  blindRankMap,
  combineDuelOrders,
  mulberry32,
  pickFinalists,
  seedFromId,
  selectDuelists,
  standingsFromDuels,
  VERDICT_SCORE,
} from './engine/duelCore.js';
// Re-export do núcleo puro (F0): a matemática do bracket/Copeland é fonte
// única em `src/engine/duelCore.ts` — consumidores históricos seguem importando
// daqui. `mulberry32`/`pickFinalists` são usados por este módulo e reexportados.
export {
  blindRankMap,
  combineDuelOrders,
  mulberry32,
  pickFinalists,
  seedFromId,
  selectDuelists,
  standingsFromDuels,
  VERDICT_SCORE,
} from './engine/duelCore.js';

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
Candidato A (dossiê):
${textA || '(vazio)'}

Candidato B (dossiê):
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
  /** Sinal de abort + ledger de custo. */
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /** Vereditos do juiz pointwise (refJudge) — ordenam o bracket. Ausente => score −1. */
  verdictByContestant?: Record<string, Verdict>;
  /**
   * Score do ORÁCULO por contestant (§19.1 do PLANO-AGENT-ARENA) — aditivo.
   * Quando AMBOS os lados de um par têm score presente E os scores diferem, o
   * vencedor do duelo é decidido PELO ORÁCULO (maior score), SEM chamada LLM —
   * o oráculo é determinístico e mais correto que o juiz para desempate (§19.1:
   * "o oráculo MANDA"). O duelo só cai no LLM quando há empate de oráculo ou
   * quando falta score de um dos lados. ADITIVO: sem esta opção, o
   * comportamento é idêntico ao de hoje.
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
 *
 * Modo agente (aditivo): quando uma resposta carrega `execution`, o candidato
 * duela pelo DOSSIÊ do disco (`readArtifact(dossier.md)`) — o juiz lê a MESMA
 * evidência que o pointwise (§19). E se `oracleScoresByContestant` estiver
 * presente e ambos os lados de um par tiverem score diferente, o vencedor é
 * decidido PELO ORÁCULO, sem LLM (§19.1). Faltar dossiê ou oráculo degrada,
 * nunca derruba.
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
    ctx,
    maxPricePerMTok,
    verdictByContestant,
    oracleScoresByContestant,
    onPair,
  } = opts;
  // Finalistas globais ditam o bracket (fase de finais); sem eles, cai na
  // selecao por etapa (topK + controle). O `topK` gravado reflete o bracket real.
  const effectiveTopK = duelists?.length ? duelists.length : topK;

  // Só respostas ok duelam; dedup defensivo (a 1ª ocorrência do id vence).
  // Quando a resposta carrega `execution` (modo agente), o candidato entra no
  // duelo pelo DOSSIÊ do disco, não pelo resumo 1-linha do `text` — o juiz lê a
  // MESMA evidência que o pointwise viu (auditável via `dossierSha256`).
  // Falha de leitura de dossiê DEGRADA para `r.text`: duelos nunca derrubam.
  const textById = new Map<string, string>();
  for (const r of responses ?? []) {
    if (r.status !== 'ok' || textById.has(r.contestantId)) continue;
    let text = r.text;
    if (r.execution) {
      try {
        const dossier = await readArtifact(r.execution, 'dossier.md');
        if (dossier) text = dossier;
      } catch {
        // sem dossiê no disco (leitura falhou): fica o resumo 1-linha. Degrada, nunca derruba.
        text = r.text;
      }
    }
    textById.set(r.contestantId, text);
  }
  const okIds = [...textById.keys()];
  // Fallback: no variation/training o controle é o prompt original.
  const control = controlId ?? contestants.find((c) => c.isOriginal)?.id;

  const semDuelos = (placement: number): StageDuels => ({
    placementByContestant: Object.fromEntries(okIds.map((id) => [id, placement])),
    order: [...okIds],
    points: Object.fromEntries(okIds.map((id) => [id, 0])),
    duels: [],
    topK: effectiveTopK,
  });

  // Sem gabarito TEXTUAL os duelos só acontecem decididos pelo ORÁCULO (scores
  // determinísticos: ground-truth F1.4 / verify do modo agente §19.1). Sem
  // gabarito e sem oráculo ⇒ degrada, nunca quebra a run.
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
        // Teto TOTAL com sala p/ raciocinio (IMPL-016): 512 virava `length` vazio => empate.
        maxTokens: ROLE_MAX_TOKENS.duel,
        timeoutMs,
        responseFormatJson: true,
        reasoningLevel,
        role: 'duel',
        signal: ctx?.signal,
        sink: ctx?.sink,
        maxPricePerMTok,
      });
      return parseDuelVerdict(result.text);
    } catch (err) {
      // Sem o rethrow, orcamento estourado viraria empate em TODOS os duelos —
      // uma final inteira decidida por falta de dinheiro, sem ninguem saber.
      if (isControlSignal(err)) throw err;
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
  // Exceção — ORÁCULO (§19.1): quando ambos os lados têm score de oráculo e os
  // scores diferem, o par é decidido PELO ORÁCULO (maior score), SEM chamada
  // LLM. O oráculo é determinístico — decidir duelo por ele é mais correto e
  // corta custo. As duas ordens espelham o MESMO resultado ('a'/'b').
  const duels: DuelOutcome[] = await Promise.all(
    pairs.map(async ([a, b]) => {
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
        // Sem gabarito, o juiz LLM não teria régua: par que o oráculo não
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
    topK: effectiveTopK,
  };
}
