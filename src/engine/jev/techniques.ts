// Modo JEV — o catálogo de OPERADORES da evolução (§11.2) e o mapa das 19
// técnicas de prompt LLM (`src/techniques.ts`) para o Jev. Filtrar a biblioteca
// LLM deixaria 2 itens úteis: o modo tem catálogo próprio.
//
// Resposta curta à pergunta do dono ("dá para usar as mesmas técnicas?"):
// 2 transferem direto (specificity, rubric), 9 transferem MUDANDO DE LUGAR
// (few-shot vira exemplo DENTRO da rubrica de cada opção; contrastive vira
// `not_for`; uncertainty vira opção de saída + bandas + temperatura…) e 8 não
// se aplicam (o Jev não gera texto: persona, CoT, formato, autocrítica…).

import type { JevLintIssue, JevOperatorId } from './types.js';

export interface JevOperatorInfo {
  id: JevOperatorId;
  /** Técnica Jev de origem (J1…J16 da pesquisa). */
  ref: string;
  kind: 'deterministic' | 'proposer' | 'policy';
  label: string;
  what: string;
  when: string;
  /** Disponível nesta versão (crítica C: 4 operadores na v1 + o estágio de política). */
  available: boolean;
}

export const JEV_OPERATORS: Record<JevOperatorId, JevOperatorInfo> = {
  add_examples: {
    id: 'add_examples',
    ref: 'J10',
    kind: 'deterministic',
    label: 'Exemplos na rubrica',
    what: 'Copia casos do split de TREINO (balanceados, os mais curtos primeiro, teto de ~600 tokens por pergunta) para `examples` de cada opção/nível. Os casos usados saem do gate da iteração.',
    when: 'Classes com erro no dossiê; o custo por request sobe (tokens de entrada).',
    available: true,
  },
  add_not_for: {
    id: 'add_not_for',
    ref: 'J4',
    kind: 'proposer',
    label: 'Fronteira `not_for`',
    what: 'Acrescenta `not_for` no par de opções MAIS confundido (a rubrica vira {what, not_for}).',
    when: 'Confusão A↔B em 3 casos ou mais no treino.',
    available: true,
  },
  describe_option: {
    id: 'describe_option',
    ref: 'J4',
    kind: 'proposer',
    label: 'Descrever opção',
    what: 'Escreve a rubrica das opções vazias/`null` (e reforça as de uma palavra).',
    when: 'Opções sem rubrica (roteador com nomes sem descrição: 40/40 no modelo errado).',
    available: true,
  },
  literalize: {
    id: 'literalize',
    ref: 'J1',
    kind: 'proposer',
    label: 'Instrução literal',
    what: 'Reescreve `instructions` como condição literal, positiva e atômica (sem negação implícita nem escopo vago).',
    when: 'Lint `question.negated`/`question.atomicity` ou erros com confiança alta.',
    available: true,
  },
  structure_rubric: {
    id: 'structure_rubric',
    ref: 'J4',
    kind: 'deterministic',
    label: 'Rubrica estruturada',
    what: 'Rubrica string → {what} (preparo para not_for).',
    when: 'Rubricas em string com par confundido.',
    available: false,
  },
  project_state: {
    id: 'project_state',
    ref: 'J8',
    kind: 'deterministic',
    label: 'Projeção do estado',
    what: 'Ablação de campos do estado (`stateView`): tira/trunca UM campo por variante — reduz custo de entrada.',
    when: 'Estado objeto com 2+ campos.',
    available: false,
  },
  add_exit: {
    id: 'add_exit',
    ref: 'J5',
    kind: 'deterministic',
    label: 'Opção de saída',
    what: 'Adiciona `other` (abstenção) — muda o espaço de rótulos, só com opt-in.',
    when: 'Lint `choice.no_exit`.',
    available: false,
  },
  polarity_align: {
    id: 'polarity_align',
    ref: 'J2',
    kind: 'proposer',
    label: 'Polaridade',
    what: 'Alinha criteria.true/false à instrução ("alto = sim"), sem inverter a pergunta.',
    when: 'Lint `noul.polarity_mismatch`.',
    available: false,
  },
  rewrite_levels: {
    id: 'rewrite_levels',
    ref: 'J9',
    kind: 'proposer',
    label: 'Níveis como situações',
    what: 'Reescreve o texto dos níveis do score (mesmo número e ordem) como situações concretas.',
    when: 'Lint `score.level_numeric`/`comparative`, MAE alto.',
    available: false,
  },
  rename_key: {
    id: 'rename_key',
    ref: 'J3',
    kind: 'proposer',
    label: 'Renomear chave',
    what: 'Troca chaves de opção polarizadas (yes/no) por conceitos, com `keyMap` para o ouro.',
    when: 'Lint `choice.key_polarized`.',
    available: false,
  },
  translate_spec: {
    id: 'translate_spec',
    ref: 'J16',
    kind: 'proposer',
    label: 'Traduzir para inglês',
    what: 'Instrução, rubrica e chaves → inglês (`keyMap` preservado; o estado NUNCA é traduzido).',
    when: 'Lint `language.non_english` (o Jev só tem avaliação oficial em inglês).',
    available: false,
  },
  fit_policy: {
    id: 'fit_policy',
    ref: 'J13',
    kind: 'policy',
    label: 'Política (T + limiares)',
    what: 'Temperatura pós-hoc e limiares auto/hitl por pergunta, no split `calib`. Não é variante: é o estágio final.',
    when: 'Sempre, no fim do treino (e no eval com `fit`).',
    available: true,
  },
};

export type JevTechniqueVerdict = 'T' | 'T±' | 'NA';

/** As 19 técnicas LLM (`TECHNIQUE_LIBRARY`) → o que viram no Jev. */
export const JEV_TECHNIQUE_MAP: { id: string; verdict: JevTechniqueVerdict; jev: string; operator?: JevOperatorId }[] = [
  { id: 'persona', verdict: 'NA', jev: 'Sem system prompt: o prior de domínio vai para a rubrica (vocabulário em criteria).' },
  { id: 'cot', verdict: 'NA', jev: 'Não há passo de raciocínio: decomponha em perguntas e componha em código (J6); contas saem do modelo (J7).' },
  { id: 'fewshot', verdict: 'T±', jev: 'Exemplos DENTRO da rubrica de cada opção/nível, só do split de treino (J10).', operator: 'add_examples' },
  { id: 'format', verdict: 'NA', jev: 'A saída já é tipada (0% de erro de tipo); o que sobra é escolher a primitiva (J11).' },
  { id: 'constraints', verdict: 'T±', jev: 'Critério explícito + opção de saída/escalonamento (J5) + bandas em código + pergunta de guarda (J12).' },
  { id: 'decompose', verdict: 'T±', jev: 'Perguntas separadas (paralelas, independentes) e composição em código (J6).' },
  { id: 'selfcritique', verdict: 'NA', jev: 'Não há texto para revisar; o análogo é uma pergunta de verificação ou um 2º request (arquitetura).' },
  { id: 'specificity', verdict: 'T', jev: 'Condição literal e exata (falha 1: leitura literal) — J1.', operator: 'literalize' },
  { id: 'concise', verdict: 'T±', jev: 'O alvo é o ESTADO (context rot; custo só de entrada) — J8.', operator: 'project_state' },
  { id: 'emphasis', verdict: 'NA', jev: 'Cada nível é julgado isolado; repetir só gasta tokens.' },
  { id: 'positive', verdict: 'T±', jev: 'Alinhamento de polaridade ("alto = sim") entre instrução e rubrica — J2.', operator: 'polarity_align' },
  { id: 'delimiters', verdict: 'T±', jev: 'JSON com chaves semânticas e caminhos entre crases; conteúdo externo em campo `untrusted_*` — J8/J12.' },
  { id: 'stepback', verdict: 'NA', jev: 'Vira topologia (classificação hierárquica), não reescrita — J17.' },
  { id: 'xml-tags', verdict: 'T±', jev: 'Igual a delimiters: o separador nativo é JSON.' },
  { id: 'rubric', verdict: 'T', jev: '`criteria` É a rubrica — a principal superfície de otimização (J4).', operator: 'describe_option' },
  { id: 'uncertainty', verdict: 'T±', jev: 'Opção de saída + bandas por confiança + temperatura pós-hoc (J5, J13).', operator: 'fit_policy' },
  { id: 'length-control', verdict: 'NA', jev: 'Saída grátis e de tamanho fixo; o que sobra é orçamento de ENTRADA.' },
  { id: 'contrastive', verdict: 'T±', jev: '`not_for` por opção + exemplos dos pares mais confundidos (J4).', operator: 'add_not_for' },
  { id: 'prefill', verdict: 'NA', jev: 'Não há resposta para iniciar.' },
];

/** Um passo do plano de candidatos: operador × pergunta-alvo. */
export interface OperatorPick {
  operatorId: JevOperatorId;
  questionId: string;
}

/**
 * Até `k` candidatos para a iteração: determinísticos primeiro (grátis),
 * depois proponentes, priorizando o que o lint/dossiê apontam; nunca repete
 * (operador, pergunta) já usado na sessão sem promoção.
 */
export function pickOperators(input: {
  operators: readonly JevOperatorId[];
  targets: readonly string[];
  k: number;
  used: ReadonlySet<string>;
  lint?: readonly JevLintIssue[];
  /** pergunta → tem par confundido em ≥ 3 casos? */
  confusedPairs?: Readonly<Record<string, boolean>>;
  /** pergunta → tem opção sem rubrica? */
  emptyRubrics?: Readonly<Record<string, boolean>>;
  /** pergunta → tipo (add_not_for/describe_option só valem para choice). */
  types: Readonly<Record<string, string>>;
}): OperatorPick[] {
  const prio = (op: JevOperatorId, qid: string): number => {
    const info = JEV_OPERATORS[op];
    let p = info.kind === 'deterministic' ? 0 : 10;
    if (op === 'literalize' && input.lint?.some((i) => i.questionId === qid && (i.code === 'question.negated' || i.code === 'question.atomicity'))) p -= 5;
    if (op === 'add_not_for' && input.confusedPairs?.[qid]) p -= 5;
    if (op === 'describe_option' && input.emptyRubrics?.[qid]) p -= 6;
    return p;
  };
  const cands: (OperatorPick & { p: number })[] = [];
  for (const qid of input.targets) {
    for (const op of input.operators) {
      if (!JEV_OPERATORS[op]?.available || JEV_OPERATORS[op].kind === 'policy') continue;
      const t = input.types[qid];
      if ((op === 'add_not_for' || op === 'describe_option') && t !== 'choice') continue;
      if (op === 'add_not_for' && !input.confusedPairs?.[qid]) continue;
      if (op === 'describe_option' && !input.emptyRubrics?.[qid] && t === 'choice') {
        // sem opção vazia: ainda vale reforçar rubricas curtas, mas com prioridade baixa
      }
      cands.push({ operatorId: op, questionId: qid, p: prio(op, qid) });
    }
  }
  const livres = cands.filter((c) => !input.used.has(`${c.operatorId}\u0000${c.questionId}`));
  const pool = (livres.length ? livres : cands).sort((a, b) => a.p - b.p || input.targets.indexOf(a.questionId) - input.targets.indexOf(b.questionId));
  // Espalha pelas perguntas-alvo (coordinate ascent): round-robin por pergunta.
  const out: OperatorPick[] = [];
  const porQ = new Map<string, (OperatorPick & { p: number })[]>();
  for (const c of pool) {
    let l = porQ.get(c.questionId);
    if (!l) porQ.set(c.questionId, (l = []));
    l.push(c);
  }
  let progresso = true;
  while (out.length < input.k && progresso) {
    progresso = false;
    for (const qid of input.targets) {
      const l = porQ.get(qid);
      const x = l?.shift();
      if (!x) continue;
      out.push({ operatorId: x.operatorId, questionId: x.questionId });
      progresso = true;
      if (out.length >= input.k) break;
    }
  }
  return out;
}
