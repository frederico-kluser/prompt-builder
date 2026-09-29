// Modo JEV — datasets (JSONL/CSV/evals.json da skill), splits e o formato
// jev-config@1 (parse que nunca lança, resolve, competidores, compliance).

import { describe, expect, it } from 'vitest';
import {
  JEV_CONFIG_FORMAT,
  JEV_EXAMPLE_KINDS,
  assignSplits,
  buildContestants,
  datasetHash,
  jevComplianceView,
  jevExample,
  lintJevCases,
  lintJevSpec,
  parseJevConfig,
  parseJevDataset,
  resolveJevConfig,
  specFromInput,
  splitCounts,
  withSpecId,
  type JevCase,
  type JevQuestionSpec,
} from '../src/engine/jev/index.js';
import { checkRunPii } from '../src/engine/pii.js';

const SPEC = withSpecId({
  label: 's',
  questions: [
    { id: 'team', type: 'choice', instructions: 'Qual time?', criteria: { pag: 'x', front: 'y', outro: null }, keyMap: { pag: 'payments' } },
    { id: 'bug', type: 'noul', instructions: 'É bug?' },
    { id: 'urg', type: 'score', instructions: 'Urgência?', criteria: ['baixa', 'média', 'alta'] },
  ] as JevQuestionSpec[],
});

const SKILL_EVALS = [
  {
    name: 'en-bug-checkout',
    state: 'My checkout page shows a blank screen after I click Pay.',
    questions: {
      is_bug: { type: 'noul', instructions: 'Is the customer reporting a software defect?', criteria: { true: 'broken', false: 'question' } },
      team: { type: 'choice', instructions: 'Which team?', criteria: { account: 'a', payments: 'p', other: 'o' } },
    },
    expected: { is_bug: true, team: 'payments' },
  },
  {
    name: 'en-feature-request',
    state: 'Could you add a dark mode toggle?',
    questions: { is_bug: { type: 'noul', instructions: 'Is the customer reporting a software defect?', criteria: { true: 'broken', false: 'question' } } },
    expected: { is_bug: false },
  },
];

describe('datasets', () => {
  it('JSONL: ouro normalizado por tipo (sim/não, chave do fio → rótulo canônico, texto do nível → índice), alternativas', () => {
    const txt = [
      JSON.stringify({ id: 'a', state: 'x', expected: { bug: 'sim', team: 'pag', urg: 'alta' } }),
      JSON.stringify({ id: 'b', state: 'y', expected: { bug: 0, team: ['front', 'outro'], urg: 1 } }),
      '{ quebrado',
    ].join('\n');
    const r = parseJevDataset(txt, 'auto', SPEC);
    expect(r.format).toBe('jsonl');
    expect(r.cases[0].expected).toEqual({ bug: true, team: 'payments', urg: 2 });
    expect(r.cases[1].expected).toEqual({ bug: false, team: ['front', 'outro'], urg: 1 });
    expect(r.issues).toEqual([expect.objectContaining({ code: 'dataset.invalid_json', line: 3, column: 1 })]);
  });

  it('CSV: state.<caminho> vira objeto, a|b = alternativas, erro com linha e sugestão de rótulo', () => {
    const csv = 'id,state.ticket.body,state.canal,expected.team,expected.bug,tags\n' + 'c1,"tela, branca",web,front|outro,true,a;b\n' + 'c2,cobrança,app,paymnts,false,\n';
    const r = parseJevDataset(csv, 'csv', SPEC);
    expect(r.cases[0]).toMatchObject({ id: 'c1', state: { ticket: { body: 'tela, branca' }, canal: 'web' }, expected: { team: ['front', 'outro'], bug: true }, tags: ['a', 'b'] });
    const erro = r.issues.find((i) => i.code === 'labels.uncovered');
    expect(erro).toMatchObject({ line: 3 });
    expect(erro?.message).toMatch(/payments/);
  });

  it('evals.json da jev-agent-skill: name → id, spec extraída; pergunta divergente = erro', () => {
    const r = parseJevDataset(JSON.stringify(SKILL_EVALS));
    expect(r.format).toBe('skill-evals');
    expect(r.cases.map((c) => c.id)).toEqual(['en-bug-checkout', 'en-feature-request']);
    expect(r.spec?.questions.map((q) => q.id)).toEqual(['is_bug', 'team']);
    expect(r.cases[0].expected).toEqual({ is_bug: true, team: 'payments' });
    const divergente = JSON.parse(JSON.stringify(SKILL_EVALS));
    divergente[1].questions.is_bug.instructions = 'outra coisa?';
    expect(parseJevDataset(JSON.stringify(divergente)).issues.map((i) => i.code)).toContain('import.questions_divergent');
  });

  it('ids por hash do estado quando faltam; duplicatas saem com aviso; estado vazio é erro', () => {
    const r = parseJevDataset(JSON.stringify([{ state: 'x', expected: { bug: true } }, { state: 'x', expected: { bug: false } }, { state: '', expected: {} }]), 'json', SPEC);
    expect(r.cases.length).toBe(1);
    expect(r.cases[0].id).toMatch(/^c-[0-9a-f]{16}$/);
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['case.duplicate', 'state.empty']));
  });

  it('splits estratificados, determinísticos pela seed, e o split pinado vence', () => {
    const cases: JevCase[] = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, state: `t${i}`, expected: { team: i % 2 ? 'front' : 'payments' }, ...(i === 0 ? { split: 'holdout' as const } : {}) }));
    const a = assignSplits(cases, { holdoutRatio: 0.3, calibrationRatio: 0.2, seed: 1, spec: SPEC });
    const b = assignSplits(cases, { holdoutRatio: 0.3, calibrationRatio: 0.2, seed: 1, spec: SPEC });
    expect(a.map((c) => c.split)).toEqual(b.map((c) => c.split));
    expect(a[0].split).toBe('holdout');
    const n = splitCounts(a);
    expect(n.holdout).toBeGreaterThanOrEqual(11);
    expect(n.calib).toBeGreaterThanOrEqual(7);
    // estratificado: cada classe tem holdout
    for (const t of ['front', 'payments']) expect(a.some((c) => c.split === 'holdout' && c.expected.team === t)).toBe(true);
    const c = assignSplits(cases, { holdoutRatio: 0.3, calibrationRatio: 0.2, seed: 2, spec: SPEC });
    expect(c.map((x) => x.split)).not.toEqual(a.map((x) => x.split));
    expect(datasetHash(a)).not.toBe(datasetHash(c));
  });
});

describe('jev-config@1', () => {
  it('parse nunca lança; .strict() recusa chave desconhecida; formato errado explicado', () => {
    expect(parseJevConfig(null)).toMatchObject({ ok: false });
    expect(parseJevConfig({ format: 'arena-config@1' })).toMatchObject({ ok: false, error: expect.stringContaining('jev-config@1') });
    const ex = jevExample('triagem', 'eval');
    expect(parseJevConfig(ex).ok).toBe(true);
    const r = parseJevConfig({ ...ex, trainig: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/trainig|unrecognized/i);
  });

  it('todos os exemplos embarcados passam no parse, no resolve e no lint (eval/compare/train)', () => {
    for (const kind of JEV_EXAMPLE_KINDS) {
      for (const mode of ['eval', 'compare', 'train'] as const) {
        const p = parseJevConfig(jevExample(kind, mode));
        expect(p.ok, `${kind}/${mode}`).toBe(true);
        if (!p.ok) continue;
        const r = resolveJevConfig(p.config);
        if (kind === 'guardrail' && mode === 'train') {
          // 8 casos: o treino recusa por poucos casos (erro do lint dos casos), não do parse
          expect(r.ok).toBe(true);
          if (r.ok) expect(lintJevCases(r.resolved.cases, r.resolved.specs[0], { mode: 'train' }).some((i) => i.level === 'error')).toBe(true);
          continue;
        }
        expect(r.ok, `${kind}/${mode}: ${JSON.stringify(!r.ok && r.issues)}`).toBe(true);
        if (!r.ok) continue;
        const erros = [...lintJevSpec(r.resolved.specs[0], { mode }), ...lintJevCases(r.resolved.cases, r.resolved.specs[0], { mode })].filter((i) => i.level === 'error');
        if (mode !== 'train' || kind === 'triagem') expect(erros, `${kind}/${mode}`).toEqual([]);
      }
    }
  });

  it('competidores determinísticos; o 1º é o controle; regras de modo', () => {
    const p = parseJevConfig({
      ...jevExample('triagem', 'compare'),
      models: { decision: ['typesafe/jev-1.13', 'upstage/solar-decide'], llm: [{ modelId: 'openai/gpt-5-mini', reasoning: 'off' }] },
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const r = resolveJevConfig(p.config);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.resolved.contestants.map((c) => c.id);
    expect(ids).toEqual([
      'd:original@typesafe/jev-1.13',
      'd:original@upstage/solar-decide',
      'd:rubrica-estruturada@typesafe/jev-1.13',
      'd:rubrica-estruturada@upstage/solar-decide',
      'l:original@openai/gpt-5-mini#off',
    ]);
    expect(r.resolved.contestants[0].isControl).toBe(true);
    expect(r.resolved.contestants.at(-1)?.probabilitySource).toBe('verbalized');
    expect(r.resolved.primary).toBe('accuracy');
    expect(buildContestants(p.config, r.resolved.specs)).toEqual(r.resolved.contestants);
    // eval com 2 competidores é erro de modo
    const e = resolveJevConfig({ ...p.config, mode: 'eval' });
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.issues.map((i) => i.code)).toContain('mode.eval');
  });

  it('variante NÃO pode criar pergunta nova; train exige proponente para operadores de LLM', () => {
    const base = jevExample('triagem', 'compare') as Record<string, unknown>;
    const r = resolveJevConfig(parseJevConfigOk({ ...base, variants: [{ label: 'v', spec: { questions: { nova: { type: 'noul', instructions: 'x?' } } } }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.code)).toContain('variant.questions');
    const t = jevExample('triagem', 'train') as Record<string, unknown>;
    const r2 = resolveJevConfig(parseJevConfigOk({ ...t, train: { ...(t.train as object), operators: ['literalize'] } }));
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => i.code)).toContain('train.rewriter');
    const r3 = resolveJevConfig(parseJevConfigOk({ ...t, train: { ...(t.train as object), operators: ['translate_spec'] } }));
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.issues.map((i) => i.code)).toContain('train.operators');
  });

  it('alias móvel é aviso no treino; noul com hitl ≤ 0,5 avisa que nunca abstém', () => {
    const t = jevExample('triagem', 'train') as Record<string, unknown>;
    const r = resolveJevConfig(parseJevConfigOk({ ...t, models: { decision: ['~typesafe/jev-latest'] }, bands: { noul: { auto: 0.9, hitl: 0.5 } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('bands.noul_hitl');
    expect(lintJevSpec(r.resolved.specs[0], { modelId: '~typesafe/jev-latest', mode: 'train' }).map((i) => i.code)).toContain('model.alias');
  });

  it('visão de compliance: modelos por papel, proponente como optimizerModelId e ESTADOS varridos mesmo sob chave *Id', () => {
    const cfg = parseJevConfigOk({
      format: JEV_CONFIG_FORMAT,
      mode: 'train',
      spec: { questions: { b: { type: 'noul', instructions: 'É bug?' } } },
      cases: Array.from({ length: 24 }, (_, i) => ({ id: `c${i}`, state: { clienteId: i === 3 ? '529.982.247-25' : `x${i}` }, expected: { b: i % 2 === 0 } })),
      models: { decision: ['typesafe/jev-1.13'] },
      train: { rewriterModelId: 'openai/gpt-5-mini', operators: ['literalize'] },
    });
    const r = resolveJevConfig(cfg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = jevComplianceView(r.resolved);
    expect(v.competitorModelIds).toEqual(['typesafe/jev-1.13']);
    expect(v.optimizerModelId).toBe('openai/gpt-5-mini');
    const pii = checkRunPii(v);
    expect(pii.blocked.map((b) => b.path)).toEqual(['casos[3].estado']);
  });

  it('specFromInput preserva ordem e id muda com o conteúdo', () => {
    const a = specFromInput({ questions: { x: { type: 'noul', instructions: 'a?' }, y: { type: 'noul', instructions: 'b?' } } });
    const b = specFromInput({ questions: { x: { type: 'noul', instructions: 'a?' }, y: { type: 'noul', instructions: 'c?' } } });
    expect(a.questions.map((q) => q.id)).toEqual(['x', 'y']);
    expect(a.id).not.toBe(b.id);
    expect(a.id).toMatch(/^sha256:[0-9a-f]{16}$/);
  });
});

function parseJevConfigOk(json: unknown) {
  const p = parseJevConfig(json);
  if (!p.ok) throw new Error(p.error);
  return p.config;
}
