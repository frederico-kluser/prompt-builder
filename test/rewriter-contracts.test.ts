// Testes de CONTRATO do gate pós-rewriter (`src/engine/contracts.ts`):
// travam as invariantes never-break, os placeholders verbatim, o piso de
// tamanho e o stripFences ANTES de qualquer refactor. Se um teste daqui mudar,
// a mudança é deliberada — o gate existe justamente para rejeitar reescritas
// destrutivas sem chamar nenhum LLM.

import { describe, expect, it } from 'vitest';
import { extractPlaceholders, stripFences, verifyRewrite } from '../src/engine/contracts.js';
import type { PromptContracts } from '../src/engine/contracts.js';

const INVARIANTE = 'Responda sempre em português do Brasil';

const BASE = [
  'Você é um assistente de suporte técnico de um SaaS de faturamento.',
  `${INVARIANTE}.`,
  'Nunca invente números: se faltar dado, peça a informação.',
  'Cite sempre a fonte das informações quando houver referência disponível.',
].join(' ');

const REESCRITA_OK = [
  'Você é um assistente de suporte técnico de um SaaS de faturamento.',
  'Responda sempre em português do Brasil.',
  'Nunca invente números: peça a informação quando o dado faltar.',
  'Cite a fonte das informações sempre que houver referência disponível.',
].join('\n');

const CONTRATOS: PromptContracts = { neverBreak: [INVARIANTE] };

/** Cola texto de preenchimento para o gate de tamanho não ser o fator dominante. */
const preenche = (s: string): string => `${s} ${'Conteúdo de exemplo para o teste. '.repeat(5)}`;

describe('verifyRewrite — gate pós-rewriter', () => {
  it('reescrita saudável passa sem violações', () => {
    const r = verifyRewrite(BASE, REESCRITA_OK, CONTRATOS);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('reescrita vazia/whitespace vira "empty" (e nada mais é avaliado)', () => {
    const r = verifyRewrite(BASE, '   \n\t ', CONTRATOS);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual(['empty']);
  });

  it('reescrita colapsada (muito menor que o base) vira "length"', () => {
    const baseGrande = 'Regra importante do prompt. '.repeat(25); // ~675 chars
    const r = verifyRewrite(baseGrande, 'Resposta curta demais.');
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual(['length']);
  });

  it('sem base, o piso é só 40 caracteres', () => {
    expect(verifyRewrite('', 'x'.repeat(39)).violations.map((v) => v.kind)).toEqual(['length']);
    expect(verifyRewrite('', 'x'.repeat(40)).ok).toBe(true);
    // base curta demais para o ratio gerar piso maior que 40: o piso continua 40
    expect(verifyRewrite('base curta', 'y'.repeat(39)).violations.map((v) => v.kind)).toEqual([
      'length',
    ]);
    expect(verifyRewrite('base curta', 'y'.repeat(40)).ok).toBe(true);
  });

  it('placeholder precisa sobreviver VERBATIM ({OS} não conta)', () => {
    const contratos: PromptContracts = { placeholders: ['{os}'] };
    expect(verifyRewrite(BASE, preenche('Rode em {os} agora.'), contratos).ok).toBe(true);

    const r = verifyRewrite(BASE, preenche('Rode em {OS} agora.'), contratos);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual(['placeholder']);
    expect(r.violations[0]?.detail).toContain('{os}');
  });

  it('minLengthRatio customizado muda o piso', () => {
    const base = 'x'.repeat(200);
    // default 0.3 → piso 60
    expect(verifyRewrite(base, 'y'.repeat(100)).ok).toBe(true);
    // 0.8 → piso 160
    const r = verifyRewrite(base, 'y'.repeat(100), { minLengthRatio: 0.8 });
    expect(r.violations.map((v) => v.kind)).toEqual(['length']);
    expect(verifyRewrite(base, 'y'.repeat(160), { minLengthRatio: 0.8 }).ok).toBe(true);
  });

  it('neverBreak tolera quebra de linha e caixa diferente, mas NÃO remoção', () => {
    const comQuebra = preenche('Responda sempre em\nportuguês do Brasil.');
    expect(verifyRewrite(BASE, comQuebra, CONTRATOS).ok).toBe(true);

    const comCaixa = preenche('responda SEMPRE em PORTUGUÊS do brasil.');
    expect(verifyRewrite(BASE, comCaixa, CONTRATOS).ok).toBe(true);

    const r = verifyRewrite(BASE, preenche('Responda em inglês.'), CONTRATOS);
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual(['neverBreak']);
    expect(r.violations[0]?.detail).toContain(INVARIANTE);
  });

  it('violações acumulam: curta + placeholder ausente + invariante ausente', () => {
    const baseRigida = `Responda em {lang} e rode em {os}. ${INVARIANTE}. ${'Contexto de exemplo. '.repeat(
      8,
    )}`;
    const r = verifyRewrite(baseRigida, 'Resposta curta.', {
      neverBreak: [INVARIANTE],
      placeholders: ['{os}', '{lang}'],
    });
    expect(r.ok).toBe(false);
    expect(r.violations.map((v) => v.kind)).toEqual([
      'length',
      'placeholder',
      'placeholder',
      'neverBreak',
    ]);
  });

  it('nunca lança exceção (entradas estranhas degradam, não quebram)', () => {
    expect(() => verifyRewrite('', '')).not.toThrow();
    expect(
      () =>
        verifyRewrite('texto base qualquer aqui', preenche('ok'), {
          minLengthRatio: Number.NaN,
          neverBreak: [''],
          placeholders: [''],
        }),
    ).not.toThrow();
    expect(() => extractPlaceholders('')).not.toThrow();
  });
});

describe('extractPlaceholders — contrato implícito', () => {
  // IMPL-011: tag XML só conta com PAR FECHADO (ou auto-fechada). Antes, um
  // `<image>` solto era placeholder — o mesmo erro que tornava `<instrucoes>`
  // sem fechamento (e `"<id>"` dentro de um exemplo de JSON) obrigatório.
  it('detecta {…}, {{…}}, <tag>…</tag>, $VAR e %s', () => {
    const text =
      'Use {os} e {lang}; total {{count}}; anexe <image>{img}</image>; exporte $API_KEY e preencha %s.';
    expect(extractPlaceholders(text)).toEqual([
      '{os}',
      '{lang}',
      '{{count}}',
      '<image>',
      '{img}',
      '</image>',
      '$API_KEY',
      '%s',
    ]);
    // O mesmo `<image>` SEM fechamento não é placeholder.
    expect(extractPlaceholders('anexe <image> e rode em {os}')).toEqual(['{os}']);
  });

  it('{{count}} é um token só (não vira {count}) e repetições são deduplicadas', () => {
    expect(extractPlaceholders('total: {{count}} de {total}')).toEqual(['{{count}}', '{total}']);
    expect(extractPlaceholders('{a} e {a} de novo')).toEqual(['{a}']);
  });

  it('texto comum não gera placeholder', () => {
    expect(
      extractPlaceholders('100% de aprovação; a < b; chave sem fechar { aqui; "aspas curvas"'),
    ).toEqual([]);
  });

  it('sem contracts.placeholders, verifyRewrite usa os implícitos do base', () => {
    const base = `Responda em {lang} e rode em {os}. ${'Contexto de exemplo. '.repeat(8)}`;
    const semOs = `Responda em {lang}. ${'Contexto de exemplo. '.repeat(8)}`;

    const r = verifyRewrite(base, semOs);
    expect(r.violations.map((v) => v.kind)).toEqual(['placeholder']);
    expect(r.violations[0]?.detail).toContain('{os}');

    // lista explícita tem prioridade — vazia desliga a detecção implícita
    expect(verifyRewrite(base, semOs, { placeholders: [] }).ok).toBe(true);
  });
});

describe('stripFences — só o par externo', () => {
  it('remove o par externo e preserva fences internos', () => {
    const envolto =
      '```markdown\n# Título\n\ntexto com fence interno:\n```js\ncode()\n```\nfim\n```';
    expect(stripFences(envolto)).toBe(
      '# Título\n\ntexto com fence interno:\n```js\ncode()\n```\nfim',
    );
  });

  it('texto sem fence sai intacto (só trim) e fence interno sem externo não é tocado', () => {
    expect(stripFences('  sem fence nenhum  ')).toBe('sem fence nenhum');
    expect(stripFences('texto\n```\ncode\n```\nfim')).toBe('texto\n```\ncode\n```\nfim');
    expect(stripFences('  ```\ncode\n```  ')).toBe('code');
  });
});
