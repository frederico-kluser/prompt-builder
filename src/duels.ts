// Duelos round-robin (Critério 2, portado do prompt-arena): depois do juiz
// pointwise, cada PAR de candidatos é julgado head-to-head contra a REFERÊNCIA,
// nas DUAS ordens (desacordo => empate — cancela viés de posição), e o placar
// Copeland (vitória 1, empate 0.5) vira o placement da etapa. O round-robin é
// QUADRÁTICO (C(n,2) pares × 2 ordens, no modelo mais caro do pipeline), então
// só duelam um BRACKET: o controle (sempre — é a régua que toda variante tem de
// bater) + os K−1 melhores no pointwise. Falha NUNCA derruba a run e NUNCA
// vira empate: o duelo sem resultado vai para `failedDuels`, fora do placar
// (IMPL-004).

import { chatCompletion } from './openrouter.js';
import { callJudgeWithRetry, withReminder, type JudgeAttempt } from './engine/judgeRetry.js';
import { readArtifact } from './agent/store.js';
import type {
  CompetitorResponse,
  Contestant,
  DuelFailure,
  DuelOutcome,
  ReasoningLevel,
  StageDuels,
  StageSpec,
  Verdict,
  VerdictError,
  RunCtx,
} from './types.js';

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
 * Parse ESTRITO da resposta do duelo: objeto JSON com `winner` em A|B|tie
 * (aceita "empate"). Qualquer outra coisa => `null` (saída inválida) — quem
 * chama pede UMA vez de novo com lembrete de formato e, persistindo, o duelo
 * fica SEM resultado (IMPL-004). O antigo fallback por regex (1º A/B isolado
 * no texto cru; lixo => 'tie') foi removido: o empate imputado pontuava 0,5.
 */
function parseDuelVerdict(text: string): { winner: 'A' | 'B' | 'tie'; explanation: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  const raw = typeof p.winner === 'string' ? p.winner.trim().toUpperCase() : '';
  const winner: 'A' | 'B' | 'tie' | null =
    raw === 'A' || raw === 'B' ? raw : raw === 'TIE' || raw === 'EMPATE' ? 'tie' : null;
  if (!winner) return null;
  const explanation = (typeof p.explanation === 'string' && p.explanation.trim().slice(0, 300)) || '';
  return { winner, explanation };
}

/** Lembrete anexado ao 2º pedido depois de uma saída fora do contrato. */
const DUEL_FORMAT_REMINDER =
  'LEMBRETE DE FORMATO: a resposta anterior não seguiu o contrato. Responda APENAS com um objeto JSON ' +
  '{"winner": "A"|"B"|"tie", "explanation": "<uma frase curta>"} — sem markdown e sem texto antes ou depois.';

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

  // UMA apresentação ordenada (first => rótulo A, second => rótulo B), com a
  // re-tentativa SELETIVA do juiz (timeout 1×; saída inválida => 1 pedido com
  // lembrete). Orçamento/cancelamento SOBEM de dentro de callJudgeWithRetry:
  // sem isso, dinheiro estourado viraria duelo "sem resultado" em TODA a final.
  const judgeOnce = (
    firstId: string,
    secondId: string,
  ): Promise<JudgeAttempt<{ winner: 'A' | 'B' | 'tie'; explanation: string }>> => {
    const userPrompt = buildDuelUserPrompt(
      stage,
      reference,
      textById.get(firstId) ?? '',
      textById.get(secondId) ?? '',
    );
    return callJudgeWithRetry({
      call: async (reminder) =>
        (
          await chatCompletion({
            apiKey,
            modelId: judgeModelId,
            messages: [
              { role: 'system', content: DUEL_HEAD },
              { role: 'user', content: withReminder(userPrompt, reminder) },
            ],
            temperature: 0,
            maxTokens: 512,
            timeoutMs,
            responseFormatJson: true,
            reasoningLevel,
            // Papel 'duel' no ledger (IMPL-021): sem isto o gateway contaria o
            // duelo como 'competitor' (o default de role).
            role: 'duel',
            signal: ctx?.signal,
            sink: ctx?.sink,
            maxPricePerMTok,
          })
        ).text,
      parse: parseDuelVerdict,
      formatReminder: DUEL_FORMAT_REMINDER,
      signal: ctx?.signal,
    });
  };

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
        const falha = !v1.ok ? v1.error : !v2.ok ? v2.error : undefined;
        return {
          ok: false,
          failure: {
            a,
            b,
            ...(v1.ok && o1 ? { order1: { winner: o1, explanation: v1.value.explanation } } : {}),
            ...(v2.ok && o2 ? { order2: { winner: o2, explanation: v2.value.explanation } } : {}),
            error: falha ?? { kind: 'judge_failed', message: 'Ordem do duelo sem resultado.' },
          },
        };
      }
      const duel: DuelOutcome = {
        a,
        b,
        order1: { winner: o1, explanation: v1.value.explanation },
        order2: { winner: o2, explanation: v2.value.explanation },
        outcome: combineDuelOrders(o1, o2),
        source: 'judge',
      };
      onPair?.(duel);
      return { ok: true, duel };
    }),
  );
  const duels = julgados.flatMap((j) => (j.ok ? [j.duel] : []));
  const failedDuels = julgados.flatMap((j) => (j.ok ? [] : [j.failure]));

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
    ...(failedDuels.length > 0 ? { failedDuels } : {}),
    topK: effectiveTopK,
  };
}
