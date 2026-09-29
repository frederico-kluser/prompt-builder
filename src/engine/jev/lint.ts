// Modo JEV — validação OFFLINE de uma definição de decisão e dos casos (§7 do
// desenho). Um `error` IMPEDE o gasto em qualquer superfície (CLI exit 3, MCP
// erro da tool, UI `isRunnable=false`); `warning` informa; `--strict` promove
// aviso a erro.
//
// Fontes do port: `jev-agent-skill/scripts/lib/validate.mjs` (códigos,
// regexes com BORDA DE PALAVRA — lição da skill: `conte` casava dentro de
// `content`) e `jev-simulator/lib/jev.ts#validateDrafts` (regras de UI). O
// `COMPOUND_RE` do simulador (`\be\b.*\?`) NÃO é portado: casa com qualquer
// frase em português. A severidade segue a API AO VIVO + a política do
// produto (ex.: estado vazio a API aceita E cobra → erro nosso).

import { countTextTokens } from '../../openrouter.js';
import type { OpenRouterModel } from '../../types.js';
import type {
  JevCase,
  JevLintIssue,
  JevMode,
  JevQuestionSpec,
  JevSpec,
} from './types.js';
import {
  JEV_LIMITS,
  JEV_QUESTION_ID_RE,
  canonicalLabel,
  canonicalLabelsOf,
  depthOf,
  expectedList,
  getPath,
  isPlainObject,
  projectState,
  toWireQuestion,
  wireKeysOf,
} from './wire.js';

/** Estado acima disto (chars) = context rot provável (skill/simulador). */
export const STATE_LARGE_CHARS = 24_000;
/** Aninhamento máximo aceito no estado (a cascata de PII varre sem teto, mas o lint recusa antes). */
export const STATE_MAX_DEPTH = 32;
/** Casos rotulados por pergunta-alvo abaixo disto: treino recusa (`jev.dataset_too_small`). */
export const MIN_TRAIN_LABELED = 20;
/** Classe com menos que isto no ouro = desbalanceada (aviso). */
export const MIN_CLASS_CASES = 5;

// Borda de palavra que entende acento (\b do JS trata "ã" como não-letra).
const B = String.raw`(?<![\p{L}\p{N}_])`;
const E = String.raw`(?![\p{L}\p{N}_])`;
const words = (alts: string): RegExp => new RegExp(`${B}(?:${alts})${E}`, 'iu');

const GENERATIVE_RE = words(
  [
    'explain(?: why)?',
    'justify',
    'write',
    'generate',
    'draft',
    'summari[sz]e',
    'translate',
    'rewrite',
    'describe in detail',
    'explique(?: porquê| por que)?',
    'justifique',
    'escreva',
    'gere',
    'redija',
    'resuma',
    'resumo de',
    'traduza',
    'reescreva',
    'descreva em detalhe',
  ].join('|'),
);

const JAGGED_RE = words(
  [
    'how many',
    'count(?: the)?',
    'sum',
    'add up',
    'calculate',
    'compute',
    'multiply',
    'divide',
    'percentage of',
    'what date',
    'which date',
    'how old',
    'how long ago',
    'days between',
    'exact number',
    'total number',
    'quantos?',
    'quantas?',
    'conte',
    'contar',
    'somar?',
    'calcule',
    'calcular',
    'multiplique',
    'divida',
    'percentual de',
    'qual data',
    'que data',
    'quantos dias',
    'quantos anos',
    'há quanto tempo',
    'número exato',
    'total de',
  ].join('|'),
);

const COMPOUND_EN_RE = words(
  'and also|as well as|plus whether|and whether|and what|and how|and needs|and is|and has|and should|and wants|and asks',
);
const COMPOUND_PT_RE = new RegExp(
  String.raw`(?:^|[\s,;("'])e\s+(?:também|se|qual|quais|como|quantos?|precisa|está|tem|deve|quer|pede|solicita|requer|reporta)${E}|(?:^|[\s,;("'])bem\s+como${E}`,
  'iu',
);

const NEGATED_RE = words(
  [
    'not',
    'no',
    'never',
    'without',
    'free of',
    'except',
    'unless',
    'usually',
    'generally',
    'mostly',
    "isn't",
    "doesn't",
    "don't",
    'não',
    'nao',
    'nunca',
    'sem',
    'nenhum',
    'nenhuma',
    'exceto',
    'salvo',
    'geralmente',
    'normalmente',
    'em geral',
  ].join('|'),
);

const COMPARATIVE_RE = words(
  'worse than|better than|more than|less than|higher than|lower than|pior que|melhor que|mais que|menos que|maior que|menor que|mais do que|menos do que',
);

/** Chaves que significam "nenhuma das opções" (J5). */
export const NO_MATCH_KEY_RE =
  /^(other|others|unknown|none|none_of_the_above|n\/?a|not[_ -]?applicable|not[_ -]?stated|needs[_ -]?review|unclear|outro|outra|outros|outras|nenhum|nenhuma|nenhuma_das_anteriores|n[ãa]o[_ -]?se[_ -]?aplica|n[ãa]o[_ -]?informado|indeterminado|indefinido)$/i;

/** Chaves de `choice` que polarizam o modelo (o NOME da opção domina a rubrica — J3). */
const POLARIZED_KEYS = new Set(['yes', 'no', 'sim', 'não', 'nao', 'true', 'false', '0', '1', 'y', 'n', 's']);

const text = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

const nonEmpty = (v: unknown, allowNull: boolean): boolean => {
  if (v === null) return allowNull;
  if (typeof v === 'string') return v.trim().length > 0;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return false;
};

/** Um modelo é alias móvel (`~…`/`…-latest`)? Calibração nele não é reproduzível (J14). */
export function isAliasModel(modelId: string): boolean {
  const id = modelId.trim();
  return id.startsWith('~') || /-latest$/.test(id);
}

export interface LintSpecOptions {
  /** Entrada do catálogo de DECISÕES (contexto por modelo; ausente = orçamento desconhecido). */
  model?: OpenRouterModel;
  modelId?: string;
  mode?: JevMode;
  /** Perguntas-alvo do treino (degeneradas viram ERRO). */
  targetQuestions?: readonly string[];
  cases?: readonly JevCase[];
  strict?: boolean;
}

/** Nenhum erro? */
export function isRunnable(issues: readonly JevLintIssue[]): boolean {
  return !issues.some((i) => i.level === 'error');
}

/** `--strict`: aviso vira erro (info continua info). */
export function applyStrict(issues: JevLintIssue[], strict: boolean | undefined): JevLintIssue[] {
  if (!strict) return issues;
  return issues.map((i) => (i.level === 'warning' ? { ...i, level: 'error' as const } : i));
}

function lintQuestion(q: JevQuestionSpec, push: (i: JevLintIssue) => void, isTarget: boolean, mode?: JevMode): void {
  const where = `questions.${q.id}`;
  const qt = q as { type?: unknown; instructions?: unknown; criteria?: unknown; keyMap?: unknown };
  if (qt.type !== 'noul' && qt.type !== 'choice' && qt.type !== 'score') {
    push({
      level: 'error',
      code: 'question.type',
      questionId: q.id,
      path: `${where}.type`,
      message: `tipo inválido ${JSON.stringify(qt.type)} — use noul (sim/não), choice (1 de N) ou score (régua ordenada).`,
    });
    return;
  }
  if (qt.instructions === undefined || qt.instructions === null || !nonEmpty(qt.instructions, false)) {
    push({
      level: 'error',
      code: 'question.instructions',
      questionId: q.id,
      path: `${where}.instructions`,
      message: 'instrução vazia — escreva a pergunta INTEIRA em `instructions` (o id da pergunta nunca vai ao modelo).',
    });
  } else {
    const t = text(qt.instructions);
    if (GENERATIVE_RE.test(t)) {
      push({
        level: 'warning',
        code: 'question.generative',
        questionId: q.id,
        path: `${where}.instructions`,
        message: 'a pergunta parece pedir texto/explicação — o Jev NÃO gera texto; ele só escolhe entre as opções.',
        fix: 'Reescreva como julgamento tipado (ex.: "Qual o motivo principal?" com opções em criteria).',
      });
    }
    if (JAGGED_RE.test(t)) {
      push({
        level: 'warning',
        code: 'question.jaggedness',
        questionId: q.id,
        path: `${where}.instructions`,
        message: 'contagem/aritmética/data exata é falha documentada do Jev (jaggedness).',
        fix: 'Calcule em código e envie o RESULTADO no estado; peça ao Jev só o julgamento semântico.',
      });
    }
    const interrogacoes = (t.match(/\?/g) ?? []).length;
    if (interrogacoes > 1 || COMPOUND_EN_RE.test(t) || COMPOUND_PT_RE.test(t)) {
      push({
        level: 'warning',
        code: 'question.atomicity',
        questionId: q.id,
        path: `${where}.instructions`,
        message: 'a pergunta parece conter MAIS DE UM julgamento.',
        fix: 'Divida em perguntas separadas no mesmo mapa (avaliadas em paralelo, sem custo de latência) e combine em código.',
      });
    }
    if (NEGATED_RE.test(t)) {
      push({
        level: 'warning',
        code: 'question.negated',
        questionId: q.id,
        path: `${where}.instructions`,
        message: 'negação/escopo vago na instrução ("não", "sem", "geralmente"…) — o Jev lê ao pé da letra (J1).',
        fix: 'Escreva a condição literal e positiva ("alto = sim").',
      });
    }
  }

  if (q.type === 'noul') {
    const c = qt.criteria;
    if (c !== undefined) {
      if (!isPlainObject(c) || !nonEmpty(c.true, false) || !nonEmpty(c.false, false)) {
        push({
          level: 'error',
          code: 'noul.criteria_pair',
          questionId: q.id,
          path: `${where}.criteria`,
          message:
            '`criteria` de noul precisa das DUAS chaves, "true" e "false", preenchidas (a API recusa com 400 a meia rubrica ou null).',
          fix: 'Preencha as duas descrições ou remova `criteria` inteiro.',
        });
      } else {
        const extras = Object.keys(c).filter((k) => k !== 'true' && k !== 'false');
        if (extras.length) {
          push({
            level: 'warning',
            code: 'noul.criteria_extra',
            questionId: q.id,
            path: `${where}.criteria`,
            message: `chaves sem efeito em noul: ${extras.join(', ')} (só "true"/"false" contam).`,
          });
        }
        const instrNeg = NEGATED_RE.test(text(qt.instructions));
        const trueNeg = NEGATED_RE.test(text(c.true).split(/[.;]/)[0] ?? '');
        if (instrNeg !== trueNeg) {
          push({
            level: 'warning',
            code: 'noul.polarity_mismatch',
            questionId: q.id,
            path: `${where}.criteria.true`,
            message: 'a rubrica de "true" tem polaridade oposta à da instrução (J2): P(sim) pode sair invertida.',
            fix: 'Alinhe "true" ao que a pergunta afirma (alto = sim), sem inverter a pergunta.',
          });
        }
      }
    }
    return;
  }

  if (q.type === 'choice') {
    if (!isPlainObject(qt.criteria)) {
      push({
        level: 'error',
        code: 'choice.criteria',
        questionId: q.id,
        path: `${where}.criteria`,
        message: '`choice` exige `criteria`: um objeto { opção: rubrica } (a API recusa com 400 "expected record").',
      });
      return;
    }
    const keys = Object.keys(qt.criteria);
    if (keys.length === 0) {
      push({ level: 'error', code: 'choice.options_empty', questionId: q.id, path: `${where}.criteria`, message: '`choice` sem opções.' });
      return;
    }
    if (keys.length > JEV_LIMITS.CHOICE_MAX_OPTIONS) {
      push({
        level: 'error',
        code: 'choice.too_many',
        questionId: q.id,
        path: `${where}.criteria`,
        message: `${keys.length} opções — a API aceita no máximo ${JEV_LIMITS.CHOICE_MAX_OPTIONS} (400 do upstream).`,
        fix: 'Hierarquize: escolha em dois níveis (grupo → detalhe).',
      });
    }
    const vistos = new Map<string, string>();
    for (const k of keys) {
      if (!k.trim()) {
        push({ level: 'error', code: 'choice.option_empty_key', questionId: q.id, path: `${where}.criteria`, message: 'opção com chave vazia.' });
        continue;
      }
      const norm = k.trim().toLowerCase();
      if (vistos.has(norm)) {
        push({
          level: 'error',
          code: 'choice.option_duplicate',
          questionId: q.id,
          path: `${where}.criteria.${k}`,
          message: `opções duplicadas depois de normalizar: "${vistos.get(norm)}" e "${k}".`,
        });
      }
      vistos.set(norm, k);
      const rub = (qt.criteria as Record<string, unknown>)[k];
      if (rub !== null && !nonEmpty(rub, true)) {
        push({
          level: 'error',
          code: 'choice.option_rubric',
          questionId: q.id,
          path: `${where}.criteria.${k}`,
          message: `rubrica inválida na opção "${k}" — use texto, objeto, lista ou null (autoexplicativa).`,
        });
      }
      if (POLARIZED_KEYS.has(norm) && rub !== null && nonEmpty(rub, false)) {
        push({
          level: 'warning',
          code: 'choice.key_polarized',
          questionId: q.id,
          path: `${where}.criteria.${k}`,
          message: `a chave "${k}" é lida pelo modelo e domina a rubrica (5 de 6 respostas seguiram o nome trocado — J3).`,
          fix: 'Renomeie a chave para o conceito (ex.: `refund_request`) e mapeie para o rótulo do ouro com `keyMap`.',
        });
      }
    }
    if (keys.length === 1) {
      push({
        level: isTarget && mode === 'train' ? 'error' : 'warning',
        code: 'choice.single_option',
        questionId: q.id,
        path: `${where}.criteria`,
        message: '`choice` com UMA opção: a API aceita (prob 1, confiança 1) mas não é decisão — sai das métricas probabilísticas.',
        fix: 'Use noul ou acrescente alternativas.',
      });
    }
    const labels = canonicalLabelsOf(q);
    if (!keys.some((k) => NO_MATCH_KEY_RE.test(k.trim())) && !labels.some((l) => NO_MATCH_KEY_RE.test(l.trim()))) {
      push({
        level: 'warning',
        code: 'choice.no_exit',
        questionId: q.id,
        path: `${where}.criteria`,
        message: 'sem opção de saída (other/none/outro…) — estados que não cabem em nenhuma opção são forçados numa errada (J5).',
      });
    }
    const km = qt.keyMap;
    if (km !== undefined) {
      if (!isPlainObject(km)) {
        push({ level: 'error', code: 'keymap.invalid', questionId: q.id, path: `${where}.keyMap`, message: '`keyMap` deve ser { chaveNoFio: rótuloDoOuro }.' });
      } else {
        const destinos = new Map<string, string>();
        for (const [wk, lab] of Object.entries(km)) {
          if (!keys.includes(wk)) {
            push({ level: 'error', code: 'keymap.invalid', questionId: q.id, path: `${where}.keyMap.${wk}`, message: `\`keyMap\` cita "${wk}", que não é opção do criteria.` });
          }
          if (typeof lab !== 'string' || !lab.trim()) {
            push({ level: 'error', code: 'keymap.invalid', questionId: q.id, path: `${where}.keyMap.${wk}`, message: `rótulo vazio para "${wk}".` });
          }
        }
        for (const k of keys) {
          const lab = canonicalLabel(q, k);
          if (destinos.has(lab)) {
            push({
              level: 'error',
              code: 'keymap.invalid',
              questionId: q.id,
              path: `${where}.keyMap`,
              message: `duas opções no fio ("${destinos.get(lab)}" e "${k}") viram o MESMO rótulo "${lab}".`,
            });
          }
          destinos.set(lab, k);
        }
      }
    }
    return;
  }

  // score
  if (!Array.isArray(qt.criteria)) {
    push({
      level: 'error',
      code: 'score.criteria',
      questionId: q.id,
      path: `${where}.criteria`,
      message: '`score` exige `criteria`: uma LISTA ordenada de níveis (do mais baixo ao mais alto).',
    });
    return;
  }
  const levels = qt.criteria as unknown[];
  if (levels.length === 0) {
    push({ level: 'error', code: 'score.level_empty', questionId: q.id, path: `${where}.criteria`, message: '`score` sem níveis.' });
    return;
  }
  if (levels.length > JEV_LIMITS.SCORE_MAX_LEVELS) {
    push({
      level: 'error',
      code: 'score.levels_max',
      questionId: q.id,
      path: `${where}.criteria`,
      message: `${levels.length} níveis — a documentação limita a ${JEV_LIMITS.SCORE_MAX_LEVELS}; acima disso os níveis nem se distinguem.`,
    });
  }
  if (levels.length < 2) {
    push({
      level: isTarget && mode === 'train' ? 'error' : 'warning',
      code: 'score.levels_min',
      questionId: q.id,
      path: `${where}.criteria`,
      message: '`score` com menos de 2 níveis (a API aceita, mas não é régua) — sai das métricas probabilísticas.',
      fix: 'Use noul ou descreva ao menos dois níveis.',
    });
  }
  const vistos = new Set<string>();
  levels.forEach((lv, i) => {
    if (lv !== null && !nonEmpty(lv, true)) {
      push({ level: 'error', code: 'score.level_empty', questionId: q.id, path: `${where}.criteria[${i}]`, message: `nível ${i} vazio.` });
      return;
    }
    const t = text(lv).trim().toLowerCase();
    if (t && vistos.has(t)) {
      push({ level: 'warning', code: 'score.level_duplicate', questionId: q.id, path: `${where}.criteria[${i}]`, message: `nível ${i} repete outro nível.` });
    }
    vistos.add(t);
    if (typeof lv === 'string' && /^\s*[\d.\s-]+\s*$/.test(lv)) {
      push({
        level: 'warning',
        code: 'score.level_numeric',
        questionId: q.id,
        path: `${where}.criteria[${i}]`,
        message: `nível ${i} só com números ("${lv}") — desempenho documentado como fraco (J9).`,
        fix: 'Descreva a SITUAÇÃO concreta de cada nível.',
      });
    }
    if (COMPARATIVE_RE.test(text(lv))) {
      push({
        level: 'warning',
        code: 'score.level_comparative',
        questionId: q.id,
        path: `${where}.criteria[${i}]`,
        message: `nível ${i} é comparativo ("pior que", "mais que") — cada nível é julgado SOZINHO, sem ver os vizinhos (J9).`,
      });
    }
  });
}

/** Caminhos citados entre crases na instrução (`ticket.body`). */
export function citedPaths(q: JevQuestionSpec): string[] {
  const t = text((q as { instructions?: unknown }).instructions);
  const out: string[] = [];
  for (const m of t.matchAll(/`([^`\s]{1,120})`/g)) {
    if (/^[A-Za-z_$][\w$]*(?:\.[\w$]+|\[\d+\])*$/.test(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Lint da DEFINIÇÃO (estrutura + conceito + orçamento de contexto por modelo).
 * `cases` (opcional) habilita `budget.*` e `path.missing` com o estado real.
 */
export function lintJevSpec(spec: JevSpec, opts: LintSpecOptions = {}): JevLintIssue[] {
  const issues: JevLintIssue[] = [];
  const push = (i: JevLintIssue): void => {
    issues.push(i);
  };
  const qs = Array.isArray(spec.questions) ? spec.questions : [];
  if (qs.length === 0) {
    push({ level: 'error', code: 'questions.empty', path: 'questions', message: 'a definição não tem perguntas.' });
    return applyStrict(issues, opts.strict);
  }
  if (qs.length > JEV_LIMITS.QUESTIONS_WARN) {
    push({
      level: 'warning',
      code: 'questions.count',
      path: 'questions',
      message: `${qs.length} perguntas num pedido: funciona (paralelo), mas orçamento e depuração pioram.`,
    });
  }
  const ids = new Set<string>();
  const alvo = opts.targetQuestions ? new Set(opts.targetQuestions) : null;
  for (const q of qs) {
    const id = typeof q.id === 'string' ? q.id : '';
    if (!JEV_QUESTION_ID_RE.test(id)) {
      push({
        level: 'error',
        code: 'question.id',
        questionId: id,
        path: `questions.${id}`,
        message: `id de pergunta inválido "${id}" — use ^[A-Za-z0-9_.-]{1,96}$ (é contrato de código e coluna do CSV).`,
      });
    } else if (ids.has(id)) {
      push({ level: 'error', code: 'question.id', questionId: id, path: `questions.${id}`, message: `id de pergunta duplicado "${id}".` });
    }
    ids.add(id);
    lintQuestion(q, push, alvo ? alvo.has(id) : !q.guard, opts.mode);
  }

  // Linguagem (J16): o Jev tem avaliação oficial só em inglês.
  const instrTexto = qs.map((q) => `${text((q as { instructions?: unknown }).instructions)} ${text((q as { criteria?: unknown }).criteria)}`).join(' ');
  const naoAscii = (instrTexto.match(/[^\x00-\x7F]/g) ?? []).length;
  if (instrTexto.length > 40 && naoAscii / instrTexto.length > 0.15) {
    push({
      level: 'info',
      code: 'language.non_english',
      message: 'instruções majoritariamente não-inglesas: o Jev não tem avaliação oficial fora do inglês — meça nos seus casos.',
    });
  }

  const modelId = opts.modelId ?? opts.model?.id;
  if (modelId && isAliasModel(modelId) && (opts.mode === 'train' || (spec.policy && Object.keys(spec.policy.questions ?? {}).length > 0))) {
    push({
      level: 'warning',
      code: 'model.alias',
      message: `"${modelId}" é um alias móvel: limiares e temperatura calibrados nele deixam de valer quando o snapshot muda (J14).`,
      fix: 'Fixe a versão (ex.: typesafe/jev-1.13).',
    });
  }

  // path.missing: caminho citado na instrução precisa existir (stateView ou casos).
  const cases = opts.cases ?? [];
  const nomesView = new Set((spec.stateView?.fields ?? []).map((f) => f.as));
  for (const q of qs) {
    for (const p of citedPaths(q)) {
      let existe = false;
      if (spec.stateView?.fields?.length) {
        const raiz = p.split(/[.[]/)[0];
        existe = nomesView.has(p) || nomesView.has(raiz);
      } else if (cases.length) {
        existe = cases.some((c) => getPath(projectState(c.state, spec.stateView), p) !== undefined);
      } else {
        existe = true; // sem como conferir
      }
      if (!existe) {
        push({
          level: 'warning',
          code: 'path.missing',
          questionId: q.id,
          path: `questions.${q.id}.instructions`,
          message: `a instrução cita \`${p}\`, que não existe no estado projetado — o modelo procura um campo que não vem (J8).`,
        });
      }
    }
  }

  // Orçamento de contexto POR MODELO (jev 32.000; kev 8.192; span = desconhecido).
  const ctx = opts.model?.contextLength;
  if (cases.length && ctx && ctx > 0) {
    let pior = { caseId: '', tokens: 0, total: 0 };
    const qTokens = qs.map((q) => {
      try {
        return countTextTokens(JSON.stringify(toWireQuestion(q)));
      } catch {
        return 0;
      }
    });
    const maiorQ = Math.max(0, ...qTokens);
    const todasQ = qTokens.reduce((s, x) => s + x, 0);
    for (const c of cases) {
      const st = projectState(c.state, spec.stateView);
      const t = countTextTokens(typeof st === 'string' ? st : JSON.stringify(st));
      if (t + maiorQ > pior.tokens) pior = { caseId: c.id, tokens: t + maiorQ, total: t + todasQ };
    }
    if (pior.tokens > ctx) {
      push({
        level: 'error',
        code: 'budget.context',
        path: 'state',
        message: `estado + maior pergunta ≈ ${pior.tokens} tokens no caso "${pior.caseId}" > contexto de ${ctx} do modelo.`,
        fix: 'Projete o estado (stateView: só os campos relevantes, com maxChars).',
      });
    } else if (pior.tokens > ctx * 0.8) {
      push({
        level: 'warning',
        code: 'budget.context_near',
        path: 'state',
        message: `estado + maior pergunta ≈ ${pior.tokens} tokens (caso "${pior.caseId}") — acima de 80% do contexto de ${ctx}.`,
      });
    }
    if (pior.total > ctx * 2) {
      push({
        level: 'warning',
        code: 'budget.total',
        path: 'questions',
        message: `estado + todas as perguntas ≈ ${pior.total} tokens (caso "${pior.caseId}") > 2× o contexto: divida as perguntas em pedidos.`,
      });
    }
  }
  return applyStrict(issues, opts.strict);
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------

export interface LintCasesOptions {
  mode?: JevMode;
  targetQuestions?: readonly string[];
  strict?: boolean;
}

/** Um valor-ouro é válido para a pergunta? (espera o valor JÁ normalizado pelo dataset). */
export function expectedIssue(q: JevQuestionSpec, v: unknown): string | null {
  if (q.type === 'noul') return typeof v === 'boolean' ? null : `noul espera true/false, veio ${JSON.stringify(v)}`;
  if (q.type === 'choice') {
    if (typeof v !== 'string') return `choice espera o rótulo (texto), veio ${JSON.stringify(v)}`;
    return canonicalLabelsOf(q).includes(v) ? null : `rótulo "${v}" não é opção (${canonicalLabelsOf(q).join(', ')})`;
  }
  const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n ? null : `score espera um nível inteiro 0..${n - 1}, veio ${JSON.stringify(v)}`;
}

/** Lint dos CASOS contra a definição (ouro, estado, cobertura de rótulos, tamanho). */
export function lintJevCases(cases: readonly JevCase[], spec: JevSpec, opts: LintCasesOptions = {}): JevLintIssue[] {
  const issues: JevLintIssue[] = [];
  if (cases.length === 0) {
    issues.push({ level: 'error', code: 'cases.empty', message: 'nenhum caso: o modo JEV mede contra rótulos-ouro.' });
    return applyStrict(issues, opts.strict);
  }
  const qById = new Map(spec.questions.map((q) => [q.id, q]));
  const ids = new Set<string>();
  const alvo = new Set(opts.targetQuestions ?? spec.questions.filter((q) => !q.guard).map((q) => q.id));
  for (const c of cases) {
    if (ids.has(c.id)) {
      issues.push({ level: 'error', code: 'case.duplicate_id', path: `cases.${c.id}`, message: `id de caso duplicado "${c.id}" (é a chave de pareamento).` });
    }
    ids.add(c.id);
    const st = c.state as unknown;
    const vazio =
      st === undefined ||
      st === null ||
      (typeof st === 'string' && !st.trim()) ||
      (Array.isArray(st) && st.length === 0) ||
      (isPlainObject(st) && Object.keys(st).length === 0);
    if (vazio) {
      issues.push({ level: 'error', code: 'state.empty', path: `cases.${c.id}.state`, message: `caso "${c.id}" com estado vazio (a API aceita E cobra).` });
    } else {
      const texto = typeof st === 'string' ? st : JSON.stringify(st);
      if (texto.length > STATE_LARGE_CHARS) {
        issues.push({ level: 'warning', code: 'state.large', path: `cases.${c.id}.state`, message: `caso "${c.id}": estado com ${texto.length} caracteres — context rot provável (J8).` });
      }
      if (/[\u0000-\u0008]/.test(texto)) {
        issues.push({ level: 'warning', code: 'state.binary', path: `cases.${c.id}.state`, message: `caso "${c.id}": bytes de controle/binários no estado (o Jev só lê texto).` });
      }
      if (/[A-Za-z0-9+/]{200,}={0,2}/.test(texto)) {
        issues.push({ level: 'warning', code: 'state.blob', path: `cases.${c.id}.state`, message: `caso "${c.id}": blob base64 no estado — ruído que consome orçamento.` });
      }
      if (depthOf(st, STATE_MAX_DEPTH + 1) > STATE_MAX_DEPTH) {
        issues.push({
          level: 'error',
          code: 'state.too_deep',
          path: `cases.${c.id}.state`,
          message: `caso "${c.id}": estado com mais de ${STATE_MAX_DEPTH} níveis de aninhamento — achate antes de enviar.`,
        });
      }
    }
    for (const [qid, v] of Object.entries(c.expected ?? {})) {
      const q = qById.get(qid);
      if (!q) {
        issues.push({ level: 'error', code: 'expected.unknown_question', path: `cases.${c.id}.expected.${qid}`, message: `caso "${c.id}": ouro para a pergunta inexistente "${qid}".` });
        continue;
      }
      for (const alt of expectedList(v)) {
        const prob = expectedIssue(q, alt);
        if (!prob) continue;
        issues.push({
          level: 'error',
          code: q.type === 'choice' && typeof alt === 'string' ? 'labels.uncovered' : 'expected.invalid',
          questionId: qid,
          path: `cases.${c.id}.expected.${qid}`,
          message: `caso "${c.id}": ${prob}.`,
        });
      }
    }
  }
  // Cobertura e tamanho por pergunta.
  for (const q of spec.questions) {
    const rotulados = cases.filter((c) => expectedList(c.expected?.[q.id]).length > 0);
    const isTarget = alvo.has(q.id);
    if (rotulados.length === 0) {
      issues.push({
        level: opts.mode === 'train' && isTarget ? 'error' : 'warning',
        code: 'question.no_gold',
        questionId: q.id,
        message: `nenhum caso rotula "${q.id}" — a pergunta é enviada (e cobrada) mas não pontua.`,
      });
      continue;
    }
    if (rotulados.length < MIN_TRAIN_LABELED) {
      issues.push({
        level: opts.mode === 'train' && isTarget ? 'error' : 'warning',
        code: 'cases.too_few',
        questionId: q.id,
        message: `"${q.id}" tem ${rotulados.length} caso(s) rotulado(s) (< ${MIN_TRAIN_LABELED}): ${opts.mode === 'train' ? 'o treino recusa' : 'métricas instáveis'}.`,
      });
    }
    if (q.type === 'choice' && isPlainObject(q.criteria)) {
      const contagem = new Map<string, number>();
      for (const c of rotulados) for (const alt of expectedList(c.expected[q.id])) contagem.set(String(alt), (contagem.get(String(alt)) ?? 0) + 1);
      const nunca = canonicalLabelsOf(q).filter((l) => !contagem.has(l));
      if (nunca.length) {
        issues.push({
          level: 'warning',
          code: 'labels.unseen',
          questionId: q.id,
          message: `opções nunca vistas no ouro de "${q.id}": ${nunca.slice(0, 8).join(', ')} — sem como medir se o modelo as usa bem.`,
        });
      }
      if (rotulados.length >= MIN_TRAIN_LABELED) {
        const raras = [...contagem.entries()].filter(([, n]) => n < MIN_CLASS_CASES).map(([l]) => l);
        if (raras.length) {
          issues.push({
            level: 'warning',
            code: 'labels.imbalanced',
            questionId: q.id,
            message: `classes com menos de ${MIN_CLASS_CASES} casos em "${q.id}": ${raras.slice(0, 8).join(', ')}.`,
          });
        }
      }
    }
  }
  return applyStrict(issues, opts.strict);
}



