// Contratos do servidor MCP moderno — IMPL-084 (R-13:REC-2), IMPL-085
// (R-13:REC-6) e IMPL-086 (R-13:REC-5):
//
//   • matriz de eras: initialize nunca ecoa versão não suportada (resposta
//     legacy lista as suportadas; era moderna leva -32022 com os 2 campos de
//     data), server/discover sempre disponível com as duas revisões;
//   • tools com title + as 4 anotações honestas e inputSchema ESTRITO
//     (campo desconhecido rejeitado com sugestão, erros sem path absoluto);
//   • sucesso traz structuredContent + espelho COMPACTO; get_result resume por
//     padrão (≤ 5 mil tokens na heurística de 3,5 chars/token), pagina por
//     cursor e devolve resumo + referência quando o record é grande.
//
// Suíte de contrato sem rede e sem gasto (< 30 s).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import {
  HARD_RESULT_TOKENS,
  LATEST_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  McpSession,
  SOFT_RESULT_TOKENS,
  SUPPORTED_PROTOCOL_VERSIONS,
  UNSUPPORTED_PROTOCOL_VERSION,
  callTool,
  estimateTokens,
  type McpTool,
  type ToolCallResult,
} from '../src/cli/commands/mcp.js';
import { getDataDir, saveRun, setDataDir } from '../src/storage.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import { KEY, cenarios, fakeDoPipeline, transporte } from './mcpHarness.js';
import { noSleep } from './fakeOpenRouter.js';

type Msg = Record<string, unknown> & {
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: Record<string, unknown> };
};

function novaSessao(tools?: readonly McpTool[]): {
  session: McpSession;
  out: Msg[];
  resposta: (id: unknown) => Msg | undefined;
} {
  const out: Msg[] = [];
  const session = new McpSession({
    write: (m) => out.push(m as Msg),
    log: () => undefined,
    tools,
  });
  return {
    session,
    out,
    resposta: (id) => out.find((m) => m.id === id),
  };
}

function pedir(s: ReturnType<typeof novaSessao>, id: unknown, method: string, params?: unknown): Msg {
  s.session.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  const r = s.resposta(id);
  if (!r) throw new Error(`sem resposta para ${method}`);
  return r;
}

const ABS_PATH_RE = /(?:\/home\/|\/Users\/|\/tmp\/|[A-Z]:\\)/u;

// ---------------------------------------------------------------------------
// IMPL-084 — negociação dual-era
// ---------------------------------------------------------------------------

describe('IMPL-084 — matriz de eras (initialize/discover/-32022)', () => {
  it('initialize de versão suportada/aceita ecoa a pedida (nunca "1999-01-01")', () => {
    const s = novaSessao();
    for (const versao of [...SUPPORTED_PROTOCOL_VERSIONS, ...LEGACY_PROTOCOL_VERSIONS]) {
      const r = pedir(s, versao, 'initialize', { protocolVersion: versao, capabilities: {} });
      expect(r.result?.protocolVersion).toBe(versao);
      expect(r.error).toBeUndefined();
    }
  });

  it('initialize "1999-01-01" (legacy): NÃO ecoa — responde a mais recente implementada listando as suportadas', () => {
    const s = novaSessao();
    const r = pedir(s, 1, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    expect(r.error).toBeUndefined();
    expect(r.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(r.result?.protocolVersion).not.toBe('1999-01-01');
    expect(r.result?.supportedVersions).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
  });

  it('pedido moderno (_meta) com versão não suportada → -32022 com data.supported e data.requested', () => {
    const s = novaSessao();
    const r = pedir(s, 1, 'initialize', {
      protocolVersion: '1999-01-01',
      _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' },
    });
    expect(r.result).toBeUndefined();
    expect(r.error?.code).toBe(UNSUPPORTED_PROTOCOL_VERSION);
    expect(r.error?.data?.supported).toEqual([...SUPPORTED_PROTOCOL_VERSIONS]);
    expect(r.error?.data?.requested).toBe('1999-01-01');
  });

  it('server/discover funciona ANTES e DEPOIS do initialize e lista as duas revisões', () => {
    const s = novaSessao();
    for (const [i, depois] of [false, true].entries()) {
      if (depois) pedir(s, 'init', 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
      const r = pedir(s, `disc-${i}`, 'server/discover');
      expect(r.error).toBeUndefined();
      expect(r.result?.resultType).toBe('complete');
      expect(r.result?.supportedVersions).toEqual(['2026-07-28', '2025-11-25']);
      const meta = r.result?._meta as Record<string, unknown>;
      expect(meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'prompt-builder' });
      expect(r.result?.capabilities).toMatchObject({ tools: {} });
    }
  });

  it('ping respondido em < 200 ms durante um tools/call em curso (laço nunca espera a ferramenta)', async () => {
    let soltar: () => void = () => undefined;
    const trava = new Promise<void>((r) => (soltar = r));
    const lenta: McpTool = {
      name: 'lenta',
      description: 'ferramenta de teste que segura a resposta',
      inputSchema: { type: 'object' },
      run: async () => {
        await trava;
        return { ok: true };
      },
    };
    const s = novaSessao([lenta]);
    s.session.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'lenta', arguments: {} } }));
    // a ferramenta está em voo; o ping tem que sair na hora
    const t0 = performance.now();
    const r = pedir(s, 'ping', 'ping');
    const ms = performance.now() - t0;
    expect(r.result).toEqual({});
    expect(ms).toBeLessThan(200);
    soltar();
  });
});

// ---------------------------------------------------------------------------
// IMPL-085 — anotações honestas + inputSchema estrito
// ---------------------------------------------------------------------------

describe('IMPL-085 — anotações e inputSchema das tools', () => {
  const listaTools = (): Array<Record<string, unknown>> => {
    const s = novaSessao();
    const r = pedir(s, 1, 'tools/list');
    return (r.result?.tools ?? []) as Array<Record<string, unknown>>;
  };

  it('todas as tools declaram title + as 4 anotações (0 sem anotação)', () => {
    const tools = listaTools();
    expect(tools.length).toBeGreaterThanOrEqual(8);
    for (const t of tools) {
      const a = (t.annotations ?? {}) as Record<string, unknown>;
      expect(typeof a.title, `title de ${String(t.name)}`).toBe('string');
      for (const dica of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        expect(typeof a[dica], `${dica} de ${String(t.name)}`).toBe('boolean');
      }
      expect(t.title).toBe(a.title);
    }
  });

  it('tabela honesta: readOnly não é auto-aprovação e run_agent_benchmark se destaca como destrutiva', () => {
    const porNome = new Map(listaTools().map((t) => [t.name, (t.annotations ?? {}) as Record<string, boolean>]));
    const esperado: Array<[string, boolean, boolean, boolean, boolean]> = [
      // name, readOnly, destructive, idempotent, openWorld
      ['list_models', true, false, true, true],
      ['estimate_cost', true, false, true, true],
      ['read_docs', true, false, true, false],
      ['get_result', true, false, true, false],
      ['get_agent_dossier', true, false, true, false],
      ['run_status', true, false, true, false],
      ['run_benchmark', false, false, false, true],
      ['train_prompt', false, false, false, true],
      ['start_run', false, false, true, true],
      ['cancel_run', false, true, true, false],
      ['run_agent_benchmark', false, true, false, true],
    ];
    for (const [nome, ro, de, id, ow] of esperado) {
      const a = porNome.get(nome);
      expect(a, `tool ${nome} ausente`).toBeDefined();
      expect({ nome, readOnlyHint: a!.readOnlyHint, destructiveHint: a!.destructiveHint, idempotentHint: a!.idempotentHint, openWorldHint: a!.openWorldHint })
        .toEqual({ nome, readOnlyHint: ro, destructiveHint: de, idempotentHint: id, openWorldHint: ow });
    }
  });

  it('inputSchema é estruturado e FECHADO (additionalProperties: false) em toda tool daqui', () => {
    for (const t of listaTools()) {
      const schema = (t.inputSchema ?? {}) as Record<string, unknown>;
      expect(schema.type, `inputSchema de ${String(t.name)}`).toBe('object');
      expect(schema.additionalProperties, `inputSchema de ${String(t.name)} aberto`).toBe(false);
      expect(Object.keys((schema.properties ?? {}) as object).length).toBeGreaterThan(0);
    }
    const getResult = listaTools().find((t) => t.name === 'get_result');
    expect(Object.keys((getResult?.inputSchema as { properties: object }).properties)).toEqual(
      expect.arrayContaining(['id', 'kind', 'detail', 'cursor', 'limit']),
    );
  });

  it('campo desconhecido é REJEITADO com sugestão do mais parecido (nunca engolido)', async () => {
    const r = await callTool('list_models', { searche: 'gpt' });
    expect(r?.isError).toBe(true);
    const texto = r?.content[0]?.text ?? '';
    expect(texto).toMatch(/campo desconhecido "searche"/u);
    expect(texto).toContain('quis dizer "search"');
    expect(texto).toContain('limit');
  });

  it('erros de validação saem sem caminho absoluto e sem eco de valor', async () => {
    const r = await callTool('get_result', { id: 123, detail: 'mega' });
    expect(r?.isError).toBe(true);
    const texto = r?.content[0]?.text ?? '';
    expect(texto).not.toMatch(ABS_PATH_RE);
    expect(texto).not.toContain('123');
  });

  it('erros de DISCO (id/dossiê inexistente, tópico desconhecido) também saem sem caminho absoluto', async () => {
    const id = '11111111-0000-4000-8000-0000000000ff'; // formato válido, nunca gravado
    const respostas = await Promise.all([
      callTool('get_result', { id }),
      callTool('get_agent_dossier', { runId: id, stageIndex: 0, contestantId: 'x' }),
      callTool('read_docs', { topic: '../../etc/passwd' }),
    ]);
    for (const r of respostas) {
      const texto = (r as ToolCallResult).content[0]?.text ?? '';
      expect(texto).not.toMatch(ABS_PATH_RE);
    }
  });
});

// ---------------------------------------------------------------------------
// IMPL-086 — structuredContent + espelho compacto + teto de tokens
// ---------------------------------------------------------------------------

describe('IMPL-086 — saídas (structuredContent, compacto, resumo/paginação)', () => {
  let tmp: string;
  let anterior: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-mcp-out-'));
    anterior = getDataDir();
    setDataDir(tmp);
  });
  afterEach(() => {
    setDataDir(anterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  function recordGrande(id: string, etapas: number, charsPorEtapa: number): RunRecord {
    return {
      id,
      status: 'aborted',
      stoppedReason: 'cancelled',
      mode: 'compare',
      config: { theme: 'tema', stages: etapas, budgetUsd: 5 } as unknown as RunConfig,
      contestants: [{ id: 'a', modelId: 'fake/a' }, { id: 'b', modelId: 'fake/b' }],
      stages: Array.from({ length: etapas }, (_, index) => ({
        index,
        spec: {
          question: `pergunta ${index}`,
          productContext: 'ctx',
          maxTokens: 100,
          rubric: '',
        },
        responses: [
          { contestantId: 'a', text: 'x'.repeat(charsPorEtapa), status: 'ok' },
          { contestantId: 'b', text: 'y'.repeat(charsPorEtapa), status: 'ok' },
        ],
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z',
      })),
      scoreboard: { a: 0.5, b: 0.4 },
      totalCostUsd: 0.02,
      startedAt: '2026-01-01T00:00:00.000Z',
    } as unknown as RunRecord;
  }

  it('sucesso com outputSchema traz structuredContent + o MESMO JSON espelhado em texto COMPACTO', async () => {
    const id = '11111111-0000-4000-8000-000000000001';
    await saveRun(recordGrande(id, 2, 50));
    const r = (await callTool('get_result', { id })) as ToolCallResult;
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toBeDefined();
    const texto = r.content[0].text;
    // espelho exato + compacto (0 espaços após ':' e ',' — sem quebra de linha)
    expect(texto).toBe(JSON.stringify(r.structuredContent));
    expect(texto).not.toContain('\n');
  });

  it('get_result POR PADRÃO fica ≤ 5 mil tokens mesmo com record de 40 etapas × texto grande', async () => {
    const id = '11111111-0000-4000-8000-000000000002';
    await saveRun(recordGrande(id, 40, 2000)); // ~160 kB de record
    const r = (await callTool('get_result', { id })) as ToolCallResult;
    const texto = r.content[0].text;
    expect(estimateTokens(texto)).toBeLessThanOrEqual(5000);
    const out = JSON.parse(texto) as Record<string, unknown>;
    expect(out.kind).toBe('run');
    expect(out.detail).toBe('summary');
    expect(out.status).toBe('aborted');
    expect(out.stageCount).toBe(40);
    expect((out.stages as unknown[]).length).toBe(5);
    expect(out.hasMore).toBe(true);
    // referência ao record em disco: caminho RELATIVO + resource link file://
    expect(out.ref).toMatchObject({ file: `runs/${id}.json` });
    expect(String((out.ref as { uri: string }).uri)).toMatch(/^file:\/\//u);
  });

  it('paginação por cursor/limit fatia as etapas; cursor inválido é erro legível', async () => {
    const id = '11111111-0000-4000-8000-000000000003';
    await saveRun(recordGrande(id, 7, 30));
    const p1 = JSON.parse(((await callTool('get_result', { id, limit: 3 })) as ToolCallResult).content[0].text) as {
      stages: { index: number }[];
      nextCursor: string | null;
    };
    expect(p1.stages.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(p1.nextCursor).toBe('3');
    const p2 = JSON.parse(
      ((await callTool('get_result', { id, cursor: '3', limit: 3 })) as ToolCallResult).content[0].text,
    ) as { stages: { index: number }[]; hasMore: boolean };
    expect(p2.stages.map((e) => e.index)).toEqual([3, 4, 5]);
    expect(p2.hasMore).toBe(true);
    const ruim = (await callTool('get_result', { id, cursor: '../../etc' })) as ToolCallResult;
    expect(ruim.isError).toBe(true);
    expect(ruim.content[0].text).toMatch(/cursor/u);
    expect(ruim.content[0].text).not.toMatch(ABS_PATH_RE);
  });

  it('detail:"full" devolve o record pequeno inteiro; record grande vira resumo + referência (truncated)', async () => {
    const pequeno = '11111111-0000-4000-8000-000000000004';
    await saveRun(recordGrande(pequeno, 2, 40));
    const cheio = JSON.parse(
      ((await callTool('get_result', { id: pequeno, detail: 'full' })) as ToolCallResult).content[0].text,
    ) as Record<string, unknown>;
    expect(cheio.detail).toBe('full');
    expect(cheio.status).toBe('aborted');
    expect(Array.isArray(cheio.stages)).toBe(true);

    const gigante = '11111111-0000-4000-8000-000000000005';
    await saveRun(recordGrande(gigante, 40, 2000));
    const resumido = JSON.parse(
      ((await callTool('get_result', { id: gigante, detail: 'full' })) as ToolCallResult).content[0].text,
    ) as Record<string, unknown>;
    expect(resumido.truncated).toBe(true);
    expect(resumido.detail).toBe('summary');
    expect(resumido.ref).toMatchObject({ file: `runs/${gigante}.json` });
    expect(estimateTokens(JSON.stringify(resumido))).toBeLessThanOrEqual(5000);
  });

  it('teto duro: resposta acima de 25 mil tokens vira isError com mensagem acionável', async () => {
    const enorme: McpTool = {
      name: 'enorme',
      description: 'devolve mais que o teto',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      run: async () => ({ blob: 'z'.repeat(HARD_RESULT_TOKENS * 4) }),
    };
    const r = (await callTool('enorme', {}, undefined, { tools: [enorme] })) as ToolCallResult;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/grande demais/u);
    expect(r.content[0].text).toMatch(/paginação|filtro/u);
  });

  it('a regra do envelope vale para toda tool com outputSchema (structuredContent + espelho)', async () => {
    const qualquer: McpTool = {
      name: 'qualquer',
      description: 'devolve objeto comum',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object', additionalProperties: true },
      run: async () => ({ a: 1, b: [2, 3], c: 'x' }),
    };
    const r = (await callTool('qualquer', {}, undefined, { tools: [qualquer] })) as ToolCallResult;
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toEqual({ a: 1, b: [2, 3], c: 'x' });
    expect(r.content[0].text).toBe(JSON.stringify(r.structuredContent));
  });
});

// ---------------------------------------------------------------------------
// IMPL-086 (critério 4) — p95 das respostas em run REAL 8×5
// ---------------------------------------------------------------------------
// Pipeline real (orquestador, julgamento, duelos, ledger) contra o transporte
// FALSO do OpenRouter (zero rede externa, zero gasto — mesmo harness do
// cancelamento): run compare com 8 cenários × 5 contestants, e as respostas de
// TODAS as tools com argumentos DEFAULT (o uso real) medidas na heurística de
// 3,5 chars/token. O p95 tem de ficar ≤ 5 mil tokens; `detail:"full"` é
// verbosidade EXPLÍCITA e vale o teto duro de 25 mil.

describe('IMPL-086 — p95 das respostas das tools em run real 8×5', () => {
  let tmp: string;
  let anterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-mcp-p95-'));
    anterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(anterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('8 tools em run 8×5: nenhuma resposta default passa de 5 mil tokens (p95 incluso)', async () => {
    const fake = fakeDoPipeline(cenarios(8));
    const t = transporte(fake, null, 1);
    const gwAnterior: OpenRouterGateway = setDefaultGateway(createGateway({ fetch: t.fetch, sleep: noSleep }));
    try {
      const config = {
        mode: 'compare',
        theme: 'suporte ao cliente',
        stages: 8,
        datagenModelId: 'fake/gen',
        judgeModelIds: ['fake/judge'],
        referenceModelId: 'fake/ref',
        referenceJudging: true,
        competitorModelIds: ['fake/a', 'fake/b', 'fake/c', 'fake/d', 'fake/e'],
        finalists: 2,
        timeoutMs: 30_000,
      };
      const chamar = (name: string, args: Record<string, unknown>): Promise<ToolCallResult | null> =>
        callTool(name, args, async () => KEY) as Promise<ToolCallResult | null>;

      const rodada = (await chamar('run_benchmark', { config, budgetUsd: 5 }))!;
      expect(rodada.isError).toBeUndefined();
      const saidaRun = JSON.parse(rodada.content[0].text) as { runId?: string; status?: string };
      expect(saidaRun.status).toBe('finished');
      const runId = saidaRun.runId!;
      expect(fake.billedCalls()).toBeGreaterThan(0); // run REAL, chamadas de verdade (falsas)

      // As 8 tools com argumentos default. `train_prompt`/`run_agent_benchmark`
      // são medidas no caminho de recusa (o de sucesso devolve o MESMO resumo
      // de run medido em run_benchmark — mesma função `resultadoDoJob`).
      const amostras: Array<[string, ToolCallResult]> = [
        ['run_benchmark', rodada],
        ['get_result', (await chamar('get_result', { id: runId }))!],
        ['get_agent_dossier', (await chamar('get_agent_dossier', { runId, stageIndex: 0, contestantId: 'fake/a' }))!],
        ['read_docs', (await chamar('read_docs', {}))!],
        ['list_models', (await chamar('list_models', {}))!],
        ['estimate_cost', (await chamar('estimate_cost', { config }))!],
        ['train_prompt', (await chamar('train_prompt', { config, budgetUsd: 1 }))!],
        ['run_agent_benchmark', (await chamar('run_agent_benchmark', { config: '{}', budgetUsd: 1 }))!],
      ];
      const tokens = amostras.map(([nome, r]) => ({ nome, tokens: estimateTokens(r.content[0]?.text ?? '') }));
      for (const { nome, tokens: n } of tokens) {
        expect(n, `resposta de ${nome} passou do teto`).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);
      }
      const ordenados = tokens.map((x) => x.tokens).sort((a, b) => a - b);
      const p95 = ordenados[Math.ceil(0.95 * ordenados.length) - 1];
      expect(p95).toBeLessThanOrEqual(SOFT_RESULT_TOKENS);

      // verbosidade explícita: o record 8×5 inteiro cabe no teto DURO (25 mil)
      const cheio = (await chamar('get_result', { id: runId, detail: 'full' }))!;
      expect(estimateTokens(cheio.content[0].text)).toBeLessThanOrEqual(HARD_RESULT_TOKENS);
    } finally {
      setDefaultGateway(gwAnterior);
    }
  }, 30_000);
});
