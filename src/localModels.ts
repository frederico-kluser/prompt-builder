// Modelos LOCAIS (2026-10-20): o prompt-builder mede e evolui modelos que rodam na própria máquina,
// lado a lado com os da nuvem e sem proxy externo:
//   - DECISÕES: um `llama-server` com a API SystemOne/TypeSafe (`POST /v1/systemone {state, questions}`
//     → `{answers, usage}`), ex.: o Laya — entra no modo JEV como `models.decision`;
//   - CHAT: um endpoint OpenAI-compatível (`POST /chat/completions`), ex.: o K2 servido pelo app — entra
//     como competidor, contestante ou qualquer papel de chat.
//
// Como funciona: o gateway (`openrouter.ts`) aceita um `fetch` injetável; este módulo devolve um
// `fetch` que intercepta SÓ o que é de um modelo local (pelo `model` do corpo ou pela URL de catálogo/
// geração) e passa todo o resto, intacto, para o transporte de verdade. Assim o limitador, o orçamento,
// os timeouts e o parser de streaming do gateway valem igual para os locais.
//
// Regras:
//   - id de modelo local começa por `local/` (nunca sombreia um id da nuvem);
//   - custo 0 (`usage.cost = 0`) e id de geração `local-…`, que a consulta de geração responde aqui;
//   - UMA chamada por vez por endpoint (um modelo, uma GPU): a fila é deste módulo, porque o limitador
//     global do gateway é para o OpenRouter;
//   - contagem de tokens de chat é ESTIMATIVA (caracteres/4) quando o servidor local não devolve `usage`.
//
// Configuração (Node; o web não tem modelos locais):
//   PB_LOCAL_MODELS="local/laya-ptes=http://127.0.0.1:18081"        decisões (llama-server)
//   PB_LOCAL_CHAT="local/k2-horizon=http://127.0.0.1:18100/v1"        chat sem chave
//   PB_LOCAL_CHAT="local/k2-horizon=@/caminho/endpoint.json"          chat com {url, apiKey, model} (relido a cada chamada)
//   PB_LOCAL_CHAT_CONTEXT=16384                                       janela anunciada no catálogo
//   PB_LOCAL_API_KEY=…                                                Bearer para os endpoints de decisão

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FetchLike } from './openrouter.js';

type Env = Record<string, string | undefined>;

export const LOCAL_MODEL_PREFIX = 'local/';
export const DEFAULT_LOCAL_CHAT_CONTEXT = 16384;

export type LocalModelKind = 'chat' | 'decision';

export interface LocalModel {
  id: string;
  kind: LocalModelKind;
  /** `http(s)://…` (base do endpoint) ou `@arquivo.json` (chat: `{url, apiKey?, model?}`). */
  target: string;
}

export interface LocalModelsRegistry {
  models: LocalModel[];
  /** Bearer dos endpoints de DECISÃO (`PB_LOCAL_API_KEY`). */
  apiKey?: string;
  /** Janela anunciada no catálogo para os modelos de chat. */
  chatContext: number;
  /** Entradas recusadas na leitura (id sem `local/`, alvo vazio…). */
  issues: string[];
}

export interface ResolvedEndpoint {
  url: string;
  apiKey: string;
  model: string;
}

function splitPairs(raw: string | undefined): Array<[string, string]> {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf('=');
      return i < 0 ? [s, ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
    });
}

/** Lê os modelos locais do ambiente. Sem variável = registro vazio (o gateway fica como sempre). */
export function parseLocalModelsEnv(env: Env): LocalModelsRegistry {
  const models: LocalModel[] = [];
  const issues: string[] = [];
  const seen = new Set<string>();
  const add = (kind: LocalModelKind, id: string, target: string): void => {
    if (!id.startsWith(LOCAL_MODEL_PREFIX) || id.length <= LOCAL_MODEL_PREFIX.length) {
      issues.push(`${id || '(vazio)'}: id de modelo local precisa começar por "${LOCAL_MODEL_PREFIX}"`);
      return;
    }
    if (!target) {
      issues.push(`${id}: sem endereço (use id=http://host:porta ou id=@arquivo.json)`);
      return;
    }
    if (!/^https?:\/\//i.test(target) && !(kind === 'chat' && target.startsWith('@'))) {
      issues.push(`${id}: endereço inválido "${target}"`);
      return;
    }
    if (seen.has(id)) {
      issues.push(`${id}: declarado mais de uma vez (vale o primeiro)`);
      return;
    }
    seen.add(id);
    models.push({ id, kind, target: target.startsWith('@') ? target : target.replace(/\/+$/, '') });
  };
  for (const [id, target] of splitPairs(env.PB_LOCAL_MODELS)) add('decision', id, target);
  for (const [id, target] of splitPairs(env.PB_LOCAL_CHAT)) add('chat', id, target);
  const ctx = Number((env.PB_LOCAL_CHAT_CONTEXT ?? '').trim() || NaN);
  const apiKey = (env.PB_LOCAL_API_KEY ?? '').trim();
  return {
    models,
    ...(apiKey ? { apiKey } : {}),
    chatContext: Number.isFinite(ctx) && ctx > 0 ? Math.floor(ctx) : DEFAULT_LOCAL_CHAT_CONTEXT,
    issues,
  };
}

/** `@arquivo` → `{url, apiKey, model}` relido a cada chamada (o servidor local pode reiniciar com outra porta). */
export function resolveLocalEndpoint(model: LocalModel, readFile: (p: string) => string = (p) => readFileSync(p, 'utf8')): ResolvedEndpoint {
  if (!model.target.startsWith('@')) return { url: model.target, apiKey: '', model: '' };
  const ep = JSON.parse(readFile(model.target.slice(1))) as { url?: unknown; apiKey?: unknown; model?: unknown };
  if (typeof ep.url !== 'string' || !ep.url) throw new Error(`${model.id}: ${model.target.slice(1)} sem "url"`);
  return {
    url: ep.url.replace(/\/+$/, ''),
    apiKey: typeof ep.apiKey === 'string' ? ep.apiKey : '',
    model: typeof ep.model === 'string' ? ep.model : '',
  };
}

/** Entradas de catálogo (forma do `GET /models` do OpenRouter): grátis, sem `reasoning`. */
export function localCatalogEntries(reg: LocalModelsRegistry, kind: LocalModelKind): Array<Record<string, unknown>> {
  return reg.models
    .filter((m) => m.kind === kind)
    .map((m) =>
      kind === 'decision'
        ? {
            id: m.id,
            name: `${m.id} (local · llama-server)`,
            context_length: 1024,
            pricing: { prompt: '0', completion: '0', request: '0' },
            architecture: { input_modalities: ['text'], output_modalities: ['decisions'] },
          }
        : {
            id: m.id,
            name: `${m.id} (local)`,
            context_length: reg.chatContext,
            pricing: { prompt: '0', completion: '0', request: '0' },
            architecture: { input_modalities: ['text'], output_modalities: ['text'] },
            supported_parameters: ['max_tokens', 'temperature', 'tools', 'tool_choice', 'response_format', 'structured_outputs', 'stop'],
          },
    );
}

/** Estimativa de tokens (caracteres/4) — só quando o servidor local não devolve `usage`. */
export const estimateTokens = (value: unknown): number => Math.ceil(JSON.stringify(value ?? '').length / 4);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> | undefined {
  if (!init || typeof init.body !== 'string') return undefined;
  try {
    const parsed = JSON.parse(init.body) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export interface LocalModelsFetchDeps {
  readFile?: (path: string) => string;
  newId?: () => string;
  now?: () => number;
}

/**
 * O `fetch` com os modelos locais. Registro vazio = devolve o próprio `base` (byte a byte o de sempre).
 */
export function createLocalModelsFetch(base: FetchLike, reg: LocalModelsRegistry, deps: LocalModelsFetchDeps = {}): FetchLike {
  if (reg.models.length === 0) return base;
  const byId = new Map(reg.models.map((m) => [m.id, m] as const));
  const newId = deps.newId ?? (() => `local-${randomUUID()}`);
  const now = deps.now ?? (() => Date.now());
  const queues = new Map<string, Promise<unknown>>();
  const serialized = <T>(key: string, job: () => Promise<T>): Promise<T> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(job, job);
    queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };

  async function localChat(model: LocalModel, payload: Record<string, unknown>, init: RequestInit): Promise<Response> {
    const t0 = now();
    const ep = resolveLocalEndpoint(model, deps.readFile);
    const result = await serialized(ep.url, async () => {
      const r = await base(`${ep.url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(ep.apiKey ? { authorization: `Bearer ${ep.apiKey}` } : {}) },
        body: JSON.stringify({ ...payload, ...(ep.model ? { model: ep.model } : {}), stream: false }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const text = await r.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { error: { message: text.slice(0, 300) } };
      }
      return { status: r.status, json: parsed };
    });
    const choices = result.json.choices as Array<Record<string, unknown>> | undefined;
    if (result.status !== 200 || !Array.isArray(choices) || choices.length === 0) {
      return json(result.status === 200 ? 502 : result.status, {
        error: { message: `modelo local ${model.id}: ${JSON.stringify(result.json).slice(0, 300)}` },
      });
    }
    const id = newId();
    const choice = choices[0] ?? {};
    const message = (choice.message ?? {}) as Record<string, unknown>;
    const reported = result.json.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
    const usage: Record<string, number> = {
      prompt_tokens: Number(reported?.prompt_tokens) || estimateTokens(payload.messages),
      completion_tokens: Number(reported?.completion_tokens) || estimateTokens([message.content, message.tool_calls]),
      cost: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const headers = { 'x-generation-id': id, 'x-provider-name': 'local', 'x-local-latency-ms': String(now() - t0) };
    if (!payload.stream) {
      return json(200, { ...result.json, id, model: payload.model, provider: 'local', usage }, headers);
    }
    // O gateway pede streaming por padrão: a resposta inteira sai como UM turno SSE (+ usage, + [DONE]).
    const created = Math.floor(now() / 1000);
    const chunk = (choicesChunk: unknown[], extra: Record<string, unknown> = {}): string =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: payload.model, provider: 'local', choices: choicesChunk, ...extra })}\n\n`;
    const delta: Record<string, unknown> = { role: 'assistant' };
    if (typeof message.content === 'string' && message.content) delta.content = message.content;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      delta.tool_calls = (message.tool_calls as unknown[]).map((tc, index) => ({ index, ...(tc as Record<string, unknown>) }));
    }
    const sse =
      chunk([{ index: 0, delta, finish_reason: null }]) +
      chunk([{ index: 0, delta: {}, finish_reason: (choice.finish_reason as string | undefined) ?? 'stop' }]) +
      chunk([], { usage }) +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
  }

  async function localDecision(model: LocalModel, payload: Record<string, unknown>, init: RequestInit): Promise<Response> {
    const t0 = now();
    const ep = resolveLocalEndpoint(model, deps.readFile);
    const result = await serialized(ep.url, async () => {
      const r = await base(`${ep.url}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(reg.apiKey ? { authorization: `Bearer ${reg.apiKey}` } : {}) },
        body: JSON.stringify({ state: payload.state, questions: payload.questions }),
        ...(init.signal ? { signal: init.signal } : {}),
      });
      const text = await r.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      return { status: r.status, json: parsed };
    });
    if (result.status !== 200 || !result.json.answers) {
      return json(result.status === 200 ? 502 : result.status, {
        error: { message: `modelo local ${model.id}: ${JSON.stringify(result.json).slice(0, 300)}` },
      });
    }
    const id = newId();
    const usage = result.json.usage as { input_tokens?: number } | undefined;
    return json(
      200,
      {
        id,
        model: payload.model,
        provider: 'local',
        answers: result.json.answers,
        usage: { input_tokens: Number(usage?.input_tokens) || 0, output_tokens: 0, cost: 0 },
        latency_ms: now() - t0,
      },
      { 'x-generation-id': id, 'x-provider-name': 'local' },
    );
  }

  async function mergedCatalog(input: string, init: RequestInit | undefined, kind: LocalModelKind): Promise<Response> {
    let upstream: { data?: unknown[] } & Record<string, unknown> = { data: [] };
    try {
      const r = await base(input, init);
      if (r.ok) upstream = (await r.json()) as typeof upstream;
    } catch {
      // Sem rede: o catálogo sai só com os locais (medir local não depende da nuvem).
    }
    const data = Array.isArray(upstream.data) ? upstream.data : [];
    return json(200, { ...upstream, data: [...data, ...localCatalogEntries(reg, kind)] });
  }

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let url: URL | undefined;
    try {
      url = new URL(input);
    } catch {
      return base(input, init);
    }
    if (method === 'POST' && url.pathname.endsWith('/chat/completions')) {
      const payload = bodyOf(init);
      const model = typeof payload?.model === 'string' ? byId.get(payload.model) : undefined;
      if (payload && model?.kind === 'chat') return localChat(model, payload, init ?? {});
      return base(input, init);
    }
    if (method === 'POST' && url.pathname.endsWith('/decisions')) {
      const payload = bodyOf(init);
      const model = typeof payload?.model === 'string' ? byId.get(payload.model) : undefined;
      if (payload && model?.kind === 'decision') return localDecision(model, payload, init ?? {});
      return base(input, init);
    }
    if (method === 'GET' && url.pathname.endsWith('/models')) {
      const modality = url.searchParams.get('output_modalities');
      if (modality === 'decisions' && reg.models.some((m) => m.kind === 'decision')) return mergedCatalog(input, init, 'decision');
      if (!modality && reg.models.some((m) => m.kind === 'chat')) return mergedCatalog(input, init, 'chat');
      return base(input, init);
    }
    if (method === 'GET' && /\/generation(\/|$)/.test(url.pathname) && (url.searchParams.get('id') ?? '').startsWith('local-')) {
      return json(200, {
        data: { id: url.searchParams.get('id'), total_cost: 0, provider_name: 'local', cancelled: false, native_tokens_completion: 0 },
      });
    }
    return base(input, init);
  };
}

/** Saúde de um endpoint local (para `prompt-builder local --check`). Nunca lança. */
export async function checkLocalModel(
  model: LocalModel,
  reg: LocalModelsRegistry,
  f: FetchLike,
  timeoutMs = 3000,
): Promise<{ id: string; ok: boolean; status?: number; error?: string; url?: string }> {
  let ep: ResolvedEndpoint;
  try {
    ep = resolveLocalEndpoint(model);
  } catch (err) {
    return { id: model.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const probe = model.kind === 'decision' ? `${ep.url}/health` : `${ep.url}/models`;
    const key = model.kind === 'decision' ? reg.apiKey : ep.apiKey;
    const r = await f(probe, { method: 'GET', headers: key ? { authorization: `Bearer ${key}` } : {}, signal: controller.signal });
    return { id: model.id, ok: r.ok, status: r.status, url: ep.url };
  } catch (err) {
    return { id: model.id, ok: false, url: ep.url, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
