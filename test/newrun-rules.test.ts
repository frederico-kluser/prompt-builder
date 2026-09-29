// Regras do formulário de Nova Run (web/src/newRunRules.ts) — auditoria web-code.
//
//  web-code#6: o esforço do GABARITO vazava para o juiz e o duelo. O form
//    mandava `reasoning.judge = juiz ?? gabarito` e nunca `reasoning.gab`; o
//    engine resolve gab = gab ?? judge ?? 'high', judge = judge ?? 'medium',
//    duel = duel ?? judge ?? 'low'. Efeito: gabarito 'low' puxava juiz e duelo
//    para 'low'; juiz 'minimal' + gabarito 'high' mandava o gabarito em
//    'minimal'. Agora cada papel vem do ajuste do SEU modelo.
//  web-code#15: o nº de cenários não tinha clamp no envio — 0 terminava a run
//    'inconclusive' e 2.5 virava "alvo: 2.5" no gerador. Clamp num lugar só +
//    pendência (nada corrigido calado).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clampStages, reasoningFromTuning, stagesProblem, STAGES_MAX, STAGES_MIN } from '../web/src/newRunRules.js';
import { reasoningLevelForRole } from '../web/src/modelCaps.js';
import { reasoningLevelForRole as reasoningLevelForRoleNode } from '../src/modelCaps.js';

const NEWRUN = readFileSync(join(process.cwd(), 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');

const papeis = (r: ReturnType<typeof reasoningFromTuning>) => ({
  judge: reasoningLevelForRole(r, 'judge'),
  duel: reasoningLevelForRole(r, 'duel'),
  gab: reasoningLevelForRole(r, 'gab'),
});

describe('web-code#6 — esforço por papel de juízo: o gabarito não vaza', () => {
  it('só o gabarito ajustado (low): juiz e duelo ficam nos defaults do papel', () => {
    const r = reasoningFromTuning({
      tuning: { 'x/ref': { effort: 'low' } },
      isSingle: false,
      judge: 'x/judge',
      reference: 'x/ref',
    });
    expect(r).toEqual({ gab: 'low' });
    expect(papeis(r)).toEqual({ judge: 'medium', duel: 'low', gab: 'low' });
  });

  it('juiz minimal + gabarito high: o gabarito vai em high (antes ia em minimal)', () => {
    const r = reasoningFromTuning({
      tuning: { 'x/judge': { effort: 'minimal' }, 'x/ref': { effort: 'high' } },
      isSingle: false,
      judge: 'x/judge',
      reference: 'x/ref',
    });
    expect(r).toEqual({ judge: 'minimal', gab: 'high' });
    // duelo sem campo próprio = legado: acompanha o juiz.
    expect(papeis(r)).toEqual({ judge: 'minimal', duel: 'minimal', gab: 'high' });
    // Os dois motores leem o mesmo contrato (modelCaps do Node = do web).
    expect(reasoningLevelForRoleNode(r, 'gab')).toBe('high');
    expect(reasoningLevelForRoleNode(r, 'judge')).toBe('minimal');
  });

  it('gabarito vazio (1º juiz escreve): o esforço do juiz vale para os dois papéis', () => {
    const r = reasoningFromTuning({ tuning: { 'x/judge': { effort: 'low' } }, isSingle: false, judge: 'x/judge' });
    expect(r).toEqual({ judge: 'low' });
    expect(papeis(r)).toEqual({ judge: 'low', duel: 'low', gab: 'low' });
  });

  it('demais papéis seguem o próprio modelo; competidor só nos modos de 1 modelo', () => {
    const tuning = {
      'x/a': { effort: 'high' as const },
      'x/gen': { effort: 'low' as const },
      'x/rw': { effort: 'medium' as const },
    };
    expect(
      reasoningFromTuning({ tuning, isSingle: true, contestant: 'x/a', datagen: 'x/gen', rewriter: 'x/rw' }),
    ).toEqual({ competitor: 'high', datagen: 'low', rewriter: 'medium' });
    // compare: o esforço de competidor é POR competidor (competitorConfigs).
    expect(reasoningFromTuning({ tuning, isSingle: false, contestant: 'x/a' })).toEqual({});
    // '' = padrão do provedor: não envia nada.
    expect(reasoningFromTuning({ tuning: { 'x/j': { effort: '' } }, isSingle: false, judge: 'x/j' })).toEqual({});
  });

  it('a Nova Run usa a regra (sem o fallback `juiz ?? gabarito`)', () => {
    expect(NEWRUN).toMatch(/reasoningFromTuning\(\{/);
    expect(NEWRUN).toMatch(/reference: referenceModel\[0\]/);
    expect(NEWRUN).not.toMatch(/effortOf\(judge\[0\]\) \?\? effortOf\(referenceModel\[0\]\)/);
  });
});

describe('web-code#15 — nº de cenários: clamp no envio + pendência', () => {
  it('clampStages: inteiro em 1–50, nunca 0/fração/NaN', () => {
    expect(clampStages(0)).toBe(STAGES_MIN);
    expect(clampStages(-3)).toBe(STAGES_MIN);
    expect(clampStages(2.5)).toBe(3);
    expect(clampStages(2.4)).toBe(2);
    expect(clampStages(100)).toBe(STAGES_MAX);
    expect(clampStages(Number.NaN)).toBe(STAGES_MIN);
    expect(clampStages(Number.POSITIVE_INFINITY)).toBe(STAGES_MIN);
    expect(clampStages(7)).toBe(7);
  });

  it('stagesProblem: avisa (não corrige calado) fora da faixa ou fracionário', () => {
    for (const ruim of [0, -1, 2.5, 51, 100, Number.NaN]) expect(stagesProblem(ruim), String(ruim)).toMatch(/1 e 50/);
    for (const bom of [1, 5, 50]) expect(stagesProblem(bom), String(bom)).toBeNull();
  });

  it('a Nova Run envia/estima o valor com clamp e mostra a pendência', () => {
    // O plannedStages (o que vai em `stages:` e na estimativa) sai do clamp.
    expect(NEWRUN).toMatch(/const stagesNum = clampStages\(stages\)/);
    expect(NEWRUN).toMatch(/Math\.max\(stagesNum, seedCount\)/);
    expect(NEWRUN).toMatch(/stages: plannedStages/);
    // A pendência só existe quando o campo aparece (sem etapas cruas).
    expect(NEWRUN).toMatch(/rawStages \? null : stagesProblem\(stages\)/);
  });
});
