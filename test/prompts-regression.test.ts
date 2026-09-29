// IMPL-070 (restante) — `prompt-builder prompts regression`: suíte FIXA de
// regressão dos meta-prompts internos, com limiares e exit ≠ 0 abaixo deles.
//
// Antes: "Comando desconhecido: prompts" — nenhum caso fixo, nenhum limiar,
// editar o texto de um meta-prompt mudava toda sessão sem nada acusar.
// Contratos aqui (transporte falso, zero rede, zero gasto real):
//   (1) o conjunto é FIXO: 80 reescritas (8 bases × 10 técnicas) + 40
//       canários de contrato (4 categorias × 10) = 120, mais os casos por papel;
//   (2) métricas puras: κ de Cohen, diversidade por 8-gramas e o portão;
//   (3) suíte boa → exit 0 com o relatório; reescritor que só COPIA o base
//       (diversidade 0) e gabarito que não sai → exit 10 `gate.prompts_regression`;
//   (4) `--dry-run` estima o TETO pelo catálogo sem key e sem nenhum POST;
//   (5) todo gasto passa pelo ledger (custo medido por papel no relatório).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import {
  cmdPrompts,
  cohenKappa,
  evaluateRegression,
  regressionCases,
  regressionPlan,
  REGRESSION_ROLES,
  REGRESSION_THRESHOLDS,
  rewriteDiversity,
} from '../src/cli/commands/prompts.js';
import { COMMANDS } from '../src/cli/help.js';
import { EXIT, resetOutputState, toCliError } from '../src/cli/output.js';
import { BASE_GENERATION_SYSTEM_PROMPT, REWRITER_SYSTEM_PROMPT, REFLECT_SYSTEM_PROMPT } from '../src/variator.js';
import { GABARITO_ROLE_PROMPT, GABARITO_VERIFIER_SYSTEM_PROMPT } from '../src/gabarito.js';
import {
  ADVERSARIAL_CATEGORIES,
  ADVERSARIAL_SYSTEM_PROMPT,
  buildAdversarialMessages,
  DATAGEN_STAGE_SYSTEM_PROMPT,
  diversityInstruction,
} from '../src/datagen.js';
import { DIFF_JUDGE_SYSTEM } from '../src/engine/contractLayers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readMarkedBlock } from '../src/engine/judgeGuard.js';
import { pinJudgeContract } from '../src/engine/judgeCalibration.js';
import { pipelineMetaPromptTexts, pipelineMetaPromptsFingerprint } from '../src/metaPrompts.js';
import { metaPromptsFingerprint } from '../src/engine/contracts.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion } from '../src/orchestrator.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeChatReply, type FakeRequest } from './fakeOpenRouter.js';
import { pointwiseReply } from './judgeReplies.js';

const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';
const CATALOGO = ['fake/m', 'fake/j'].map((id) => catalogItem(id, 1e-7, 2e-7));

describe('IMPL-070 (1) — o conjunto de casos é FIXO', () => {
  it('80 reescritas + 40 canários (4 categorias × 10) = 120; papéis extras fixos', () => {
    const c = regressionCases();
    expect(c.rewrites).toHaveLength(80);
    expect(c.canaries).toHaveLength(40);
    const porCategoria = new Map<string, number>();
    for (const k of c.canaries) porCategoria.set(k.category!, (porCategoria.get(k.category!) ?? 0) + 1);
    expect([...porCategoria.values()]).toEqual([10, 10, 10, 10]);
    expect(new Set(c.rewrites.map((r) => r.technique)).size).toBe(10);
    expect(c.labeled.length).toBe(10);
    // Determinístico: duas chamadas = o mesmo conjunto (ids estáveis).
    expect(regressionCases().rewrites.map((r) => r.id)).toEqual(c.rewrites.map((r) => r.id));
    expect(COMMANDS).toContain('prompts');
  });

  it('plano: 180 chamadas na rodada completa; --roles recorta', () => {
    const cheio = regressionPlan([...REGRESSION_ROLES]);
    expect(Object.values(cheio.calls).reduce((a, b) => a + b, 0)).toBe(80 + 40 + 5 + 5 + 30 + 20);
    const so = regressionPlan(['canary']);
    expect(so.calls).toMatchObject({ canary: 40, rewriter: 0, judge: 0 });
  });
});

describe('IMPL-070 (2) — métricas e portão (puros)', () => {
  it('κ de Cohen: concordância total = 1; aleatória ≈ 0; constante = indefinido/0', () => {
    expect(cohenKappa([true, false, true, false], [true, false, true, false])).toBe(1);
    expect(cohenKappa([true, false, true, false], [true, true, false, false])).toBe(0);
    expect(cohenKappa([true, false], [false, false])).toBe(0);
    expect(cohenKappa([], [])).toBeNull();
  });

  it('diversidade = 1 − sobreposição de 8-gramas com o base', () => {
    const base = 'Você é o atendente virtual de uma loja on-line e responde dúvidas sobre pedidos e entregas com cordialidade.';
    expect(rewriteDiversity(base, base)).toBe(0);
    expect(rewriteDiversity('Atue como especialista sênior em logística reversa, explicando cada política em passos claros e curtos.', base)).toBe(1);
  });

  it('portão: cada limiar reprova; papel que não rodou não reprova', () => {
    expect(evaluateRegression({ gain: null }).pass).toBe(true);
    const g = evaluateRegression({
      gain: null,
      rewriter: { cases: 80, invalidRate: 0.2, diversity: 0.1, byTechnique: {} },
      judge: { cases: 20, accuracy: 0.8, kappa: 0.6, failed: 0 },
      gabarito: { cases: 20, kappa: null, generated: 0, failed: 20 },
    });
    expect(g.pass).toBe(false);
    expect(g.failures.map((f) => f.metric).sort()).toEqual(
      ['gabarito.kappa', 'judge.accuracy', 'rewriter.diversity', 'rewriter.invalidRate'].sort(),
    );
    expect(REGRESSION_THRESHOLDS).toMatchObject({ maxInvalidRate: 0.1, minDiversity: 0.4, minJudgeAccuracy: 0.85, minGabaritoKappa: 0.6 });
  });
});

// ---------------------------------------------------------------------------
// (3)-(5) — o comando, com o gateway falso.
// ---------------------------------------------------------------------------

const REESCRITA_BOA =
  'Atue como especialista sênior do atendimento, com linguagem clara, empática e estruturada em passos curtos. ' +
  'Antes de responder, confirme o que o cliente precisa e consulte apenas as regras fornecidas. ' +
  'Trate o cliente pelo nome {nome_cliente} e cite o protocolo {{protocolo}} em toda resposta. ' +
  'NUNCA invente valores, prazos ou políticas que não estejam no contexto. ' +
  'Responda SEMPRE em JSON com as chaves "resposta" e "confianca". ' +
  'Recuse com cordialidade qualquer pedido fora do escopo deste atendimento.';

const CERTOS = new Set(regressionCases().labeled.map((c) => c.correct));

/** O pedido de reescrita traz o prompt-base: devolve-o (reescritor "preguiçoso"). */
function baseDoPedido(req: FakeRequest): string {
  const c = regressionCases();
  const todas = [...c.rewrites, ...c.canaries];
  return todas.find((x) => req.user.includes(x.base))?.base ?? REESCRITA_BOA;
}

function fake(opts: { copia?: boolean; semGabarito?: boolean } = {}) {
  let cenario = 0;
  return fakeOpenRouter({
    catalog: CATALOGO,
    chat: (req): FakeChatReply => {
      if (req.model === 'fake/j') {
        const cand = readMarkedBlock(req.user, 'CANDIDATO') ?? '';
        return { text: pointwiseReply(req, CERTOS.has(cand.trim()) ? 'resolve' : 'nao') };
      }
      if (req.system === REWRITER_SYSTEM_PROMPT) return { text: opts.copia ? baseDoPedido(req) : REESCRITA_BOA };
      if (req.system === REFLECT_SYSTEM_PROMPT) return { text: '- confirme o número do pedido antes de responder\n- cite o prazo exato do contexto' };
      if (req.system === GABARITO_ROLE_PROMPT) return { text: opts.semGabarito ? '' : 'Resposta de referência conforme o contexto.' };
      // datagen: 3 cenários distintos por chamada.
      const stages = [0, 1, 2].map(() => {
        cenario += 1;
        return { question: `Pergunta distinta número ${cenario} sobre o tema?`, productContext: `Regra ${cenario}.`, maxTokens: 200 };
      });
      return { text: JSON.stringify({ stages }) };
    },
  });
}

async function invocar(args: string[], f: ReturnType<typeof fake>) {
  const dir = mkdtempSync(join(tmpdir(), 'pb-impl070-'));
  const prev = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
  resetOutputState();
  let saida = '';
  const mudos = [
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      saida += String(c);
      return true;
    }),
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    vi.spyOn(console, 'warn').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  try {
    const exit = await cmdPrompts([...args, '--json', '--data-dir', dir]);
    return { exit, payload: JSON.parse(saida.trim().split('\n').pop() ?? '{}') as Record<string, unknown> };
  } catch (e) {
    const err = toCliError(e);
    return { exit: err.code, errorCode: err.errorCode, details: err.details as Record<string, unknown> };
  } finally {
    mudos.forEach((m) => m.mockRestore());
    resetOutputState();
    setDefaultGateway(prev);
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => resetOutputState());

describe('IMPL-070 (3)/(5) — prompts regression ponta a ponta', { timeout: 60_000 }, () => {
  it('suíte saudável: exit 0, todos os papéis medidos, custo medido por papel', async () => {
    const f = fake();
    const r = await invocar(['regression', '--model', 'fake/m', '--judge', 'fake/j', '--budget', '2', '--key', KEY], f);
    expect(r.exit, JSON.stringify(r).slice(0, 800)).toBe(EXIT.OK);
    const rel = (r.payload as { data: Record<string, unknown> }).data as {
      metrics: Record<string, Record<string, unknown>>;
      gate: { pass: boolean };
      costUsd: number;
      costByRole: Record<string, number>;
      promptsFingerprint: string;
    };
    expect(rel.gate.pass).toBe(true);
    expect(rel.metrics.rewriter).toMatchObject({ cases: 80, invalidRate: 0 });
    expect(rel.metrics.rewriter.diversity as number).toBeGreaterThanOrEqual(0.4);
    expect(rel.metrics.canary).toMatchObject({ cases: 40, invalidRate: 0 });
    expect(rel.metrics.reflection).toMatchObject({ cases: 5, invalidRate: 0 });
    expect(rel.metrics.datagen).toMatchObject({ requested: 15, delivered: 15, invalidRate: 0 });
    expect(rel.metrics.judge).toMatchObject({ cases: 20, accuracy: 1, kappa: 1 });
    expect(rel.metrics.gabarito).toMatchObject({ kappa: 1, generated: 10 });
    expect((rel.metrics as unknown as { gain: unknown }).gain).toBeNull();
    // Dinheiro MEDIDO (usage.cost do fake) e por papel, pelo ledger.
    expect(rel.costUsd).toBeGreaterThan(0);
    expect(Object.keys(rel.costByRole).sort()).toEqual(['datagen', 'gabarito', 'judge', 'rewriter']);
    expect(rel.promptsFingerprint).toMatch(/^[0-9a-f]{64}$/);
    // 180 chamadas de chat (sem retry, sem correção: tudo passou de primeira).
    expect(f.chatRequests()).toHaveLength(180);
  });

  it('reescritor que COPIA o base e gabarito que não sai: exit 10 gate.prompts_regression', async () => {
    const r = await invocar(
      ['regression', '--model', 'fake/m', '--judge', 'fake/j', '--budget', '2', '--key', KEY, '--roles', 'rewriter,gabarito'],
      fake({ copia: true, semGabarito: true }),
    );
    expect(r.exit).toBe(EXIT.GATE_BLOCKED);
    expect(r.errorCode).toBe('gate.prompts_regression');
    const rel = (r.details as { report: { gate: { failures: { metric: string }[] } } }).report;
    expect(rel.gate.failures.map((x) => x.metric)).toEqual(expect.arrayContaining(['rewriter.diversity', 'gabarito.kappa']));
  });

  // Revisão w2: resposta sem `usage` com id de geração fica PENDENTE no ledger
  // — fora de spentUsd/byRole/accuracy.unknown. Sem conciliar, o relatório
  // mostrava US$ 0 para chamada paga com `unknownCostCalls: 0`.
  it('juiz sem `usage`: concilia pelo /generation no fim; o que não concilia sai como pendente, nunca US$ 0 calado', async () => {
    const gid = (n: number): string => `gen-1759150000-${String(n).padStart(20, 'y')}`;
    const semUsage = (conciliavel: boolean) => {
      let n = 0;
      const ids: string[] = [];
      // `--roles judge`: só o juiz é chamado (casos fixos da suíte).
      const chat = fakeOpenRouter({
        catalog: CATALOGO,
        chat: (req): FakeChatReply => {
          const cand = readMarkedBlock(req.user, 'CANDIDATO') ?? '';
          const id = gid(++n);
          ids.push(id);
          return { text: pointwiseReply(req, CERTOS.has(cand.trim()) ? 'resolve' : 'nao'), id, usage: null };
        },
      });
      const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
        const u = new URL(url);
        if (u.pathname.endsWith('/generation')) {
          if (!conciliavel) return new Response('{"error":"not found"}', { status: 404 });
          return new Response(JSON.stringify({ data: { id: u.searchParams.get('id'), total_cost: 0.002, is_byok: false } }), { status: 200 });
        }
        return chat.fetch(url, init as never);
      };
      return { fetch, chatRequests: () => chat.chatRequests(), ids };
    };
    type Rel = { costUsd: number; costByRole: Record<string, number>; unknownCostCalls: number; pendingUsd: number; pendingCalls: number };
    const relDe = (r: Awaited<ReturnType<typeof invocar>>): Rel => (r.payload as { data: Rel }).data;

    // (a) fatura disponível: o custo do juiz entra MEDIDO pela conciliação.
    const ok = semUsage(true);
    const a = await invocar(['regression', '--model', 'fake/m', '--judge', 'fake/j', '--budget', '2', '--key', KEY, '--roles', 'judge'], ok as never);
    expect(a.exit, JSON.stringify(a).slice(0, 600)).toBe(EXIT.OK);
    expect(ok.ids.length).toBeGreaterThan(0);
    expect(relDe(a).pendingCalls).toBe(0);
    expect(relDe(a).costByRole.judge).toBeCloseTo(0.002 * ok.ids.length, 9);

    // (b) sem fatura (404): pendente no relatório, com o valor reservado.
    const pend = semUsage(false);
    const b = await invocar(['regression', '--model', 'fake/m', '--judge', 'fake/j', '--budget', '2', '--key', KEY, '--roles', 'judge'], pend as never);
    expect(b.exit, JSON.stringify(b).slice(0, 600)).toBe(EXIT.OK);
    expect(relDe(b).pendingCalls).toBe(pend.ids.length);
    expect(relDe(b).pendingUsd).toBeGreaterThan(0);
  });

  it('subcomando desconhecido / modelo ausente / --roles inválido: exit 2', async () => {
    expect((await invocar(['nada'], fake())).exit).toBe(EXIT.USAGE);
    expect((await invocar(['regression', '--judge', 'fake/j', '--budget', '1', '--key', KEY], fake())).errorCode).toBe('usage.missing_flag');
    expect(
      (await invocar(['regression', '--model', 'fake/m', '--judge', 'fake/j', '--roles', 'xyz', '--budget', '1', '--key', KEY], fake())).errorCode,
    ).toBe('usage.invalid_flag_value');
  });
});

describe('IMPL-070 (4) — --dry-run estima o teto sem key e sem gastar', () => {
  it('nenhum POST; teto numérico e ≤ US$ 2 com modelos baratos', async () => {
    const f = fake();
    const anterior = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const r = await invocar(['regression', '--model', 'fake/m', '--judge', 'fake/j', '--dry-run'], f);
      expect(r.exit, JSON.stringify(r).slice(0, 500)).toBe(EXIT.OK);
      const d = (r.payload as { data: { estimate: { highUsd: number; calls: number } } }).data;
      expect(d.estimate.calls).toBe(180);
      expect(d.estimate.highUsd).toBeGreaterThan(0);
      expect(d.estimate.highUsd).toBeLessThanOrEqual(2);
      expect(f.chatRequests()).toHaveLength(0);
    } finally {
      if (anterior !== undefined) process.env.OPENROUTER_API_KEY = anterior;
    }
  });
});

// ---------------------------------------------------------------------------
// Critério 2 — o hash de contrato DA RUN muda com o texto dos meta-prompts.
// ---------------------------------------------------------------------------

describe('IMPL-070 (c2) — runContractHash cobre reescritor, reflexão e datagen', () => {
  // Revisão w2: o teste anterior editava uma CÓPIA do mapa e re-hasheava —
  // qualquer mapa passaria. Agora: (a) cada constante/builder LLM-facing do
  // pipeline tem o texto DENTRO do mapa real; (b) a varredura dos
  // `role: 'system'` dos módulos do pipeline falha quando aparece mensagem de
  // sistema nova sem registro em src/metaPrompts.ts.
  it('cobertura: o texto de cada meta-prompt do pipeline está no mapa do fingerprint', () => {
    const valores = Object.values(pipelineMetaPromptTexts());
    const presente = (t: string) => valores.some((v) => v.includes(t));
    const obrigatorios: Record<string, string> = {
      REWRITER_SYSTEM_PROMPT,
      REFLECT_SYSTEM_PROMPT,
      BASE_GENERATION_SYSTEM_PROMPT,
      GABARITO_ROLE_PROMPT,
      GABARITO_VERIFIER_SYSTEM_PROMPT,
      DATAGEN_STAGE_SYSTEM_PROMPT,
      ADVERSARIAL_SYSTEM_PROMPT,
      DIFF_JUDGE_SYSTEM,
      // Builders: o molde fixo (sem o que vem da config/rodada).
      'datagen/backfill-diversity': diversityInstruction(2, 3, 4).split('rodada')[0],
      'datagen/batch-user': 'Gere os 1 cenarios em JSON conforme as regras.',
      'rewriter/user-template': 'Reescreva o prompt agora, aplicando a tecnica.',
      'gabarito/user-template': 'Responda APENAS com a resposta de referência ideal',
    };
    for (const [nome, texto] of Object.entries(obrigatorios)) {
      expect(texto.trim().length, nome).toBeGreaterThan(10);
      expect(presente(texto), `${nome} fora de pipelineMetaPromptTexts()`).toBe(true);
    }
    for (const c of ADVERSARIAL_CATEGORIES) {
      const [, user] = buildAdversarialMessages({ category: c, count: 1, baseSystemPrompt: '' });
      expect(presente(user.content as string), `adversarial/${c}`).toBe(true);
    }
  });

  it('varredura: toda mensagem de SISTEMA dos módulos do pipeline está classificada (registrada)', () => {
    // Expressão do `content` de cada `role: 'system'` → coberta por qual chave.
    // Mensagem de sistema NOVA: registre o texto em src/metaPrompts.ts e
    // classifique aqui (senão o runContractHash não muda quando ela muda).
    const CLASSIFICADAS: Record<string, string[]> = {
      'src/variator.ts': ['REWRITER_SYSTEM_PROMPT', 'BASE_GENERATION_SYSTEM_PROMPT', 'REFLECT_SYSTEM_PROMPT'],
      'src/datagen.ts': [
        '`${DATAGEN_STAGE_SYSTEM_PROMPT}\\n${languageLine(languages)}`',
        // `rendered.system` = regras do USUÁRIO (config); o resto é o batch-system.
        '`${rendered.system}\\n\\n---\\n\\n${systemComContrato}`',
        'systemComContrato',
        'ADVERSARIAL_SYSTEM_PROMPT',
      ],
      'src/gabarito.ts': ['GABARITO_ROLE_PROMPT', 'GABARITO_VERIFIER_SYSTEM_PROMPT'],
      'src/engine/contractLayers.ts': ['DIFF_JUDGE_SYSTEM'],
    };
    const ROOT = fileURLToPath(new URL('..', import.meta.url));
    for (const [rel, ok] of Object.entries(CLASSIFICADAS)) {
      const fonte = readFileSync(join(ROOT, rel), 'utf8');
      const achadas = [...fonte.matchAll(/role:\s*'system',\s*content:\s*([^\n]+?)\s*\},?\s*$/gm)].map((m) => m[1]);
      expect(achadas.length, rel).toBeGreaterThan(0);
      // Mensagem de sistema escrita noutro formato (multilinha, `as const`…)
      // também conta: o total de `role: 'system',` tem de bater com o varrido.
      const total = (fonte.match(/role:\s*'system'\s*(?:as const\s*)?,/g) ?? []).length;
      expect(achadas.length, `${rel}: mensagem de sistema fora do formato varrido`).toBe(total);
      for (const expr of achadas) {
        expect(ok, `${rel}: mensagem de sistema NÃO registrada no fingerprint: ${expr}`).toContain(expr);
      }
    }
  });

  it('editar o texto de uma constante REAL muda o fingerprint do pipeline; o hash do juiz não muda', () => {
    const base = pinJudgeContract(['j/x'], 'PROMPT DO JUIZ', undefined, undefined, {
      metaPromptsFingerprint: pipelineMetaPromptsFingerprint(),
    });
    expect(base.metaPromptsFingerprint).toBe(pipelineMetaPromptsFingerprint());
    expect(base.runContractHash).toMatch(/^[0-9a-f]{32}$/);
    const textos = pipelineMetaPromptTexts();
    for (const chave of Object.keys(textos)) {
      const editado = metaPromptsFingerprint({ ...textos, [chave]: `${textos[chave]} ` });
      const pin = pinJudgeContract(['j/x'], 'PROMPT DO JUIZ', undefined, undefined, { metaPromptsFingerprint: editado });
      expect(pin.runContractHash, chave).not.toBe(base.runContractHash);
      expect(pin.hash, chave).toBe(base.hash);
    }
  });

  it('a run (Node) grava o fingerprint e o hash da run no pin do juiz', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-impl070-run-'));
    const antes = getDataDir();
    setDataDir(dir);
    const f = fakeOpenRouter({
      catalog: ['fake/judge', 'fake/a', 'fake/b', 'fake/gen'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => (req.model === 'fake/judge' ? { text: pointwiseReply(req, 'resolve') } : { text: `Resposta de ${req.model}` }),
    });
    const prev = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
    const mudos = (['log', 'warn', 'error'] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const rec = await runToCompletion(
        {
          mode: 'compare',
          theme: 't',
          stages: 1,
          datagenModelId: 'fake/gen',
          judgeModelIds: ['fake/judge'],
          referenceJudging: true,
          competitorModelIds: ['fake/a', 'fake/b'],
          customStages: [{ question: 'Q?', productContext: 'C.', maxTokens: 100, reference: 'R.' }],
          finalists: 0,
          timeoutMs: 5_000,
        } as never,
        KEY,
        { runId: 'impl070-run' } as never,
      );
      const pin = rec.judgeDiagnostics?.contract as { metaPromptsFingerprint?: string; runContractHash?: string } | undefined;
      expect(pin?.metaPromptsFingerprint).toBe(pipelineMetaPromptsFingerprint());
      expect(pin?.runContractHash).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      mudos.forEach((m) => m.mockRestore());
      setDefaultGateway(prev);
      setDataDir(antes);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
