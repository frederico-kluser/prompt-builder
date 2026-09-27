// IMPL-093 (R-12:REC-2) — config fail-closed no CLI:
//   1. os 3 modos de `config example` passam em `config validate` (round-trip);
//   2. chave desconhecida NUNCA é descartada em silêncio: exit 3 com caminho
//      JSON e "você quis dizer" (aqui vive a regressão do defeito medido — um
//      typo como 'trainig' sumia do config e a run rodava com outro
//      comportamento);
//   3. chave descontinuada (training.halving, IMPL-012) continua aceita com
//      AVISO — fail-closed não é over-strict.
//
// Tudo pelo PROCESSO REAL (tsx): o exit code é o contrato.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT } from '../src/cli/output.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = path.join(ROOT, 'src', 'cli', 'index.ts');

let home = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-config-strict-'));
});

afterAll(() => {
  if (home) rmSync(home, { force: true, recursive: true });
});

interface CliRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[]): CliRun {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(TSX, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function grava(nome: string, json: unknown): string {
  const file = path.join(home, nome);
  writeFileSync(file, typeof json === 'string' ? json : JSON.stringify(json));
  return file;
}

describe('config example: os 3 modos passam em config validate (round-trip)', { timeout: 120_000 }, () => {
  for (const modo of ['train', 'vary', 'compare', 'variation', 'training']) {
    it(`--mode ${modo} gera config VÁLIDO`, () => {
      const alvo = path.join(home, `exemplo-${modo}.json`);
      const gerado = cli(['config', 'example', '--mode', modo, '-o', alvo]);
      expect(gerado.status, gerado.stderr).toBe(EXIT.OK);
      const validado = cli(['config', 'validate', alvo, '--json']);
      expect(validado.status, validado.stderr).toBe(EXIT.OK);
      const payload = JSON.parse(validado.stdout) as { ok: boolean; data: { format: string } };
      expect(payload.ok).toBe(true);
      expect(payload.data.format).toBe('arena-config@1');
    });
  }

  it('modo desconhecido é uso (exit 2) com a lista dos válidos', () => {
    const r = cli(['config', 'example', '--mode', 'trianing', '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = JSON.parse(r.stdout) as { error: { code: string; hint: string; details: { accepted: string[] } } };
    expect(env.error.code).toBe('usage.invalid_flag_value');
    expect(env.error.details.accepted).toEqual(['compare', 'variation', 'training']);
    expect(env.error.hint).toContain('--mode');
  });
});

describe('chave desconhecida nunca é descartada em silêncio (fail-closed)', { timeout: 120_000 }, () => {
  it("typo 'trainig' sai exit 3 sugerindo 'training' (config.unknown_key)", () => {
    const file = grava('typo.json', {
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
      trainig: { iterations: 3 },
    });
    const r = cli(['config', 'validate', file, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as {
      error: { code: string; kind: string; message: string; details: { unknownKeys: { path: string; suggestion: string | null }[] } };
    };
    expect(env.error.code).toBe('config.unknown_key');
    expect(env.error.kind).toBe('config');
    // Critério do item: sair 3 SUGERINDO 'training'.
    expect(env.error.message).toContain('training');
    expect(env.error.details.unknownKeys[0].path).toBe('trainig');
    expect(env.error.details.unknownKeys[0].suggestion).toBe('training');
  });

  it('typo aninhado cita o caminho JSON completo e sugere o campo certo', () => {
    const file = grava('typo-aninhado.json', {
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
      training: { iterations: 3, minGainr: 2 },
    });
    const r = cli(['config', 'validate', file, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as {
      error: { code: string; details: { unknownKeys: { path: string; suggestion: string | null }[] } };
    };
    expect(env.error.code).toBe('config.unknown_key');
    expect(env.error.details.unknownKeys[0].path).toBe('training.minGainr');
    expect(env.error.details.unknownKeys[0].suggestion).toBe('minGain');
  });

  it('RunConfig cru tem o MESMO fail-closed (dialeto par)', () => {
    const file = grava('cru.json', {
      mode: 'compare',
      theme: 'suporte',
      stages: 3,
      datagenModelId: 'openai/gpt-5-mini',
      judgeModelIds: ['anthropic/claude-sonnet-5'],
      competitorModelIds: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini'],
      finalistas: 3,
    });
    const r = cli(['config', 'validate', file, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as {
      error: { code: string; details: { unknownKeys: { path: string; suggestion: string | null }[] } };
    };
    expect(env.error.code).toBe('config.unknown_key');
    expect(env.error.details.unknownKeys[0].suggestion).toBe('finalists');
  });

  it('o mesmo vale para `estimate --config` (todo caminho de --config é fail-closed)', () => {
    const file = grava('typo-estimate.json', {
      mode: 'compare',
      theme: 'suporte',
      stages: 3,
      datagenModelId: 'openai/gpt-5-mini',
      judgeModelIds: ['anthropic/claude-sonnet-5'],
      competitorModelIds: ['google/gemini-2.5-flash', 'openai/gpt-4.1-mini'],
      temperatura: 0.3,
    });
    const r = cli(['estimate', '--config', file, '--json']);
    expect(r.status).toBe(EXIT.CONFIG);
    const env = JSON.parse(r.stdout) as { error: { code: string; details: { unknownKeys: { suggestion: string | null }[] } } };
    expect(env.error.code).toBe('config.unknown_key');
    expect(env.error.details.unknownKeys[0].suggestion).toBe('temperature');
  });
});

describe('fail-closed não é over-strict', { timeout: 120_000 }, () => {
  it('training.halving (descontinuada, IMPL-012) segue VÁLIDA com aviso no stderr', () => {
    const file = grava('legado.json', {
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
      variation: { optimize: true, techniques: ['persona', 'constraints'] },
      training: { iterations: 3, halving: true },
    });
    const r = cli(['config', 'validate', file, '--json']);
    expect(r.status, r.stdout).toBe(EXIT.OK);
    expect(r.stderr).toContain('descontinuado');
  });

  it('config válido sem chave nenhuma extra continua saindo 0', () => {
    const alvo = path.join(home, 'valido.json');
    expect(cli(['config', 'example', '--mode', 'variation', '-o', alvo]).status).toBe(EXIT.OK);
    expect(cli(['config', 'validate', alvo]).status).toBe(EXIT.OK);
  });
});

describe('config schema: JSON Schema publicado com $schema versionado (IMPL-093)', { timeout: 120_000 }, () => {
  it('arena-config@1 sai com $schema (draft 2020-12) e $id versionado, compacto por padrão', () => {
    const r = cli(['config', 'schema', '--json']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(String(doc.$id)).toContain('arena-config@1');
    // As chaves que `config validate` exige estão no schema publicado.
    const props = doc.properties as Record<string, unknown>;
    for (const chave of ['format', 'mode', 'theme', 'stages', 'prompt', 'models']) {
      expect(props, chave).toHaveProperty(chave);
    }
    // Compacto por padrão (IMPL-092): UMA linha de payload.
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('--dialect run publica o schema do RunConfig cru; --pretty formata', () => {
    const r = cli(['config', 'schema', '--dialect', 'run', '--pretty']);
    expect(r.status, r.stderr).toBe(EXIT.OK);
    const doc = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(String(doc.$id)).toContain('run-config@1');
    expect(r.stdout.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('--dialect desconhecido é uso (exit 2) citando os aceitos', () => {
    const r = cli(['config', 'schema', '--dialect', 'xpto', '--json']);
    expect(r.status).toBe(EXIT.USAGE);
    const env = JSON.parse(r.stdout) as { error: { code: string; details: { accepted: string[] } } };
    expect(env.error.code).toBe('usage.invalid_flag_value');
    expect(env.error.details.accepted).toEqual(['arena', 'run']);
  });
});
