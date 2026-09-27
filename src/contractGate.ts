// Gate never-break em 3 camadas (IMPL-011, R-20:REC-5/DEC-5) — a parte que
// CHAMA LLM. O variator cria UM gate por lote de variantes e passa cada
// reescrita por ele:
//
//   (1) local  — `verifyRewrite` (extrator corrigido, invariantes, exceção
//                acrescentada na frase, piso de tamanho). Grátis; se reprovar,
//                as camadas pagas nem rodam.
//   (2) juiz   — LLM sobre o diff base × reescrita para `neverBreak`
//                (rejeita exceção/condição/escopo/subordinação acrescentados
//                em QUALQUER frase — o que a substring não vê).
//   (3) canário— entradas-canário no MODELO SOB TESTE com a variante como
//                system (recusa, formato, placeholder). Gate final e
//                DIFERENCIAL: o canário só vale se o base passa nele.
//
// Toda chamada passa por `chatCompletion` com `role: 'rewriter'` + sink do
// ledger (o custo de validar a variante é custo de produzi-la; papel novo no
// CostRole mexeria em estimate/CLI/UI de outros donos). Falha de INFRA do juiz
// ou do canário reprova a variante (não verificada = não entra), mas com tipo
// próprio (`judgeError`/`canaryError`) para o log separar infra de violação
// real. `BudgetExceeded`/`RunCancelled` sempre sobem (isControlSignal).

import { chatCompletion, peekModelsCache } from './openrouter.js';
import { isControlSignal } from './budget.js';
import { layerOf, verifyRewrite } from './engine/contracts.js';
import type { ContractCanary, ContractLayer, ContractViolation, PromptContracts } from './engine/contracts.js';
import {
  buildDiffJudgeMessages,
  canaryLabel,
  evaluateCanary,
  fillPlaceholders,
  parseDiffJudgeReply,
} from './engine/contractLayers.js';
import type { ReasoningLevel, RunCtx } from './types.js';

export interface ContractGateOptions {
  apiKey: string;
  contracts?: PromptContracts;
  /** Texto de referência da camada 1 (o base, ou o texto-sentinela "sem base"). */
  baseText: string;
  /** Há prompt base DE VERDADE? Sem base não há diff nem baseline de canário. */
  hasBase: boolean;
  /** System prompt efetivo de um fragmento (multi-prompt: compõe os irmãos). */
  compose?: (fragment: string) => string;
  /** Juiz do diff (camada 2) — o juiz da run; nunca o próprio reescritor quando houver alternativa. */
  judgeModelId: string;
  /** Modelo sob teste — quem responde aos canários (camada 3). */
  contestantModelId: string;
  /**
   * Nível de raciocínio do juiz do diff (`RunConfig.reasoning.judge`) — o mesmo
   * que o refJudge recebe. Sem isto o juiz rodava no default do provedor.
   */
  judgeReasoningLevel?: ReasoningLevel;
  /**
   * Nível de raciocínio do modelo sob teste nos canários
   * (`RunConfig.reasoning.competitor`): o canário mede o modelo NAS MESMAS
   * condições da competição, não num nível diferente.
   */
  contestantReasoningLevel?: ReasoningLevel;
  /** Canário é teste de CHAT: com runner 'agent' a camada 3 é pulada (com aviso). */
  runner?: 'chat' | 'agent';
  timeoutMs?: number;
  ctx?: RunCtx;
  maxPricePerMTok?: { prompt?: number; completion?: number };
  /** Narração (stderr no CLI). Default: console.warn. */
  log?: (msg: string) => void;
}

export interface ContractGateResult {
  ok: boolean;
  /** Camada que reprovou (ausente quando ok). */
  layer?: ContractLayer;
  violations: ContractViolation[];
}

export interface ContractGate {
  check(rewrite: string): Promise<ContractGateResult>;
}

/** Tentativas do juiz do diff quando a saída não é o JSON pedido. */
const JUDGE_ATTEMPTS = 2;
/** Teto de saída do juiz do diff (o JSON de vereditos é curto). */
export const JUDGE_MAX_TOKENS = 1024;
/** Teto default da resposta de um canário. */
export const CANARY_MAX_TOKENS = 400;
/**
 * Folga somada ao teto quando o modelo vai RACIOCINAR: em muitos provedores os
 * tokens de raciocínio contam no `max_tokens`, e um teto de 1024 consumido
 * inteiro pelo raciocínio devolve texto vazio — o juiz daria `judgeError` 2x e
 * o variator descartaria TODA variante sem pedir correção (a run ficaria só
 * com o 'original').
 */
export const REASONING_HEADROOM_TOKENS = 3072;

/**
 * O modelo vai raciocinar nesta chamada? Nível pedido ≠ 'off' → sim. Sem nível
 * (ou 'off' num modelo `mandatory`, onde o 'off' nem é enviado — ver
 * applyReasoning), decide o catálogo EM CACHE (sem rede): raciocínio
 * obrigatório, ou ligado por default quando nada foi pedido.
 */
export function reasoningLikely(apiKey: string, modelId: string, level?: ReasoningLevel): boolean {
  if (level && level !== 'off') return true;
  const meta = peekModelsCache(apiKey)?.data.find((m) => m.id === modelId)?.reasoning;
  if (meta?.mandatory) return true;
  return level === undefined && meta?.defaultEnabled === true;
}

/** Teto de saída de uma chamada de verificação, com folga se o modelo raciocina. */
export function verificationMaxTokens(
  apiKey: string,
  modelId: string,
  level: ReasoningLevel | undefined,
  base: number,
): number {
  return base + (reasoningLikely(apiKey, modelId, level) ? REASONING_HEADROOM_TOKENS : 0);
}

function errMsg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Camada 2 isolada: juiz LLM sobre o diff. Devolve as violações (vazio = ok).
 * Exportada para teste direto; o gate a chama só depois da camada 1 passar.
 */
export async function judgeNeverBreakDiff(
  o: ContractGateOptions,
  rewrite: string,
): Promise<ContractViolation[]> {
  const invariants = (o.contracts?.neverBreak ?? []).filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  if (!invariants.length) return [];
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = buildDiffJudgeMessages({
    base: o.hasBase ? o.baseText : undefined,
    rewrite,
    invariants,
  });

  let ultimoProblema = '';
  for (let tentativa = 0; tentativa < JUDGE_ATTEMPTS; tentativa++) {
    let texto: string;
    try {
      const r = await chatCompletion({
        apiKey: o.apiKey,
        modelId: o.judgeModelId,
        messages,
        temperature: 0,
        maxTokens: verificationMaxTokens(o.apiKey, o.judgeModelId, o.judgeReasoningLevel, JUDGE_MAX_TOKENS),
        reasoningLevel: o.judgeReasoningLevel,
        responseFormatJson: true,
        timeoutMs: o.timeoutMs ?? 90_000,
        role: 'rewriter',
        signal: o.ctx?.signal,
        sink: o.ctx?.sink,
        maxPricePerMTok: o.maxPricePerMTok,
      });
      texto = r.text;
    } catch (err) {
      if (isControlSignal(err)) throw err;
      return [{ kind: 'judgeError', detail: `Juiz do contrato falhou (${o.judgeModelId}): ${errMsg(err)}` }];
    }
    const parsed = parseDiffJudgeReply(texto);
    if (parsed) {
      return parsed.violacoes.map((v) => ({
        kind: 'semantic' as const,
        detail: `Juiz do contrato: invariante "${v.invariante}" ${v.tipo ? `${v.tipo}` : 'violada'}${
          v.trecho ? ` — trecho: "${v.trecho.slice(0, 200)}"` : ''
        }.`,
      }));
    }
    ultimoProblema = texto.slice(0, 120);
    messages.push(
      { role: 'assistant', content: texto },
      {
        role: 'user',
        content: 'Sua resposta nao era o JSON pedido. Responda APENAS {"violacoes":[...]} (lista vazia se tudo preservado).',
      },
    );
  }
  return [
    {
      kind: 'judgeError',
      detail: `Juiz do contrato devolveu saída inválida ${JUDGE_ATTEMPTS}x (${o.judgeModelId}): "${ultimoProblema}"`,
    },
  ];
}

/** UMA execução de canário no modelo sob teste. */
async function askCanary(o: ContractGateOptions, fragment: string, c: ContractCanary): Promise<string> {
  const composto = o.compose ? o.compose(fragment) : fragment;
  const r = await chatCompletion({
    apiKey: o.apiKey,
    modelId: o.contestantModelId,
    messages: [
      { role: 'system', content: fillPlaceholders(composto, c.fill) },
      { role: 'user', content: c.input },
    ],
    temperature: 0,
    maxTokens: verificationMaxTokens(
      o.apiKey,
      o.contestantModelId,
      o.contestantReasoningLevel,
      c.maxTokens ?? CANARY_MAX_TOKENS,
    ),
    reasoningLevel: o.contestantReasoningLevel,
    timeoutMs: o.timeoutMs ?? 90_000,
    role: 'rewriter',
    signal: o.ctx?.signal,
    sink: o.ctx?.sink,
    maxPricePerMTok: o.maxPricePerMTok,
  });
  return r.text;
}

/** Cria o gate de UM lote (a baseline dos canários no base é memoizada). */
export function createContractGate(o: ContractGateOptions): ContractGate {
  const log = o.log ?? ((m: string) => console.warn(m));
  const contracts = o.contracts;
  const invariants = (contracts?.neverBreak ?? []).filter((s) => typeof s === 'string' && s.trim());
  const judgeOn = contracts?.judgeDiff !== false && invariants.length > 0;
  const canaries = Array.isArray(contracts?.canaries) ? contracts.canaries : [];
  const canariesOn = canaries.length > 0 && o.runner !== 'agent';
  if (canaries.length > 0 && o.runner === 'agent') {
    log('[contrato] canários são teste de chat — pulados em run de agente (camadas 1 e 2 seguem).');
  }

  // Baseline: quais canários o BASE cumpre. Sem base, todos valem (absolutos).
  let baseline: Promise<boolean[]> | null = null;
  const ativos = (): Promise<boolean[]> => {
    baseline ??= (async () => {
      if (!o.hasBase) return canaries.map(() => true);
      return Promise.all(
        canaries.map(async (c, i) => {
          const rotulo = canaryLabel(c, i);
          let resposta: string;
          try {
            resposta = await askCanary(o, o.baseText, c);
          } catch (err) {
            if (isControlSignal(err)) throw err;
            log(`[contrato] canário ${rotulo}: baseline no base falhou (${errMsg(err)}) — canário ignorado.`);
            return false;
          }
          const r = evaluateCanary(c, resposta);
          if (!r.pass) {
            log(
              `[contrato] canário ${rotulo} ignorado: nem o prompt BASE passa nele (${r.reason ?? 'falhou'}).`,
            );
          }
          return r.pass;
        }),
      );
    })();
    return baseline;
  };

  async function canaryViolations(rewrite: string): Promise<ContractViolation[]> {
    const vale = await ativos();
    const resultados = await Promise.all(
      canaries.map(async (c, i): Promise<ContractViolation | null> => {
        if (!vale[i]) return null;
        const rotulo = canaryLabel(c, i);
        // Confirmação: uma falha é re-testada UMA vez e só reprova se repetir —
        // ruído de amostragem não derruba variante; regressão sistemática sim.
        let ultimo = '';
        for (let tentativa = 0; tentativa < 2; tentativa++) {
          let resposta: string;
          try {
            resposta = await askCanary(o, rewrite, c);
          } catch (err) {
            if (isControlSignal(err)) throw err;
            return { kind: 'canaryError', detail: `Canário ${rotulo} não rodou: ${errMsg(err)}` };
          }
          const r = evaluateCanary(c, resposta);
          if (r.pass || r.invalid) return null;
          ultimo = r.reason ?? 'falhou';
        }
        return { kind: 'canary', detail: `Canário ${rotulo} (${c.kind}) falhou: ${ultimo}.` };
      }),
    );
    return resultados.filter((v): v is ContractViolation => v !== null);
  }

  return {
    async check(rewrite: string): Promise<ContractGateResult> {
      // (1) local — grátis; reprovou, nada de gastar com as camadas pagas.
      const local = verifyRewrite(o.baseText, rewrite, contracts);
      if (!local.ok) return { ok: false, layer: 'local', violations: local.violations };

      // (2) juiz do diff para neverBreak.
      if (judgeOn) {
        const v = await judgeNeverBreakDiff(o, rewrite);
        if (v.length) return { ok: false, layer: layerOf(v[0].kind), violations: v };
      }

      // (3) canários — gate final.
      if (canariesOn) {
        const v = await canaryViolations(rewrite);
        if (v.length) return { ok: false, layer: 'canary', violations: v };
      }
      return { ok: true, violations: [] };
    },
  };
}
