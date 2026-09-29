// IMPL-047 (critérios 3 e 4) — a parte CI-SAFE do A/B do prompt honesto do juiz.
//
// Os critérios em si (falso_nao_gabarito_errado < 50%; falso_resolve sobe ≤ 2
// p.p.) só se medem com juiz REAL — `scripts/judge-ab-pilot.ts`, opt-in, com
// --budget. Aqui, sem rede e sem gasto:
//  (a) a fixture de gabarito PROPOSITALMENTE errado é válida (≥ 30 itens PT-BR);
//  (b) o script RECUSA sem --budget (exit 2) e sem key (exit 4), antes de
//      qualquer rede;
//  (c) as métricas (taxa, n, IC 95% de Wilson, delta em p.p., critérios, parcial
//      no teto do orçamento) com juízes falsos injetados.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_BASELINE_REF,
  DEFAULT_FIXTURE,
  parseWrongReferenceFixture,
  runPilot,
  wilson,
  type PilotJudge,
} from '../scripts/judge-ab-pilot.js';
import { BudgetExceeded } from '../src/budget.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const SCRIPT = join(ROOT, 'scripts', 'judge-ab-pilot.ts');

const fixture = () => JSON.parse(readFileSync(DEFAULT_FIXTURE, 'utf8')) as unknown;

describe('IMPL-047 — fixture de gabarito propositalmente errado', () => {
  it('(a) ≥ 30 itens válidos, ids únicos, resposta correta ≠ gabarito errado', () => {
    const p = parseWrongReferenceFixture(fixture());
    expect(p.ok, p.ok ? '' : p.error).toBe(true);
    if (!p.ok) return;
    expect(p.items.length).toBeGreaterThanOrEqual(30);
    for (const it of p.items) {
      // PT-BR (acentuação) e rubrica que a resposta correta atende.
      expect(`${it.question}${it.rubric}${it.correctAnswer}`).toMatch(/[áéíóúâêôãõç]/i);
      expect(it.wrongReference).not.toBe(it.correctAnswer);
    }
  });

  it('o parser explica o defeito (nunca aceita fixture pequena ou incompleta)', () => {
    const f = fixture() as { format: string; items: Record<string, string>[] };
    expect(parseWrongReferenceFixture({ ...f, items: f.items.slice(0, 5) })).toMatchObject({ ok: false });
    expect(parseWrongReferenceFixture({ ...f, format: 'x' })).toMatchObject({ ok: false });
    const semRubrica = f.items.map((it, i) => (i === 3 ? { ...it, rubric: '' } : it));
    expect(parseWrongReferenceFixture({ ...f, items: semRubrica })).toMatchObject({
      ok: false,
      error: expect.stringContaining('rubric'),
    });
  });
});

describe('IMPL-047 — o script RECUSA antes de gastar', () => {
  const rodar = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(TSX, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf-8',
      timeout: 60_000,
      // Qualquer rede falharia rápido (porta fechada) — a recusa vem antes.
      env: { ...process.env, OPENROUTER_API_KEY: '', OPENROUTER_BASE_URL: 'http://127.0.0.1:9', ...env },
    });

  it('(b) sem --budget: exit 2, nada gasto', () => {
    const r = rodar(['--judge', 'x/juiz']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--budget');
    expect(r.stdout).toBe('');
  });

  it('(b) com --budget mas sem key: exit 4, nada gasto', () => {
    const r = rodar(['--judge', 'x/juiz', '--budget', '1']);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain('OPENROUTER_API_KEY');
  });
});

describe('IMPL-047 — métricas do A/B (juízes falsos injetados)', () => {
  const p = parseWrongReferenceFixture(fixture());
  const items = p.ok ? p.items.slice(0, 30) : [];

  // ANTERIOR: segue a referência cegamente — só aprova o que "bate" com ela
  // (condena a resposta certa quando a referência está errada).
  const segueReferencia: PilotJudge = async (_item, reference, candidate) =>
    candidate === reference ? 'resolve' : 'nao';
  // ATUAL: segue a rubrica — aprova a correta, reprova a errada.
  const segueRubrica: PilotJudge = async (item, _reference, candidate) =>
    candidate === item.correctAnswer ? 'resolve' : 'nao';

  it('(c) taxas com n e IC 95%; critérios avaliados; delta em p.p.', async () => {
    const r = await runPilot({ items, anterior: segueReferencia, atual: segueRubrica });
    expect(r.anterior.falsoNaoGabaritoErrado).toMatchObject({ rate: 1, k: 30, n: 30 });
    expect(r.atual.falsoNaoGabaritoErrado).toMatchObject({ rate: 0, k: 0, n: 30 });
    expect(r.atual.falsoNaoGabaritoErrado.ic95[0]).toBe(0);
    expect(r.atual.falsoNaoGabaritoErrado.ic95[1]).toBeLessThan(0.15);
    expect(r.deltaFalsoResolvePp).toBe(0);
    expect(r.criteria).toEqual({ falsoNaoAbaixoDe50: true, falsoResolveDeltaAte2pp: true });
    expect(r.partial).toBe(false);
  });

  it('falha do juiz sai do denominador (falha não é veredito)', async () => {
    const falhaMetade: PilotJudge = async (item) => (Number(item.id.slice(-2)) % 2 ? null : 'nao');
    const r = await runPilot({ items, anterior: falhaMetade, atual: falhaMetade });
    expect(r.atual.falsoNaoGabaritoErrado.n).toBe(15);
  });

  it('teto do --budget (BudgetExceeded) ⇒ relatório PARCIAL, dito', async () => {
    let n = 0;
    const caro: PilotJudge = async () => {
      n += 1;
      if (n > 10) throw new BudgetExceeded(1, 1, 'judge');
      return 'nao';
    };
    const r = await runPilot({ items, anterior: caro, atual: caro });
    expect(r.partial).toBe(true);
    expect(r.criteria.falsoNaoAbaixoDe50).toBe(false);
  });

  it('fiação REAL offline: o juiz ANTERIOR (src/refJudge.ts do git) e o ATUAL rodam no gateway falso', async () => {
    // Clone raso sem o commit de base: nada a provar aqui (o main diz o erro).
    const temRef = spawnSync('git', ['cat-file', '-e', `${DEFAULT_BASELINE_REF}:src/refJudge.ts`], { cwd: ROOT }).status === 0;
    if (!temRef) return;
    const { juizDoRef, comoJuiz } = await import('../scripts/judge-ab-pilot.js');
    const { judgeStageReference } = await import('../src/refJudge.js');
    const { createGateway, setDefaultGateway } = await import('../src/openrouter.js');
    const { fakeOpenRouter, noSleep } = await import('./fakeOpenRouter.js');
    const { canaryOf } = await import('./judgeReplies.js');
    const sistemas: string[] = [];
    const fake = fakeOpenRouter({
      chat: (req) => {
        sistemas.push(req.system);
        return { text: JSON.stringify({ canario: canaryOf(req), explanation: 'x', verdict: 'nao' }) };
      },
    });
    const anteriorGw = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    try {
      const base = { apiKey: 'sk-or-v1-fake-key-para-teste-0000000000', judge: 'fake/juiz', ctx: {} };
      const anterior = comoJuiz(await juizDoRef(DEFAULT_BASELINE_REF), base);
      const atual = comoJuiz(judgeStageReference, base);
      const r = await runPilot({ items: items.slice(0, 2), anterior, atual });
      expect(r.anterior.falsoNaoGabaritoErrado.n).toBe(2);
      expect(r.atual.falsoNaoGabaritoErrado.n).toBe(2);
      // Os dois prompts foram de fato usados: o anterior dizia "(correta)".
      expect(sistemas.some((s) => s.includes('RESPOSTA DE REFERÊNCIA (correta)'))).toBe(true);
      expect(sistemas.some((s) => s.includes('PODE ESTAR ERRADA'))).toBe(true);
    } finally {
      setDefaultGateway(anteriorGw);
    }
  });

  it('Wilson: limites em [0,1] e n = 0 é o intervalo inteiro', () => {
    expect(wilson(0, 0)).toEqual([0, 1]);
    const [lo, hi] = wilson(15, 30);
    expect(lo).toBeGreaterThan(0.3);
    expect(hi).toBeLessThan(0.7);
  });
});
