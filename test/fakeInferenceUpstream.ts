// Upstream FALSO de inferência (OpenAI/OpenRouter-compatível) para os testes do
// proxy local (IMPL-037). Um servidor HTTP no loopback que responde
// `POST /api/v1/chat/completions` com um stream SSE SINTÉTICO — texto, chamada
// de tool ou erro — e registra cada requisição (headers + corpo) para os testes
// afirmarem o que o provedor "viu" (ex.: a key REAL no Authorization). Nunca
// fala com o OpenRouter: nada é cobrado.
import http from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

export interface FakeUpstreamRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  /** Mensagens do corpo JSON (quando houver). */
  messages: Array<{ role?: string; content?: unknown; tool_calls?: unknown }>;
}

export type FakeReply =
  | { text: string; cost?: number; delayMs?: number; id?: string }
  | { toolCall: { name: string; args: Record<string, unknown> }; cost?: number; id?: string }
  | { status: number; error: string }
  /** Chunks crus (já com `data: `), com atraso entre eles — testa streaming real. */
  | { rawChunks: string[]; gapMs: number }
  /**
   * Chunks crus com um TTFT: o 1º sai depois de `ttftMs` (o "modelo pensando") e
   * o resto sai de uma vez (método do LiteLLM: payload de 1.000 chunks).
   */
  | { burst: string[]; ttftMs: number };

export interface FakeUpstream {
  /** Base no formato do OpenRouter: `http://127.0.0.1:<porta>/api/v1`. */
  baseUrl: string;
  port: number;
  requests: FakeUpstreamRequest[];
  /** Respostas cuja conexão o CLIENTE (o proxy) fechou antes do fim. */
  aborted(): number;
  /** Pico de chamadas de chat simultâneas vistas pelo upstream. */
  maxConcurrent(): number;
  /** Soma do `usage.cost` SERVIDO nas respostas de chat completas (a "fatura" do fake). */
  billedUsd(): number;
  /** `usage.cost` servido por id de geração (o que `GET /generation` lança por default). */
  generations: Map<string, number>;
  close(): Promise<void>;
}

export interface FakeUpstreamOptions {
  /**
   * Lançamento de `GET /api/v1/generation?id=` (a "fatura" por geração). Recebe o
   * id e o custo SERVIDO; devolve o `total_cost` a lançar, ou `null` = 404.
   * Default: lança exatamente o custo servido (404 para id desconhecido).
   */
  invoice?: (id: string, servedUsd: number | undefined) => number | null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function chunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/** Os chunks SSE de uma resposta (o ÚLTIMO traz `usage.cost`, como o OpenRouter). */
export function sseChunks(
  reply: Exclude<FakeReply, { status: number } | { rawChunks: string[] } | { burst: string[] }>,
  model = 'openai/gpt-4o-mini',
): string[] {
  const base = { id: reply.id ?? 'gen-fake-037', object: 'chat.completion.chunk', created: 1_790_000_000, model };
  const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15, cost: reply.cost ?? 0.0001 };
  if ('toolCall' in reply) {
    return [
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [{ index: 0, id: 'call_fake_1', type: 'function', function: { name: reply.toolCall.name, arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(reply.toolCall.args) } }] }, finish_reason: null }],
      }),
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
      chunk({ ...base, choices: [], usage }),
      'data: [DONE]\n\n',
    ];
  }
  return [
    chunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] }),
    chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    chunk({ ...base, choices: [], usage }),
    'data: [DONE]\n\n',
  ];
}

/**
 * Sobe o upstream falso. `script(req, n)` decide a resposta da n-ésima chamada
 * (0-based) de chat; default = texto "ok".
 */
export async function startFakeUpstream(
  script: (req: FakeUpstreamRequest, n: number) => FakeReply = () => ({ text: 'ok' }),
  opts: FakeUpstreamOptions = {},
): Promise<FakeUpstream> {
  const requests: FakeUpstreamRequest[] = [];
  const generations = new Map<string, number>();
  let chats = 0;
  let aborted = 0;
  let active = 0;
  let peak = 0;
  let billed = 0;
  const server = http.createServer((req, res) => {
    res.on('close', () => {
      if (!res.writableFinished) aborted++;
    });
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => {
      body += d;
    });
    req.on('end', () => {
      let messages: FakeUpstreamRequest['messages'] = [];
      try {
        messages = (JSON.parse(body) as { messages?: FakeUpstreamRequest['messages'] }).messages ?? [];
      } catch {
        /* corpo não-JSON */
      }
      const rec: FakeUpstreamRequest = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body, messages };
      requests.push(rec);
      void (async () => {
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [] }));
          return;
        }
        // Auditoria da fatura (IMPL-035): o `total_cost` lançado por geração.
        if (req.method === 'GET' && req.url?.startsWith('/api/v1/generation')) {
          const id = new URL(req.url, 'http://fake.local').searchParams.get('id') ?? '';
          const served = generations.get(id);
          const total = opts.invoice ? opts.invoice(id, served) : (served ?? null);
          if (total === null) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 404, message: `Generation ${id} not found` } }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { id, total_cost: total, streamed: true } }));
          return;
        }
        if (req.method !== 'POST' || !req.url?.startsWith('/api/v1/chat/completions')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 404, message: 'rota inexistente no upstream falso' } }));
          return;
        }
        const reply = script(rec, chats++);
        active++;
        peak = Math.max(peak, active);
        res.on('close', () => {
          active--;
        });
        if ('status' in reply) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: reply.status, message: reply.error } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'set-cookie': 'cf=abc' });
        if ('rawChunks' in reply) {
          for (const c of reply.rawChunks) {
            if (res.destroyed) return;
            res.write(c);
            await sleep(reply.gapMs);
          }
          res.end();
          return;
        }
        if ('burst' in reply) {
          await sleep(reply.ttftMs);
          if (res.destroyed) return;
          for (const c of reply.burst) res.write(c);
          res.end();
          return;
        }
        if ('delayMs' in reply && reply.delayMs) await sleep(reply.delayMs);
        if (res.destroyed) return;
        for (const c of sseChunks(reply)) res.write(c);
        res.end();
        const served = reply.cost ?? 0.0001;
        billed += served;
        const genId = reply.id ?? 'gen-fake-037';
        generations.set(genId, (generations.get(genId) ?? 0) + served);
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    port,
    requests,
    aborted: () => aborted,
    maxConcurrent: () => peak,
    billedUsd: () => Math.round(billed * 1e9) / 1e9,
    generations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * Payload SSE de `n` chunks de conteúdo + o chunk de usage (com `cost`) + `[DONE]`
 * — o formato do OpenRouter, para medir o overhead do proxy de custo.
 */
export function manyChunks(n: number, cost: number, id = 'gen-fake-035-burst'): string[] {
  const base = { id, object: 'chat.completion.chunk', created: 1_790_000_000, model: 'openai/gpt-4o-mini' };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(chunk({ ...base, choices: [{ index: 0, delta: { content: `t${i} ` }, finish_reason: null }] }));
  }
  out.push(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
  out.push(chunk({ ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: n, total_tokens: 50 + n, cost } }));
  out.push('data: [DONE]\n\n');
  return out;
}

/** Script de agente: 1ª chamada roda `command` no bash; a seguinte encerra com texto. */
export function bashThenDone(command: string): (req: FakeUpstreamRequest, n: number) => FakeReply {
  return (req) => {
    const sawTool = req.messages.some((m) => m.role === 'tool');
    return sawTool ? { text: 'feito', cost: 0.0002 } : { toolCall: { name: 'bash', args: { command } }, cost: 0.0003 };
  };
}
