// Modo JEV — o fio (corpo, projeção, erros, validação de resposta) e o lint
// offline (§7). Puro: sem rede.

import { describe, expect, it } from 'vitest';
import {
  buildDecisionsRequest,
  isSpecRejection,
  lintJevCases,
  lintJevSpec,
  isRunnable,
  parseDecisionsError,
  projectState,
  toWireQuestion,
  validateDecisionsResponse,
  withSpecId,
  type JevCase,
  type JevQuestionSpec,
  type JevSpec,
} from '../src/engine/jev/index.js';
import { parseModelsPayload } from '../src/openrouter.js';
import { DECISION_CATALOG, edge400, upstream400 } from './fakeDecisions.js';

const spec = (questions: unknown[], extra: Partial<JevSpec> = {}): JevSpec =>
  withSpecId({ label: 't', questions: questions as JevQuestionSpec[], ...extra });

const codes = (issues: { code: string }[]): string[] => issues.map((i) => i.code);

describe('fio', () => {
  it('noul leva AS DUAS chaves de criteria (regressão do bug do simulador) e a meia rubrica não vai', () => {
    const q = { id: 'b', type: 'noul', instructions: 'É bug?', criteria: { true: 'sim, quebrado', false: 'não' } } as JevQuestionSpec;
    expect(toWireQuestion(q)).toEqual({ type: 'noul', instructions: 'É bug?', criteria: { true: 'sim, quebrado', false: 'não' } });
    const meia = { id: 'b', type: 'noul', instructions: 'É bug?', criteria: { true: 'sim' } } as unknown as JevQuestionSpec;
    expect(toWireQuestion(meia)).toEqual({ type: 'noul', instructions: 'É bug?' });
  });

  it('choice mantém rubrica null; score mantém a ordem dos níveis; stateView projeta e trunca', () => {
    const s = spec(
      [
        { id: 'team', type: 'choice', instructions: 'Time?', criteria: { a: 'x', other: null } },
        { id: 'u', type: 'score', instructions: 'Urgência?', criteria: ['baixa', 'média', 'alta'] },
      ],
      { stateView: { fields: [{ from: 'ticket.body', as: 'ticket_body', maxChars: 5 }, { from: 'ticket.tags[1]', as: 'tag' }, { from: 'nao.existe', as: 'z' }] } },
    );
    const req = buildDecisionsRequest(s, { ticket: { body: 'abcdefghij', tags: ['p', 'q'] }, ruido: 'x' }, { model: 'm', sessionId: 'r' });
    expect(req.questions.team).toEqual({ type: 'choice', instructions: 'Time?', criteria: { a: 'x', other: null } });
    expect(req.questions.u).toEqual({ type: 'score', instructions: 'Urgência?', criteria: ['baixa', 'média', 'alta'] });
    expect(req.state).toEqual({ ticket_body: 'abcde…', tag: 'q' });
    expect(projectState('texto', undefined)).toBe('texto');
  });

  it('parseDecisionsError lê o 400 do EDGE (todos os problemas, com path) e o do UPSTREAM (detail)', () => {
    const edge = parseDecisionsError(
      400,
      edge400([
        { path: ['questions', 'bad', 'type'], message: 'Invalid discriminator', code: 'invalid_union' },
        { path: ['questions', 'x', 'criteria'], message: 'expected record', code: 'invalid_type' },
      ]),
    );
    expect(edge).toEqual([
      { layer: 'edge', path: 'questions.bad.type', code: 'invalid_union', message: 'Invalid discriminator' },
      { layer: 'edge', path: 'questions.x.criteria', code: 'invalid_type', message: 'expected record' },
    ]);
    expect(isSpecRejection(edge)).toBe(true);
    const up = parseDecisionsError(400, upstream400('Too many choices. Must have at most 255 choices.'));
    expect(up).toEqual([{ layer: 'upstream', path: '', code: 'http_400', message: 'Too many choices. Must have at most 255 choices.' }]);
    expect(isSpecRejection(up)).toBe(false);
    // 400 por `provider` (roteamento sensível) NÃO é spec recusada
    expect(isSpecRejection(parseDecisionsError(400, edge400([{ path: ['provider', 'zdr'], message: 'x' }])))).toBe(false);
  });

  it('validateDecisionsResponse: answer.missing, choice.not_in_criteria e soma de probabilidades', () => {
    const questions = {
      a: { type: 'noul' as const, instructions: 'x' },
      b: { type: 'choice' as const, instructions: 'x', criteria: { p: 'x', q: 'y' } },
      c: { type: 'score' as const, instructions: 'x', criteria: ['a', 'b'] },
    };
    const v = validateDecisionsResponse(questions, {
      b: { type: 'choice', choice: 'z', probabilities: { p: 0.5, q: 0.5 } },
      c: { type: 'score', score: 1, probabilities: { '0': 0.3, '1': 0.3 }, confidence: 0.4 },
      extra: { type: 'noul', noul: 1 },
    });
    expect(v.invalid).toEqual({ a: 'answer.missing', b: 'choice.not_in_criteria' });
    expect(v.answers.c).toMatchObject({ type: 'score', score: 1 });
    expect(v.notes.map((n) => n.code)).toContain('answer.extra');
    const ok = validateDecisionsResponse({ b: questions.b }, { b: { type: 'choice', choice: 'p', probabilities: { p: 0.4, q: 0.4 } } });
    expect(ok.invalid).toEqual({});
    expect(ok.warnings.map((w) => w.code)).toContain('probabilities.sum');
  });
});

describe('lint da definição (§7)', () => {
  it('estrutura: vazia, id inválido/duplicado, tipo, instrução, noul sem par, choice sem criteria', () => {
    expect(codes(lintJevSpec(spec([])))).toEqual(['questions.empty']);
    const issues = lintJevSpec(
      spec([
        { id: 'bad id!', type: 'noul', instructions: 'x?' },
        { id: 'dup', type: 'noul', instructions: 'a?' },
        { id: 'dup', type: 'noul', instructions: 'b?' },
        { id: 't', type: 'text', instructions: 'x?' },
        { id: 'i', type: 'noul', instructions: '' },
        { id: 'n', type: 'noul', instructions: 'É bug?', criteria: { true: 'sim' } },
        { id: 'n2', type: 'noul', instructions: 'É bug?', criteria: { true: 'sim', false: null } },
        { id: 'c', type: 'choice', instructions: 'Qual?' },
      ]),
    );
    const erros = issues.filter((i) => i.level === 'error').map((i) => `${i.code}:${i.questionId ?? ''}`);
    expect(erros).toEqual(
      expect.arrayContaining(['question.id:bad id!', 'question.id:dup', 'question.type:t', 'question.instructions:i', 'noul.criteria_pair:n', 'noul.criteria_pair:n2', 'choice.criteria:c']),
    );
    expect(isRunnable(issues)).toBe(false);
  });

  it('limites do fio: > 255 opções e > 10 níveis são ERRO; 1 opção e 1 nível são AVISO (a API aceita)', () => {
    const muitas = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `opção ${i}`]));
    const i1 = lintJevSpec(spec([{ id: 'c', type: 'choice', instructions: 'Qual?', criteria: muitas }]));
    expect(i1.find((i) => i.code === 'choice.too_many')?.level).toBe('error');
    const i2 = lintJevSpec(spec([{ id: 's', type: 'score', instructions: 'Nível?', criteria: Array.from({ length: 11 }, (_, i) => `situação ${i}`) }]));
    expect(i2.find((i) => i.code === 'score.levels_max')?.level).toBe('error');
    const i3 = lintJevSpec(spec([{ id: 'c', type: 'choice', instructions: 'Qual?', criteria: { a: 'x' } }, { id: 's', type: 'score', instructions: 'Nível?', criteria: ['só um'] }]));
    expect(i3.find((i) => i.code === 'choice.single_option')?.level).toBe('warning');
    expect(i3.find((i) => i.code === 'score.levels_min')?.level).toBe('warning');
    // no treino, pergunta-alvo degenerada vira ERRO (sai das métricas probabilísticas)
    const i4 = lintJevSpec(spec([{ id: 'c', type: 'choice', instructions: 'Qual?', criteria: { a: 'x' } }]), { mode: 'train', targetQuestions: ['c'] });
    expect(i4.find((i) => i.code === 'choice.single_option')?.level).toBe('error');
  });

  it('conceito: gerativa, jaggedness, atomicidade, negação, polaridade, saída, chave polarizada, níveis numéricos', () => {
    const issues = lintJevSpec(
      spec([
        { id: 'g', type: 'noul', instructions: 'Escreva um resumo do ticket?' },
        { id: 'j', type: 'noul', instructions: 'Quantos dias entre as datas?' },
        { id: 'a', type: 'noul', instructions: 'É urgente? É bug?' },
        { id: 'neg', type: 'noul', instructions: 'O ticket não é spam?' },
        { id: 'pol', type: 'noul', instructions: 'O cliente pede reembolso?', criteria: { true: 'Não pede reembolso', false: 'Pede' } },
        { id: 'c', type: 'choice', instructions: 'Qual time?', criteria: { yes: 'aprova', no: 'nega' } },
        { id: 's', type: 'score', instructions: 'Nível?', criteria: ['0', '1', 'pior que o anterior'] },
      ]),
    );
    const por = (code: string): string[] => issues.filter((i) => i.code === code).map((i) => i.questionId ?? '');
    expect(por('question.generative')).toEqual(['g']);
    expect(por('question.jaggedness')).toEqual(['j']);
    expect(por('question.atomicity')).toEqual(['a']);
    expect(por('question.negated')).toContain('neg');
    expect(por('noul.polarity_mismatch')).toEqual(['pol']);
    expect(por('choice.no_exit')).toEqual(['c']);
    expect(por('choice.key_polarized').sort()).toEqual(['c', 'c']);
    expect(por('score.level_numeric')).toEqual(['s', 's']);
    expect(por('score.level_comparative')).toEqual(['s']);
  });

  it('borda de palavra: "content" não dispara "conte"; saída reconhecida em pt e en', () => {
    const issues = lintJevSpec(
      spec([
        { id: 'x', type: 'noul', instructions: 'Does the content mention a refund?' },
        { id: 'c', type: 'choice', instructions: 'Qual?', criteria: { a: 'x', outro: 'nenhum' } },
        { id: 'c2', type: 'choice', instructions: 'Which?', criteria: { a: 'x', none_of_the_above: 'n/a' } },
      ]),
    );
    expect(codes(issues)).not.toContain('question.jaggedness');
    expect(issues.filter((i) => i.code === 'choice.no_exit')).toEqual([]);
  });

  it('keyMap inválido e path.missing contra o stateView/casos', () => {
    const issues = lintJevSpec(
      spec(
        [
          { id: 'c', type: 'choice', instructions: 'Qual time para `ticket_body`?', criteria: { a: 'x', b: 'y', other: null }, keyMap: { a: 'A', b: 'A', z: 'Z' } },
          { id: 'p', type: 'noul', instructions: 'O `cliente.plano` é pago?' },
        ],
        { stateView: { fields: [{ from: 'ticket.body', as: 'ticket_body' }] } },
      ),
    );
    expect(issues.filter((i) => i.code === 'keymap.invalid').length).toBeGreaterThanOrEqual(2);
    expect(issues.filter((i) => i.code === 'path.missing').map((i) => i.questionId)).toEqual(['p']);
  });

  it('orçamento de contexto POR MODELO: jev 32.000, kev 8.192, span desconhecido', () => {
    const modelos = parseModelsPayload({ data: DECISION_CATALOG });
    const kev = modelos.find((m) => m.id === 'jaredpalmer/kev-4b')!;
    const jev = modelos.find((m) => m.id === 'typesafe/jev-1.13')!;
    const span = modelos.find((m) => m.id === 'respan/span-01')!;
    const s = spec([{ id: 'b', type: 'noul', instructions: 'É bug?' }]);
    const grande: JevCase[] = [{ id: 'g', state: 'palavra '.repeat(6000), expected: { b: true } }];
    expect(lintJevSpec(s, { model: kev, cases: grande }).find((i) => i.code === 'budget.context')?.level).toBe('error');
    expect(lintJevSpec(s, { model: jev, cases: grande }).filter((i) => i.code.startsWith('budget.'))).toEqual([]);
    expect(lintJevSpec(s, { model: span, cases: grande }).filter((i) => i.code.startsWith('budget.'))).toEqual([]);
  });

  it('alias móvel em treino avisa (J14); idioma não-inglês é info', () => {
    const s = spec([{ id: 'b', type: 'noul', instructions: 'A mensagem é uma reclamação de cobrança indevida feita pelo cliente?' }]);
    const i = lintJevSpec(s, { modelId: '~typesafe/jev-latest', mode: 'train' });
    expect(i.find((x) => x.code === 'model.alias')?.level).toBe('warning');
    expect(lintJevSpec(spec([{ id: 'b', type: 'noul', instructions: 'Ação é pública ou não? Situação crítica? Opção ótima já está em execução.' }])).find((x) => x.code === 'language.non_english')?.level).toBe('info');
  });
});

describe('lint dos casos', () => {
  const s = spec([
    { id: 'team', type: 'choice', instructions: 'Qual time?', criteria: { pag: 'x', front: 'y', other: null } },
    { id: 'bug', type: 'noul', instructions: 'É bug?' },
  ]);
  it('estado vazio, ouro inválido, pergunta desconhecida, estado fundo, id duplicado', () => {
    let fundo: unknown = 'x';
    for (let i = 0; i < 40; i++) fundo = { n: fundo };
    const issues = lintJevCases(
      [
        { id: 'a', state: '   ', expected: { team: 'pag' } },
        { id: 'b', state: 'ok', expected: { team: 'nope' } },
        { id: 'c', state: 'ok', expected: { outra: true } },
        { id: 'd', state: fundo as Record<string, unknown>, expected: { bug: 'sim' as unknown as boolean } },
        { id: 'd', state: 'dup', expected: {} },
      ],
      s,
    );
    const c = codes(issues);
    expect(c).toEqual(expect.arrayContaining(['state.empty', 'labels.uncovered', 'expected.unknown_question', 'state.too_deep', 'expected.invalid', 'case.duplicate_id']));
  });
  it('poucos casos: aviso em eval, ERRO no treino para a pergunta-alvo', () => {
    const cases: JevCase[] = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, state: `t${i}`, expected: { team: 'pag', bug: true } }));
    expect(lintJevCases(cases, s).find((i) => i.code === 'cases.too_few')?.level).toBe('warning');
    expect(lintJevCases(cases, s, { mode: 'train', targetQuestions: ['team'] }).find((i) => i.code === 'cases.too_few' && i.questionId === 'team')?.level).toBe('error');
    expect(codes(lintJevCases(cases, s))).toContain('labels.unseen');
  });
});
