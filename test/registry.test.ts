// Testes de CONTRATO da guarda de drift de prompts (`src/registry.ts`) — o
// parse do registro versionado e a checagem de drift (função pura, reader
// injetado). Mensagens de erro em PT-BR citando o campo são parte do contrato:
// quem lê o output é um agente/operador tentando corrigir o registro.

import { describe, expect, it } from 'vitest';
import {
  exampleRegistryJson,
  parseRegistry,
  validateRegistry,
  REGISTRY_FORMAT,
  type PromptRegistry,
} from '../src/registry.js';

const entry = {
  id: 'response-generation',
  name: 'Geração de resposta',
  source: { kind: 'needle', file: 'src/prompts.ts', needle: 'export const RESPONSE_PROMPT' },
  trainedAt: '2026-09-25T00:00:00Z',
  trainedFrom: { sessionId: 's1', runId: 'r1' },
};

const registryCom = (prompts: unknown[]): unknown => ({ format: REGISTRY_FORMAT, prompts });

describe('parseRegistry', () => {
  it('aceita um registro válido e devolve o registro normalizado', () => {
    const r = parseRegistry(registryCom([entry]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registry.format).toBe(REGISTRY_FORMAT);
    expect(r.registry.prompts).toHaveLength(1);
    expect(r.registry.prompts[0]).toMatchObject({
      id: 'response-generation',
      name: 'Geração de resposta',
      trainedAt: '2026-09-25T00:00:00Z',
      trainedFrom: { sessionId: 's1', runId: 'r1' },
    });
    expect(r.registry.prompts[0].source).toEqual({
      kind: 'needle',
      file: 'src/prompts.ts',
      needle: 'export const RESPONSE_PROMPT',
    });
  });

  it('aceita trainedFrom opcional e parcial', () => {
    const r = parseRegistry(registryCom([{ ...entry, trainedFrom: { sessionId: 's1' } }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registry.prompts[0].trainedFrom).toEqual({ sessionId: 's1' });
    const sem = parseRegistry(registryCom([{ ...entry, trainedFrom: undefined }]));
    expect(sem.ok).toBe(true);
    if (!sem.ok) return;
    expect(sem.registry.prompts[0].trainedFrom).toBeUndefined();
  });

  it('rejeita formato errado citando o campo "format"', () => {
    const r = parseRegistry({ format: 'prompt-registry@2', prompts: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('"format"');
    expect(r.error).toContain(REGISTRY_FORMAT);
    expect(r.error).toContain('prompt-registry@2');
  });

  it('rejeita "prompts" ausente/não-lista citando o campo', () => {
    for (const json of [{ format: REGISTRY_FORMAT }, { format: REGISTRY_FORMAT, prompts: 'x' }]) {
      const r = parseRegistry(json);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain('"prompts"');
    }
  });

  it('rejeita campo faltando citando o caminho completo (mensagens PT-BR)', () => {
    const casos: [string, Record<string, unknown>][] = [
      ['"prompts[0].id"', { ...entry, id: undefined }],
      ['"prompts[0].name"', { ...entry, name: '' }],
      ['"prompts[0].source"', { ...entry, source: undefined }],
      [
        '"prompts[0].source.kind"',
        { ...entry, source: { kind: 'symbol', file: 'a.ts', needle: 'X' } },
      ],
      [
        '"prompts[0].source.file"',
        { ...entry, source: { kind: 'needle', file: '  ', needle: 'X' } },
      ],
      [
        '"prompts[0].source.needle"',
        { ...entry, source: { kind: 'needle', file: 'a.ts', needle: '' } },
      ],
      ['"prompts[0].trainedAt"', { ...entry, trainedAt: 'ontem' }],
      [
        '"prompts[0].trainedFrom.runId"',
        { ...entry, trainedFrom: { sessionId: 's1', runId: 42 } },
      ],
    ];
    for (const [campo, prompt] of casos) {
      const r = parseRegistry(registryCom([prompt]));
      expect(r.ok, `deveria rejeitar ${campo}`).toBe(false);
      if (r.ok) return;
      expect(r.error).toContain(campo);
    }
  });

  it('nunca lança — entrada que não é objeto vira erro legível', () => {
    for (const json of [undefined, null, 'texto', 42, [], { format: 1, prompts: [] }]) {
      const r = parseRegistry(json);
      expect(r.ok).toBe(false);
    }
  });

  it('aceita o registro-exemplo do `registry init` (JSON comentado segue válido)', () => {
    const r = parseRegistry(JSON.parse(exampleRegistryJson()));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.registry.prompts).toHaveLength(1);
    expect(r.registry.prompts[0].id).toBe('exemplo');
  });
});

describe('validateRegistry', () => {
  const registry = (needle: string): PromptRegistry => ({
    format: REGISTRY_FORMAT,
    prompts: [{ ...entry, source: { kind: 'needle', file: 'src/prompts.ts', needle } }],
  });

  it('needle presente no fonte => id em ok', () => {
    const report = validateRegistry(registry('export const RESPONSE_PROMPT'), () =>
      'export const RESPONSE_PROMPT = "…";\n',
    );
    expect(report).toEqual({ total: 1, ok: ['response-generation'], drifted: [] });
  });

  it('compara literal mas trimmed (quebra de linha no needle não derruba)', () => {
    const report = validateRegistry(registry('  export const RESPONSE_PROMPT\n'), () =>
      'export const RESPONSE_PROMPT = "…";\n',
    );
    expect(report.ok).toEqual(['response-generation']);
  });

  it('needle ausente no fonte => drifted citando arquivo e motivo PT-BR', () => {
    const report = validateRegistry(registry('export const RESPONSE_PROMPT'), () =>
      'export const OUTRA_COISA = 1;\n',
    );
    expect(report.ok).toEqual([]);
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0].id).toBe('response-generation');
    expect(report.drifted[0].reason).toContain('src/prompts.ts');
    expect(report.drifted[0].reason).toContain('export const RESPONSE_PROMPT');
  });

  it('arquivo ilegível (reader devolve undefined) => drifted com motivo PT-BR', () => {
    const report = validateRegistry(registry('X'), () => undefined);
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0].reason).toContain('ilegível');
    expect(report.drifted[0].reason).toContain('src/prompts.ts');
  });

  it('reader que lança também vira drifted, nunca exceção', () => {
    const report = validateRegistry(registry('X'), () => {
      throw new Error('EACCES');
    });
    expect(report.drifted).toHaveLength(1);
    expect(report.drifted[0].reason).toContain('ilegível');
  });

  it('mistura ok/drifted e conta o total', () => {
    const reg: PromptRegistry = {
      format: REGISTRY_FORMAT,
      prompts: [
        { ...entry, id: 'a', source: { kind: 'needle', file: 'ok.ts', needle: 'NEEDLE_A' } },
        { ...entry, id: 'b', source: { kind: 'needle', file: 'bad.ts', needle: 'NEEDLE_B' } },
        { ...entry, id: 'c', source: { kind: 'needle', file: 'sumiu.ts', needle: 'NEEDLE_C' } },
      ],
    };
    const report = validateRegistry(reg, (p) =>
      p === 'ok.ts' ? 'NEEDLE_A aqui' : p === 'bad.ts' ? 'sem nada' : undefined,
    );
    expect(report.total).toBe(3);
    expect(report.ok).toEqual(['a']);
    expect(report.drifted.map((d) => d.id)).toEqual(['b', 'c']);
  });

  it('needle vazio no registro => drifted (nada para procurar)', () => {
    const report = validateRegistry(registry('   '), () => 'qualquer coisa');
    expect(report.drifted[0].reason).toContain('source.needle');
  });
});
