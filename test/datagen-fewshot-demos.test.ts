// IMPL-061 (R-02a:REC-3) — a técnica fewshot usa demos do conjunto ROTULADO
// (padrão BootstrapFewShot/MIPROv2 a partir de traces reais) e NUNCA fabrica
// exemplos.
//
// O gap: o metaInstruction mandava o reescritor INVENTAR "de 2 a 5 exemplos
// curtos e de alta qualidade" — nenhum código selecionava demonstrações de
// cenários com rótulo/gabarito. Exemplos fabricados não têm precedente medido,
// inflam o prompt de produção e podem imitar cenários do benchmark (canal de
// contaminação dados→prompt).
//
// Contrato aqui: com ≥ 3 cenários rotulados, a instrução embuta EXATAMENTE as
// demos selecionadas do conjunto (pergunta/resposta/rótulo) e proíbe inventar;
// com < 3 (ou nenhum), a técnica DECAI para formato sem demos — sem exemplos
// fabricados. O `metaInstruction` estático da biblioteca (o que o pipeline usa
// hoje, sem traces) já é o fallback sem fabricação.

import { describe, expect, it } from 'vitest';
import {
  FEWSHOT_MAX_CHARS,
  FEWSHOT_MAX_DEMOS,
  FEWSHOT_MIN_DEMOS,
  FEWSHOT_NO_DEMOS_INSTRUCTION,
  TECHNIQUE_LIBRARY,
  fewshotInstructionFor,
  fewshotMetaInstruction,
  getTechnique,
  selectFewShotDemos,
  type LabeledScenario,
} from '../src/techniques.js';

const ROTULADOS: LabeledScenario[] = [
  { question: 'Qual o prazo de troca?', response: '30 dias com nota fiscal.', label: 'prazo' },
  { question: 'Como faço o login?', response: 'Pelo app, aba Conta.', label: 'acesso' },
  { question: 'Qual o valor do frete?', response: 'R$ 25 para o Norte.', label: 'preco' },
  { question: 'Posso parcelar?', response: 'Até 12x sem juros.', label: 'preco' },
  { question: 'E a garantia?', response: '12 meses para defeito de fabricação.', label: 'prazo' },
  { question: 'Como troco a cor?', response: 'Em até 30 dias, sem custo.', label: 'prazo' },
];

function demosNaInstrucao(instrucao: string): { question: string; response: string }[] {
  const bloco = instrucao.match(/<demonstracoes_reais>([\s\S]*?)<\/demonstracoes_reais>/)?.[1] ?? '';
  return [...bloco.matchAll(/\[\d+\] Pergunta: (.*)\n\s+Resposta: (.*)(?:\n\s+Rotulo: .*)?/g)].map((m) => ({
    question: m[1],
    response: m[2],
  }));
}

describe('IMPL-061 — demos vêm do conjunto rotulado; nada de exemplo inventado', () => {
  it('com ≥ 3 cenários com rótulo, TODOS os exemplos da instrução são demos verbatim do conjunto', () => {
    const demos = selectFewShotDemos(ROTULADOS);
    expect(demos.length).toBeGreaterThanOrEqual(FEWSHOT_MIN_DEMOS);
    const instrucao = fewshotMetaInstruction(demos);
    const exemplos = demosNaInstrucao(instrucao);
    expect(exemplos.length).toBe(demos.length);

    // NENHUM exemplo inventado: cada par (pergunta, resposta) da instrução
    // existe literalmente no conjunto rotulado.
    for (const ex of exemplos) {
      const origem = ROTULADOS.find((r) => r.question === ex.question);
      expect(origem, `exemplo "${ex.question}" não veio do conjunto rotulado`).toBeDefined();
      expect(ex.response).toBe(origem!.response ?? origem!.label);
    }
    // E a instrução proíbe fabricação explícita.
    expect(instrucao).toContain('NAO invente');
    expect(instrucao).toContain('use EXATAMENTE estes exemplos');
  });

  it('fewshotInstructionFor = seleção + instrução num passo (o atalho do payload)', () => {
    const instrucao = fewshotInstructionFor(ROTULADOS);
    expect(demosNaInstrucao(instrucao).length).toBeGreaterThanOrEqual(FEWSHOT_MIN_DEMOS);
    for (const ex of demosNaInstrucao(instrucao)) {
      expect(ROTULADOS.some((r) => r.question === ex.question)).toBe(true);
    }
  });

  it('as demos carregam o trace completo (pergunta/resposta/rótulo)', () => {
    const demos = selectFewShotDemos(ROTULADOS);
    for (const d of demos) {
      expect(d.question.length).toBeGreaterThan(0);
      expect(d.response.length).toBeGreaterThan(0);
      expect(d.label).toBeTruthy();
    }
  });
});

describe('IMPL-061 — sem cenários rotulados suficientes, a técnica decai (nada fabricado)', () => {
  it('0 cenários rotulados: instrução SEM exemplos', () => {
    const instrucao = fewshotInstructionFor([]);
    expect(instrucao).toBe(FEWSHOT_NO_DEMOS_INSTRUCTION);
    expect(instrucao).not.toContain('<demonstracoes_reais>');
    // O fallback não pede exemplos — ele os PROÍBE.
    expect(instrucao).toContain('NAO fabrique exemplos few-shot');
    expect(instrucao).not.toMatch(/inclu[ia] de 2 a 5 exemplos/);
  });

  it('< 3 cenários com rótulo: cai para formato sem demos em vez de inventar (mesmo com 2)', () => {
    const dois = ROTULADOS.slice(0, 2);
    expect(selectFewShotDemos(dois)).toEqual([]);
    expect(fewshotInstructionFor(dois)).toBe(FEWSHOT_NO_DEMOS_INSTRUCTION);
  });

  it('cenário sem rótulo/gabarito verificado NÃO vira demo', () => {
    const misto: LabeledScenario[] = [
      ...ROTULADOS.slice(0, 3),
      { question: 'Pergunta sem gabarito?', response: '   ' },
      { question: 'Outra sem nada?' },
    ];
    const demos = selectFewShotDemos(misto);
    expect(demos).toHaveLength(3);
    expect(demos.some((d) => d.question.includes('sem gabarito') || d.question.includes('sem nada'))).toBe(false);
  });

  it('regressão: o metaInstruction estático da biblioteca é o fallback sem fabricação', () => {
    const fewshot = getTechnique('fewshot');
    expect(fewshot?.metaInstruction).toBe(FEWSHOT_NO_DEMOS_INSTRUCTION);
    // O texto antigo que mandava inventar não volta.
    expect(fewshot?.metaInstruction).not.toMatch(/de 2 a 5 exemplos curtos/);
    expect(TECHNIQUE_LIBRARY.find((t) => t.id === 'fewshot')?.metaInstruction).toBe(
      FEWSHOT_NO_DEMOS_INSTRUCTION,
    );
  });
});

describe('IMPL-061 — seleção: balance de rótulos e penalidade de comprimento', () => {
  it('round-robin entre rótulos (sem viés de classe majoritária)', () => {
    const demos = selectFewShotDemos(ROTULADOS, { max: 3 });
    expect(demos).toHaveLength(3);
    const rotulos = new Set(demos.map((d) => d.label));
    expect(rotulos.size).toBe(3); // um por rótulo antes de repetir
  });

  it('teto de demos e de caracteres (cruzado com a penalidade de comprimento)', () => {
    expect(FEWSHOT_MAX_DEMOS).toBe(5);
    expect(FEWSHOT_MAX_CHARS).toBeGreaterThan(0);
    const demos = selectFewShotDemos(ROTULADOS);
    expect(demos.length).toBeLessThanOrEqual(FEWSHOT_MAX_DEMOS);
    const chars = demos.reduce((s, d) => s + d.question.length + d.response.length, 0);
    expect(chars).toBeLessThanOrEqual(FEWSHOT_MAX_CHARS);

    // Com orçamento apertado, as demos mais curtas de cada rótulo entram
    // primeiro e o conjunto não estoura o teto.
    const apertado = selectFewShotDemos(ROTULADOS, { maxChars: 60 });
    expect(apertado.length).toBeGreaterThanOrEqual(1);
    expect(apertado.reduce((s, d) => s + d.question.length + d.response.length, 0)).toBeLessThanOrEqual(60);
    for (const d of apertado) {
      const doRotulo = ROTULADOS.filter((r) => r.label === d.label);
      const menorDoRotulo = [...doRotulo].sort((a, b) => a.question.length - b.question.length)[0];
      expect(d.question).toBe(menorDoRotulo.question);
    }
  });
});
