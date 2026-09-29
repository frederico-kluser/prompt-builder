// IMPL-117 (R-07b:REC-5) — hash de contrato do juiz: sensibilidade a TODOS os
// componentes que mudam a distribuição de veredito.
//
// O contrato cobre: prompts pointwise + duelo + listwise, esforço de julgamento,
// TEMPERATURA de amostragem, modelo de referência e política de provedor (além
// dos ids de juiz, que são CONJUNTO — a ordem de cadastro não muda a rúbrica).
// O gap do IMPL-117 era exatamente a temperatura (e o ponto que já tinha vindo
// no IMPL-049: prompts de duelo/listwise, esforço, referência, provedor).
//
// Critério de aceite provado aqui: "teste de sensibilidade: o hash de contrato
// muda quando qualquer prompt de juízo/esforço/temperatura/modelo de
// referência/provider policy mudar".
//
// O `runs reproduce --replay` (re-pontuar respostas gravadas a US$ 0) é provado
// em test/runs-replay.test.ts; o artefato por chamada de juízo (finish_reason,
// id da geração, SHA-256 da resposta) em test/judge-finish-per-vote.test.ts; a
// temperatura no pin REAL da run em test/baseline-contract-roundtrip.test.ts.

import { describe, expect, it } from 'vitest';
import {
  judgeContractHash,
  pinJudgeContract,
  type JudgeContractComponentsExt,
} from '../src/engine/judgeCalibration.js';

const JUIZES = ['anthropic/claude-x', 'openai/gpt-y'];
const PROMPT_POINTWISE = 'Você é um juiz. Vereditos: resolve/parcial/nao.';

const COMPONENTES: JudgeContractComponentsExt = {
  duelPromptText: 'HEAD DO DUELO v1',
  listwisePromptText: 'PROMPT LISTWISE v1',
  referenceModelId: 'google/gemini-ref',
  judgeReasoningLevel: 'high',
  judgeTemperature: 0,
  providerPolicy: '{"zdr":true}',
};

describe('IMPL-117 — sensibilidade do hash a cada componente do juízo', () => {
  const base = judgeContractHash(JUIZES, PROMPT_POINTWISE, COMPONENTES);

  it('é determinístico (32 hex) e a ordem dos ids não muda o contrato (conjunto)', () => {
    expect(base).toMatch(/^[0-9a-f]{32}$/);
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, COMPONENTES)).toBe(base);
    expect(judgeContractHash([...JUIZES].reverse(), PROMPT_POINTWISE, COMPONENTES)).toBe(base);
  });

  it('contrato_rastreado = 100%: prompts (pointwise/duelo/listwise), esforço, TEMPERATURA, referência e provedor', () => {
    const trocas: Array<[string, JudgeContractComponentsExt]> = [
      ['prompt do duelo', { ...COMPONENTES, duelPromptText: 'HEAD DO DUELO v2' }],
      ['prompt listwise', { ...COMPONENTES, listwisePromptText: 'PROMPT LISTWISE v2' }],
      ['esforço de julgamento', { ...COMPONENTES, judgeReasoningLevel: 'low' }],
      ['temperatura de amostragem', { ...COMPONENTES, judgeTemperature: 0.3 }],
      ['modelo de referência', { ...COMPONENTES, referenceModelId: 'google/gemini-outro' }],
      ['provider policy', { ...COMPONENTES, providerPolicy: '{"zdr":false}' }],
    ];
    for (const [nome, c] of trocas) {
      expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, c), `trocar(a) ${nome} tem de mudar o hash`).not.toBe(base);
    }
    // Prompt pointwise (posicional) e ids de juiz também.
    expect(judgeContractHash(JUIZES, `${PROMPT_POINTWISE} `, COMPONENTES)).not.toBe(base);
    expect(judgeContractHash(['anthropic/claude-x', 'openai/gpt-z'], PROMPT_POINTWISE, COMPONENTES)).not.toBe(base);
  });

  it('temperatura: ausente ≠ presente, e o formato canónico não colide (0 vs "0")', () => {
    const semTemperatura: JudgeContractComponentsExt = { ...COMPONENTES };
    delete semTemperatura.judgeTemperature;
    const hashSem = judgeContractHash(JUIZES, PROMPT_POINTWISE, semTemperatura);
    // Ausente entra vazio na serialização canônica — decisão é decisão.
    expect(hashSem).not.toBe(base);
    // `undefined` explícito é o mesmo que ausente (canónico único).
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeTemperature: undefined })).toBe(hashSem);
    // Números e strings com o mesmo valor colidem de propósito (mesmo contrato);
    // valores DIFERENTES nunca colidem.
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeTemperature: '0' })).toBe(base);
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeTemperature: 1 })).not.toBe(base);
    expect(judgeContractHash(JUIZES, PROMPT_POINTWISE, { ...COMPONENTES, judgeTemperature: '1' })).not.toBe(base);
  });

  it('o pin carrega os componentes usados (auditoria de granularidade) e o hash fecha', () => {
    const pin = pinJudgeContract(JUIZES, PROMPT_POINTWISE, new Date('2026-01-01T00:00:00Z'), COMPONENTES);
    expect(pin.hash).toBe(base);
    expect(pin.components?.judgeTemperature).toBe(0);
    expect(pin.components?.judgeReasoningLevel).toBe('high');
    expect(pin.components?.providerPolicy).toBe('{"zdr":true}');
    expect(pin.modelIds).toEqual(JUIZES);
    // Retrocompatibilidade: quem chama só com o contrato clássico continua a
    // compilar e a hashear (campos novos entram vazios).
    expect(typeof judgeContractHash(JUIZES, PROMPT_POINTWISE, { judgeReasoningLevel: 'high' })).toBe('string');
    expect(typeof judgeContractHash(JUIZES, PROMPT_POINTWISE)).toBe('string');
  });
});
