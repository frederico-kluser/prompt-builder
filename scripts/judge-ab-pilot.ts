// A/B PILOTO do prompt honesto do juiz (IMPL-047, R-03a:REC-7 — critérios 3 e 4).
//
// Mede, no juiz pointwise REAL, o prompt ANTERIOR (a referência era "correta")
// contra o ATUAL (a referência é candidata; a rubrica manda), na fixture
// `test/fixtures/judge-wrong-reference.json` (≥ 30 cenários PT-BR):
//
//   • falso_nao_gabarito_errado — referência ERRADA (contradiz a rubrica) ×
//     candidato CORRETO: fração julgada 'nao'. Alvo do ATUAL: < 50%.
//   • falso_resolve — referência CORRETA × candidato ERRADO: fração julgada
//     'resolve'. Alvo: o ATUAL não sobe mais que 2 p.p. sobre o ANTERIOR.
//
// Cada taxa sai com n e IC 95% (Wilson). Gasta dinheiro de verdade: é OPT-IN e
// EXIGE `--budget` (teto duro no ledger — `BudgetExceeded` para a medição e o
// relatório sai PARCIAL, dito). Sem `--budget` recusa com exit 2 ANTES de
// qualquer rede; sem key, exit 4. Nunca roda no CI (o teste só valida a fixture
// e as recusas — test/judge-ab-pilot.test.ts).
//
// O prompt ANTERIOR sai do próprio git (`--baseline-ref`, default o commit
// anterior à troca): o `src/refJudge.ts` daquele ref é importado INTEIRO (as
// instruções do user também mudaram, não só o system) de um arquivo
// temporário em `src/`, apagado logo depois.
//
// Uso:
//   OPENROUTER_API_KEY=… npx tsx scripts/judge-ab-pilot.ts \
//     --judge anthropic/claude-sonnet-5 --budget 2 [--baseline-ref 60dabd7] \
//     [--limit 30] [--fixture test/fixtures/judge-wrong-reference.json]
// Registre os números medidos na memória CoALA (`coala.py add --type episodic`).

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE = join(ROOT, 'test', 'fixtures', 'judge-wrong-reference.json');
/** Commit anterior à troca do prompt do juiz (IMPL-047 entrou em ca61be8). */
export const DEFAULT_BASELINE_REF = '60dabd7';

// Mesmos códigos do CLI (src/cli/output.ts) — sem importar o CLI inteiro.
const EXIT_OK = 0;
const EXIT_CRITERIO = 1;
const EXIT_USO = 2;
const EXIT_AUTH = 4;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export interface WrongReferenceItem {
  id: string;
  question: string;
  productContext: string;
  rubric: string;
  /** Resposta que SATISFAZ a rubrica. */
  correctAnswer: string;
  /** Gabarito PROPOSITALMENTE errado (contradiz a rubrica). */
  wrongReference: string;
}

export function parseWrongReferenceFixture(
  json: unknown,
): { ok: true; items: WrongReferenceItem[] } | { ok: false; error: string } {
  const raiz = json as { format?: unknown; items?: unknown } | null;
  if (!raiz || raiz.format !== 'judge-wrong-reference@1') {
    return { ok: false, error: 'format deve ser "judge-wrong-reference@1".' };
  }
  if (!Array.isArray(raiz.items)) return { ok: false, error: 'items deve ser uma lista.' };
  const campos = ['id', 'question', 'productContext', 'rubric', 'correctAnswer', 'wrongReference'] as const;
  const ids = new Set<string>();
  const items: WrongReferenceItem[] = [];
  for (const [i, bruto] of raiz.items.entries()) {
    const it = bruto as Record<string, unknown>;
    for (const c of campos) {
      if (typeof it?.[c] !== 'string' || !(it[c] as string).trim()) {
        return { ok: false, error: `items[${i}].${c} deve ser texto não vazio.` };
      }
    }
    const item = it as unknown as WrongReferenceItem;
    if (ids.has(item.id)) return { ok: false, error: `id duplicado: ${item.id}` };
    ids.add(item.id);
    if (item.correctAnswer.trim() === item.wrongReference.trim()) {
      return { ok: false, error: `items[${i}]: a resposta correta e o gabarito errado são iguais.` };
    }
    items.push(item);
  }
  if (items.length < 30) return { ok: false, error: `a fixture precisa de ≥ 30 itens (tem ${items.length}).` };
  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

/** IC 95% de Wilson para k sucessos em n (n = 0 ⇒ [0, 1]). */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centro = (p + (z * z) / (2 * n)) / den;
  const margem = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, Number((centro - margem).toFixed(4))), Math.min(1, Number((centro + margem).toFixed(4)))];
}

export interface Rate {
  /** Fração (0..1); `null` = nenhuma medição válida. */
  rate: number | null;
  k: number;
  /** Vereditos VÁLIDOS (falha do juiz sai do denominador — falha não é veredito). */
  n: number;
  ic95: [number, number];
}

function taxa(k: number, n: number): Rate {
  return { rate: n > 0 ? Number((k / n).toFixed(4)) : null, k, n, ic95: wilson(k, n) };
}

export type Verdict = 'resolve' | 'parcial' | 'nao';
/** Um juiz do A/B: veredito para (item, referência, candidato); `null` = falhou. */
export type PilotJudge = (item: WrongReferenceItem, reference: string, candidate: string) => Promise<Verdict | null>;

export interface VariantReport {
  falsoNaoGabaritoErrado: Rate;
  falsoResolve: Rate;
}

export interface PilotReport {
  items: number;
  anterior: VariantReport;
  atual: VariantReport;
  /** falso_resolve(atual) − falso_resolve(anterior), em p.p.; null sem medição. */
  deltaFalsoResolvePp: number | null;
  criteria: { falsoNaoAbaixoDe50: boolean; falsoResolveDeltaAte2pp: boolean };
  /** true = parou no teto do --budget (medição PARCIAL). */
  partial: boolean;
}

async function medir(items: WrongReferenceItem[], judge: PilotJudge): Promise<VariantReport> {
  let kNao = 0;
  let nNao = 0;
  let kRes = 0;
  let nRes = 0;
  for (const it of items) {
    // (3) gabarito ERRADO × candidato CORRETO: condenar = falso 'nao'.
    const v1 = await judge(it, it.wrongReference, it.correctAnswer);
    if (v1) {
      nNao += 1;
      if (v1 === 'nao') kNao += 1;
    }
    // (4) gabarito CORRETO × candidato ERRADO: aprovar = falso 'resolve'.
    const v2 = await judge(it, it.correctAnswer, it.wrongReference);
    if (v2) {
      nRes += 1;
      if (v2 === 'resolve') kRes += 1;
    }
  }
  return { falsoNaoGabaritoErrado: taxa(kNao, nNao), falsoResolve: taxa(kRes, nRes) };
}

/** Roda o A/B com os juízes INJETADOS (o main liga os reais; o teste, falsos). */
export async function runPilot(opts: {
  items: WrongReferenceItem[];
  anterior: PilotJudge;
  atual: PilotJudge;
}): Promise<PilotReport> {
  let partial = false;
  const vazio: VariantReport = { falsoNaoGabaritoErrado: taxa(0, 0), falsoResolve: taxa(0, 0) };
  let anterior = vazio;
  let atual = vazio;
  try {
    anterior = await medir(opts.items, opts.anterior);
    atual = await medir(opts.items, opts.atual);
  } catch (err) {
    // Teto do --budget (sinal de CONTROLE): o que já foi medido sai, marcado parcial.
    if ((err as { benchControl?: unknown })?.benchControl) partial = true;
    else throw err;
  }
  const ra = anterior.falsoResolve.rate;
  const rb = atual.falsoResolve.rate;
  const delta = ra !== null && rb !== null ? Number(((rb - ra) * 100).toFixed(2)) : null;
  return {
    items: opts.items.length,
    anterior,
    atual,
    deltaFalsoResolvePp: delta,
    criteria: {
      falsoNaoAbaixoDe50: atual.falsoNaoGabaritoErrado.rate !== null && atual.falsoNaoGabaritoErrado.rate < 0.5,
      falsoResolveDeltaAte2pp: delta !== null && delta <= 2,
    },
    partial,
  };
}

// ---------------------------------------------------------------------------
// Juízes REAIS (só no main — nunca no CI)
// ---------------------------------------------------------------------------

type JudgeStageReference = (typeof import('../src/refJudge.js'))['judgeStageReference'];

/**
 * Importa o `src/refJudge.ts` de um ref do git (o prompt ANTERIOR inteiro:
 * system + instruções do user). Escreve um temporário em `src/` (os imports
 * relativos resolvem para os módulos de hoje), importa e apaga.
 */
export async function juizDoRef(ref: string): Promise<JudgeStageReference> {
  const fonte = execFileSync('git', ['show', `${ref}:src/refJudge.ts`], { cwd: ROOT, encoding: 'utf8' });
  const tmp = join(ROOT, 'src', `.pilot-refJudge-${ref.replace(/[^\w-]/g, '')}.ts`);
  writeFileSync(tmp, fonte);
  try {
    const mod = (await import(pathToFileURL(tmp).href)) as { judgeStageReference: JudgeStageReference };
    return mod.judgeStageReference;
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function comoJuiz(
  judgeStageReference: JudgeStageReference,
  base: { apiKey: string; judge: string; ctx: { signal?: AbortSignal; sink?: unknown } },
): PilotJudge {
  return async (item, reference, candidate) => {
    const res = await judgeStageReference({
      stage: { question: item.question, productContext: item.productContext, rubric: item.rubric, reference, maxTokens: 400 },
      responses: [
        { contestantId: 'c', modelId: 'pilot', text: candidate, latencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, status: 'ok' },
      ],
      contestants: [{ id: 'c', label: 'c', modelId: 'pilot' }],
      judgeModelIds: [base.judge],
      apiKey: base.apiKey,
      ctx: base.ctx as never,
    });
    return (res.verdictByContestant.c as Verdict | undefined) ?? null;
  };
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      judge: { type: 'string' },
      budget: { type: 'string' },
      'baseline-ref': { type: 'string' },
      fixture: { type: 'string' },
      limit: { type: 'string' },
    },
    strict: true,
  });
  const orcamento = Number(values.budget);
  if (!values.budget || !Number.isFinite(orcamento) || orcamento <= 0) {
    process.stderr.write(
      'judge-ab-pilot: recusado — o A/B gasta chamadas REAIS de juiz; passe --budget <USD> (teto duro). Nada foi gasto.\n',
    );
    return EXIT_USO;
  }
  if (!values.judge) {
    process.stderr.write('judge-ab-pilot: passe --judge <modelo> (o juiz do A/B). Nada foi gasto.\n');
    return EXIT_USO;
  }
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    process.stderr.write('judge-ab-pilot: OPENROUTER_API_KEY ausente. Nada foi gasto.\n');
    return EXIT_AUTH;
  }
  const fx = parseWrongReferenceFixture(JSON.parse(readFileSync(values.fixture ?? DEFAULT_FIXTURE, 'utf8')));
  if (!fx.ok) {
    process.stderr.write(`judge-ab-pilot: fixture inválida: ${fx.error}\n`);
    return EXIT_USO;
  }
  const limite = values.limit ? Math.max(1, Math.trunc(Number(values.limit))) : fx.items.length;
  const items = fx.items.slice(0, limite);

  // Só agora a rede: o teto é DURO no ledger (BudgetExceeded para a medição).
  const { BudgetLedger } = await import('../src/budget.js');
  const { listModels } = await import('../src/openrouter.js');
  const { makeCallEstimator } = await import('../src/estimate.js');
  const { judgeStageReference } = await import('../src/refJudge.js');
  const catalogo = await listModels(apiKey).catch(() => []);
  const ledger = new BudgetLedger({ budgetUsd: orcamento, estimateCall: makeCallEstimator(catalogo) });
  const ctx = { signal: ledger.signal, sink: ledger };
  const anterior = comoJuiz(await juizDoRef(values['baseline-ref'] ?? DEFAULT_BASELINE_REF), { apiKey, judge: values.judge, ctx });
  const atual = comoJuiz(judgeStageReference, { apiKey, judge: values.judge, ctx });
  const report = await runPilot({ items, anterior, atual });
  process.stdout.write(
    `${JSON.stringify({ ...report, judge: values.judge, baselineRef: values['baseline-ref'] ?? DEFAULT_BASELINE_REF, spentUsd: ledger.spentUsd }, null, 2)}\n`,
  );
  if (report.partial) process.stderr.write('judge-ab-pilot: PARCIAL — o teto do --budget parou a medição.\n');
  return report.criteria.falsoNaoAbaixoDe50 && report.criteria.falsoResolveDeltaAte2pp && !report.partial
    ? EXIT_OK
    : EXIT_CRITERIO;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`judge-ab-pilot: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
