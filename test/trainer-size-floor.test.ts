// IMPL-071 (R-20:REC-6) — piso de tamanho contra o ORIGINAL da sessão (o piso
// composto contra o pai encolhia 0,3^k: 3000→900→270→81) e desempate por
// tamanho só entre variantes com o contrato never-break v2 VERDE.
//
// Critérios de aceite:
//  1) cadeia de 3 iterações encolhendo garante piso TOTAL contra o ORIGINAL
//     (900 caracteres mínimos numa base de 3000 — e não 81);
//  2) encolhimento acumulado por sessão limitado a minLengthRatio do original;
//  3) a suíte de contrato fica verde (npm test — os demais arquivos rodam no
//     pipeline do orquestrador; aqui só os escopados deste lote).

import { describe, expect, it } from 'vitest';
import { contractsAgainstOriginal } from '../src/variator.js';
import * as webVariator from '../web/src/engine/variator.js';
import { verifyRewrite, type PromptContracts } from '../src/engine/contracts.js';
import { buildRankEntries as nodeBuildRankEntries } from '../src/trainer.js';
import { buildRankEntries as webBuildRankEntries } from '../web/src/engine/trainer.js';
import { rankEntries } from '../src/rank.js';
import type { RunRecord } from '../src/types.js';

const ORIGINAL = 'R'.repeat(3000); // base de 3000 chars → piso 0,3 × 3000 = 900
const PISO = 900;

describe('IMPL-071 (1/2) — cadeia de encolhimento: piso contra o ORIGINAL', () => {
  it('3000→900→270→81: 900 é o piso TOTAL da sessão (o composto dava 81)', () => {
    // Padrão de chamada REAL do trainer: cada iteração recalcula a partir do
    // contrato do USUÁRIO (nunca do resultado escalado da anterior).
    let pai = ORIGINAL;

    // Geração 1: pai = original (3000). Piso = 0,3 × 3000 = 900.
    let contratos = contractsAgainstOriginal(undefined, ORIGINAL, pai);
    expect(contratos).toBeUndefined(); // pai == original: nada a ajustar
    expect(verifyRewrite(pai, 'g'.repeat(PISO), contratos).ok).toBe(true);
    expect(
      verifyRewrite(pai, 'g'.repeat(PISO - 1), contratos).violations.map((v) => v.kind),
    ).toContain('length');

    // Geração 2: pai = 900. O piso ANTERIOR era 0,3 × 900 = 270; agora segue 900.
    pai = 'g'.repeat(PISO);
    contratos = contractsAgainstOriginal(undefined, ORIGINAL, pai);
    expect(contratos!.minLengthRatio).toBeCloseTo(1, 6); // 0,3 × 3000 / 900
    expect(
      verifyRewrite(pai, 'g'.repeat(269), contratos).violations.map((v) => v.kind),
    ).toContain('length');
    expect(verifyRewrite(pai, 'g'.repeat(PISO), contratos).ok).toBe(true);

    // Geração 3: pai = 900 de novo — a cadeia adversarial 3000→900→270→81 morre
    // no 270; e o 81 é rejeitado em QUALQUER geração.
    pai = 'g'.repeat(PISO);
    contratos = contractsAgainstOriginal(undefined, ORIGINAL, pai);
    expect(
      verifyRewrite(pai, 'g'.repeat(81), contratos).violations.map((v) => v.kind),
    ).toContain('length');
    expect(verifyRewrite(pai, 'g'.repeat(PISO), contratos).ok).toBe(true);
  });

  it('encolhimento acumulado limitado a minLengthRatio do original em TODA geração', () => {
    for (const razao of [0.3, 0.5]) {
      const contratosUsuario: PromptContracts | undefined =
        razao === 0.3 ? undefined : { minLengthRatio: razao };
      const piso = Math.floor(ORIGINAL.length * razao);
      // Passeio adversarial: pais cada vez menores (até o piso antigo colapsar).
      for (const tamPai of [3000, 1500, 1000, 900, 500]) {
        const pai = 'p'.repeat(tamPai);
        const c = contractsAgainstOriginal(contratosUsuario, ORIGINAL, pai);
        // Piso efetivo = tamPai × ratio_ajustado = razao × ORIGINAL SEMPRE.
        const pisoEfetivo = Math.max(40, tamPai * (c?.minLengthRatio ?? 0.3));
        expect(Math.round(pisoEfetivo), `razão ${razao}, pai ${tamPai}`).toBe(piso);
        // Logo, uma reescrita abaixo do piso TOTAL reprova em toda geração…
        expect(verifyRewrite(pai, 'g'.repeat(piso - 1), c).ok).toBe(false);
        // …e uma reescrita com o piso do original passa em toda geração.
        expect(verifyRewrite(pai, 'g'.repeat(piso), c).ok).toBe(true);
      }
    }
  });

  it('sem original (treino só de tema) nada é inventado: vale a regra padrão do gate', () => {
    const c = contractsAgainstOriginal(undefined, '', 'p'.repeat(200));
    expect(c).toBeUndefined();
    // Com base (= pai) o piso segue o padrão 0,3 × pai (60 chars aqui)…
    expect(verifyRewrite('p'.repeat(200), 'x'.repeat(59), c).ok).toBe(false);
    expect(verifyRewrite('p'.repeat(200), 'x'.repeat(60), c).ok).toBe(true);
    // …e sem base nenhuma vale o piso absoluto de 40.
    expect(verifyRewrite('', 'x'.repeat(39), c).violations.map((v) => v.kind)).toContain('length');
    expect(verifyRewrite('', 'x'.repeat(40), c).ok).toBe(true);
  });

  it('o shim do SPA reexporta a MESMA função (fonte única)', () => {
    expect(webVariator.contractsAgainstOriginal).toBe(contractsAgainstOriginal);
  });
});

// ----------------------------------------------------------------------------
// IMPL-071 — desempate por tamanho SÓ entre variantes com contrato verde.
// ----------------------------------------------------------------------------

function runComEmpate(): RunRecord {
  const stage = (i: number) => ({
    index: i,
    spec: { question: `cenario ${i}`, productContext: 'ctx', maxTokens: 100, reference: 'ref' },
    responses: [],
    // Todos empatados em 'parcial' (judge-score 50): só o tamanho desempata.
    referenceJudge: {
      verdictByContestant: { carry: 'parcial', v0: 'parcial', v1: 'parcial', m0: 'parcial' },
      explanationByContestant: {},
      judgeModelId: 'fake/judge',
    },
    startedAt: '2026-09-27T00:00:00.000Z',
  });
  return {
    id: 'run-tie',
    status: 'finished',
    config: { mode: 'variation' },
    mode: 'variation',
    contestants: [
      { id: 'carry', label: 'Régua', modelId: 'fake/a', systemPrompt: 'c'.repeat(500) },
      // Variante VERDE (reescritor + gate de 3 camadas): o tamanho vale.
      { id: 'v0', label: 'curta', modelId: 'fake/a', systemPrompt: 'a'.repeat(100), techniqueId: 'cot' },
      { id: 'v1', label: 'longa', modelId: 'fake/a', systemPrompt: 'b'.repeat(300), techniqueId: 'constraints' },
      // Variante MANUAL (sem techniqueId): nunca passou pelo gate ⇒ sem desempate.
      { id: 'm0', label: 'manual', modelId: 'fake/a', systemPrompt: 'm'.repeat(50) },
    ],
    stages: [stage(0), stage(1), stage(2)],
    scoreboard: {},
    judgeScoreByContestant: { carry: 50, v0: 50, v1: 50, m0: 50 },
    totalCostUsd: 0,
    startedAt: '2026-09-27T00:00:00.000Z',
    finishedAt: '2026-09-27T00:00:01.000Z',
  } as unknown as RunRecord;
}

const MOTORES = [
  ['Node', nodeBuildRankEntries],
  ['SPA', webBuildRankEntries],
] as const;

describe('IMPL-071 — desempate por tamanho só entre variantes com contrato verde', () => {
  for (const [nome, buildRankEntries] of MOTORES) {
    it(`${nome}: com contratos ativos, só quem tem técnica (gate v2) disputa por tamanho`, () => {
      const entradas = buildRankEntries(runComEmpate(), 'carry', { contractsActive: true });
      const porId = Object.fromEntries(entradas.map((e) => [e.id, e]));
      // Verde (v0/v1): tamanho REAL entra no desempate.
      expect(porId.v0.promptLen).toBe(100);
      expect(porId.v1.promptLen).toBe(300);
      // Régua e manual (sem gate v2): promptLen ZERADO — o "mais curto vence"
      // não premia quem nunca passou pelo contrato (nem a régua).
      expect(porId.carry.promptLen).toBe(0);
      expect(porId.m0.promptLen).toBe(0);
      // Ordem total com o contrato vigente: sem gate v2 o tamanho é ZERADO
      // (m0 empatado em tudo não é penalizado pelo comprimento) e, entre as
      // VERDES, a mais curta vence o desempate (v0 antes de v1).
      const ordenado = rankEntries(entradas).filter((e) => !e.isControl);
      expect(ordenado.map((e) => e.id)).toEqual(['m0', 'v0', 'v1']);
    });

    it(`${nome}: sem contratos na sessão ninguém disputa por tamanho`, () => {
      const entradas = buildRankEntries(runComEmpate(), 'carry', { contractsActive: false });
      for (const e of entradas) expect(e.promptLen).toBe(0);
    });

    it(`${nome}: default (sem opts) preserva o contrato antigo — régua zerada`, () => {
      const entradas = buildRankEntries(runComEmpate(), 'carry');
      const porId = Object.fromEntries(entradas.map((e) => [e.id, e]));
      expect(porId.carry.promptLen).toBe(0);
      expect(porId.v0.promptLen).toBe(0); // sem opts.contractsActive ⇒ sem gate assumido
    });
  }
});