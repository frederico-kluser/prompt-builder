// Config fail-closed — a parte pura (src/configKeys.ts) e a superfície HTTP.
//
//  • extra#0: o "você quis dizer" sai das chaves VÁLIDAS do MESMO objeto
//    (JSON Schema do dialeto), nunca ecoa a própria chave errada. Antes,
//    `effort.contestant` sugeria "contestant" (a chave existe em `models`, não
//    em `effort`) e `effort.competitors` sugeria "competitors".
//  • IMPL-093: POST /v1/benchmark/runs e /sessions recusam chave desconhecida
//    com 400 (a MESMA regra do CLI e do MCP) — antes um typo sumia do body e a
//    run PAGA rodava com o default. Zero rede: a recusa vem antes do GET /key.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArenaConfig } from '../src/configFile.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { unknownKeyIssues, unknownKeysMessage, closestMatch } from '../src/configKeys.js';
import { createApp } from '../src/server.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';

const ARENA_BASE = {
  format: 'arena-config@1',
  mode: 'training',
  theme: 'suporte',
  stages: 3,
  prompt: { text: 'Você é um assistente.' },
  models: {
    datagen: 'openai/gpt-5-mini',
    judges: ['anthropic/claude-sonnet-5'],
    reference: 'google/gemini-2.5-pro',
    contestant: 'openai/gpt-5-mini',
  },
};

function issuesArena(extra: Record<string, unknown>) {
  const raw = { ...ARENA_BASE, ...extra };
  const p = parseArenaConfig(raw);
  if (!p.ok) throw new Error(p.error);
  return unknownKeyIssues(raw, p.config);
}

const RUN_BASE = {
  mode: 'compare',
  theme: 'suporte',
  stages: 3,
  datagenModelId: 'openai/gpt-5-mini',
  judgeModelIds: ['anthropic/claude-sonnet-5'],
  competitorModelIds: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini'],
};

describe('extra#0 — sugestão vem das chaves válidas do MESMO objeto', () => {
  it('effort.contestant → "competitor" (sinônimo do domínio), nunca o eco "contestant"', () => {
    const [i] = issuesArena({ effort: { contestant: 'off' } });
    expect(i.path).toBe('effort.contestant');
    expect(i.suggestion).toBe('competitor');
  });

  it('effort.competitors → "competitor"', () => {
    const [i] = issuesArena({ effort: { competitors: 'off' } });
    expect(i.path).toBe('effort.competitors');
    expect(i.suggestion).toBe('competitor');
  });

  it('typos seguem sugerindo o irmão certo (raiz e aninhado)', () => {
    expect(issuesArena({ trainig: { iterations: 3 } })[0].suggestion).toBe('training');
    expect(issuesArena({ training: { iterations: 3, minGian: 2 } })[0].suggestion).toBe('minGain');
  });

  it('a sugestão NUNCA é a própria chave errada', () => {
    for (const extra of [{ effort: { contestant: 'off' } }, { models: { ...ARENA_BASE.models, judge: 'x/y' } }]) {
      for (const i of issuesArena(extra)) expect(i.suggestion).not.toBe(i.key);
    }
  });

  it('RunConfig cru (sem `format`) usa o schema do RunConfig', () => {
    const raw = { ...RUN_BASE, judgePases: 2 };
    const p = parseRunConfig(raw);
    expect(p.ok).toBe(true);
    const issues = unknownKeyIssues(raw, (p as { config: unknown }).config);
    expect(issues).toEqual([{ path: 'judgePases', key: 'judgePases', suggestion: 'judgePasses' }]);
    expect(unknownKeysMessage(issues)).toContain('você quis dizer "judgePasses"');
  });

  it('closestMatch: tolerância por tamanho e prefixo', () => {
    expect(closestMatch('shwo', ['list', 'show'])).toBe('show');
    expect(closestMatch('zzz', ['list', 'show'])).toBeUndefined();
    expect(closestMatch('rep', ['report', 'list'])).toBe('report');
  });
});

describe('IMPL-093 — API HTTP fail-closed (POST /runs e /sessions)', () => {
  let server: Server;
  let porta = 0;
  let dataDirAnterior = '';
  let tmp = '';
  let chamadas = 0;
  let gatewayAnterior: OpenRouterGateway | undefined;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'pb-http-keys-'));
    dataDirAnterior = getDataDir();
    setDataDir(tmp);
    // Gateway que CONTA qualquer toque: a recusa tem de vir antes da rede.
    const conta = new Proxy({} as OpenRouterGateway, {
      get: () => () => {
        chamadas += 1;
        throw new Error('rede não deveria ser tocada');
      },
    });
    gatewayAnterior = setDefaultGateway(conta);
    const app = createApp({ webDist: null });
    server = await new Promise<Server>((r) => {
      const s = app.listen(0, '127.0.0.1', () => r(s));
    });
    porta = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (gatewayAnterior) setDefaultGateway(gatewayAnterior);
    setDataDir(dataDirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  function post(rota: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const dados = JSON.stringify(body);
      const r = http.request(
        {
          host: '127.0.0.1',
          port: porta,
          path: rota,
          method: 'POST',
          headers: {
            host: `localhost:${porta}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(dados),
            'x-openrouter-key': 'sk-or-v1-fake-key-para-teste-0000000000000000000000000000',
          },
        },
        (res) => {
          let txt = '';
          res.setEncoding('utf-8');
          res.on('data', (c: string) => (txt += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(txt || '{}') }));
        },
      );
      r.on('error', reject);
      r.end(dados);
    });
  }

  it('POST /runs com typo → 400 config.unknown_key com caminho e sugestão, sem tocar a rede', async () => {
    const r = await post('/v1/benchmark/runs', { ...RUN_BASE, judgePases: 2 });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('config.unknown_key');
    expect(r.json.error).toContain('"judgePases" (você quis dizer "judgePasses"?)');
    expect(r.json.unknownKeys).toEqual([{ path: 'judgePases', key: 'judgePases', suggestion: 'judgePasses' }]);
    expect(chamadas).toBe(0);
  });

  it('POST /sessions com typo aninhado → 400 com o caminho JSON', async () => {
    const r = await post('/v1/benchmark/sessions', {
      mode: 'training',
      theme: 'suporte',
      stages: 3,
      iterations: 2,
      datagenModelId: 'openai/gpt-5-mini',
      judgeModelIds: ['anthropic/claude-sonnet-5'],
      contestantModelId: 'openai/gpt-5-mini',
      referenceModelId: 'google/gemini-2.5-pro',
      basePrompt: 'Você é um assistente.',
      techniqueIds: ['persona', 'constraints'],
      reasoning: { competitr: 'off' },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.code, JSON.stringify(r.json)).toBe('config.unknown_key');
    expect((r.json.unknownKeys as Array<{ path: string }>)[0].path).toBe('reasoning.competitr');
    expect(chamadas).toBe(0);
  });
});
