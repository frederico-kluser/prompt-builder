// IMPL-049 (R-03a:REC-9) — guarda de contrato estendida + `judge.contract.changed`.
//
// Contratos provados aqui:
//  (i)   o hash cobre TODOS os componentes do contrato (juízes + prompt
//        pointwise + prompt do duelo + prompt listwise + modelo de referência +
//        think level + provedor): trocar CADA um muda o hash
//        (contrato_rastreado = 100% dos componentes);
//  (ii)  os mesmos componentes com juízes em outra ordem NÃO mudam o hash (ids
//        são conjunto);
//  (iii) o pin grava os componentes usados (auditoria de granularidade) e o
//        record mantém o hash de 32 hex que `runs show` imprime;
//  (iv)  drift entre runs do MESMO processo dispara `judge.contract.changed`
//        com sugestão de recalibração (o evento de IMPL-049 — agregado, sem
//        stageIndex, fora do reducer de etapas).
// ⚠️ Granularidade: o hash é byte a byte — mudança cosmética de prompt também
// muda o hash (decisão consciente, documentada em judgeCalibration).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import {
  judgeContractHash,
  noteJudgeContract,
  pinJudgeContract,
  resetJudgeContractMemory,
  type JudgeContractPin,
} from '../src/engine/judgeCalibration.js';
import type { JudgeContractComponents, RunConfig, RunEvent, RunRecord } from '../src/types.js';
import { subscribe } from '../src/events.js';
import { runToCompletion } from '../src/orchestrator.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { canaryOf } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const JUIZES = ['anthropic/claude-x', 'openai/gpt-y'];
const PROMPT_POINTWISE = 'Você é um juiz. Vereditos: resolve/parcial/nao.';

/** Componentes de referência — o caso completo do contrato (IMPL-049). */
const COMPONENTES: JudgeContractComponents = {
  duelPromptText: 'HEAD DO DUELO v1',
  listwisePromptText: 'PROMPT LISTWISE v1',
  referenceModelId: 'google/gemini-ref',
  judgeReasoningLevel: 'high',
  providerPolicy: '{"zdr":true}',
};

describe('IMPL-049 — o hash cobre cada componente do contrato', () => {
  const base = judgeContractHash(JUIZES, PROMPT_POINTWISE, COMPONENTES);

  it('é determinístico e estável (32 hex) para a MESMA entrada', () => {
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, COMPONENTES)).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{32}$/);
  });

  it('contrato_rastreado = 100%: trocar CADA componente muda o hash', () => {
    const trocas: Array<[string, JudgeContractComponents]> = [
      ['prompt do duelo', { ...COMPONENTES, duelPromptText: 'HEAD DO DUELO v2' }],
      ['prompt listwise', { ...COMPONENTES, listwisePromptText: 'PROMPT LISTWISE v2' }],
      ['modelo de referência', { ...COMPONENTES, referenceModelId: 'google/gemini-outro' }],
      ['think level', { ...COMPONENTES, judgeReasoningLevel: 'low' }],
      ['provedor', { ...COMPONENTES, providerPolicy: '{"zdr":false}' }],
    ];
    for (const [nome, c] of trocas) {
      expect(
        judgeContractHash(JUIZES, PROMPT_POINTWISE, c),
        `trocar o(a) ${nome} tem de mudar o hash`,
      ).not.toBe(base);
    }
    // …e os dois campos posicionais clássicos continuam cobertos:
    expect(judgeContractHash(['anthropic/claude-x', 'openai/gpt-z'], PROMPT_POINTWISE, COMPONENTES)).not.toBe(base);
    expect(judgeContractHash(JUIZES, `${PROMPT_POINTWISE} `, COMPONENTES)).not.toBe(base);
  });

  it('ausente ≠ presente: componente por omissão muda o hash (default é decisão)', () => {
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE)).not.toBe(base);
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeReasoningLevel: undefined })).not.toBe(
      base,
    );
  });

  it('juízes em outra ordem NÃO mudam o hash (ids são um conjunto)', () => {
    expect(judgeContractHash([...JUIZES].reverse(), PROMPT_POINTWISE, COMPONENTES)).toBe(base);
  });

  it('framing por comprimento vale também com componentes (["ab","c"] ≠ ["a","bc"])', () => {
    expect(
      judgeContractHash(['ab', 'c'], 'x', { referenceModelId: 'r' }),
    ).not.toBe(judgeContractHash(['a', 'bc'], 'x', { referenceModelId: 'r' }));
    expect(
      judgeContractHash(['j'], 'x', { referenceModelId: 'ab', judgeReasoningLevel: 'c' }),
    ).not.toBe(judgeContractHash(['j'], 'x', { referenceModelId: 'a', judgeReasoningLevel: 'bc' }));
  });

  it('o pin grava os componentes usados (auditoria de granularidade)', () => {
    const agora = new Date('2026-07-30T12:34:56.789Z');
    const pin: JudgeContractPin = pinJudgeContract(JUIZES, PROMPT_POINTWISE, agora, COMPONENTES);
    expect(pin.components).toEqual(COMPONENTES);
    expect(pin.hash).toBe(base);
    expect(pin.pinnedAt).toBe('2026-07-30T12:34:56.789Z');
    // Sem componentes o pin não inventa o campo (records antigos/legado).
    const legado = pinJudgeContract(JUIZES, PROMPT_POINTWISE, agora);
    expect(legado.components).toBeUndefined();
    expect(legado.hash).toBe(judgeContractHash(JUIZES, PROMPT_POINTWISE));
  });
});

describe('IMPL-049 — drift do contrato entre runs (memória do processo)', () => {
  beforeEach(() => resetJudgeContractMemory());

  it('primeira run é âncora (sem drift); mesmo hash => silêncio; hash novo => recalibrar', () => {
    const a = judgeContractHash(JUIZES, PROMPT_POINTWISE, COMPONENTES);
    const b = judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeReasoningLevel: 'low' });

    expect(noteJudgeContract(a)).toMatchObject({ changed: false, message: '' });
    expect(noteJudgeContract(a)).toMatchObject({ changed: false, message: '' });

    const drift = noteJudgeContract(b);
    expect(drift.changed).toBe(true);
    expect(drift.previousHash).toBe(a);
    expect(drift.message).toContain('recalibre');
    expect(drift.message).toContain('contrato do juiz mudou');

    // Continua estável depois do aviso (o novo hash vira âncora).
    expect(noteJudgeContract(b)).toMatchObject({ changed: false });
    resetJudgeContractMemory();
    expect(noteJudgeContract(b)).toMatchObject({ changed: false, message: '' });
  });
});

// ---------------------------------------------------------------------------
// Integração: o evento `judge.contract.changed` dispara de verdade entre runs
// do mesmo processo (servidor/sessão), com sugestão de recalibração.
// ---------------------------------------------------------------------------
describe('IMPL-049 — evento judge.contract.changed entre runs (pipeline Node)', () => {
  let dirAnterior: string;
  let tmp: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  let anterior: ReturnType<typeof setDefaultGateway> | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl049-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
    resetJudgeContractMemory();
  });
  afterEach(() => {
    if (anterior) setDefaultGateway(anterior);
    anterior = undefined;
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
    resetJudgeContractMemory();
  });

  const CONFIG = {
    mode: 'compare',
    theme: 'suporte',
    stages: 1,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    referenceModelId: 'fake/ref',
    referenceJudging: true,
    competitorModelIds: ['fake/a', 'fake/b'],
    finalists: 0,
    duels: false,
    timeoutMs: 5_000,
    customStages: [
      {
        question: 'Qual o prazo para trocar um produto?',
        productContext: 'Trocas em até 30 dias.',
        maxTokens: 200,
        reference: 'Trinta dias, com nota fiscal.',
      },
    ],
  } as unknown as RunConfig;

  const juizFake = () =>
    fakeOpenRouter({
      chat: (req) => ({
        text: JSON.stringify({
          canario: canaryOf(req),
          explanation: 'confere com a referência',
          verdict: 'resolve',
          confianca: 'alta',
        }),
        finishReason: 'stop',
      }),
    });

  it('1ª run ancora; 2ª run com think level diferente dispara o evento com sugestão de recalibração', async () => {
    const eventos1: RunEvent[] = [];
    const off1 = subscribe('run-impl049-1', (e) => eventos1.push(e));
    try {
      anterior = setDefaultGateway(createGateway({ fetch: juizFake().fetch, sleep: noSleep }));
      await runToCompletion(CONFIG, KEY, { runId: 'run-impl049-1' });
    } finally {
      off1();
    }
    expect(eventos1.some((e) => e.type === 'judge.contract.changed')).toBe(false);

    const eventos2: RunEvent[] = [];
    const off2 = subscribe('run-impl049-2', (e) => eventos2.push(e));
    let rec2: RunRecord | undefined;
    try {
      anterior = setDefaultGateway(createGateway({ fetch: juizFake().fetch, sleep: noSleep }));
      rec2 = await runToCompletion(
        { ...CONFIG, reasoning: { judge: 'high' } } as RunConfig,
        KEY,
        { runId: 'run-impl049-2' },
      );
    } finally {
      off2();
    }

    const mudou = eventos2.filter(
      (e): e is Extract<RunEvent, { type: 'judge.contract.changed' }> => e.type === 'judge.contract.changed',
    );
    expect(mudou).toHaveLength(1);
    expect(mudou[0].detail).toContain('judge.contract.changed');
    expect(mudou[0].detail).toContain('recalibre');
    expect(mudou[0].currentHash).not.toBe(mudou[0].previousHash);

    // 'runs show' continua imprimindo o hash: o record tem os 32 hex + componentes.
    expect(rec2!.judgeDiagnostics!.contract.hash).toMatch(/^[0-9a-f]{32}$/);
    expect(rec2!.judgeDiagnostics!.contract.components?.judgeReasoningLevel).toBe('high');
  });
});
