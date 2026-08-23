// Duelos round-robin (Critério 2, portado do prompt-arena): depois do juiz
// pointwise, cada PAR de candidatos é julgado head-to-head contra a REFERÊNCIA,
// nas DUAS ordens (desacordo => empate — cancela viés de posição), e o placar
// Copeland (vitória 1, empate 0.5) vira o placement da etapa. O round-robin é
// QUADRÁTICO (C(n,2) pares × 2 ordens, no modelo mais caro do pipeline), então
// só duelam um BRACKET: o controle (sempre — é a régua que toda variante tem de
// bater) + os K−1 melhores no pointwise. Toda falha degrada para empate/ausência
// de duelos — NUNCA derruba a run.

import { chatCompletion } from './openrouter.js';
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

/** Hash FNV-1a 32-bit do id/conteúdo — seed estável p/ o shuffle cego por etapa. */
export function seedFromId(id: string): number {
  let h = 2166136261;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** PRNG determinístico (mesma seed => mesma sequência) p/ embaralhamentos cegos. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pontuação do veredito pointwise usada na seleção do bracket. */
export const VERDICT_SCORE: Record<Verdict, number> = { resolve: 2, parcial: 1, nao: 0 };

/** Rank cego e determinístico por id: chave aleatória semeada, nunca ordem de entrada. */
export function blindRankMap(ids: string[], seed: number): Map<string, number> {
  const rng = mulberry32(seed);
  const arr = ids.map((id) => ({ id, k: rng() })).sort((a, b) => a.k - b.k);
  return new Map(arr.map((x, i) => [x.id, i]));
}

/**
 * Escolhe QUEM duelo numa etapa — o governador de custo do round-robin.
 * O controle entra SEMPRE (é a baseline); as outras vagas vão aos melhores por
 * `score` (veredito pointwise da etapa). Empate de score é desempatado pelo
 * shuffle semeado cego, NUNCA pela ordem de entrada — senão a variante listada
 * primeiro se classificaria sistematicamente. `topK <= 0` ou `>= entries.length`
 * => round-robin completo. Determinístico: mesma etapa => mesmo bracket.
 */
export function selectDuelists(
  entries: { id: string; score: number }[],
  controlId: string | undefined,
  topK: number,
  seed: number,
): string[] {
  const list = entries ?? [];
  if (topK <= 0 || topK >= list.length) return list.map((e) => e.id);
  const rank = blindRankMap(
    list.map((e) => e.id),
    seed,
  );
  const control = controlId !== undefined ? list.find((e) => e.id === controlId) : undefined;
  const rest = list
    .filter((e) => e !== control)
    .sort((a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  return control
    ? [control.id, ...rest.slice(0, topK - 1).map((e) => e.id)]
    : rest.slice(0, topK).map((e) => e.id);
}

/**
 * Escolhe os N FINALISTAS globais: maiores `score` (judge-score médio da run).
 * Empate é desempatado pelo shuffle cego semeado (nunca pela ordem de entrada).
 * `count <= 0` ou `>= entries.length` => todos, **mas ainda ordenados por score**:
 * a lista sai como ranking (é ela que vira `record.finalists`, o evento
 * `finals.started` e o pódio provisório da UI enquanto os duelos rodam). Devolver
 * a ordem de entrada aqui numerava 1º/2º/3º por ordem de cadastro.
 */
export function pickFinalists(
  entries: { id: string; score: number }[],
  count: number,
  seed: number,
): string[] {
  const list = entries ?? [];
  const rank = blindRankMap(
    list.map((e) => e.id),
    seed,
  );
  const ordenados = [...list]
    .sort((a, b) => b.score - a.score || (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0))
    .map((e) => e.id);
  return count <= 0 || count >= list.length ? ordenados : ordenados.slice(0, count);
}

/**
 * Agregação Copeland dos duelos de uma etapa: vitória 1, empate 0.5, derrota 0.
 * Placement 1-based por pontos desc; empates de pontos DIVIDEM a média dos ranks
 * que ocupam (placements fracionários). `order` = ids do melhor ao pior
 * placement (empate mantém a ordem de `ids` — o chamador passa a ordem cega).
 */
export function standingsFromDuels(
  ids: string[],
  duels: DuelOutcome[],
): { points: Record<string, number>; placementById: Record<string, number>; order: string[] } {
  const points = new Map<string, number>(ids.map((id) => [id, 0]));
  for (const d of duels ?? []) {
    if (!points.has(d.a) || !points.has(d.b)) continue;
    if (d.outcome === 'a') points.set(d.a, (points.get(d.a) ?? 0) + 1);
    else if (d.outcome === 'b') points.set(d.b, (points.get(d.b) ?? 0) + 1);
    else {
      points.set(d.a, (points.get(d.a) ?? 0) + 0.5);
      points.set(d.b, (points.get(d.b) ?? 0) + 0.5);
    }
  }
  const sorted = [...points.entries()].sort((x, y) => y[1] - x[1]);
  const placementById = new Map<string, number>();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1][1] === sorted[i][1]) j += 1;
    const avgRank = (i + 1 + (j + 1)) / 2;
    for (let k = i; k <= j; k += 1) placementById.set(sorted[k][0], avgRank);
    i = j + 1;
  }
  const order = [...placementById.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id);
  return { points: Object.fromEntries(points), placementById: Object.fromEntries(placementById), order };
}

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

  // Sem gabarito não há duelo possível — degrada, nunca quebra a run.
  const reference = stage.reference?.trim() ?? '';
  if (!reference) return semDuelos(1);

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
      const [v1, v2] = await Promise.all([judgeOnce(a, b), judgeOnce(b, a)]);
      const o1 = v1.winner === 'A' ? 'a' : v1.winner === 'B' ? 'b' : 'tie';
      const o2 = v2.winner === 'A' ? 'b' : v2.winner === 'B' ? 'a' : 'tie';
      const duel: DuelOutcome = {
        a,
        b,
        order1: { winner: o1, explanation: v1.explanation },
        order2: { winner: o2, explanation: v2.explanation },
        outcome: o1 === o2 ? o1 : 'tie',
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
