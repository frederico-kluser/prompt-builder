// Pré-voo das runs de chat (`compare` | `vary` | `train`) — UM avaliador para a
// execução real E para o `--dry-run` (IMPL-029, R-12:REC-4).
//
// O furo medido: o dry-run devolvia ANTES do pré-voo, e as recusas reais
// (modelo fora do catálogo, teto de preço, saldo, faixa duvidosa sem --yes)
// só apareciam na execução. O dry-run aprovava com exit 0 o que a run recusava
// — um falso gate de segurança orçamentária para o agente que confia nele.
//
// A paridade aqui é POR CONSTRUÇÃO: as duas rotas percorrem a MESMA sequência
// de checagens. Na real, a primeira recusa é lançada (e nada depois dela roda —
// nem a rede); no dry-run, todas são coletadas em `wouldRefuse`, na mesma
// ordem, e a primeira vira o `error.code`/exit do envelope. Logo o código de
// recusa do dry-run é, sempre, o da execução real com a mesma config e o mesmo
// ambiente.
//
// A ÚNICA diferença é a key (critério de aceite da REC-4): sem key o dry-run
// não recusa — lista em `requires` o que a execução exigiria (a key e o saldo
// que só ela deixa ver), com o `code` que a real devolveria. Para isso a
// checagem da key é a ÚLTIMA: toda recusa de config sai igual com ou sem key.
// Leituras de rede do pré-voo são só as sem efeito e gratuitas: catálogo
// público (`GET /models`) e, com key, `GET /key` (validade + saldo).

import { estimateInputFromConfig, estimateRunCost, toPerMTok, type CostEstimate } from '../estimate.js';
import { isKnownPrice } from '../engine/pricing.js';
import { ignoredReasoningLevels } from '../modelCaps.js';
import type { KeyInfo } from '../openrouter.js';
import type { OpenRouterModel, RunConfig } from '../types.js';
import { CliError, EXIT, fmtUsd, isCliError, kindForExit, type ErrorKind } from './output.js';
import { keyMissingError, type LoadedCatalog } from './context.js';
import type { DailySnapshot } from './spendLedger.js';

/** Como o orçamento chegou na linha de comando. */
export type BudgetChoice =
  /** `--budget <usd>` */
  | { kind: 'usd'; usd: number }
  /** `--budget none`: sem teto, assumido explicitamente. */
  | { kind: 'none' }
  /** Sem flag num terminal interativo: roda sem teto (com aviso). */
  | { kind: 'unset' }
  /** Sem flag fora de TTY: a execução recusa (`usage.budget_required`). */
  | { kind: 'missing' };

export function budgetUsdOf(b: BudgetChoice): number | undefined {
  return b.kind === 'usd' ? b.usd : undefined;
}

/** Uma recusa: exatamente o `error` do envelope que a execução real emitiria. */
export interface Refusal {
  code: string;
  kind: ErrorKind;
  exit: number;
  message: string;
  hint: string | null;
  details: unknown;
}

/** Pré-condição que o dry-run NÃO conseguiu confirmar (só com a key). */
export interface Requirement {
  /** O `error.code` com que a execução real recusaria se ela faltar. */
  code: string;
  what: 'key' | 'credit';
  message: string;
  hint: string | null;
  details: unknown;
}

export interface PreflightChecks {
  catalog: { source: LoadedCatalog['catalogSource']; scope: LoadedCatalog['catalogScope']; models: number } | null;
  /** `unchecked` = o `GET /key` falhou por rede (a key pode estar boa). */
  key: 'ok' | 'missing' | 'invalid' | 'unchecked';
  /** Saldo da key (null = sem limite; ausente = não consultado). */
  creditRemainingUsd?: number | null;
  /** Lock da MESMA config (IMPL-031): `skipped` = `--allow-concurrent`. Ausente = sem guarda. */
  lock?: 'free' | 'held' | 'skipped';
  /** Teto diário da máquina, somando processos (IMPL-031). Ausente = sem guarda. */
  daily?: {
    capUsd: number | null;
    source: DailySnapshot['capSource'];
    spentUsd: number;
    pendingUsd: number;
    remainingUsd: number | null;
    resetsAt: string;
  };
}

export interface PreflightReport {
  estimate: CostEstimate;
  /** Recusas, NA ORDEM da execução real: `[0]` é o que ela lançaria. */
  wouldRefuse: Refusal[];
  requires: Requirement[];
  warnings: string[];
  checks: PreflightChecks;
  /** Catálogo carregado (a execução real segue com ele). */
  catalog: LoadedCatalog | null;
}

export interface PreflightInput {
  /** Config já com `budgetUsd` quando há teto. */
  config: RunConfig;
  budget: BudgetChoice;
  apiKey: string | null;
  yes: boolean;
  force: boolean;
  /** Fora de TTY (agente/CI): a faixa duvidosa recusa em vez de só avisar. */
  agentContext: boolean;
}

/**
 * Estado da MÁQUINA que também recusa (IMPL-031, anti-gasto-N×). Só leitura:
 * o dry-run consulta sem efeito; a execução real toma o lock depois do pré-voo
 * (e a tomada atômica recusa com o MESMO `run.locked` se alguém chegar antes).
 */
export interface PreflightGuard {
  /** Recusa `run.locked` se outro processo VIVO roda a mesma config; `null` = livre. `undefined` = não checado. */
  lockRefusal?(): CliError | null;
  /** Teto diário e gasto de hoje (todos os processos). */
  daily(): DailySnapshot;
}

/** I/O do pré-voo — injetado para os testes rodarem sem rede. */
export interface PreflightDeps {
  loadCatalog(apiKey: string | null): Promise<LoadedCatalog>;
  /** Lança CliError `auth.key_invalid` quando o OpenRouter recusa a key. */
  checkKey(apiKey: string): Promise<KeyInfo>;
  info(msg: string): void;
  warn(msg: string): void;
  /** Ausente = sem lock/teto diário (chamadores antigos e testes de unidade). */
  guard?: PreflightGuard;
}

export type PreflightMode = 'real' | 'dry-run';

export function toRefusal(err: CliError): Refusal {
  return {
    code: err.errorCode,
    kind: kindForExit(err.code),
    exit: err.code,
    message: err.message,
    hint: err.hint ?? null,
    details: err.details ?? null,
  };
}

/** O CliError que a execução real lança para esta recusa (mesmo code/exit/hint). */
export function refusalToError(r: Refusal): CliError {
  return new CliError(r.message, r.exit, r.details ?? undefined, { code: r.code, hint: r.hint ?? undefined });
}

// --- modelos que a run chama -------------------------------------------------

/**
 * Variantes DINÂMICAS de roteamento do OpenRouter: valem para qualquer modelo
 * e não aparecem no catálogo (`:free`/`:extended` aparecem como ids próprios).
 * `x:nitro` é conhecido se `x` é — mas segue SEM preço exato no catálogo.
 */
const ROUTING_SUFFIXES = new Set(['nitro', 'floor', 'online', 'exacto']);

export function isKnownModel(id: string, byId: ReadonlySet<string>): boolean {
  if (byId.has(id)) return true;
  const i = id.lastIndexOf(':');
  return i > 0 && ROUTING_SUFFIXES.has(id.slice(i + 1)) && byId.has(id.slice(0, i));
}

/**
 * Ids que a run vai CHAMAR, na ordem do pipeline. Só entra o que é chamado de
 * fato (datagen só quando há cenário a gerar; gabarito só com julgamento por
 * referência; reescritor só fora do compare) — um id configurado mas nunca
 * usado não pode virar recusa.
 */
export function modelIdsCalledBy(config: RunConfig): string[] {
  const inp = estimateInputFromConfig(config);
  const ids = [
    ...inp.contestantModelIds,
    ...inp.judgeModelIds,
    ...(inp.datagenModelId ? [inp.datagenModelId] : []),
    ...(inp.referenceJudging && inp.referenceModelId ? [inp.referenceModelId] : []),
    ...(config.mode !== 'compare' && inp.optimizerModelId ? [inp.optimizerModelId] : []),
  ];
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Preço variável/desconhecido no catálogo (ex.: `openrouter/auto` = "-1", que o
 * parser já normaliza para `null` — IMPL-018): sem estimativa exata possível.
 */
function hasVariablePrice(m: OpenRouterModel): boolean {
  return !isKnownPrice(m.pricing.prompt) || !isKnownPrice(m.pricing.completion);
}

// --- a sequência ------------------------------------------------------------

/**
 * Roda o pré-voo. `real`: lança a PRIMEIRA recusa (nada depois roda). `dry-run`:
 * coleta todas em `wouldRefuse` e segue, sem gastar nada. A ordem abaixo É o
 * contrato de paridade — mude-a só aqui.
 */
export async function runPreflight(
  input: PreflightInput,
  deps: PreflightDeps,
  mode: PreflightMode,
): Promise<PreflightReport> {
  const { config, budget, apiKey } = input;
  const budgetUsd = budgetUsdOf(budget);
  const wouldRefuse: Refusal[] = [];
  const requires: Requirement[] = [];
  const warnings: string[] = [];
  const checks: PreflightChecks = { catalog: null, key: apiKey ? 'ok' : 'missing' };

  const refuse = (err: CliError): void => {
    if (mode === 'real') throw err;
    wouldRefuse.push(toRefusal(err));
  };
  const warn = (msg: string): void => {
    warnings.push(msg);
    deps.warn(msg);
  };

  // 0. Lock da MESMA config (IMPL-031): outro processo vivo já roda este
  //    experimento — a repetição gastaria em dobro. Primeiro de tudo: é grátis
  //    (só disco) e é o que um agente em laço de retentativa precisa ouvir.
  if (deps.guard) {
    if (deps.guard.lockRefusal) {
      const travado = deps.guard.lockRefusal();
      checks.lock = travado ? 'held' : 'free';
      if (travado) refuse(travado);
    } else {
      checks.lock = 'skipped';
    }
  }

  // 1. Orçamento explícito fora de TTY. Na execução real sai antes de qualquer
  //    rede (nada foi gasto, nem uma leitura).
  if (budget.kind === 'missing') refuse(budgetRequiredError());

  // 2. Catálogo (público sem key). Sem ele não há o que conferir nem estimar.
  let catalog: LoadedCatalog | null = null;
  try {
    catalog = await deps.loadCatalog(apiKey);
    checks.catalog = { source: catalog.catalogSource, scope: catalog.catalogScope, models: catalog.models.length };
  } catch (err) {
    if (!isCliError(err)) throw err;
    refuse(err);
  }
  const models = catalog?.models ?? [];
  const est = estimateRunCost(estimateInputFromConfig(config), models);
  // Estimativa do ORÇAMENTO: igual à reportada, salvo preço variável com teto
  // de preço nos dois lados — aí vai pelo pior caso (IMPL-018, passo 4).
  let estOrcamento = est;

  if (catalog) {
    const byId = new Set(models.map((m) => m.id));
    const chamados = modelIdsCalledBy(config);

    // 3. Id que não existe: a run gastaria em datagen/juiz e o competidor
    //    tomaria 400 — vira veredito degradado, não resultado.
    const desconhecidos = chamados.filter((id) => !isKnownModel(id, byId));
    if (desconhecidos.length) refuse(unknownModelError(desconhecidos, catalog));

    // cli#2: nível de raciocínio pedido a modelo SEM raciocínio — o gateway
    // não envia nada; avisa em vez de o esforço sumir em silêncio.
    for (const i of ignoredReasoningLevels(config as Parameters<typeof ignoredReasoningLevels>[0], models)) {
      warn(`"${i.modelId}" não aceita raciocínio: o nível "${i.level}" (${i.role}) será ignorado — nada vai no fio.`);
    }

    // 4. Sem preço exato. Duas naturezas:
    //    (a) sem entrada no catálogo (variante de roteamento `:nitro`…): com
    //        teto, orçamento sobre custo desconhecido não é orçamento → recusa.
    //    (b) preço VARIÁVEL no catálogo (IMPL-018: roteadores, "-1"): fica fora
    //        da estimativa REPORTADA (nunca negativo nem "grátis"); com teto, a
    //        conta do orçamento vai pelo PIOR CASO dos endpoints elegíveis — só
    //        limitável com teto de preço nos DOIS lados. Sem ele: recusa.
    const variaveis = [
      ...new Set([
        ...est.unknownPriceModelIds,
        ...chamados.filter((id) => {
          const m = models.find((x) => x.id === id);
          return m ? hasVariablePrice(m) : false;
        }),
      ]),
    ].filter((id) => !desconhecidos.includes(id));
    const semPreco = est.unpricedModelIds.filter((id) => !desconhecidos.includes(id) && !variaveis.includes(id));
    if (semPreco.length) {
      if (budgetUsd !== undefined) refuse(unpricedModelsError(semPreco));
      else warn(`modelos sem preço exato no catálogo (custo contado como zero): ${semPreco.join(', ')}`);
    }
    if (variaveis.length) {
      const msg = `preço variável no catálogo: ${variaveis.join(', ')}`;
      if (budgetUsd !== undefined) {
        const teto = config.maxPricePerMTok;
        if (teto?.prompt === undefined || teto?.completion === undefined) {
          refuse(variablePriceError(variaveis));
        } else {
          estOrcamento = estimateRunCost(estimateInputFromConfig(config), models, { unknownPrice: 'worst-case' });
          warn(
            `${msg} — o orçamento é conferido pelo pior caso limitado pelo teto ` +
              `(${fmtUsd(estOrcamento.low)} – ${fmtUsd(estOrcamento.high)}).`,
          );
        }
      } else {
        warn(`${msg} — fora da estimativa; o custo real será maior.`);
      }
    }

    deps.info(
      `Custo estimado: ${fmtUsd(est.low)} – ${fmtUsd(est.high)}` +
        (est.unknownPriceModelIds.length > 0 ? ' + variável ' : ' ') +
        `(${est.assumptions.stages} cenários × ${est.assumptions.contestants} participantes` +
        (est.assumptions.iterations > 1 ? ` × até ${est.assumptions.iterations} iterações` : '') +
        ')',
    );

    // 5. Teto por requisição: apertado demais vira 404 "No allowed providers"
    //    em runtime — que NÃO é sinal de controle e viraria veredito 'parcial'.
    const cap = config.maxPricePerMTok;
    if (cap) {
      const usados = new Set<string>([
        ...(config.mode === 'compare'
          ? (config.competitorConfigs?.map((c) => c.modelId) ?? config.competitorModelIds ?? [])
          : [config.contestantModelId]),
        ...config.judgeModelIds,
        config.datagenModelId,
      ]);
      for (const id of usados) {
        const m = models.find((x) => x.id === id);
        if (!m) continue;
        // Preço desconhecido (roteador): o teto vai no pedido, mas não dá para
        // conferir aqui — avisa em vez de comparar com um -1 (que sempre "cabia").
        if (
          (cap.prompt !== undefined && !isKnownPrice(m.pricing.prompt)) ||
          (cap.completion !== undefined && !isKnownPrice(m.pricing.completion))
        ) {
          warn(`"${id}" tem preço variável: o teto por requisição não pode ser conferido antes da run.`);
        }
        const erro = priceCapError(id, m, cap);
        if (erro) refuse(erro);
      }
    }

    // 6. Orçamento × faixa estimada (a do ORÇAMENTO: pior caso p/ preço variável).
    if (budgetUsd !== undefined && estOrcamento.high > budgetUsd) {
      if (estOrcamento.low > budgetUsd && !input.force) {
        refuse(budgetBelowEstimateError(budgetUsd, estOrcamento));
      } else if (!input.yes && input.agentContext) {
        refuse(confirmationRequiredError(budgetUsd, estOrcamento));
      } else {
        warn(
          `orçamento ${fmtUsd(budgetUsd)} pode não cobrir o teto (${fmtUsd(estOrcamento.high)}) — a run pode parar cedo.`,
        );
      }
    }
  }

  // 6b. Teto DIÁRIO da máquina (IMPL-031): soma o gasto de hoje (UTC) de todos
  //     os processos. Esgotado recusa sempre; abaixo do piso estimado recusa
  //     salvo --force (a porta dura segue armada durante a run).
  if (deps.guard) {
    const dia = deps.guard.daily();
    checks.daily = {
      capUsd: dia.capUsd,
      source: dia.capSource,
      spentUsd: dia.spentUsd,
      pendingUsd: dia.pendingUsd,
      remainingUsd: dia.remainingUsd,
      resetsAt: dia.resetsAt,
    };
    const resta = dia.remainingUsd;
    if (resta !== null) {
      if (resta <= 0) refuse(dailyCapError(dia, catalog ? est : null));
      else if (catalog && est.low > resta && !input.force) refuse(dailyCapError(dia, est));
      else if (catalog && est.high > resta) {
        warn(`teto diário da máquina: restam ${fmtUsd(resta)} hoje (UTC) — a run pode parar cedo.`);
      } else if (budgetUsd === undefined || budgetUsd > resta) {
        warn(`teto real desta run: ${fmtUsd(resta)} (o que resta do teto diário da máquina hoje).`);
      }
    }
  }

  // 7. Key — por ÚLTIMO, para toda recusa de config sair igual com e sem key.
  if (!apiKey) {
    if (mode === 'real') throw keyMissingError();
    requires.push(keyRequirement());
    if (catalog && est.low > 0) {
      requires.push({
        code: 'credit.insufficient',
        what: 'credit',
        message: `Saldo não verificado (sem key): a execução exige pelo menos ${fmtUsd(est.low)} disponíveis na key.`,
        hint: 'Com a key configurada, o mesmo --dry-run consulta o saldo (GET /key, sem custo).',
        details: { minUsd: est.low, estimateHighUsd: est.high },
      });
    }
  } else {
    let info: KeyInfo | null = null;
    try {
      info = await deps.checkKey(apiKey);
    } catch (err) {
      if (!isCliError(err)) throw err;
      checks.key = err.code === EXIT.NETWORK ? 'unchecked' : 'invalid';
      refuse(err);
    }

    // 8. Saldo (só com a estimativa, que depende do catálogo).
    if (info) {
      const saldo = info.limitRemainingUsd;
      checks.creditRemainingUsd = saldo ?? null;
      if (catalog && typeof saldo === 'number') {
        if (saldo < est.low) {
          refuse(
            new CliError(
              `A key tem ${fmtUsd(saldo)} disponíveis e a run custa pelo menos ${fmtUsd(est.low)}. ` +
                'Adicione créditos ou reduza --stages/--iterations.',
              EXIT.NO_CREDIT,
              { remainingUsd: saldo, estimateLowUsd: est.low, estimateHighUsd: est.high },
              { code: 'credit.insufficient' },
            ),
          );
        } else if (saldo < est.high) {
          warn(`saldo da key (${fmtUsd(saldo)}) pode não cobrir o teto estimado.`);
        }
        if (budgetUsd !== undefined && budgetUsd > saldo) {
          warn(`orçamento ${fmtUsd(budgetUsd)} maior que o saldo da key — teto real: ${fmtUsd(saldo)}.`);
        }
      }
    }
  }

  return { estimate: est, wouldRefuse, requires, warnings, checks, catalog };
}

// --- as recusas (mensagem/código/dica num lugar só) --------------------------

/** Teto diário da máquina (IMPL-031) — esgotado, ou sem espaço para o piso estimado. */
export function dailyCapError(dia: DailySnapshot, est: CostEstimate | null): CliError {
  const cap = dia.capUsd ?? 0;
  const resta = dia.remainingUsd ?? 0;
  const esgotado = resta <= 0;
  return new CliError(
    esgotado
      ? `Teto diário da máquina esgotado: ${fmtUsd(dia.spentUsd + dia.pendingUsd)} de ${fmtUsd(cap)} hoje (UTC), ` +
          `somando todos os processos. Nada foi gasto; o teto zera em ${dia.resetsAt}.`
      : `Restam ${fmtUsd(resta)} do teto diário da máquina (${fmtUsd(cap)}) e a run custa pelo menos ` +
          `${fmtUsd(est?.low ?? 0)}. Nada foi gasto.`,
    EXIT.BUDGET,
    {
      day: dia.day,
      capUsd: dia.capUsd,
      capSource: dia.capSource,
      spentTodayUsd: dia.spentUsd,
      pendingUsd: dia.pendingUsd,
      remainingUsd: dia.remainingUsd,
      resetsAt: dia.resetsAt,
      estimateLowUsd: est?.low ?? null,
    },
    {
      code: 'control.daily_cap_reached',
      hint:
        'O teto diário vale para TODOS os processos desta máquina (defesa contra gasto N×). Espere o reset ' +
        '(00:00 UTC) ou, por decisão humana, `prompt-builder limits set --daily <usd>`' +
        (esgotado ? '' : '; `--force` roda mesmo assim até o teto') +
        '. `prompt-builder limits show` mostra quem gastou.',
    },
  );
}

/** A key como pré-condição (`requires`) — o mesmo erro que a execução lançaria. */
export function keyRequirement(): Requirement {
  const k = keyMissingError();
  return { code: k.errorCode, what: 'key', message: k.message, hint: k.hint ?? null, details: k.details ?? null };
}

export function budgetRequiredError(): CliError {
  return new CliError(
    'Faltou definir orçamento. Escolha explicitamente:\n' +
      '  --budget 5      teto de US$ 5 para esta execução\n' +
      '  --budget none   sem teto (assumindo o custo)\n' +
      '(a exigência vale fora de um terminal interativo — nada foi gasto)',
    EXIT.USAGE,
    undefined,
    {
      code: 'usage.budget_required',
      hint:
        'Repita o comando com `--budget <usd>` (teto) ou `--budget none`; `--dry-run` estima o custo ' +
        'sem gastar (a estimativa sai em details.estimate).',
    },
  );
}

function unknownModelError(ids: string[], catalog: LoadedCatalog): CliError {
  const velho = catalog.catalogSource === 'stale';
  return new CliError(
    `Modelo(s) fora do catálogo do OpenRouter: ${ids.join(', ')}. ` +
      'A run chamaria um id inexistente (HTTP 400) depois de já ter gasto em datagen/gabaritos.',
    EXIT.CONFIG,
    {
      unknownModelIds: ids,
      catalogSource: catalog.catalogSource,
      catalogModels: catalog.models.length,
    },
    {
      code: 'config.unknown_model',
      hint:
        `Confira os ids com \`prompt-builder models list --search ${ids[0].split('/').pop()?.split(':')[0] ?? ''} --json\`` +
        (velho
          ? '; o catálogo veio de um cache VENCIDO (offline) — `--refresh-models` força recarregar.'
          : ' (ou `--refresh-models` se o modelo acabou de sair).'),
    },
  );
}

function unpricedModelsError(ids: string[]): CliError {
  return new CliError(
    `Não dá para respeitar um orçamento com modelos sem preço exato no catálogo ` +
      `(custo contado como zero): ${ids.join(', ')}.`,
    EXIT.CONFIG,
    { unpricedModelIds: ids },
    {
      code: 'config.unpriced_models',
      hint:
        'Use o id base do modelo (sem variante de roteamento como `:nitro`/`:online`; ' +
        '`prompt-builder models list --search <nome> --json`) ou rode com `--budget none`.',
    },
  );
}

/** Preço variável com orçamento e SEM teto de preço nos dois lados (IMPL-018). */
function variablePriceError(ids: string[]): CliError {
  return new CliError(
    `Não dá para garantir um orçamento com preço variável no catálogo: ${ids.join(', ')}. ` +
      'Passe --max-price-in e --max-price-out (USD por MILHÃO — limitam o pior caso) ou escolha ' +
      'modelos com preço fixo (`models list --max-prompt-price N` já os exclui).',
    EXIT.CONFIG,
    { unpricedModelIds: ids, variablePrice: true },
    {
      // Mesma família de `unpricedModelsError` (sem preço exato => sem orçamento
      // garantido); o `variablePrice` dos details e a dica dizem a saída: teto.
      code: 'config.unpriced_models',
      hint: 'Repita com `--max-price-in <usd/M> --max-price-out <usd/M>`, troque o modelo ou rode com `--budget none`.',
    },
  );
}

function priceCapError(
  id: string,
  m: OpenRouterModel,
  cap: { prompt?: number; completion?: number },
): CliError | null {
  const { prompt, completion } = m.pricing;
  if (cap.prompt !== undefined && isKnownPrice(prompt) && toPerMTok(prompt) > cap.prompt) {
    return new CliError(
      `--max-price-in ${cap.prompt} está abaixo do preço de "${id}" ` +
        `(${toPerMTok(prompt).toFixed(2)} por 1M). Lembre: a flag é USD por MILHÃO de tokens.`,
      EXIT.CONFIG,
      { modelId: id, capPerMTok: cap.prompt, pricePerMTok: toPerMTok(prompt) },
      { code: 'config.price_cap_below_model', hint: 'Suba --max-price-in ou troque o modelo.' },
    );
  }
  if (cap.completion !== undefined && isKnownPrice(completion) && toPerMTok(completion) > cap.completion) {
    return new CliError(
      `--max-price-out ${cap.completion} está abaixo do preço de "${id}" ` +
        `(${toPerMTok(completion).toFixed(2)} por 1M). A flag é USD por MILHÃO de tokens.`,
      EXIT.CONFIG,
      { modelId: id, capPerMTok: cap.completion, pricePerMTok: toPerMTok(completion) },
      { code: 'config.price_cap_below_model', hint: 'Suba --max-price-out ou troque o modelo.' },
    );
  }
  return null;
}

function budgetBelowEstimateError(budgetUsd: number, est: CostEstimate): CliError {
  return new CliError(
    `Orçamento ${fmtUsd(budgetUsd)} abaixo do piso estimado ${fmtUsd(est.low)}.\n` +
      'Reduza --stages, desligue as finais (--no-duels), use menos juízes, ' +
      'ou passe --force para rodar mesmo assim (as portas de orçamento seguem armadas).',
    EXIT.USAGE,
    { budgetUsd, estimateLowUsd: est.low, estimateHighUsd: est.high },
    {
      code: 'usage.budget_below_estimate',
      hint: 'Suba --budget, reduza --stages/--no-duels/juízes, ou passe --force para rodar mesmo assim.',
    },
  );
}

function confirmationRequiredError(budgetUsd: number, est: CostEstimate): CliError {
  return new CliError(
    `Orçamento ${fmtUsd(budgetUsd)} está dentro da faixa estimada (${fmtUsd(est.low)} – ${fmtUsd(est.high)}), ` +
      'então a run pode parar no meio. Confirme com --yes.',
    EXIT.USAGE,
    { budgetUsd, estimateLowUsd: est.low, estimateHighUsd: est.high },
    {
      code: 'usage.confirmation_required',
      hint: 'Repita o mesmo comando com `--yes` (ou suba --budget acima do teto estimado).',
    },
  );
}
