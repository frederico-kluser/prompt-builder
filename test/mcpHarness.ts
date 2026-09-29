// Harness COMPARTILHADO dos testes do servidor MCP (IMPL-025 cancelamento,
// IMPL-026 jobs). Não é arquivo de teste (sem `.test.`): pipeline FALSO do
// OpenRouter (em processo ou num http local), transporte instrumentado que
// marca o que saiu depois de um cancelamento e o processo real `mcp` por stdio.
// Zero rede externa, zero gasto.

import { duelReply, pointwiseReply } from './judgeReplies.js';
import { nodeOrTsx } from './support/cli.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { FetchLike } from '../src/openrouter.js';
import type { RunRecord } from '../src/types.js';
import { catalogItem, fakeOpenRouter, type FakeOpenRouter } from './fakeOpenRouter.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const _cli = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
export const TSX = _cli.cmd;
export const CLI = _cli.entry;
export const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

export type Msg = Record<string, unknown> & { id?: unknown; result?: unknown; error?: { code: number; message: string } };

export function esperaAbortavel(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function ate(cond: () => boolean, maxMs: number, oQue: string): Promise<void> {
  const fim = Date.now() + maxMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error(`timeout esperando: ${oQue}`);
    await dormir(5);
  }
}

// ---------------------------------------------------------------------------
// Pipeline falso (mesmo roteamento do gateway-pipeline.test.ts)
// ---------------------------------------------------------------------------

export const CENARIOS = [
  {
    question: 'Qual o prazo para trocar um tenis comprado na loja online?',
    productContext: 'Politica de trocas: 30 dias corridos a partir do recebimento, com nota fiscal.',
    maxTokens: 300,
    rubric: 'Deve citar 30 dias e a nota fiscal.',
  },
  {
    question: 'Explique como calcular juros compostos de um investimento mensal em renda fixa.',
    productContext: 'Voce e um assistente financeiro. Formula: M = C (1 + i)^n.',
    maxTokens: 400,
    rubric: 'Deve apresentar a formula M = C(1+i)^n corretamente.',
  },
];

export const CATALOGO = ['fake/gen', 'fake/ref', 'fake/judge', 'fake/a', 'fake/b', 'fake/opt'].map((id) =>
  catalogItem(id, 1e-7, 1e-7),
);

export type Papel = 'datagen' | 'gabarito' | 'rewriter' | 'competitor' | 'judge' | 'duel';

/** Papel de um pedido de chat pelo modelo/forma (o fake não vê o `role` do ledger). */
export function papelDe(body: { model?: string; stream?: boolean; messages?: { role: string; content: string }[] }): Papel {
  if (body.model === 'fake/gen') return 'datagen';
  if (body.model === 'fake/ref') return 'gabarito';
  if (body.model === 'fake/opt') return 'rewriter';
  const system = body.messages?.find((m) => m.role === 'system')?.content ?? '';
  // IMPL-072: o processo real manda TODO papel em streaming — o juiz sai pelo MODELO.
  if (body.model === 'fake/judge') return system.includes('DUELO') ? 'duel' : 'judge';
  if (body.stream === true) return 'competitor';
  return system.includes('DUELO') ? 'duel' : 'judge';
}

/** Cenários sintéticos: `n` variações dos dois de base (runs de N etapas). */
// Perguntas DISTINTAS de verdade: o datagen deduplica por ROUGE-L, e variar só
// um sufixo "(caso N)" colapsava os N cenários nos 2 da base.
const TEMAS = [
  'devolucao de geladeira com defeito de fabrica',
  'cancelamento de assinatura anual de streaming',
  'segunda via de boleto vencido do condominio',
  'troca de titularidade de linha telefonica movel',
  'reembolso de passagem aerea por voo atrasado',
  'agendamento de vacina contra gripe em farmacia',
  'portabilidade de salario entre bancos digitais',
  'rastreamento de encomenda internacional retida',
  'renovacao de carteira de motorista vencida',
  'desconto de estudante em plano de academia',
];

export function cenarios(n: number): typeof CENARIOS {
  return Array.from({ length: n }, (_, i) => ({
    ...CENARIOS[i % CENARIOS.length],
    question: `Como funciona ${TEMAS[i % TEMAS.length]}${i >= TEMAS.length ? ` — variante ${i + 1}` : ''}?`,
  }));
}

export function fakeDoPipeline(stages: typeof CENARIOS = CENARIOS): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: CATALOGO,
    chat: (req, n) => {
      const usage = { prompt_tokens: 100 + n, completion_tokens: 20, cost: Number((0.0001 * (n + 1)).toFixed(6)) };
      if (req.model === 'fake/gen') return { text: JSON.stringify({ stages }), usage };
      if (req.model === 'fake/opt') {
        const tecnica = /tecnica id="([^"]+)"/.exec(req.user)?.[1] ?? 'x';
        return {
          text: `Voce e um atendente cordial e preciso (${tecnica}). Responda sempre com base no contexto do produto, cite prazos e regras exatamente como aparecem e recuse o que estiver fora do escopo.`,
          usage,
        };
      }
      if (req.model === 'fake/ref') return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      // IMPL-072: juiz roteado pelo MODELO (no processo real todo papel faz stream).
      if (req.model !== 'fake/judge' && req.stream) return { text: `Resposta de ${req.model}`, usage };
      // Contrato do IMPL-006: todo veredito devolve o canário do pedido.
      if (req.system.includes('DUELO')) return { text: duelReply(req, 'A', 'A melhor'), usage };
      return { text: pointwiseReply(req, 'resolve', 'confere'), usage };
    },
  });
}

export const COMPARE = {
  mode: 'compare',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  competitorModelIds: ['fake/a', 'fake/b'],
  finalists: 2,
  // folgado: quem encerra a chamada pendurada é o CANCELAMENTO, não o timeout
  timeoutMs: 30_000,
};

export const TRAINING = {
  mode: 'training',
  theme: 'suporte ao cliente',
  stages: 2,
  datagenModelId: 'fake/gen',
  judgeModelIds: ['fake/judge'],
  referenceModelId: 'fake/ref',
  referenceJudging: true,
  contestantModelId: 'fake/a',
  basePrompt: 'Voce e um atendente de suporte. Responda com base no contexto do produto.',
  techniqueIds: ['persona', 'constraints'],
  promptOptimization: true,
  optimizerModelId: 'fake/opt',
  iterations: 2,
  holdoutRatio: 0,
  finalists: 2,
  timeoutMs: 30_000,
};

export interface Chegada {
  papel: Papel;
  /** O pedido chegou ao transporte DEPOIS de o cancelamento ser emitido. */
  depoisDoCancel: boolean;
  /** …com o sinal já abortado (o fetch real rejeita sem sair da máquina). */
  jaAbortada: boolean;
  /** Servido e cobrado pelo fake (== chamada paga). */
  servida: boolean;
}

/**
 * Transporte instrumentado: o papel `pendura` fica preso até o abort (é onde
 * o teste corta); os outros levam `atrasoMs`. Um pedido abortado no meio NÃO
 * chega ao fake — não é servido nem cobrado, como um fetch real abortado.
 */
export function transporte(fake: FakeOpenRouter, pendura: Papel | null, atrasoMs = 5) {
  const chegadas: Chegada[] = [];
  let cancelado = false;
  let avisar!: () => void;
  const alvoChegou = new Promise<void>((r) => (avisar = r));
  const fetch: FetchLike = async (url, init) => {
    if (!url.endsWith('/chat/completions')) return fake.fetch(url, init);
    const body = JSON.parse(String(init?.body ?? '{}')) as Parameters<typeof papelDe>[0];
    const c: Chegada = {
      papel: papelDe(body),
      depoisDoCancel: cancelado,
      jaAbortada: Boolean(init?.signal?.aborted),
      servida: false,
    };
    chegadas.push(c);
    if (pendura !== null && c.papel === pendura) avisar();
    await esperaAbortavel(c.papel === pendura ? 60_000 : atrasoMs, init?.signal);
    const res = await fake.fetch(url, init);
    c.servida = true;
    return res;
  };
  return {
    fetch,
    chegadas,
    alvoChegou,
    marcarCancel: (): void => {
      cancelado = true;
    },
    /** Pedidos que sairiam para o provedor depois do cancel (o limiar é 0). */
    pagasDepoisDoCancel: (): number => chegadas.filter((x) => x.depoisDoCancel && !x.jaAbortada).length,
  };
}

// ---------------------------------------------------------------------------
// Processo REAL (`prompt-builder mcp`) contra um OpenRouter falso em http local
// ---------------------------------------------------------------------------

export interface ChegadaHttp {
  t: number;
  papel: Papel;
  abortada: boolean;
  servida: boolean;
}

export async function openRouterHttp(opts: { stages?: typeof CENARIOS } = {}) {
  const fake = fakeDoPipeline(opts.stages);
  const chegadas: ChegadaHttp[] = [];
  let avisar!: () => void;
  const competidorChegou = new Promise<void>((r) => (avisar = r));
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf-8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => {
      void (async () => {
        const url = `http://127.0.0.1${req.url ?? '/'}`;
        const fechou = new AbortController();
        res.on('close', () => {
          if (!res.writableFinished) fechou.abort(new Error('cliente fechou a conexão'));
        });
        let c: ChegadaHttp | undefined;
        if (url.endsWith('/chat/completions')) {
          const parsed = JSON.parse(body) as Parameters<typeof papelDe>[0];
          c = { t: Date.now(), papel: papelDe(parsed), abortada: false, servida: false };
          chegadas.push(c);
          if (c.papel === 'competitor') avisar();
          try {
            // competidor pendura até o cliente desistir; o resto responde rápido
            await esperaAbortavel(c.papel === 'competitor' ? 60_000 : 5, fechou.signal);
          } catch {
            c.abortada = true;
            return;
          }
        }
        const r = await fake.fetch(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: body || undefined,
        });
        const text = await r.text();
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') ?? 'application/json' });
        res.end(text);
        if (c) c.servida = true;
      })();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    chegadas,
    competidorChegou,
    fake,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

export function processoMcp(dataDir: string, baseUrl: string) {
  const child = spawn(TSX, [CLI, 'mcp', '--data-dir', dataDir], {
    cwd: ROOT,
    env: {
      ...process.env,
      OPENROUTER_BASE_URL: baseUrl,
      OPENROUTER_API_KEY: KEY,
      NO_COLOR: '1',
      CLAUDECODE: '',
      CI: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const msgs: Array<{ t: number; msg: Msg }> = [];
  let buf = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const linha = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (linha) msgs.push({ t: performance.now(), msg: JSON.parse(linha) as Msg });
    }
  });
  child.stderr.on('data', (c) => (stderr += String(c)));
  const saiu = new Promise<{ code: number | null; signal: NodeJS.Signals | null; t: number }>((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal, t: performance.now() })),
  );
  const enviar = (m: Record<string, unknown>): number => {
    const t = performance.now();
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    return t;
  };
  const resposta = (id: unknown) => msgs.find((x) => x.msg.id === id);
  const aguardar = async (id: unknown, maxMs = 5_000) => {
    await ate(() => resposta(id) !== undefined, maxMs, `resposta ${String(id)}`);
    return resposta(id)!;
  };
  return { child, msgs, enviar, resposta, aguardar, saiu, stderr: () => stderr };
}

export function recordsDoDisco(dataDir: string): RunRecord[] {
  const dir = path.join(dataDir, 'runs');
  let arquivos: string[] = [];
  try {
    arquivos = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const f of arquivos) {
    try {
      out.push(JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as RunRecord);
    } catch {
      // escrita atômica: arquivo pela metade não existe; tmp é ignorado pelo filtro
    }
  }
  return out;
}

