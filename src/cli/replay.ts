// `runs reproduce <id> --replay` — RE-PONTUAR uma run gravada a US$ 0
// (IMPL-117, R-07b:REC-5; pré-requisito para congelar respostas da R-07b:REC-8).
//
// O pipeline ATUAL (orquestrador, juízes, agregação, finais) roda de novo,
// inteiro, sobre um gateway de REPLAY que não fala com a rede: cada chamada é
// respondida com o que a run GRAVOU — a resposta de cada competidor e a saída
// de cada juiz (voto pointwise por juiz, passagem listwise, cada ordem de
// duelo), inclusive as FALHAS (saída inválida, cortada, timeout), para que
// veredito ausente continue ausente. Nada é cobrado: todo corpo sai com
// `usage.cost: 0` — o ledger mede zero, não infere.
//
// Por que não "replay por hash do pedido": o prompt de cada veredito leva um
// marcador + canário SORTEADOS por chamada (IMPL-006, anti-injeção) — o pedido
// nunca se repete byte a byte. O replay casa pelo CONTEÚDO dos blocos (caso,
// candidato(s), rótulos) e devolve o veredito gravado com o canário NOVO.
//
// O que ele prova: o binário de hoje pontua as respostas gravadas exatamente
// como a run original (judge-score ±0 em 100% dos cenários). Qualquer
// diferença é drift de PONTUAÇÃO (agregação, regra do judge-score, finais) —
// exit 3, com o que divergiu.
//
// Fora do alcance (dito, nunca simulado): run de AGENTE (a execução do agente
// não é uma chamada de chat gravada) e as sondas de verbosidade (IMPL-053,
// re-julgamento de texto manipulado que a run não gravou — desligadas no replay).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createGateway, setDefaultGateway, type FetchLike } from '../openrouter.js';
import { runToCompletion } from '../orchestrator.js';
import { getDataDir, setDataDir } from '../storage.js';
import { JUDGE_CONTRACT_TEXT } from '../refJudge.js';
import { JUDGE_LISTWISE_CONTRACT_TEXT } from '../judge.js';
import { DUEL_HEAD } from '../engine/duelPrompt.js';
import { GABARITO_ROLE_PROMPT } from '../gabarito.js';
import { escapeMarkers, readCanary, readMarkedBlock } from '../engine/judgeGuard.js';
import { renderCaseInput } from '../engine/caseInput.js';
import type {
  CompetitorResponse,
  Contestant,
  DuelFailure,
  DuelOrderResult,
  DuelOutcome,
  JudgeVote,
  RunConfig,
  RunRecord,
  StageRecord,
  StageSpec,
  Verdict,
  VerdictErrorKind,
} from '../types.js';

// ---------------------------------------------------------------------------
// Respostas sintéticas (o "fio" do replay)
// ---------------------------------------------------------------------------

/** Uma resposta do replay: texto + sinais de fim, OU um erro HTTP. */
type Resposta =
  | { kind: 'ok'; text: string; finishReason?: string; nativeFinishReason?: string; refusal?: string }
  | { kind: 'http'; status: number; message: string };

const USAGE_ZERO = { prompt_tokens: 0, completion_tokens: 0, cost: 0 };

function responder(r: Resposta, stream: boolean, n: number): Response {
  if (r.kind === 'http') {
    return new Response(JSON.stringify({ error: { message: r.message, code: r.status } }), { status: r.status });
  }
  if (stream) {
    const frames: string[] = [];
    if (r.text) frames.push(JSON.stringify({ id: `replay-${n}`, choices: [{ delta: { content: r.text } }] }));
    if (r.refusal) frames.push(JSON.stringify({ id: `replay-${n}`, choices: [{ delta: { refusal: r.refusal } }] }));
    frames.push(
      JSON.stringify({
        id: `replay-${n}`,
        choices: [{ delta: {}, finish_reason: r.finishReason ?? 'stop', native_finish_reason: r.nativeFinishReason ?? null }],
      }),
    );
    frames.push(JSON.stringify({ id: `replay-${n}`, choices: [], usage: USAGE_ZERO }));
    frames.push('[DONE]');
    return new Response(frames.map((f) => `data: ${f}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  return new Response(
    JSON.stringify({
      id: `replay-${n}`,
      choices: [
        {
          message: { content: r.text, ...(r.refusal ? { refusal: r.refusal } : {}) },
          finish_reason: r.finishReason ?? 'stop',
          ...(r.nativeFinishReason ? { native_finish_reason: r.nativeFinishReason } : {}),
        },
      ],
      usage: USAGE_ZERO,
    }),
    { status: 200 },
  );
}

/**
 * A falha GRAVADA de um veredito, reproduzida no fio — o bastante para o retry
 * seletivo do juiz (`callJudgeWithRetry`) chegar ao MESMO desfecho (veredito
 * ausente). Cada item é uma chamada (o lembrete de formato e o 2º timeout são
 * chamadas próprias).
 */
function falhaGravada(kind: VerdictErrorKind | undefined): Resposta[] {
  switch (kind) {
    case 'truncated':
      return [{ kind: 'ok', text: '', finishReason: 'length' }];
    case 'timeout':
      return [
        { kind: 'ok', text: '', finishReason: 'timeout' },
        { kind: 'ok', text: '', finishReason: 'timeout' },
      ];
    case 'judge_failed':
      return [{ kind: 'http', status: 400, message: 'replay: o juiz falhou nesta chamada na run gravada' }];
    default:
      // invalid_output (e o que não der para distinguir): 2 saídas fora do contrato.
      return [
        { kind: 'ok', text: '(replay: saída fora do contrato, como na run gravada)' },
        { kind: 'ok', text: '(replay: saída fora do contrato, como na run gravada)' },
      ];
  }
}

// ---------------------------------------------------------------------------
// Índice da run gravada
// ---------------------------------------------------------------------------

interface Slot {
  /** Chamadas deste veredito/resposta, em ordem (retries inclusos). */
  fila: Resposta[];
}

/** Próxima resposta do slot: consome até a ÚLTIMA, que se repete (defensivo). */
function proxima(slot: Slot): Resposta {
  return slot.fila.length > 1 ? slot.fila.shift()! : slot.fila[0];
}

/** Pool de slots por chave de conteúdo (clones idênticos = vários slots na mesma chave). */
class Pool {
  private readonly livres = new Map<string, Slot[]>();
  private readonly originais = new Map<string, Resposta[]>();
  add(chave: string, slot: Slot): void {
    const l = this.livres.get(chave);
    if (l) l.push(slot);
    else this.livres.set(chave, [slot]);
    this.originais.set(chave, [...slot.fila]);
  }
  /** Próximo slot livre da chave (ordem das etapas); esgotado = cópia do último gravado. */
  claim(chave: string): Slot | undefined {
    const s = this.livres.get(chave)?.shift();
    if (s) return s;
    const orig = this.originais.get(chave);
    return orig ? { fila: [...orig] } : undefined;
  }
}

/** O caso como aparece nos blocos de um juiz (escapado — é o que o juiz vê). */
function casoEscapado(spec: StageSpec): string {
  return escapeMarkers(renderCaseInput(spec));
}

/** O caso lido dos blocos de um pedido de juiz (contexto + linha em branco + pergunta). */
function casoDoPedido(user: string): string | undefined {
  const q = readMarkedBlock(user, 'PERGUNTA');
  if (q === undefined) return undefined;
  const ctx = readMarkedBlock(user, 'CONTEXTO');
  return ctx ? `${ctx}\n\n${q}` : q;
}

function respostaDoCompetidor(r: CompetitorResponse): Resposta[] {
  // Erro de infra: o competidor re-tenta 1x (`retries: 1`) — as duas falham.
  if (r.status === 'error') {
    const erro: Resposta = { kind: 'http', status: 400, message: 'replay: erro do competidor na run gravada' };
    return [erro, erro];
  }
  if (r.status === 'blocked') return [{ kind: 'ok', text: '', finishReason: 'content_filter' }];
  if (r.status === 'refused') return [{ kind: 'ok', text: '', refusal: r.text }];
  const final: Resposta = r.truncated
    ? { kind: 'ok', text: r.text, finishReason: 'length', nativeFinishReason: r.nativeFinishReason }
    : { kind: 'ok', text: r.text, finishReason: r.finishReason ?? 'stop', nativeFinishReason: r.nativeFinishReason };
  // Retry x2 por truncamento: a 1ª tentativa saiu cortada ('length').
  return r.truncationRetried ? [{ kind: 'ok', text: r.text, finishReason: 'length' }, final] : [final];
}

function votoPointwise(v: JudgeVote | undefined, fallback?: { verdict?: Verdict; explanation?: string }): Resposta[] {
  const verdict = v?.verdict ?? (v ? undefined : fallback?.verdict);
  if (!verdict) return falhaGravada(v?.error?.kind);
  return [
    {
      kind: 'ok',
      // O canário é preenchido na hora (é do pedido NOVO).
      text: JSON.stringify({
        canario: '__CANARIO__',
        explanation: v?.explanation ?? fallback?.explanation ?? '(replay)',
        verdict,
        ...(v?.confianca ? { confianca: v.confianca } : {}),
      }),
    },
  ];
}

function ordemDeDuelo(o: DuelOrderResult | undefined, primeiroEhA: boolean, erro?: VerdictErrorKind): Resposta[] {
  if (!o) return falhaGravada(erro);
  // Termos REAIS do par ('a' = 1º do par) → rótulo desta apresentação.
  const winner =
    o.winner === 'tie' ? 'tie' : (o.winner === 'a') === primeiroEhA ? 'A' : 'B';
  return [
    {
      kind: 'ok',
      text: JSON.stringify({
        canario: '__CANARIO__',
        explanation: o.explanation || '(replay)',
        winner,
        ...(o.confidence ? { confianca: o.confidence } : {}),
      }),
    },
  ];
}

interface Indice {
  /** caso (sem escape, como o competidor recebe) + contestant → chamadas. */
  competidor: Pool;
  /** juiz + caso + candidato → voto. */
  pointwise: Pool;
  /** caso + texto A + texto B → ordem. */
  duelo: Pool;
  /** juiz + caso + textos (multiconjunto) → passagem listwise. */
  listwise: Map<string, { stage: StageRecord; judgeModelId: string }>;
  /** Contestants por (modelo, system) — identidade do pedido do competidor. */
  contestants: Contestant[];
}

const SEP = '\u0000';

function indexar(record: RunRecord): Indice {
  const competidor = new Pool();
  const pointwise = new Pool();
  const duelo = new Pool();
  const listwise = new Map<string, { stage: StageRecord; judgeModelId: string }>();
  for (const st of record.stages) {
    const spec = st.spec;
    if (!spec) continue;
    const caso = renderCaseInput(spec);
    const casoEsc = casoEscapado(spec);
    const textoDe = new Map(st.responses.map((r) => [r.contestantId, r.text]));
    for (const r of st.responses) competidor.add([caso, r.contestantId].join(SEP), { fila: respostaDoCompetidor(r) });
    const ref = st.referenceJudge;
    if (ref) {
      for (const [cid, votos] of Object.entries(ref.judgeVotesByContestant ?? {})) {
        const texto = escapeMarkers(textoDe.get(cid) ?? '');
        for (const v of votos) pointwise.add([v.judgeModelId, casoEsc, texto].join(SEP), { fila: votoPointwise(v) });
      }
      // Record anterior ao IMPL-057 (sem votos por juiz): o agregado por juiz.
      if (!ref.judgeVotesByContestant) {
        for (const [cid, verdict] of Object.entries(ref.verdictByContestant)) {
          if (ref.verdictSourceByContestant?.[cid] === 'auto' || ref.verdictSourceByContestant?.[cid] === 'ground-truth') continue;
          const texto = escapeMarkers(textoDe.get(cid) ?? '');
          for (const jid of record.config.judgeModelIds) {
            pointwise.add([jid, casoEsc, texto].join(SEP), {
              fila: votoPointwise(undefined, { verdict, explanation: ref.explanationByContestant[cid] }),
            });
          }
        }
      }
    } else if (st.judge && st.judge.judges.length + Object.keys(st.judge.verdictErrorByContestant ?? {}).length > 0) {
      // As respostas que o listwise JULGA: nem erro de infra nem bloqueio, e não vazias.
      const textos = st.responses
        .filter((r) => r.status !== 'error' && r.status !== 'blocked' && r.text.trim())
        .map((r) => escapeMarkers(r.text))
        .sort();
      for (const jid of new Set(record.config.judgeModelIds)) {
        listwise.set([jid, casoEsc, ...textos].join(SEP), { stage: st, judgeModelId: jid });
      }
    }
    const pares: Array<DuelOutcome | DuelFailure> = [...(st.duels?.duels ?? []), ...(st.duels?.failedDuels ?? [])];
    for (const d of pares) {
      if ('source' in d && d.source === 'ground-truth') continue; // oráculo: sem LLM
      const ta = escapeMarkers(textoDe.get(d.a) ?? '');
      const tb = escapeMarkers(textoDe.get(d.b) ?? '');
      const erro = 'error' in d ? d.error.kind : undefined;
      // Ordem 1: a apresentado como A; ordem 2: b apresentado como A.
      duelo.add([casoEsc, ta, tb].join(SEP), { fila: ordemDeDuelo(d.order1, true, erro) });
      duelo.add([casoEsc, tb, ta].join(SEP), { fila: ordemDeDuelo(d.order2, false, erro) });
    }
  }
  return { competidor, pointwise, duelo, listwise, contestants: record.contestants };
}

// ---------------------------------------------------------------------------
// O gateway de replay
// ---------------------------------------------------------------------------

/** Chamada que o replay NÃO soube responder (não gravada) — torna o replay inválido. */
export interface ReplayMiss {
  role: string;
  model: string;
  detail: string;
}

export interface ReplayTransport {
  fetch: FetchLike;
  misses: ReplayMiss[];
  /** Chamadas de chat respondidas (todas a US$ 0). */
  calls: () => number;
}

function sistemaDe(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  const s = msgs.find((m) => m.role === 'system')?.content;
  return typeof s === 'string' ? s : '';
}

function userDe(body: Record<string, unknown>): string {
  const msgs = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
  return msgs
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
}

/** Transporte que responde cada chamada com o que a run gravou (custo 0). */
export function replayTransport(record: RunRecord): ReplayTransport {
  const idx = indexar(record);
  const misses: ReplayMiss[] = [];
  // O canário prende a re-tentativa (lembrete de formato, 2º timeout) ao MESMO voto.
  const porCanario = new Map<string, Slot>();
  // Competidor não tem canário: o slot com chamadas PENDENTES (retry x2 do
  // truncamento, 2ª tentativa do erro) atende a próxima chamada da mesma chave.
  const emCurso = new Map<string, Slot>();
  let n = 0;

  const comCanario = (r: Resposta, canary: string | undefined): Resposta =>
    r.kind === 'ok' && canary ? { ...r, text: r.text.replace('__CANARIO__', canary) } : r;

  const fetch: FetchLike = async (url, init) => {
    const p = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      if (p.endsWith('/key')) {
        return new Response(JSON.stringify({ data: { label: 'replay', usage: 0, limit: null } }), { status: 200 });
      }
      // Catálogo/endpoints: vazio — o replay não precisa (e não pode) consultar a rede.
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    // Este transporte fica ATRÁS do ponto único (é o `fetch` injetado no
    // gateway de `openrouter.ts`, como o transporte falso dos testes): ele
    // RECEBE o POST de chat do gateway — nunca fala com a rede.
    if (!p.endsWith('/completions')) return new Response('replay: rota não gravada', { status: 404 });
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const model = String(body.model ?? '');
    const stream = body.stream === true;
    const system = sistemaDe(body);
    const user = userDe(body);
    n += 1;
    const falta = (role: string, detail: string): Response => {
      misses.push({ role, model, detail });
      return responder({ kind: 'http', status: 400, message: `replay: chamada não gravada (${role})` }, stream, n);
    };

    // --- competidor (streaming; system = a variante, e só ela) -------------
    if (stream) {
      const candidatos = idx.contestants.filter(
        (c) => c.modelId === model && (c.systemPrompt?.trim() ? c.systemPrompt : '') === system,
      );
      const temp = typeof body.temperature === 'number' ? body.temperature : undefined;
      const esforco = (body.reasoning as { effort?: string } | undefined)?.effort;
      const refinados =
        candidatos.length > 1
          ? candidatos.filter(
              (c) =>
                (temp === undefined || c.temperature === undefined || c.temperature === temp) &&
                (esforco === undefined || c.reasoningLevel === undefined || c.reasoningLevel === esforco),
            )
          : candidatos;
      for (const c of refinados.length ? refinados : candidatos) {
        const chave = [user, c.id].join(SEP);
        const pendente = emCurso.get(chave);
        const slot = pendente ?? idx.competidor.claim(chave);
        if (!slot) continue;
        // Havia mais de uma chamada na fila ⇒ a PRÓXIMA desta chave é o retry deste slot.
        const antes = slot.fila.length;
        const r = proxima(slot);
        if (antes > 1) emCurso.set(chave, slot);
        else emCurso.delete(chave);
        return responder(r, true, n);
      }
      return falta('competidor', `nenhuma resposta gravada para ${model} neste caso`);
    }

    const canary = readCanary(user);
    const presa = canary ? porCanario.get(canary) : undefined;
    const servir = (chave: string, pool: Pool, role: string): Response => {
      const slot = presa ?? pool.claim(chave);
      if (!slot) return falta(role, 'veredito não gravado para este conteúdo');
      if (canary) porCanario.set(canary, slot);
      return responder(comCanario(proxima(slot), canary), false, n);
    };

    // --- juiz pointwise ------------------------------------------------------
    if (system === JUDGE_CONTRACT_TEXT) {
      const caso = casoDoPedido(user);
      const cand = readMarkedBlock(user, 'CANDIDATO');
      if (caso === undefined || cand === undefined) return falta('juiz', 'pedido pointwise sem blocos');
      return servir([model, caso, cand].join(SEP), idx.pointwise, 'juiz');
    }
    // --- duelo --------------------------------------------------------------
    if (system.startsWith(DUEL_HEAD)) {
      const caso = casoDoPedido(user);
      const a = readMarkedBlock(user, 'CANDIDATO A');
      const b = readMarkedBlock(user, 'CANDIDATO B');
      if (caso === undefined || a === undefined || b === undefined) return falta('duelo', 'pedido de duelo sem blocos');
      return servir([caso, a, b].join(SEP), idx.duelo, 'duelo');
    }
    // --- listwise -----------------------------------------------------------
    if (system === JUDGE_LISTWISE_CONTRACT_TEXT) {
      const caso = casoDoPedido(user);
      const rotulos = /rotulos (\[[^\]]*\])/.exec(user);
      if (caso === undefined || !rotulos) return falta('listwise', 'pedido listwise sem blocos');
      const labels = JSON.parse(rotulos[1]) as string[];
      const textos = labels.map((l) => readMarkedBlock(user, `RESPOSTA ${l}`) ?? '');
      const achado = idx.listwise.get([model, caso, ...[...textos].sort()].join(SEP));
      if (!achado) return falta('listwise', 'passagem listwise não gravada');
      const juiz = achado.stage.judge!.judges.find((j) => j.judgeModelId === model);
      if (!juiz) return responder(comCanario(falhaGravada('invalid_output')[0], canary)!, false, n);
      const idPorTexto = new Map(
        achado.stage.responses.map((r) => [escapeMarkers(r.text), r.contestantId] as const),
      );
      const letraDe = new Map(textos.map((t, i) => [idPorTexto.get(t), labels[i]] as const));
      const ranking = juiz.rankedContestantIds.map((id) => letraDe.get(id)).filter((l): l is string => Boolean(l));
      const verdicts = labels.map((label, i) => {
        const cid = idPorTexto.get(textos[i]);
        const v = juiz.verdicts.find((x) => x.contestantId === cid);
        return { label, justificativa: v?.motivo ?? '(replay)', veredito: v?.verdict ?? 'parcial' };
      });
      return responder({ kind: 'ok', text: JSON.stringify({ canario: canary ?? '', ranking, verdicts }) }, false, n);
    }
    // --- gabarito: só etapa que ficou SEM régua na run gravada chega aqui ----
    if (system === GABARITO_ROLE_PROMPT) {
      return responder({ kind: 'ok', text: '' }, false, n);
    }
    return falta('desconhecido', `system não reconhecido (${system.slice(0, 60)}…)`);
  };
  return { fetch, misses, calls: () => n };
}

// ---------------------------------------------------------------------------
// Comparação original × replay
// ---------------------------------------------------------------------------

export interface ReplayMismatch {
  what: 'judge-score' | 'scenario' | 'standings' | 'finalists' | 'cost' | 'miss';
  detail: string;
}

export interface ReplayComparison {
  identical: boolean;
  /** Cenários (perguntas distintas) comparados veredito a veredito. */
  scenarios: number;
  judgeScoreOriginal: Record<string, number>;
  judgeScoreReplay: Record<string, number>;
  mismatches: ReplayMismatch[];
}

/** Vereditos por (pergunta, contestant) — multiconjunto (clones de repeat somam). */
function vereditosPorCenario(record: RunRecord): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const st of record.stages) {
    if (!st.spec || st.incomplete) continue;
    const vs = st.referenceJudge?.verdictByContestant ?? st.judge?.verdictByContestant ?? {};
    for (const c of record.contestants) {
      const chave = `${st.spec.question}${SEP}${c.id}`;
      const lista = out.get(chave) ?? [];
      lista.push(vs[c.id] ?? '(sem veredito)');
      out.set(chave, lista);
    }
  }
  for (const l of out.values()) l.sort();
  return out;
}

export function compareReplay(original: RunRecord, replay: RunRecord, misses: ReplayMiss[] = []): ReplayComparison {
  const mismatches: ReplayMismatch[] = [];
  const jsO = original.judgeScoreByContestant ?? {};
  const jsR = replay.judgeScoreByContestant ?? {};
  for (const id of new Set([...Object.keys(jsO), ...Object.keys(jsR)])) {
    if (jsO[id] !== jsR[id]) {
      mismatches.push({ what: 'judge-score', detail: `${id}: ${jsO[id] ?? '—'} → ${jsR[id] ?? '—'}` });
    }
  }
  const vO = vereditosPorCenario(original);
  const vR = vereditosPorCenario(replay);
  const perguntas = new Set<string>();
  for (const chave of new Set([...vO.keys(), ...vR.keys()])) {
    perguntas.add(chave.split(SEP)[0]);
    const a = JSON.stringify(vO.get(chave) ?? []);
    const b = JSON.stringify(vR.get(chave) ?? []);
    if (a !== b) mismatches.push({ what: 'scenario', detail: `${chave.replace(SEP, ' × ')}: ${a} → ${b}` });
  }
  const st = (r: RunRecord) =>
    JSON.stringify(
      [...(r.standings ?? [])].map((s) => [s.id, s.wins, s.ties, s.losses]).sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
    );
  if (st(original) !== st(replay)) mismatches.push({ what: 'standings', detail: `${st(original)} → ${st(replay)}` });
  const fin = (r: RunRecord) => JSON.stringify([...(r.finalists ?? [])].sort());
  if (fin(original) !== fin(replay)) mismatches.push({ what: 'finalists', detail: `${fin(original)} → ${fin(replay)}` });
  if (replay.totalCostUsd !== 0) mismatches.push({ what: 'cost', detail: `o replay custou $${replay.totalCostUsd}` });
  for (const m of misses) mismatches.push({ what: 'miss', detail: `${m.role} ${m.model}: ${m.detail}` });
  return {
    identical: mismatches.length === 0,
    scenarios: perguntas.size,
    judgeScoreOriginal: jsO,
    judgeScoreReplay: jsR,
    mismatches,
  };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

/** Por que uma run NÃO pode ser re-pontuada por replay (ou `undefined`). */
export function replayUnsupportedReason(record: RunRecord): string | undefined {
  if (record.config.agent || record.contestants.some((c) => c.runner === 'agent')) {
    return 'run de AGENTE: a execução do agente não é uma chamada de chat gravada — o replay a US$ 0 não a reproduz.';
  }
  if (!record.stages.some((s) => s.spec)) return 'a run não gravou nenhum cenário (nada a re-pontuar).';
  return undefined;
}

export interface ReplayOutcome {
  replay: RunRecord;
  comparison: ReplayComparison;
  calls: number;
}

/**
 * Re-pontua a run gravada com o pipeline ATUAL e o gateway de replay, num
 * data-dir TEMPORÁRIO (o record do replay usa o MESMO id — mesmas sementes de
 * finalistas/desempate — e nunca toca o record original). Restaura o gateway e
 * o data-dir no fim, aconteça o que acontecer.
 */
export async function replayRun(record: RunRecord): Promise<ReplayOutcome> {
  const transporte = replayTransport(record);
  const specs = record.stages.map((s) => s.spec).filter((s): s is StageSpec => Boolean(s));
  const config = {
    ...record.config,
    // Specs gravadas (com gabarito e validação) — nada de datagen nem gabarito novo.
    customStages: specs,
    stages: specs.length,
    // Os clones de repeat JÁ estão nas specs gravadas.
    ...(record.config.mode === 'compare' ? { repeats: 1 } : {}),
    // Sondas re-julgam texto manipulado que a run não gravou: fora do replay.
    verbosityProbes: false,
    validateReferences: false,
    secondReferenceModelId: undefined,
    // Custo é ZERO por construção; teto não se aplica.
    budgetUsd: undefined,
  } as RunConfig;
  const dirAnterior = getDataDir();
  const tmp = mkdtempSync(path.join(tmpdir(), 'pb-replay-'));
  const gwAnterior = setDefaultGateway(
    createGateway({ fetch: transporte.fetch, sleep: async () => undefined, providerLookup: 'off', resendGuardTtlMs: 0 }),
  );
  setDataDir(tmp);
  try {
    const replay = await runToCompletion(config, 'sk-or-v1-replay-sem-rede-0000000000000000', {
      runId: record.id,
      contestants: record.contestants,
    });
    return { replay, comparison: compareReplay(record, replay, transporte.misses), calls: transporte.calls() };
  } finally {
    setDefaultGateway(gwAnterior);
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  }
}
