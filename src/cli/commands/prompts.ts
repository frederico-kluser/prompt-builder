// `prompts regression` — suíte de REGRESSÃO dos meta-prompts internos
// (IMPL-070, R-20:REC-8).
//
// Os prompts embutidos do reescritor, da reflexão, do datagen, do gabarito e
// dos juízes mudavam sem régua: editar um texto mudava o comportamento de toda
// sessão seguinte e nada acusava a regressão. Aqui roda um conjunto FIXO de
// casos (120 do reescritor — 80 reescritas × técnicas + 40 canários de
// contrato — e casos por papel de reflexão, datagen, gabarito e juiz), mede
// cada papel contra limiares e sai com exit 10 (`gate`) abaixo deles:
//
//   inválidas (reescritor/canário/reflexão/datagen)  ≤ 10%
//   diversidade das reescritas (1 − sobreposição de 8-gramas com o base) ≥ 0,4
//   acerto do juiz (resolve × não-resolve, contra rótulo fixo)          ≥ 85%
//   κ de Cohen do gabarito gerado (vereditos com ele × rótulo fixo)     ≥ 0,6
//
// ⚠️ "ganho ≥ 0 em ≥ 60% das técnicas" NÃO é medido aqui: exige rodar
// competidor + juiz por técnica sobre cenários (é o `vary`); o relatório diz
// isso explicitamente (`gain: null`) em vez de inventar número.
//
// Toda chamada passa pelo gateway (limitador + ledger, papel de cada meta-
// prompt); `--dry-run` estima o TETO do custo pelo catálogo (sem key, sem
// gasto) e `--budget` é obrigatório fora de um terminal, como nas runs. O
// relatório carrega o fingerprint dos meta-prompts testados (cadência: rode de
// novo quando o texto de um prompt mudar — o fingerprint muda junto).

import { buildCatalogContext, buildNetworkContext, isAgentContext, parse } from '../context.js';
import { CliError, EXIT, fmtUsd, type Output } from '../output.js';
import { BudgetLedger, isControlSignal } from '../../budget.js';
import { computeCost, isFatalGatewayError } from '../../openrouter.js';
import { generateContestants, llmReflectLessons } from '../../variator.js';
import { pipelineMetaPromptsFingerprint } from '../../metaPrompts.js';
import { generateStages, type DatagenReport } from '../../datagen.js';
import { generateReferences } from '../../gabarito.js';
import { judgeStageReference } from '../../refJudge.js';
import { TECHNIQUE_LIBRARY } from '../../techniques.js';
import { ngramContainment, type PromptContracts } from '../../engine/contracts.js';
import {
  MAX_TOKENS_DATAGEN_BATCH,
  MAX_TOKENS_REWRITER,
  REWRITER_PROMPT_TOKENS,
  DATAGEN_PROMPT_TOKENS,
} from '../../engine/callCaps.js';
import { ROLE_MAX_TOKENS } from '../../roleLimits.js';
import type { CompetitorResponse, Contestant, CostRole, OpenRouterModel, RunCtx, StageSpec, Verdict } from '../../types.js';

export const PROMPTS_REGRESSION_FORMAT = 'prompts-regression@1';

/** Limiares da suíte (R-20:REC-8) — abaixo deles o comando sai com exit 10. */
export const REGRESSION_THRESHOLDS = Object.freeze({
  maxInvalidRate: 0.1,
  minDiversity: 0.4,
  minJudgeAccuracy: 0.85,
  minGabaritoKappa: 0.6,
});

/** Teto de custo por rodada que a pesquisa fixou (critério 3). */
export const REGRESSION_COST_CEILING_USD = 2;

export const REGRESSION_ROLES = ['rewriter', 'canary', 'reflection', 'datagen', 'gabarito', 'judge'] as const;
export type RegressionRole = (typeof REGRESSION_ROLES)[number];

// ---------------------------------------------------------------------------
// Casos FIXOS (dado versionado; mudar = nova versão da suíte).
// ---------------------------------------------------------------------------

/** 10 prompts-base de domínios distintos (os 8 primeiros alimentam as 80 reescritas). */
const BASES: readonly { theme: string; prompt: string }[] = [
  { theme: 'suporte de e-commerce', prompt: 'Você é o atendente virtual de uma loja on-line. Responda dúvidas sobre pedidos, trocas e entregas com base apenas no contexto fornecido, de forma cordial e objetiva.' },
  { theme: 'agendamento de exames', prompt: 'Você agenda exames laboratoriais. Informe preparo, horários e documentos necessários usando só as regras do contexto; se faltar informação, peça o dado ao paciente.' },
  { theme: 'suporte técnico de internet', prompt: 'Você é o suporte técnico de um provedor de internet. Guie o cliente em passos numerados para diagnosticar a conexão e abra chamado quando os passos não resolverem.' },
  { theme: 'banco digital', prompt: 'Você é o assistente de um banco digital. Explique tarifas, limites e prazos de transferência conforme a política do contexto, sem prometer aprovação de crédito.' },
  { theme: 'RH interno', prompt: 'Você responde dúvidas de funcionários sobre férias, benefícios e ponto eletrônico, citando a política interna do contexto e indicando o canal do RH quando necessário.' },
  { theme: 'restaurante delivery', prompt: 'Você atende pedidos de um restaurante por delivery. Confirme itens, endereço e forma de pagamento, informe o tempo estimado e ofereça as promoções do dia do contexto.' },
  { theme: 'seguro auto', prompt: 'Você orienta segurados de uma seguradora de automóveis sobre sinistros, assistência 24h e documentos, seguindo a apólice descrita no contexto.' },
  { theme: 'educação a distância', prompt: 'Você é o tutor de uma plataforma de cursos on-line. Tire dúvidas sobre prazos de atividades, certificados e acesso às aulas, com base no regulamento do contexto.' },
  { theme: 'companhia aérea', prompt: 'Você atende passageiros de uma companhia aérea sobre bagagem, remarcação e check-in, aplicando as regras tarifárias do contexto.' },
  { theme: 'condomínio', prompt: 'Você é o assistente da administração de um condomínio. Responda sobre reservas de áreas comuns, regras de convivência e boletos conforme o regimento do contexto.' },
];

/** 10 técnicas das 80 reescritas (as que existirem na biblioteca desta versão). */
const TECNICAS_REESCRITA = ['persona', 'cot', 'fewshot', 'format', 'constraints', 'decompose', 'selfcritique', 'specificity', 'concise', 'emphasis'];

type CategoriaCanario = 'placeholder' | 'invariante' | 'formato' | 'recusa';

/** 4 categorias × 10 bases = 40 canários de contrato. */
const CANARIOS: Record<CategoriaCanario, { sufixo: string; contratos: PromptContracts }> = {
  placeholder: {
    sufixo: ' Trate o cliente pelo nome {nome_cliente} e cite o protocolo {{protocolo}} em toda resposta.',
    contratos: { placeholders: ['{nome_cliente}', '{{protocolo}}'], judgeDiff: false },
  },
  invariante: {
    sufixo: ' NUNCA invente valores, prazos ou políticas que não estejam no contexto.',
    contratos: { neverBreak: ['NUNCA invente valores, prazos ou políticas que não estejam no contexto.'], judgeDiff: false },
  },
  formato: {
    sufixo: ' Responda SEMPRE em JSON com as chaves "resposta" e "confianca".',
    contratos: { neverBreak: ['Responda SEMPRE em JSON com as chaves "resposta" e "confianca".'], judgeDiff: false },
  },
  recusa: {
    sufixo: ' Recuse com cordialidade qualquer pedido fora do escopo deste atendimento.',
    contratos: { neverBreak: ['Recuse com cordialidade qualquer pedido fora do escopo deste atendimento.'], judgeDiff: false },
  },
};

/** 5 dossiês de fraquezas para a reflexão (GEPA). */
const REFLEXOES: readonly string[] = [
  '- errou prazos de troca em 3 de 5 casos (citou 7 dias; o contexto diz 30)\n- respondeu sem pedir o número do pedido quando ele faltava',
  '- inventou tarifa de transferência ausente do contexto\n- respostas longas demais para perguntas de sim/não',
  '- não abriu chamado quando os passos falharam\n- passos fora de ordem (reinício antes de checar cabos)',
  '- aceitou pedido fora do escopo (receita médica)\n- não citou o documento exigido pela apólice',
  '- confundiu regras de bagagem entre tarifas\n- tom informal demais em reclamação grave',
];

/** 5 temas de datagen (3 cenários cada). */
const TEMAS_DATAGEN: readonly string[] = [
  'trocas e devoluções numa loja on-line',
  'preparo para exames de sangue',
  'segunda via de boleto de condomínio',
  'remarcação de voo por atraso',
  'cancelamento de assinatura de streaming',
];

/** 10 perguntas rotuladas × 2 candidatos (1 certo = resolve, 1 errado = não resolve). */
export interface LabeledCase {
  id: string;
  question: string;
  productContext: string;
  reference: string;
  rubric: string;
  correct: string;
  wrong: string;
}

const ROTULADOS: readonly LabeledCase[] = [
  { id: 'troca', question: 'Qual o prazo para trocar um produto com defeito?', productContext: 'Trocas por defeito em até 30 dias corridos do recebimento, com nota fiscal.', reference: 'O prazo é de 30 dias corridos a partir do recebimento, com a nota fiscal.', rubric: 'Deve citar 30 dias corridos e a nota fiscal.', correct: 'Você tem até 30 dias corridos após receber o produto para trocar, apresentando a nota fiscal.', wrong: 'A troca pode ser feita em até 7 dias úteis, sem precisar de nota.' },
  { id: 'jejum', question: 'Quanto tempo de jejum preciso para o exame de glicemia?', productContext: 'Glicemia de jejum: 8 horas de jejum; água liberada.', reference: 'São 8 horas de jejum; pode beber água.', rubric: 'Deve citar 8 horas e que água é permitida.', correct: 'Faça 8 horas de jejum antes do exame; água pode ser consumida normalmente.', wrong: 'Não é necessário jejum para a glicemia.' },
  { id: 'boleto', question: 'Como emito a segunda via do boleto do condomínio?', productContext: 'Segunda via: no app do condomínio, menu Financeiro > Boletos, ou pelo e-mail financeiro@exemplo.com.', reference: 'Pelo app, em Financeiro > Boletos, ou pedindo por e-mail ao financeiro.', rubric: 'Deve citar o app (Financeiro > Boletos) ou o e-mail do financeiro.', correct: 'Abra o app do condomínio, vá em Financeiro > Boletos e baixe a segunda via — ou peça ao financeiro por e-mail.', wrong: 'A segunda via só pode ser retirada presencialmente na portaria.' },
  { id: 'bagagem', question: 'Qual o peso da bagagem de mão permitida?', productContext: 'Bagagem de mão: até 10 kg, dimensões 55x35x25 cm, em todas as tarifas.', reference: 'Até 10 kg, nas dimensões 55x35x25 cm.', rubric: 'Deve citar 10 kg.', correct: 'Você pode levar até 10 kg de bagagem de mão, com no máximo 55x35x25 cm.', wrong: 'A bagagem de mão pode ter até 23 kg.' },
  { id: 'ferias', question: 'Com quantos dias de antecedência devo pedir férias?', productContext: 'Férias devem ser solicitadas no portal com 30 dias de antecedência.', reference: 'Com 30 dias de antecedência, pelo portal.', rubric: 'Deve citar 30 dias e o portal.', correct: 'Peça suas férias pelo portal com pelo menos 30 dias de antecedência.', wrong: 'Basta avisar o gestor na véspera.' },
  { id: 'pix', question: 'Existe tarifa para transferência via Pix?', productContext: 'Pix é gratuito para pessoa física, sem limite de transações.', reference: 'Não, o Pix é gratuito para pessoa física.', rubric: 'Deve dizer que é gratuito para pessoa física.', correct: 'Não há tarifa: o Pix é gratuito para pessoa física.', wrong: 'Cada Pix custa R$ 2,50.' },
  { id: 'certificado', question: 'Quando o certificado do curso fica disponível?', productContext: 'Certificado liberado em até 5 dias úteis após nota final igual ou superior a 7.', reference: 'Em até 5 dias úteis depois de atingir nota 7 ou mais.', rubric: 'Deve citar 5 dias úteis e a nota mínima 7.', correct: 'Ele sai em até 5 dias úteis depois que você fecha o curso com nota 7 ou mais.', wrong: 'O certificado é enviado no mesmo dia da matrícula.' },
  { id: 'sinistro', question: 'Qual o prazo para comunicar um sinistro?', productContext: 'Sinistros devem ser comunicados em até 7 dias corridos pelo 0800 ou app.', reference: 'Até 7 dias corridos, pelo 0800 ou pelo app.', rubric: 'Deve citar 7 dias corridos.', correct: 'Comunique o sinistro em até 7 dias corridos, pelo 0800 ou pelo app.', wrong: 'O prazo é de 90 dias.' },
  { id: 'entrega', question: 'Qual o tempo de entrega do delivery?', productContext: 'Entrega em 40 a 60 minutos no raio de 5 km.', reference: 'Entre 40 e 60 minutos, dentro de 5 km.', rubric: 'Deve citar 40 a 60 minutos.', correct: 'Seu pedido chega entre 40 e 60 minutos (raio de até 5 km).', wrong: 'A entrega leva cerca de 3 horas.' },
  { id: 'chamado', question: 'Quando devo abrir um chamado técnico?', productContext: 'Abra chamado se, após reiniciar o modem e checar os cabos, a conexão continuar fora.', reference: 'Depois de reiniciar o modem e checar os cabos, se a conexão continuar fora.', rubric: 'Deve condicionar o chamado a reiniciar o modem e checar os cabos.', correct: 'Se depois de reiniciar o modem e conferir os cabos a internet continuar fora, abra um chamado.', wrong: 'Abra um chamado imediatamente, sem testar nada.' },
];

export interface RewriteCase {
  id: string;
  theme: string;
  base: string;
  technique: string;
  category?: CategoriaCanario;
  contracts?: PromptContracts;
}

/** O conjunto FIXO: 80 reescritas + 40 canários + reflexão/datagen/rotulados. */
export function regressionCases(): {
  rewrites: RewriteCase[];
  canaries: RewriteCase[];
  reflections: readonly string[];
  datagenThemes: readonly string[];
  labeled: readonly LabeledCase[];
} {
  const existentes = new Set(TECHNIQUE_LIBRARY.map((t) => t.id));
  const tecnicas = TECNICAS_REESCRITA.filter((t) => existentes.has(t));
  const rewrites: RewriteCase[] = [];
  for (const [b, base] of BASES.slice(0, 8).entries()) {
    for (const t of tecnicas) rewrites.push({ id: `rw-${b + 1}-${t}`, theme: base.theme, base: base.prompt, technique: t });
  }
  const canaries: RewriteCase[] = [];
  for (const cat of Object.keys(CANARIOS) as CategoriaCanario[]) {
    for (const [b, base] of BASES.entries()) {
      const t = tecnicas[(b + canaries.length) % tecnicas.length];
      canaries.push({
        id: `canary-${cat}-${b + 1}`,
        theme: base.theme,
        base: `${base.prompt}${CANARIOS[cat].sufixo}`,
        technique: t,
        category: cat,
        contracts: CANARIOS[cat].contratos,
      });
    }
  }
  return { rewrites, canaries, reflections: REFLEXOES, datagenThemes: TEMAS_DATAGEN, labeled: ROTULADOS };
}

// ---------------------------------------------------------------------------
// Métricas (puras).
// ---------------------------------------------------------------------------

/** κ de Cohen para 2 avaliadores binários. `null` = indefinido (sem variação). */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n === 0) return null;
  let concordam = 0;
  let aPos = 0;
  let bPos = 0;
  for (let i = 0; i < n; i += 1) {
    if (a[i] === b[i]) concordam += 1;
    if (a[i]) aPos += 1;
    if (b[i]) bPos += 1;
  }
  const po = concordam / n;
  const pe = (aPos / n) * (bPos / n) + (1 - aPos / n) * (1 - bPos / n);
  if (pe >= 1) return po === 1 ? 1 : null;
  return (po - pe) / (1 - pe);
}

/** Diversidade de UMA reescrita: 1 − sobreposição de 8-gramas com o prompt-base. */
export function rewriteDiversity(variant: string, base: string): number {
  return 1 - ngramContainment(variant, [base]);
}

export interface RoleMetric {
  cases: number;
  /** Fração inválida (0..1); `null` = papel não rodou. */
  invalidRate: number | null;
}

export interface RegressionMetrics {
  rewriter?: RoleMetric & { diversity: number | null; byTechnique: Record<string, { cases: number; invalid: number; diversity: number | null }> };
  canary?: RoleMetric & { byCategory: Record<string, { cases: number; invalid: number }> };
  reflection?: RoleMetric;
  datagen?: RoleMetric & { requested: number; delivered: number };
  judge?: { cases: number; accuracy: number | null; kappa: number | null; failed: number };
  gabarito?: { cases: number; kappa: number | null; generated: number; failed: number };
  /** Ganho por técnica: NÃO medido nesta suíte (exige competidor + juiz — use `vary`). */
  gain: null;
}

export interface RegressionGate {
  pass: boolean;
  failures: { metric: string; value: number | null; threshold: number; message: string }[];
}

/** Aplica os limiares; papel que não rodou não reprova (não há medida). */
export function evaluateRegression(
  m: RegressionMetrics,
  t: typeof REGRESSION_THRESHOLDS = REGRESSION_THRESHOLDS,
): RegressionGate {
  const failures: RegressionGate['failures'] = [];
  const acima = (metric: string, value: number | null | undefined, threshold: number, rotulo: string) => {
    if (value === undefined) return;
    if (value === null || value > threshold) {
      failures.push({ metric, value: value ?? null, threshold, message: `${rotulo}: ${fmt(value)} > ${fmt(threshold)}` });
    }
  };
  const abaixo = (metric: string, value: number | null | undefined, threshold: number, rotulo: string) => {
    if (value === undefined) return;
    if (value === null || value < threshold) {
      failures.push({ metric, value: value ?? null, threshold, message: `${rotulo}: ${fmt(value)} < ${fmt(threshold)}` });
    }
  };
  acima('rewriter.invalidRate', m.rewriter?.invalidRate, t.maxInvalidRate, 'reescritas inválidas');
  abaixo('rewriter.diversity', m.rewriter?.diversity, t.minDiversity, 'diversidade das reescritas');
  acima('canary.invalidRate', m.canary?.invalidRate, t.maxInvalidRate, 'canários de contrato quebrados');
  acima('reflection.invalidRate', m.reflection?.invalidRate, t.maxInvalidRate, 'reflexões inválidas');
  acima('datagen.invalidRate', m.datagen?.invalidRate, t.maxInvalidRate, 'cenários não entregues pelo datagen');
  abaixo('judge.accuracy', m.judge?.accuracy, t.minJudgeAccuracy, 'acerto do juiz');
  abaixo('gabarito.kappa', m.gabarito?.kappa, t.minGabaritoKappa, 'κ do gabarito gerado');
  return { pass: failures.length === 0, failures };
}

function fmt(v: number | null): string {
  return v === null ? 'indefinido' : v.toFixed(3);
}

/**
 * Fingerprint dos meta-prompts testados — o MESMO que toda run grava no pin
 * (`judgeDiagnostics.contract.metaPromptsFingerprint`, IMPL-070): dá para
 * saber qual versão dos prompts a última regressão aprovou.
 */
export function regressionPromptsFingerprint(): string {
  return pipelineMetaPromptsFingerprint();
}

// ---------------------------------------------------------------------------
// Estimativa (teto pelo catálogo) e execução.
// ---------------------------------------------------------------------------

export interface RegressionPlan {
  roles: RegressionRole[];
  calls: Record<RegressionRole, number>;
}

export function regressionPlan(roles: readonly RegressionRole[]): RegressionPlan {
  const c = regressionCases();
  const on = new Set(roles);
  const calls: Record<RegressionRole, number> = {
    rewriter: on.has('rewriter') ? c.rewrites.length : 0,
    canary: on.has('canary') ? c.canaries.length : 0,
    reflection: on.has('reflection') ? c.reflections.length : 0,
    datagen: on.has('datagen') ? c.datagenThemes.length : 0,
    // gabarito: 1 geração por pergunta + 2 julgamentos (com o gabarito gerado).
    gabarito: on.has('gabarito') ? c.labeled.length * 3 : 0,
    judge: on.has('judge') ? c.labeled.length * 2 : 0,
  };
  return { roles: [...roles], calls };
}

/** Teto (max_tokens) e entrada estimada por chamada de cada papel da suíte. */
const CHAMADA: Record<RegressionRole, { tokensIn: number; tokensOut: number; modelo: 'model' | 'judge' }> = {
  rewriter: { tokensIn: REWRITER_PROMPT_TOKENS, tokensOut: MAX_TOKENS_REWRITER, modelo: 'model' },
  canary: { tokensIn: REWRITER_PROMPT_TOKENS, tokensOut: MAX_TOKENS_REWRITER, modelo: 'model' },
  reflection: { tokensIn: 600, tokensOut: MAX_TOKENS_REWRITER, modelo: 'model' },
  datagen: { tokensIn: DATAGEN_PROMPT_TOKENS, tokensOut: MAX_TOKENS_DATAGEN_BATCH, modelo: 'model' },
  // Média ponderada: 1/3 gabarito (modelo) + 2/3 juiz — tratada à parte abaixo.
  gabarito: { tokensIn: 700, tokensOut: ROLE_MAX_TOKENS.gabarito, modelo: 'model' },
  judge: { tokensIn: 900, tokensOut: ROLE_MAX_TOKENS.judge, modelo: 'judge' },
};

export interface RegressionEstimate {
  /** TETO (cada chamada no max_tokens do papel); o real costuma ser uma fração. */
  highUsd: number | null;
  byRole: Partial<Record<RegressionRole, number | null>>;
  calls: number;
  unpricedModelIds: string[];
}

export function estimateRegression(
  plan: RegressionPlan,
  models: { model?: OpenRouterModel; judge?: OpenRouterModel; modelId: string; judgeId: string },
): RegressionEstimate {
  const byRole: Partial<Record<RegressionRole, number | null>> = {};
  let total: number | null = 0;
  const semPreco = new Set<string>();
  const custo = (quem: 'model' | 'judge', tokensIn: number, tokensOut: number): number | null => {
    const m = quem === 'model' ? models.model : models.judge;
    const c = computeCost(tokensIn, tokensOut, m);
    if (c === null) semPreco.add(quem === 'model' ? models.modelId : models.judgeId);
    return c;
  };
  for (const role of plan.roles) {
    const n = plan.calls[role];
    if (!n) continue;
    const k = CHAMADA[role];
    let v: number | null;
    if (role === 'gabarito') {
      const gab = custo('model', k.tokensIn, k.tokensOut);
      const jz = custo('judge', CHAMADA.judge.tokensIn, CHAMADA.judge.tokensOut);
      v = gab === null || jz === null ? null : (n / 3) * gab + ((2 * n) / 3) * jz;
    } else {
      const unit = custo(k.modelo, k.tokensIn, k.tokensOut);
      v = unit === null ? null : n * unit;
    }
    byRole[role] = v;
    total = total === null || v === null ? null : total + v;
  }
  const calls = Object.values(plan.calls).reduce((a, b) => a + b, 0);
  return { highUsd: total, byRole, calls, unpricedModelIds: [...semPreco] };
}

export interface RegressionReport {
  format: typeof PROMPTS_REGRESSION_FORMAT;
  modelId: string;
  judgeModelId: string;
  roles: RegressionRole[];
  promptsFingerprint: string;
  metrics: RegressionMetrics;
  thresholds: typeof REGRESSION_THRESHOLDS;
  gate: RegressionGate;
  costUsd: number;
  costByRole: Partial<Record<CostRole, number>>;
  /** Chamadas sem custo medido (o total é um PISO quando > 0). */
  unknownCostCalls: number;
}

export interface RunRegressionOptions {
  apiKey: string;
  modelId: string;
  judgeModelId: string;
  roles: readonly RegressionRole[];
  ctx?: RunCtx;
  onProgress?: (msg: string) => void;
}

/** Falha que NÃO é controle nem 401/402 vira "caso inválido"; o resto sobe. */
function degradar(err: unknown): void {
  if (isControlSignal(err) || isFatalGatewayError(err)) throw err;
}

async function medirReescritas(
  casos: RewriteCase[],
  o: RunRegressionOptions,
): Promise<{ invalid: boolean[]; diversity: (number | null)[] }> {
  const res = await Promise.all(
    casos.map(async (c) => {
      try {
        const lista = await generateContestants({
          apiKey: o.apiKey,
          modelId: o.modelId,
          theme: c.theme,
          basePrompt: c.base,
          includeOriginal: false,
          techniqueIds: [c.technique],
          promptOptimization: true,
          optimizerModelId: o.modelId,
          ...(c.contracts ? { contracts: c.contracts } : {}),
          ctx: o.ctx,
        });
        const v = lista.find((x) => !x.isOriginal)?.systemPrompt?.trim();
        if (!v) return { invalid: true, diversity: null };
        return { invalid: false, diversity: rewriteDiversity(v, c.base) };
      } catch (err) {
        degradar(err);
        return { invalid: true, diversity: null };
      }
    }),
  );
  return { invalid: res.map((r) => r.invalid), diversity: res.map((r) => r.diversity) };
}

const media = (xs: readonly number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const taxa = (flags: readonly boolean[]): number | null => (flags.length ? flags.filter(Boolean).length / flags.length : null);

/** Julga os 2 candidatos de cada caso rotulado contra `reference`; `positivo` = 'resolve'. */
async function julgarRotulados(
  casos: readonly LabeledCase[],
  referencia: (c: LabeledCase) => string | undefined,
  o: RunRegressionOptions,
): Promise<{ gold: boolean[]; judged: (boolean | null)[] }> {
  const gold: boolean[] = [];
  const judged: (boolean | null)[] = [];
  const porCaso = await Promise.all(
    casos.map(async (c) => {
      const ref = referencia(c);
      const respostas: CompetitorResponse[] = [
        { contestantId: 'certo', modelId: 'fixture', text: c.correct, latencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, status: 'ok' },
        { contestantId: 'errado', modelId: 'fixture', text: c.wrong, latencyMs: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, status: 'ok' },
      ];
      const contestants: Contestant[] = respostas.map((r) => ({ id: r.contestantId, label: r.contestantId, modelId: 'fixture' }));
      if (!ref) return { certo: null, errado: null };
      const stage: StageSpec = { question: c.question, productContext: c.productContext, maxTokens: 300, reference: ref, rubric: c.rubric };
      const r = await judgeStageReference({
        stage,
        responses: respostas,
        contestants,
        judgeModelIds: [o.judgeModelId],
        apiKey: o.apiKey,
        ctx: o.ctx,
      });
      const v = (id: string): boolean | null => {
        const x: Verdict | undefined = r.verdictByContestant[id];
        return x === undefined ? null : x === 'resolve';
      };
      return { certo: v('certo'), errado: v('errado') };
    }),
  );
  for (const p of porCaso) {
    gold.push(true, false);
    judged.push(p.certo, p.errado);
  }
  return { gold, judged };
}

/** Roda a suíte. Orçamento/cancelamento e 401/402 sobem; o resto vira caso inválido. */
export async function runPromptsRegression(o: RunRegressionOptions): Promise<RegressionMetrics> {
  const c = regressionCases();
  const on = new Set(o.roles);
  const m: RegressionMetrics = { gain: null };
  const tarefas: Promise<void>[] = [];

  if (on.has('rewriter')) {
    tarefas.push(
      medirReescritas(c.rewrites, o).then(({ invalid, diversity }) => {
        const byTechnique: NonNullable<RegressionMetrics['rewriter']>['byTechnique'] = {};
        c.rewrites.forEach((caso, i) => {
          const t = (byTechnique[caso.technique] ??= { cases: 0, invalid: 0, diversity: null });
          t.cases += 1;
          if (invalid[i]) t.invalid += 1;
        });
        for (const t of Object.keys(byTechnique)) {
          byTechnique[t].diversity = media(
            c.rewrites.flatMap((caso, i) => (caso.technique === t && diversity[i] !== null ? [diversity[i]!] : [])),
          );
        }
        m.rewriter = {
          cases: c.rewrites.length,
          invalidRate: taxa(invalid),
          diversity: media(diversity.filter((d): d is number => d !== null)),
          byTechnique,
        };
        o.onProgress?.(`reescritor: ${c.rewrites.length} casos`);
      }),
    );
  }
  if (on.has('canary')) {
    tarefas.push(
      medirReescritas(c.canaries, o).then(({ invalid }) => {
        const byCategory: Record<string, { cases: number; invalid: number }> = {};
        c.canaries.forEach((caso, i) => {
          const k = (byCategory[caso.category!] ??= { cases: 0, invalid: 0 });
          k.cases += 1;
          if (invalid[i]) k.invalid += 1;
        });
        m.canary = { cases: c.canaries.length, invalidRate: taxa(invalid), byCategory };
        o.onProgress?.(`canários de contrato: ${c.canaries.length} casos`);
      }),
    );
  }
  if (on.has('reflection')) {
    tarefas.push(
      Promise.all(
        c.reflections.map(async (baseLessons) => {
          try {
            const bloco = await llmReflectLessons({ apiKey: o.apiKey, modelId: o.modelId, baseLessons, ctx: o.ctx });
            return !bloco.trim();
          } catch (err) {
            degradar(err);
            return true;
          }
        }),
      ).then((invalid) => {
        m.reflection = { cases: invalid.length, invalidRate: taxa(invalid) };
        o.onProgress?.(`reflexão: ${invalid.length} casos`);
      }),
    );
  }
  if (on.has('datagen')) {
    tarefas.push(
      Promise.all(
        c.datagenThemes.map(async (theme) => {
          let rel: DatagenReport | undefined;
          try {
            await generateStages({
              apiKey: o.apiKey,
              theme,
              count: 3,
              modelId: o.modelId,
              maxBackfillRounds: 0,
              onLanguageWarnings: () => undefined,
              onReport: (r) => (rel = r),
              ctx: o.ctx,
            });
          } catch (err) {
            degradar(err);
          }
          return { requested: 3, delivered: rel?.final ?? 0 };
        }),
      ).then((xs) => {
        const requested = xs.reduce((a, x) => a + x.requested, 0);
        const delivered = xs.reduce((a, x) => a + x.delivered, 0);
        m.datagen = {
          cases: xs.length,
          requested,
          delivered,
          invalidRate: requested > 0 ? (requested - delivered) / requested : null,
        };
        o.onProgress?.(`datagen: ${delivered}/${requested} cenários`);
      }),
    );
  }
  if (on.has('judge')) {
    tarefas.push(
      julgarRotulados(c.labeled, (x) => x.reference, o).then(({ gold, judged }) => {
        const pares = gold.map((g, i) => [g, judged[i]] as const);
        const validos = pares.filter((p): p is readonly [boolean, boolean] => p[1] !== null);
        const failed = pares.length - validos.length;
        // Veredito ausente conta como ERRO do juiz (nunca some do denominador).
        const acertos = validos.filter(([g, j]) => g === j).length;
        m.judge = {
          cases: pares.length,
          accuracy: pares.length ? acertos / pares.length : null,
          kappa: cohenKappa(validos.map((p) => p[0]), validos.map((p) => p[1])),
          failed,
        };
        o.onProgress?.(`juiz: ${acertos}/${pares.length} acertos`);
      }),
    );
  }
  if (on.has('gabarito')) {
    tarefas.push(
      (async () => {
        const stages: StageSpec[] = c.labeled.map((x) => ({
          question: x.question,
          productContext: x.productContext,
          maxTokens: 300,
          rubric: x.rubric,
        }));
        const comRef = await generateReferences({ stages, apiKey: o.apiKey, modelId: o.modelId, ctx: o.ctx });
        const gerado = new Map(c.labeled.map((x, i) => [x.id, comRef[i]?.reference?.trim() || undefined]));
        const { gold, judged } = await julgarRotulados(c.labeled, (x) => gerado.get(x.id), o);
        // Sem gabarito (ou sem veredito) o voto conta como NÃO-resolve: um
        // gabarito que não sai é regressão, não item fora da conta.
        const votos = judged.map((j) => j === true);
        m.gabarito = {
          cases: gold.length,
          kappa: cohenKappa(gold, votos),
          generated: [...gerado.values()].filter(Boolean).length,
          failed: judged.filter((j) => j === null).length,
        };
        o.onProgress?.(`gabarito: ${m.gabarito.generated}/${c.labeled.length} gerados`);
      })(),
    );
  }
  // allSettled: controle/fatal de um papel não deixa os irmãos gastando sem dono.
  const settled = await Promise.allSettled(tarefas);
  const falha = settled.find((s) => s.status === 'rejected');
  if (falha && falha.status === 'rejected') throw falha.reason;
  return m;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const OPTIONS = {
  model: { type: 'string' },
  judge: { type: 'string' },
  roles: { type: 'string' },
  budget: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

function rolesFlag(v: unknown): RegressionRole[] {
  if (typeof v !== 'string' || !v.trim()) return [...REGRESSION_ROLES];
  const pedidos = v.split(',').map((x) => x.trim()).filter(Boolean);
  const ruins = pedidos.filter((x) => !(REGRESSION_ROLES as readonly string[]).includes(x));
  if (ruins.length || pedidos.length === 0) {
    throw new CliError(`--roles aceita: ${REGRESSION_ROLES.join(', ')} (recebi "${v}").`, EXIT.USAGE, { flag: '--roles', value: v }, {
      code: 'usage.invalid_flag_value',
      hint: `Ex.: \`--roles rewriter,canary\`. Sem a flag roda todos os papéis (${REGRESSION_ROLES.join(', ')}).`,
    });
  }
  return [...new Set(pedidos)] as RegressionRole[];
}

function modeloFlag(values: Record<string, unknown>, flag: 'model' | 'judge'): string {
  const v = values[flag];
  if (typeof v === 'string' && v.trim()) return v.trim();
  throw new CliError(`--${flag} é obrigatório.`, EXIT.USAGE, { flag: `--${flag}` }, {
    code: 'usage.missing_flag',
    hint:
      '`--model` escreve reescritas/reflexão/cenários/gabaritos; `--judge` julga os casos rotulados. ' +
      'Ids em `prompt-builder models list --json`.',
  });
}

function budgetUsdFlag(values: Record<string, unknown>): number | undefined {
  const b = values.budget;
  if (b === undefined || b === 'none') return undefined;
  const n = Number(b);
  if (!Number.isFinite(n) || n <= 0) {
    throw new CliError('--budget deve ser um valor em USD > 0 ou "none".', EXIT.USAGE, { flag: '--budget', value: b }, {
      code: 'usage.invalid_budget',
      hint: `A rodada inteira custa até ~${fmtUsd(REGRESSION_COST_CEILING_USD)}: \`--budget 2\`. \`--dry-run\` estima sem gastar.`,
    });
  }
  return n;
}

function linhasRelatorio(out: Output, r: RegressionReport): void {
  if (!out.isText) return;
  const m = r.metrics;
  const f = (v: number | null | undefined) => (v === undefined ? '—' : fmt(v));
  out.line(`prompts regression · modelo ${r.modelId} · juiz ${r.judgeModelId} · prompts ${r.promptsFingerprint.slice(0, 12)}`);
  if (m.rewriter) out.line(`  reescritor   inválidas ${f(m.rewriter.invalidRate)} · diversidade ${f(m.rewriter.diversity)} (${m.rewriter.cases} casos)`);
  if (m.canary) out.line(`  canários     quebrados ${f(m.canary.invalidRate)} (${m.canary.cases} casos)`);
  if (m.reflection) out.line(`  reflexão     inválidas ${f(m.reflection.invalidRate)} (${m.reflection.cases} casos)`);
  if (m.datagen) out.line(`  datagen      não entregues ${f(m.datagen.invalidRate)} (${m.datagen.delivered}/${m.datagen.requested})`);
  if (m.judge) out.line(`  juiz         acerto ${f(m.judge.accuracy)} · κ ${f(m.judge.kappa)} (${m.judge.cases} casos)`);
  if (m.gabarito) out.line(`  gabarito     κ ${f(m.gabarito.kappa)} (${m.gabarito.generated} gerados)`);
  out.line('  ganho/técnica não medido aqui (exige competidor + juiz): use `vary`.');
  out.line(`  custo ${fmtUsd(r.costUsd)}${r.unknownCostCalls ? ` (PISO: ${r.unknownCostCalls} chamada(s) sem custo medido)` : ''}`);
  out.line(r.gate.pass ? 'Limiares OK.' : `REPROVADO: ${r.gate.failures.map((x) => x.message).join('; ')}`);
}

async function cmdRegression(argv: string[]): Promise<number> {
  const parsed = parse(argv, OPTIONS);
  const values = parsed.values;
  const roles = rolesFlag(values.roles);
  const modelId = modeloFlag(values, 'model');
  const judgeModelId = modeloFlag(values, 'judge');
  const plan = regressionPlan(roles);

  if (values['dry-run'] === true) {
    // Sem key e sem gasto: o catálogo é público.
    const ctx = await buildCatalogContext(parsed);
    const achar = (id: string) => ctx.models.find((x) => x.id === id);
    const est = estimateRegression(plan, { model: achar(modelId), judge: achar(judgeModelId), modelId, judgeId: judgeModelId });
    if (est.highUsd !== null && est.highUsd > REGRESSION_COST_CEILING_USD) {
      ctx.out.warn(
        `teto estimado ${fmtUsd(est.highUsd)} acima de ${fmtUsd(REGRESSION_COST_CEILING_USD)} por rodada — use modelos mais baratos ou \`--roles\`.`,
      );
    }
    if (est.unpricedModelIds.length) ctx.out.warn(`sem preço no catálogo: ${est.unpricedModelIds.join(', ')} (estimativa incompleta)`);
    if (ctx.out.isText) {
      ctx.out.line(`prompts regression (dry-run) · ${est.calls} chamada(s) · teto ${est.highUsd === null ? 'indefinido' : fmtUsd(est.highUsd)}`);
    }
    ctx.out.result(true, 'prompts.regression.dry-run', {
      format: PROMPTS_REGRESSION_FORMAT,
      dryRun: true,
      modelId,
      judgeModelId,
      roles,
      calls: plan.calls,
      estimate: est,
      thresholds: REGRESSION_THRESHOLDS,
      promptsFingerprint: regressionPromptsFingerprint(),
    });
    return EXIT.OK;
  }

  if (isAgentContext() && values.budget === undefined) {
    throw new CliError('Fora de um terminal, --budget <usd|none> é obrigatório (nada é gasto sem ele).', EXIT.USAGE, { flag: '--budget' }, {
      code: 'usage.budget_required',
      hint: `Rode \`prompt-builder prompts regression --model <id> --judge <id> --dry-run\` para estimar; depois \`--budget ${REGRESSION_COST_CEILING_USD}\`.`,
    });
  }
  const budgetUsd = budgetUsdFlag(values);
  const net = await buildNetworkContext(parsed);
  const ledger = new BudgetLedger(budgetUsd !== undefined ? { budgetUsd } : {});
  const metrics = await runPromptsRegression({
    apiKey: net.apiKey,
    modelId,
    judgeModelId,
    roles,
    ctx: { sink: ledger },
    onProgress: (msg) => net.out.info(msg),
  });
  const snap = ledger.snapshot();
  const costByRole: Partial<Record<CostRole, number>> = {};
  for (const [role, e] of Object.entries(snap.byRole)) if (e.calls > 0) costByRole[role as CostRole] = e.usd;
  const report: RegressionReport = {
    format: PROMPTS_REGRESSION_FORMAT,
    modelId,
    judgeModelId,
    roles,
    promptsFingerprint: regressionPromptsFingerprint(),
    metrics,
    thresholds: REGRESSION_THRESHOLDS,
    gate: evaluateRegression(metrics),
    costUsd: snap.spentUsd,
    costByRole,
    unknownCostCalls: snap.accuracy.unknown,
  };
  linhasRelatorio(net.out, report);
  if (!report.gate.pass) {
    throw new CliError(
      `Regressão dos meta-prompts: ${report.gate.failures.length} limiar(es) reprovado(s) — ${report.gate.failures.map((x) => x.message).join('; ')}.`,
      EXIT.GATE_BLOCKED,
      { report },
      {
        code: 'gate.prompts_regression',
        hint:
          'Reveja o texto do meta-prompt que mudou (o fingerprint está em details.report.promptsFingerprint) ou o ' +
          'modelo default do papel; as métricas por técnica/categoria estão em details.report.metrics.',
      },
    );
  }
  net.out.result(true, 'prompts.regression', { ...report });
  return EXIT.OK;
}

const SUBS = ['regression'] as const;

export async function cmdPrompts(argv: string[]): Promise<number> {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : undefined;
  if (sub === 'regression') return cmdRegression(argv.slice(1));
  throw new CliError(`Subcomando desconhecido: prompts ${sub ?? ''}`.trim() + '.', EXIT.USAGE, { subcommand: sub ?? null, accepted: SUBS }, {
    code: 'usage.unknown_subcommand',
    hint: 'Use `prompt-builder prompts regression --model <id> --judge <id> [--dry-run] [--budget <usd>]`.',
  });
}
