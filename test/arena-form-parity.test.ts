// IMPL-045 (R-11b:REC-4) — paridade arena-config@1 × formulário Nova Run.
//
// Antes: o import validava `repeats`, `training.reflection/paretoPool/halving` e
// `prompt.group/promptId` e os DESCARTAVA em silêncio (a run rodava com outra
// config). Agora todo campo do schema é `ui` ou `json-only` (tabela
// ARENA_FIELD_HANDLING), o import AVISA nomeando o que não entra na run, e o
// export→import é um round-trip por igualdade profunda.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseArenaConfig, type ArenaConfigFile } from '../web/src/engine/configFile';
import {
  ARENA_FIELD_HANDLING,
  ARENA_JSON_ONLY_FIELDS,
  applyArenaConfigToForm,
  arenaSchemaFieldPaths,
  defaultArenaFormState,
  exportArenaConfig,
  formatArenaWarning,
  jsonOnlyRunPatch,
  presentArenaFieldPaths,
  unclassifiedArenaFields,
  unknownArenaFields,
  type ArenaFieldWarning,
} from '../web/src/arenaForm';

const NOW = '2026-09-27T00:00:00.000Z';

function parse(json: unknown): ArenaConfigFile {
  const r = parseArenaConfig(json);
  if (!r.ok) throw new Error(`fixture inválida: ${r.error}`);
  return r.config;
}

/** Importa sobre o estado-base da tela (como um usuário que abre a Nova Run). */
function importar(json: unknown) {
  const cfg = parse(json);
  return applyArenaConfigToForm(defaultArenaFormState(), cfg, { raw: json, now: NOW });
}

/** Export → arquivo (JSON de verdade) → parse: o que o usuário baixa e reabre. */
function exportarEReler(state: ReturnType<typeof defaultArenaFormState>) {
  const { config, omitted } = exportArenaConfig(state);
  return { reread: parse(JSON.parse(JSON.stringify(config))), omitted };
}

const hasWarning = (ws: ArenaFieldWarning[], path: string) => ws.some((w) => w.path === path);

// --------------------------------------------------------------------------
// Fixtures canônicas: TODO campo aplicável preenchido com valor não-default.
// --------------------------------------------------------------------------

const cenarios = [
  {
    id: 'c1',
    question: 'Posso tomar café antes do exame de sangue?',
    productContext: 'Clínica X, jejum de 8h.',
    maxTokens: 700,
    rubric: 'Deve citar o jejum de 8h.',
    reference: 'Não: apenas água durante o jejum.',
    expected: ['nao', 'não'],
    // IMPL-003: rótulo curto exige o conjunto de rótulos válidos.
    labelSet: ['nao', 'não', 'sim'],
  },
  {
    id: 'c2',
    question: 'Qual o horário de coleta?',
    productContext: 'Coleta 7h–11h.',
    maxTokens: 300,
    rubric: '',
    expected: { horario: '7h-11h', aberto: true },
  },
];

const comum = {
  format: 'arena-config@1',
  theme: 'Preparo para exames',
  scenarioBrief: 'Foque em jejum e medicamentos.',
  // IMPL-056: idiomas do datagen viraram campo da tela (Avançado).
  languages: ['pt-BR', 'en'],
  stages: 7,
  scenarios: cenarios,
  duels: false,
  finalists: 5,
  judging: { reference: true, passes: 2 },
  limits: { maxOutputTokens: 900, timeoutMs: 45000, concurrency: 4 },
  compliance: { area: 'saude', includeRessalvas: false },
  // LGPD (IMPL-040): 'synthetic' é o único valor que o export escreve.
  piiMode: 'synthetic',
} as const;

const FIXTURES: Record<string, Record<string, unknown>> = {
  'compare/modelos': {
    ...comum,
    mode: 'compare',
    repeats: 3,
    models: {
      datagen: 'gen/a',
      judges: ['judge/a', 'judge/b'],
      reference: 'ref/a',
      competitors: ['comp/a', 'comp/b', 'comp/c'],
    },
    effort: { competitor: 'low', judge: 'high', datagen: 'medium' },
  },
  'compare/configs': {
    ...comum,
    mode: 'compare',
    repeats: 2,
    models: {
      datagen: 'gen/a',
      judges: ['judge/a'],
      competitorConfigs: [
        { model: 'comp/a', temperature: 0.7, reasoning: 'high' },
        { model: 'comp/a', temperature: 0, reasoning: 'off' },
        { model: 'comp/b' },
      ],
    },
    effort: { judge: 'minimal' },
  },
  variation: {
    ...comum,
    mode: 'variation',
    prompt: {
      text: 'Você é o assistente da clínica.',
      generateFrom: 'assistente de preparo',
      group: [
        { id: 'regras', label: 'Regras', text: 'Você é o assistente da clínica.' },
        { id: 'tom', text: 'Seja cordial.' },
      ],
      promptId: 'regras',
    },
    // optimize: false → reescritor/contratos/técnicas NÃO entram na run (só
    // valem com optimize ligado; ficam na fixture de treino).
    models: {
      datagen: 'gen/a',
      judges: ['judge/a'],
      contestant: 'cont/a',
    },
    effort: { competitor: 'xhigh', judge: 'high', datagen: 'medium' },
    variation: {
      optimize: false,
      manualVariants: [
        { label: 'Curta', systemPrompt: 'Responda curto.' },
        { label: 'Longa', systemPrompt: 'Responda com detalhes.' },
      ],
    },
  },
  training: {
    ...comum,
    mode: 'training',
    prompt: {
      text: 'Você é o assistente da clínica.',
      generateFrom: 'assistente de preparo',
      contracts: {
        neverBreak: ['nunca diagnostique'],
        placeholders: ['{{nome}}'],
        minLengthRatio: 0.6,
        // IMPL-011: camadas 2 e 3 do contrato.
        judgeDiff: false,
        canaries: [
          { id: 'fmt', kind: 'format', input: 'Liste os horários.', json: true, requiredKeys: ['horario'], forbid: 'segredo', maxTokens: 300 },
          { kind: 'placeholder', input: 'Olá', fill: { '{{nome}}': 'Zulmira' }, pattern: 'Zulmira' },
        ],
      },
      group: [{ id: 'unico', text: 'Você é o assistente da clínica.' }],
      promptId: 'unico',
    },
    models: {
      datagen: 'gen/a',
      judges: ['judge/a', 'judge/b'],
      reference: 'ref/a',
      contestant: 'cont/a',
      rewriter: 'rew/a',
    },
    effort: { competitor: 'max', judge: 'low', rewriter: 'medium', datagen: 'high' },
    variation: { optimize: true, techniques: ['persona', 'cot', 'format'] },
    training: {
      iterations: 6,
      minGain: 2.5,
      holdoutRatio: 0.3,
      feedbackDriven: false,
      reflection: 'llm',
      paretoPool: 4,
    },
  },
};

// --------------------------------------------------------------------------
// (a) Paridade schema × formulário
// --------------------------------------------------------------------------

describe('IMPL-045 (a) — todo campo do schema tem controle na UI OU entrada só-JSON', () => {
  it('nenhum campo-folha do schema fica sem classificação', () => {
    const paths = arenaSchemaFieldPaths();
    // Sanidade do walker: enxerga o schema de verdade (inclusive os 5 do gap).
    expect(paths.length).toBeGreaterThan(50);
    for (const p of ['repeats', 'training.reflection', 'training.paretoPool', 'prompt.group[].id', 'prompt.promptId', 'scenarios[].question', 'scenarios.from']) {
      expect(paths).toContain(p);
    }
    expect(unclassifiedArenaFields(paths)).toEqual([]);
  });

  it('a guarda REPROVA um campo novo no schema sem controle e sem só-JSON', () => {
    // Um schema com um campo a mais (o próximo `training.xyz`): o walker o
    // encontra e a classificação acusa — é exatamente o que falharia no CI.
    const estendido = z.object({
      training: z.object({ iterations: z.number().optional(), novoCampo: z.boolean().optional() }).optional(),
      itens: z.array(z.object({ peso: z.number() })).optional(),
    });
    const paths = arenaSchemaFieldPaths(estendido);
    expect(paths).toEqual(['itens[].peso', 'training.iterations', 'training.novoCampo']);
    expect(unclassifiedArenaFields(paths)).toEqual(['itens[].peso', 'training.novoCampo']);
  });

  it('a tabela não tem entrada órfã (campo que saiu do schema), exceto descontinuados', () => {
    const paths = new Set(arenaSchemaFieldPaths());
    const orfas = Object.entries(ARENA_FIELD_HANDLING)
      .filter(([p, h]) => !paths.has(p) && !(h.kind === 'json-only' && h.discontinued))
      .map(([p]) => p);
    expect(orfas).toEqual([]);
  });

  it('os 5 campos do gap estão declarados (e halving como descontinuado/ignorado)', () => {
    const jsonOnly = new Map(ARENA_JSON_ONLY_FIELDS.map((f) => [f.path, f]));
    for (const p of ['repeats', 'training.reflection', 'training.paretoPool', 'prompt.group[].id', 'prompt.promptId']) {
      expect(jsonOnly.get(p)?.status, p).toBe('aplicado');
    }
    expect(jsonOnly.get('training.halving')).toMatchObject({ status: 'ignorado', discontinued: true });
  });

  it('a lista só-JSON é renderizada na tela (Avançado)', () => {
    const tsx = readFileSync(new URL('../web/src/pages/NewRun.tsx', import.meta.url), 'utf8');
    expect(tsx).toMatch(/ARENA_JSON_ONLY_FIELDS\.map\(/);
    expect(tsx).toContain('Só pelo arquivo JSON');
  });

  it('as fixtures cobrem TODO campo aplicável (ui + só-JSON aplicado, fora sinônimos legados)', () => {
    const cobertos = new Set(Object.values(FIXTURES).flatMap((f) => presentArenaFieldPaths(f)));
    const faltando = Object.entries(ARENA_FIELD_HANDLING)
      .filter(([, h]) => !h.aliasOf && !(h.kind === 'json-only' && (h.status === 'ignorado' || h.oneShot)))
      .map(([p]) => p)
      .filter((p) => !cobertos.has(p));
    expect(faltando).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// (c) Round-trip export → import por igualdade profunda
// --------------------------------------------------------------------------

describe('IMPL-045 (c) — round-trip export→import preserva todos os campos aplicáveis', () => {
  for (const [nome, fixture] of Object.entries(FIXTURES)) {
    it(`arquivo → tela → arquivo: ${nome}`, () => {
      const original = parse(fixture);
      const { state, warnings } = importar(fixture);
      expect(warnings).toEqual([]);
      const { reread, omitted } = exportarEReler(state);
      expect(omitted).toEqual([]);
      expect(reread).toEqual(original);
    });

    it(`tela → arquivo → tela: ${nome}`, () => {
      const { state } = importar(fixture);
      const { config } = exportArenaConfig(state);
      const again = applyArenaConfigToForm(defaultArenaFormState(), parse(JSON.parse(JSON.stringify(config))), {
        raw: config,
        now: NOW,
      });
      expect(again.warnings).toEqual([]);
      expect(again.state).toEqual(state);
    });
  }

  it('os campos do gap sobrevivem e CHEGAM ao RunConfig (antes: validados e descartados)', () => {
    const t = importar(FIXTURES.training).state;
    expect(jsonOnlyRunPatch(t)).toEqual({
      contracts: {
        neverBreak: ['nunca diagnostique'],
        placeholders: ['{{nome}}'],
        minLengthRatio: 0.6,
        judgeDiff: false,
        canaries: [
          { id: 'fmt', kind: 'format', input: 'Liste os horários.', json: true, requiredKeys: ['horario'], forbid: 'segredo', maxTokens: 300 },
          { kind: 'placeholder', input: 'Olá', fill: { '{{nome}}': 'Zulmira' }, pattern: 'Zulmira' },
        ],
      },
      promptGroup: { prompts: [{ id: 'unico', text: 'Você é o assistente da clínica.' }] },
      promptId: 'unico',
      reflection: 'llm',
      paretoPool: 4,
    });
    const c = importar(FIXTURES['compare/modelos']).state;
    expect(jsonOnlyRunPatch(c)).toEqual({ repeats: 3 });
    expect(c.refJudgingChoice).toBe(true);
  });

  it('sinônimos legados (training.duels/finalists/repeats) saem na raiz canônica', () => {
    const legado = {
      ...FIXTURES['compare/modelos'],
      duels: undefined,
      finalists: undefined,
      repeats: undefined,
      training: { duels: false, finalists: 2, repeats: 2 },
    };
    const { state, warnings } = importar(JSON.parse(JSON.stringify(legado)));
    // training.* no compare: os sinônimos valem em todo modo — sem aviso.
    expect(warnings).toEqual([]);
    const { reread } = exportarEReler(state);
    expect(reread).toMatchObject({ duels: false, finalists: 2, repeats: 2 });
    expect(reread.training).toBeUndefined();
  });

  it('allowPii (one-shot, IMPL-040) é aceito sem aviso e NUNCA vai para o arquivo exportado', () => {
    const { state, warnings } = importar({ ...FIXTURES.variation, allowPii: true });
    expect(warnings).toEqual([]);
    const { config } = exportArenaConfig(state);
    expect('allowPii' in config).toBe(false);
  });

  it('um import novo não herda campo só-JSON invisível do anterior', () => {
    const primeiro = importar(FIXTURES.training).state;
    const semNada = { ...FIXTURES.training, prompt: { text: 'x' }, training: { iterations: 3 }, judging: undefined };
    const segundo = applyArenaConfigToForm(primeiro, parse(JSON.parse(JSON.stringify(semNada))), { now: NOW }).state;
    expect(segundo.promptGroup).toBeUndefined();
    expect(segundo.promptId).toBeUndefined();
    expect(segundo.promptContracts).toBeUndefined();
    expect(segundo.reflection).toBeUndefined();
    expect(segundo.paretoPool).toBeUndefined();
    expect(segundo.refJudgingChoice).toBeNull();
  });
});

// --------------------------------------------------------------------------
// (b) Aviso nomeando o campo quando o import descarta algo não aplicável
// --------------------------------------------------------------------------

describe('IMPL-045 (b) — import com campo não aplicável avisa NOMEANDO o campo', () => {
  it('training.halving (descontinuado) → aviso nomeando training.halving', () => {
    const cfg = { ...FIXTURES.training, training: { ...(FIXTURES.training.training as object), halving: true } };
    const { warnings } = importar(cfg);
    expect(hasWarning(warnings, 'training.halving')).toBe(true);
    expect(warnings.map(formatArenaWarning).join('\n')).toContain('training.halving: ignorado');
  });

  it('repeats fora do compare → aviso e NÃO vai para a run', () => {
    const { state, warnings } = importar({ ...FIXTURES.training, repeats: 3 });
    expect(hasWarning(warnings, 'repeats')).toBe(true);
    expect(jsonOnlyRunPatch(state).repeats).toBeUndefined();
  });

  it('scenarios da biblioteca (só CLI) → UM aviso nomeando scenarios.from', () => {
    const { warnings } = importar({ ...FIXTURES.training, scenarios: { from: 'library', profile: 'clinica', ids: ['a'] } });
    expect(warnings.filter((w) => w.path.startsWith('scenarios'))).toEqual([
      expect.objectContaining({ path: 'scenarios.from' }),
    ]);
  });

  it('chave desconhecida (typo) que o zod descartaria calado → aviso nomeando o caminho', () => {
    const raw = {
      ...FIXTURES.training,
      training: { ...(FIXTURES.training.training as object), halvng: true },
      scenarios: [{ ...cenarios[0], peso: 2 }],
    };
    const { warnings } = importar(raw);
    expect(hasWarning(warnings, 'training.halvng')).toBe(true);
    expect(hasWarning(warnings, 'scenarios[0].peso')).toBe(true);
    expect(unknownArenaFields(FIXTURES.training, parse(FIXTURES.training))).toEqual([]);
  });

  it('limite fora da faixa da tela → aviso de ajuste nomeando o campo', () => {
    const { state, warnings } = importar({ ...FIXTURES.training, limits: { timeoutMs: 500, concurrency: 99 } });
    expect(state.timeoutMs).toBe(1000);
    expect(state.concurrency).toBe(32);
    expect(hasWarning(warnings, 'limits.timeoutMs')).toBe(true);
    expect(hasWarning(warnings, 'limits.concurrency')).toBe(true);
  });

  it('dois papéis no mesmo modelo com esforços diferentes → o perdedor é nomeado', () => {
    const cfg = {
      ...FIXTURES.training,
      models: { ...(FIXTURES.training.models as object), datagen: 'judge/a' },
      effort: { datagen: 'high', judge: 'low' },
    };
    const { warnings } = importar(cfg);
    expect(hasWarning(warnings, 'effort.datagen')).toBe(true);
  });

  it('raiz × sinônimo legado divergentes → o de training é nomeado', () => {
    const { warnings } = importar({ ...FIXTURES.training, duels: true, training: { duels: false } });
    expect(hasWarning(warnings, 'training.duels')).toBe(true);
  });

  it('effort.competitor com competitorConfigs → aviso (o esforço vai por config)', () => {
    const cfg = { ...FIXTURES['compare/configs'], effort: { competitor: 'high' } };
    expect(hasWarning(importar(cfg).warnings, 'effort.competitor')).toBe(true);
  });

  // Métrica-alvo: campos validados-e-descartados em silêncio = 0. Para CADA
  // campo com escopo de modo, importá-lo num modo em que não vale gera aviso
  // com o nome do campo.
  const MODOS = ['compare', 'variation', 'training'] as const;
  const base: Record<(typeof MODOS)[number], Record<string, unknown>> = {
    compare: FIXTURES['compare/modelos'],
    variation: FIXTURES.variation,
    training: FIXTURES.training,
  };
  const getAt = (obj: unknown, path: string): unknown =>
    path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], obj);
  const setAt = (obj: Record<string, unknown>, path: string, value: unknown) => {
    const ks = path.split('.');
    let o = obj;
    for (const k of ks.slice(0, -1)) o = (o[k] = { ...((o[k] as object) ?? {}) }) as Record<string, unknown>;
    o[ks[ks.length - 1]] = value;
  };
  // Campos sem fixture própria (descontinuado/sinônimo legado): valor de amostra.
  const AMOSTRA: Record<string, unknown> = { 'training.halving': true, 'training.repeats': 2 };
  for (const [path, h] of Object.entries(ARENA_FIELD_HANDLING)) {
    if (!h.modes) continue;
    const topo = path.replace(/\[\]\..*$/, '');
    const grupo = topo.split('.')[0];
    const fonte = Object.values(FIXTURES).find((f) => getAt(f, topo) !== undefined);
    for (const modo of MODOS.filter((m) => !h.modes!.includes(m))) {
      it(`métrica 0 silencioso: ${path} no modo ${modo} → aviso nomeando o campo`, () => {
        const cfg = JSON.parse(JSON.stringify(base[modo])) as Record<string, unknown>;
        // Copia o BLOCO inteiro da fixture de origem (prompt/variation/…) para o
        // arquivo continuar válido (ex.: prompt.text é obrigatório no bloco).
        if (fonte && grupo !== topo) cfg[grupo] = { ...((cfg[grupo] as object) ?? {}), ...(fonte[grupo] as object) };
        else setAt(cfg, topo, fonte ? getAt(fonte, topo) : AMOSTRA[path]);
        if (!fonte) setAt(cfg, topo, AMOSTRA[path]);
        const { warnings } = importar(cfg);
        expect(warnings.some((w) => w.path === topo || w.path === path)).toBe(true);
      });
    }
  }
});
