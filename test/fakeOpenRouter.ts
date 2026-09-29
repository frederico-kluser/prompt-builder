// Transporte FALSO do OpenRouter para testes (IMPL-021). NUNCA toca a rede:
// é injetado no gateway por `createGateway({ fetch })` (instância isolada) ou
// `setDefaultGateway(createGateway({ fetch }))` (o pipeline inteiro usa a
// instância padrão). Não é um arquivo de teste (sem `.test.`): é um helper
// reutilizável pelos testes de contrato de qualquer cluster.
//
// Serve GET /models (catálogo), GET /key e POST /chat/completions — JSON ou
// SSE (quando o corpo pede `stream: true`), com `usage.cost` como o OpenRouter
// devolve de verdade. `billedUsd()` soma o `usage.cost` de toda resposta 200
// servida: é a "fatura" contra a qual o ledger é conferido.

import type { FetchLike } from '../src/openrouter.js';

export interface FakeRequest {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  /** Conveniências para rotear: modelo, system e user do pedido de chat. */
  model: string;
  system: string;
  user: string;
  stream: boolean;
  /** Modo JEV: perguntas e estado do corpo de decisão (quando for decisão). */
  questions?: Record<string, unknown>;
  state?: unknown;
}

export interface FakeUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  /**
   * O OpenRouter manda `is_byok` e `cost_details` em TODA resposta (medido
   * 2026-09-29): na não-BYOK `upstream_inference_cost` == `cost` (já contido
   * nele); na BYOK `cost` é só a taxa e o upstream foi cobrado na key do provedor.
   */
  is_byok?: boolean;
  cost_details?: {
    upstream_inference_cost?: number;
    upstream_inference_prompt_cost?: number;
    upstream_inference_completions_cost?: number;
  };
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

export interface FakeChatReply {
  /** Default 200. Diferente de 200 => corpo `bodyText` e nenhum custo. */
  status?: number;
  bodyText?: string;
  text?: string;
  /** `null` = resposta sem bloco usage. Ausente = usage default com `cost`. */
  usage?: FakeUsage | null;
  /** Erro in-band (HTTP 200 com corpo de erro). `code`/`metadata` como o OpenRouter manda. */
  error?: { message: string; code?: number | string; metadata?: Record<string, unknown> };
  /** Só SSE: chunks extras DEPOIS do frame de usage (keep-alive etc.). */
  trailing?: string[];
  /** `choices[0].finish_reason` (JSON) / chunk final de `finish_reason` (SSE). IMPL-010. */
  finishReason?: string;
  /** `choices[0].native_finish_reason` — valor cru do provedor. */
  nativeFinishReason?: string;
  /** `message.refusal` (JSON) / `delta.refusal` (SSE) — recusa declarada pelo modelo. */
  refusal?: string;
  /** Id da geração (`gen-…`) em todo chunk/no corpo — como o OpenRouter manda (IMPL-074). */
  id?: string;
  /** Campo `provider` (nome do provedor que serviu) em todo chunk/no corpo (IMPL-075). */
  provider?: string;
}

/** Modo JEV — resposta do endpoint de decisões. */
export interface FakeDecisionReply {
  /** Default 200. Diferente de 200 => corpo `bodyText` (e `headers`) e nenhum custo. */
  status?: number;
  bodyText?: string;
  /** `answers` por id de pergunta. Ausente = resposta default determinística do fake. */
  answers?: Record<string, unknown>;
  /** Snapshot devolvido em `model` (default `<pedido>-20260917`). */
  model?: string;
  provider?: string;
  /** `null` = resposta sem bloco usage. Ausente = input_tokens pelo tamanho do corpo e custo a 0,042/Mtok. */
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number } | null;
  headers?: Record<string, string>;
}

export interface FakeOpenRouterOptions {
  /** Itens CRUS de /models (formato do OpenRouter). */
  catalog?: unknown[];
  /** Modo JEV: itens CRUS de `GET /models?output_modalities=decisions`. */
  decisionCatalog?: unknown[];
  /** Modo JEV: resposta de cada decisão. `n` = índice do pedido de decisão (0-based). */
  decisions?: (req: FakeRequest, n: number) => FakeDecisionReply | Response | Promise<FakeDecisionReply | Response>;
  /** Resposta de cada chat. `n` = índice do pedido de chat (0-based). */
  chat?: (req: FakeRequest, n: number) => FakeChatReply | Response | Promise<FakeChatReply | Response>;
  /** `data` de GET /key. */
  keyData?: Record<string, unknown>;
}

export interface FakeOpenRouter {
  fetch: FetchLike;
  requests: FakeRequest[];
  chatRequests(): FakeRequest[];
  /** Modo JEV: pedidos ao endpoint de decisões. */
  decisionRequests(): FakeRequest[];
  /** Soma do `usage.cost` servido em respostas 200 (a "fatura"). */
  billedUsd(): number;
  /** Quantas respostas de chat 200 foram servidas. */
  billedCalls(): number;
}

function sse(frames: string[]): string {
  return frames.map((f) => (f.startsWith(':') ? `${f}\n\n` : `data: ${f}\n\n`)).join('');
}

export function fakeOpenRouter(opts: FakeOpenRouterOptions = {}): FakeOpenRouter {
  const requests: FakeRequest[] = [];
  let chatN = 0;
  let decisionN = 0;
  let billed = 0;
  let billedCalls = 0;

  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === 'string') body = JSON.parse(init.body) as Record<string, unknown>;
    const path = new URL(url).pathname;
    const messages = (body?.messages ?? []) as { role: string; content: unknown }[];
    // Conteúdo em PARTES (`[{ type: 'text', text, cache_control }]` — IMPL-114)
    // vira o texto concatenado: o roteamento dos testes lê texto, não a forma.
    const textOf = (c: unknown): string =>
      typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('')
          : '';
    const req: FakeRequest = {
      url,
      path,
      method,
      headers,
      body,
      model: String(body?.model ?? ''),
      system: textOf(messages.find((m) => m.role === 'system')?.content),
      user: messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n'),
      stream: body?.stream === true,
      ...(body && typeof body.questions === 'object' ? { questions: body.questions as Record<string, unknown>, state: body.state } : {}),
    };
    requests.push(req);
    if (init?.signal?.aborted) throw init.signal.reason ?? new Error('aborted');

    if (method === 'GET' && path.endsWith('/models')) {
      const decisoes = new URL(url).searchParams.get('output_modalities') === 'decisions';
      return new Response(JSON.stringify({ data: (decisoes ? opts.decisionCatalog : opts.catalog) ?? [] }), { status: 200 });
    }
    if (method === 'POST' && path.endsWith('/alpha/decisions')) {
      const n = decisionN++;
      const reply = (await opts.decisions?.(req, n)) ?? {};
      if (reply instanceof Response) return reply;
      const status = reply.status ?? 200;
      if (status !== 200) return new Response(reply.bodyText ?? '', { status, headers: reply.headers ?? {} });
      const inTok = Math.max(270, Math.ceil(JSON.stringify(body ?? {}).length / 3));
      const usage =
        reply.usage === null ? undefined : { input_tokens: inTok, output_tokens: 22, cost: inTok * 0.042e-6, ...(reply.usage ?? {}) };
      if (typeof usage?.cost === 'number') billed += usage.cost;
      billedCalls += 1;
      const answers = reply.answers ?? defaultDecisionAnswers(req.questions ?? {});
      const json: Record<string, unknown> = {
        model: reply.model ?? `${String(body?.model ?? '').replace(/^~/, '')}-20260917`,
        answers,
        id: `gen-dec-${n}`,
        provider: reply.provider ?? 'TypeSafe',
      };
      if (usage) json.usage = usage;
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'x-generation-id': `gen-dec-${n}`, 'x-provider-name': reply.provider ?? 'TypeSafe', ...(reply.headers ?? {}) },
      });
    }
    if (method === 'GET' && path.endsWith('/key')) {
      return new Response(JSON.stringify({ data: opts.keyData ?? { label: 'fake', usage: 0, limit: null } }), {
        status: 200,
      });
    }
    if (method !== 'POST' || !path.endsWith('/chat/completions')) {
      return new Response('rota desconhecida no fake', { status: 404 });
    }

    const n = chatN++;
    const reply = (await opts.chat?.(req, n)) ?? { text: 'ok' };
    if (reply instanceof Response) return reply;
    const status = reply.status ?? 200;
    if (status !== 200) return new Response(reply.bodyText ?? '', { status });

    const usage: FakeUsage | undefined =
      reply.usage === null
        ? undefined
        : (reply.usage ?? {
            prompt_tokens: 10,
            completion_tokens: 5,
            cost: 0.001,
            // Forma REAL de uma chamada não-BYOK: o upstream repete o custo que
            // JÁ está em `cost` — quem somá-lo dobra o gasto (extra#1).
            is_byok: false,
            cost_details: { upstream_inference_cost: 0.001 },
          });
    if (typeof usage?.cost === 'number') billed += usage.cost;
    billedCalls += 1;
    const text = reply.text ?? '';

    // Campos que o OpenRouter repete em TODO chunk (e no corpo JSON).
    const meta: Record<string, unknown> = {
      ...(reply.id ? { id: reply.id } : {}),
      ...(reply.provider ? { provider: reply.provider } : {}),
    };
    if (req.stream) {
      const frames: string[] = [];
      const meio = Math.ceil(text.length / 2);
      for (const pedaco of [text.slice(0, meio), text.slice(meio)]) {
        if (pedaco) frames.push(JSON.stringify({ ...meta, choices: [{ delta: { content: pedaco } }] }));
      }
      if (reply.refusal) frames.push(JSON.stringify({ ...meta, choices: [{ delta: { refusal: reply.refusal } }] }));
      if (reply.finishReason || reply.nativeFinishReason) {
        frames.push(
          JSON.stringify({
            ...meta,
            choices: [
              {
                delta: {},
                finish_reason: reply.finishReason ?? null,
                native_finish_reason: reply.nativeFinishReason ?? null,
              },
            ],
          }),
        );
      }
      if (reply.error) frames.push(JSON.stringify({ ...meta, error: reply.error }));
      if (usage) frames.push(JSON.stringify({ ...meta, choices: [], usage }));
      frames.push(...(reply.trailing ?? []));
      frames.push('[DONE]');
      return new Response(sse(frames), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    const choice: Record<string, unknown> = {
      message: { content: text, ...(reply.refusal ? { refusal: reply.refusal } : {}) },
    };
    if (reply.finishReason) choice.finish_reason = reply.finishReason;
    if (reply.nativeFinishReason) choice.native_finish_reason = reply.nativeFinishReason;
    const json: Record<string, unknown> = { ...meta, choices: [choice] };
    if (usage) json.usage = usage;
    if (reply.error) json.error = reply.error;
    return new Response(JSON.stringify(json), { status: 200 });
  };

  return {
    fetch,
    requests,
    chatRequests: () => requests.filter((r) => r.path.endsWith('/chat/completions')),
    decisionRequests: () => requests.filter((r) => r.path.endsWith('/alpha/decisions')),
    billedUsd: () => billed,
    billedCalls: () => billedCalls,
  };
}

/** Item cru de /models com preço por token (e faixas opcionais). */
export function catalogItem(
  id: string,
  prompt: number,
  completion: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    context_length: 128_000,
    pricing: { prompt: String(prompt), completion: String(completion) },
    supported_parameters: ['temperature', 'seed', 'max_tokens', 'response_format'],
    ...extra,
  };
}

/**
 * Modo JEV — respostas default de um corpo de decisão: noul 0,9; choice na 1ª
 * opção com 0,8 (resto dividido), confidence 0,7; score no último nível com 0,9.
 */
export function defaultDecisionAnswers(questions: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [qid, raw] of Object.entries(questions)) {
    const q = (raw ?? {}) as { type?: string; criteria?: unknown };
    if (q.type === 'noul') out[qid] = { type: 'noul', noul: 0.9 };
    else if (q.type === 'choice') {
      const keys = Object.keys((q.criteria ?? {}) as Record<string, unknown>);
      const resto = keys.length > 1 ? 0.2 / (keys.length - 1) : 0;
      out[qid] = {
        type: 'choice',
        choice: keys[0],
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? (keys.length > 1 ? 0.8 : 1) : resto])),
        confidence: 0.7,
      };
    } else if (q.type === 'score') {
      const L = Array.isArray(q.criteria) ? q.criteria.length : 1;
      const probs = Object.fromEntries(Array.from({ length: L }, (_, i) => [String(i), i === L - 1 ? (L > 1 ? 0.9 : 1) : L > 1 ? 0.1 / (L - 1) : 0]));
      out[qid] = { type: 'score', score: Object.entries(probs).reduce((s, [k, p]) => s + Number(k) * p, 0), probabilities: probs, confidence: 0.8 };
    }
  }
  return out;
}

/** Espera nula para o backoff (injeta em `createGateway({ sleep })`). */
export const noSleep = async (): Promise<void> => undefined;
