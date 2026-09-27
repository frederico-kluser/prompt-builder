// Testes de CONTRATO do ground-truth determinístico (`src/engine/groundTruth.ts`) —
// o veredito decodificado SEM juiz LLM quando o cenário traz o rótulo esperado
// (padrão do prompt-arena `gabaritoSpec kind:'labels'`). Travam a normalização
// de rótulo, o casamento BCP-47, a extração de campo em JSON e a escada
// resolve/parcial/nao antes de qualquer refactor.
//
// IMPL-003 (R-03b:REC-5): o verificador é ESTRITO por padrão — standalone/
// substring valem no máximo 'parcial'; negação, hesitação e multi-rótulo dão
// 'nao'; JSON ambíguo (dois objetos, chave duplicada) dá 'nao'. O corpus N1 e
// o adversarial abaixo travam 0 falso 'resolve'.

import { describe, expect, it } from 'vitest';
import {
  extractJsonField,
  isShortLabelExpected,
  labelSetIssue,
  languageMatches,
  matchExpected,
  normalizeLabel,
  SHORT_LABEL_MAX_WORDS,
  stageLabelIssues,
  type ExpectedSpec,
} from '../src/engine/groundTruth.js';

describe('normalizeLabel', () => {
  it('minúsculas, sem acentos e sem pontuação/aspas nas bordas', () => {
    expect(normalizeLabel('  «Edição!»  ')).toBe('edicao');
    expect(normalizeLabel('(EDIT)')).toBe('edit');
  });

  it('colapsa espaços (inclusive quebras de linha)', () => {
    expect(normalizeLabel('muito   bom')).toBe('muito bom');
    expect(normalizeLabel('um\ndois')).toBe('um dois');
  });

  it('remove prefixos tipo "resposta:"/"label:"/"classificação:"', () => {
    expect(normalizeLabel('Resposta: edit')).toBe('edit');
    expect(normalizeLabel('label: pt-BR')).toBe('pt-br');
    expect(normalizeLabel('Classificação: SIM')).toBe('sim');
    expect(normalizeLabel('«Resposta:» «edit»')).toBe('edit');
  });

  it('preserva pontuação interna (pt-br não vira pt br)', () => {
    expect(normalizeLabel('pt-BR')).toBe('pt-br');
    expect(normalizeLabel('nao-resolvido')).toBe('nao-resolvido');
  });
});

describe('languageMatches (BCP-47)', () => {
  it('casa no nível do idioma primário', () => {
    expect(languageMatches('pt-BR', 'pt')).toBe(true);
    expect(languageMatches('pt', 'pt-BR')).toBe(true);
    expect(languageMatches('EN', 'en')).toBe(true);
    expect(languageMatches('zh-Hans-CN', 'zh')).toBe(true);
  });

  it('não casa idiomas diferentes', () => {
    expect(languageMatches('en-US', 'pt-BR')).toBe(false);
    expect(languageMatches('en', 'pt-BR')).toBe(false);
    expect(languageMatches('', 'pt')).toBe(false);
    expect(languageMatches('pt', '')).toBe(false);
  });
});

describe('extractJsonField', () => {
  it('extrai campo de JSON puro', () => {
    expect(extractJsonField('{"action": "edit"}', 'action')).toBe('edit');
    expect(extractJsonField('{"count": 3}', 'count')).toBe(3);
    expect(extractJsonField('{"ok": true}', 'ok')).toBe(true);
  });

  it('tolera fences ``` e prosa ao redor', () => {
    expect(extractJsonField('```json\n{"action": "edit"}\n```', 'action')).toBe('edit');
    expect(extractJsonField('Claro! {"action": "edit"} — espero que ajude.', 'action')).toBe('edit');
    expect(extractJsonField('Segue:\n```\n{"count": 3}\n```\npronto.', 'count')).toBe(3);
  });

  it('retorna undefined com JSON inválido, truncado ou sem o campo', () => {
    expect(extractJsonField('isto não é json', 'action')).toBeUndefined();
    expect(extractJsonField('{"action": "edit"', 'action')).toBeUndefined();
    expect(extractJsonField('{"outro": 1}', 'action')).toBeUndefined();
    expect(extractJsonField('', 'action')).toBeUndefined();
  });

  it('busca no objeto externo primeiro e depois nos aninhados', () => {
    expect(extractJsonField('{"action": "help", "extra": {"action": "edit"}}', 'action')).toBe('help');
    expect(extractJsonField('{"extra": {"action": "edit"}}', 'action')).toBe('edit');
  });
});

describe('matchExpected — rótulo simples', () => {
  it('match exato resolve e marca deterministic', () => {
    const r = matchExpected('edit', 'edit');
    expect(r.verdict).toBe('resolve');
    expect(r.deterministic).toBe(true);
    expect(r.explanation).toContain("esperado 'edit'");
  });

  it('case, acentos e pontuação não atrapalham ("Edit!" vs "edit")', () => {
    expect(matchExpected('Edit!', 'edit').verdict).toBe('resolve');
    expect(matchExpected('Edição', 'edicao').verdict).toBe('resolve');
    expect(matchExpected('«AÇAO»', 'acao').verdict).toBe('resolve');
  });

  it('prefixo "Resposta:" não atrapalha', () => {
    expect(matchExpected('Resposta: edit', 'edit').verdict).toBe('resolve');
  });

  it('primeira linha não-vazia casa mesmo com prosa depois', () => {
    const r = matchExpected('Resposta: edit\nPorque o usuário pediu edição.', 'edit');
    expect(r.verdict).toBe('resolve');
    expect(r.explanation).toContain('primeira linha');
  });

  it('primeira linha resolve rótulo longo (>5 palavras) que seria só substring', () => {
    const label = 'um dois tres quatro cinco seis';
    const r = matchExpected('Um dois três quatro cinco seis\nmais contexto aqui', label);
    expect(r.verdict).toBe('resolve');
    expect(r.explanation).toContain('primeira linha');
  });

  // IMPL-003: antes 'resolve' — é exatamente o casamento "aparece em algum
  // ponto" que a medida N1 mostrou dar falso positivo 7/7. No estrito, prosa
  // com o rótulo vale no máximo 'parcial' (o modo lenient guarda o legado).
  it('rótulo standalone no meio da prosa vale no máximo parcial (strict)', () => {
    const r = matchExpected('edit o texto', 'edit');
    expect(r.verdict).toBe('parcial');
    expect(r.rule).toBe('standalone');
    expect(r.explanation).toContain('standalone');
    expect(matchExpected('edit o texto', 'edit', { mode: 'lenient' }).verdict).toBe('resolve');
  });

  it('rótulo só dentro de outra palavra/frase é parcial', () => {
    const r = matchExpected('O editor de texto é útil', 'edit');
    expect(r.verdict).toBe('parcial');
    expect(r.explanation).toContain('dentro de outra palavra/frase');
  });

  it('standalone exige fronteira alfanumérica ("2" não casa em "2024")', () => {
    expect(matchExpected('2024', '2').verdict).toBe('parcial');
    expect(matchExpected('2024', '2').rule).toBe('substring');
    // IMPL-003: standalone na prosa era 'resolve'; no estrito é 'parcial'.
    expect(matchExpected('foram 2 gatos', '2').verdict).toBe('parcial');
    expect(matchExpected('foram 2 gatos', '2').rule).toBe('standalone');
    expect(matchExpected('foram 2 gatos', '2', { mode: 'lenient' }).verdict).toBe('resolve');
  });

  it('rótulo de 6+ palavras não casa standalone (só substring → parcial)', () => {
    const label = 'um dois tres quatro cinco seis';
    expect(matchExpected('temos um dois tres quatro cinco seis aqui', label).verdict).toBe('parcial');
  });
});

describe('matchExpected — alternativas', () => {
  it('qualquer alternativa casando resolve', () => {
    expect(matchExpected('help', ['help', 'edit']).verdict).toBe('resolve');
    expect(matchExpected('edit', ['help', 'edit']).verdict).toBe('resolve');
    expect(matchExpected('Resposta: help', ['help', 'edit']).verdict).toBe('resolve');
  });

  it('substring de uma alternativa dá parcial mesmo sem as outras', () => {
    const r = matchExpected('o editor', ['help', 'edit']);
    expect(r.verdict).toBe('parcial');
    expect(r.explanation).toContain('help|edit');
    expect(r.explanation).toContain("'edit'");
  });

  it('lista sem nenhum casamento dá nao', () => {
    const r = matchExpected('nada disso', ['help', 'edit']);
    expect(r.verdict).toBe('nao');
    expect(r.explanation).toContain('[help|edit]');
    expect(r.explanation).toContain('não contém nenhum');
  });

  it('lista de alternativas vazia dá nao', () => {
    expect(matchExpected('edit', []).verdict).toBe('nao');
  });
});

describe('matchExpected — idioma BCP-47', () => {
  it('pt-BR vs pt resolve (nível de idioma primário)', () => {
    expect(matchExpected('pt-BR', 'pt').verdict).toBe('resolve');
    expect(matchExpected('pt', 'pt-BR').verdict).toBe('resolve');
    expect(matchExpected('PT-br', 'PT').verdict).toBe('resolve');
  });

  it('en vs pt-BR não resolve', () => {
    const r = matchExpected('en', 'pt-BR');
    expect(r.verdict).toBe('nao');
    expect(r.explanation).toContain('não contém o rótulo');
  });
});

describe('matchExpected — objeto campo→valor', () => {
  it('JSON puro com o campo resolve', () => {
    const r = matchExpected('{"action": "edit"}', { action: 'edit' });
    expect(r.verdict).toBe('resolve');
    expect(r.explanation).toContain("campo 'action'");
  });

  it('JSON com fence e prosa resolve', () => {
    expect(
      matchExpected('Segue o resultado:\n```json\n{"action": "edit"}\n```', { action: 'edit' }).verdict,
    ).toBe('resolve');
    expect(matchExpected('Claro: {"action": "edit"} — pronto!', { action: 'edit' }).verdict).toBe('resolve');
  });

  it('JSON inválido com valor esperado standalone dá parcial', () => {
    const r = matchExpected('sem json, a resposta certa é edit', { action: 'edit' });
    expect(r.verdict).toBe('parcial');
    expect(r.explanation).toContain('standalone');
  });

  it('JSON válido sem o campo, mas valor standalone no texto, dá parcial', () => {
    const r = matchExpected('{"count": 3}, mas a ação correta é edit', { action: 'edit' });
    expect(r.verdict).toBe('parcial');
  });

  it('valor divergente dá nao (não importa o que a prosa diga)', () => {
    const r = matchExpected('{"action": "help"}', { action: 'edit' });
    expect(r.verdict).toBe('nao');
    expect(r.explanation).toContain('diverge');
  });

  it('campo ausente sem valor standalone dá nao', () => {
    const r = matchExpected('{"count": 3}', { action: 'edit' });
    expect(r.verdict).toBe('nao');
    expect(r.explanation).toContain("campo 'action'");
  });

  it('números: igualdade numérica resolve, divergência dá nao', () => {
    expect(matchExpected('{"count": 3}', { count: 3 }).verdict).toBe('resolve');
    expect(matchExpected('{"count": 4}', { count: 3 }).verdict).toBe('nao');
    // forma textual equivalente conta como o mesmo valor
    expect(matchExpected('{"count": "3"}', { count: 3 }).verdict).toBe('resolve');
  });

  it('booleanos: igualdade booleana resolve, divergência dá nao', () => {
    expect(matchExpected('{"ok": true}', { ok: true }).verdict).toBe('resolve');
    expect(matchExpected('{"ok": true}', { ok: false }).verdict).toBe('nao');
    expect(matchExpected('{"ok": "true"}', { ok: true }).verdict).toBe('resolve');
  });

  it('múltiplos campos só resolvem se todos conferirem (pior campo decide)', () => {
    expect(matchExpected('{"action": "edit", "count": 3}', { action: 'edit', count: 3 }).verdict).toBe('resolve');
    expect(matchExpected('{"action": "edit", "count": 1}', { action: 'edit', count: 3 }).verdict).toBe('nao');
    expect(
      matchExpected('{"action": "edit"}, mas o valor 3 está solto no texto', { action: 'edit', count: 3 }).verdict,
    ).toBe('parcial');
  });
});

describe('matchExpected — casos degenerados', () => {
  it('resposta vazia/whitespace-only dá nao explicando a vazio', () => {
    for (const vazio of ['', '   ', '\n \t ']) {
      const r = matchExpected(vazio, 'edit');
      expect(r.verdict).toBe('nao');
      expect(r.explanation).toContain('vazia');
    }
  });

  it('resposta vazia também dá nao no modo objeto', () => {
    const r = matchExpected('', { action: 'edit' });
    expect(r.verdict).toBe('nao');
    expect(r.explanation).toContain('vazia');
  });

  it('sempre devolve deterministic: true e explanation em PT-BR não vazia', () => {
    const casos = [
      matchExpected('edit', 'edit'),
      matchExpected('o editor', 'edit'),
      matchExpected('nada', 'edit'),
      matchExpected('{"action": "edit"}', { action: 'edit' }),
      matchExpected('', 'edit'),
    ];
    for (const r of casos) {
      expect(r.deterministic).toBe(true);
      expect(typeof r.explanation).toBe('string');
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// IMPL-003 — verificador ESTRITO (R-03b:REC-5 / DEC-4)
// ---------------------------------------------------------------------------

const SENT = ['positivo', 'negativo', 'neutro'];
const SIMNAO = ['sim', 'nao'];
const INTENT = ['edit', 'create', 'delete', 'help'];
const URG = ['urgente', 'normal'];
const YN = ['yes', 'no'];
const EN = ['positive', 'negative', 'neutral'];

interface Caso {
  texto: string;
  expected: ExpectedSpec;
  labelSet?: string[];
}

/**
 * Medida N1 (R-03b, 2026-09-25, `matchExpected` @ ebad7a2): as 7 respostas
 * adversariais em texto livre que davam 'resolve' + os 2 casos JSON do
 * contexto (dois objetos com rótulos diferentes; chave duplicada).
 */
const N1: Caso[] = [
  { texto: 'Não é sim, é não.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'positivo? negativo? neutro?', expected: 'negativo', labelSet: SENT },
  { texto: 'As opções são edit, create ou delete. Escolho delete.', expected: 'edit', labelSet: INTENT },
  { texto: 'Talvez sim, talvez não.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'Definitivamente não é negativo; é positivo.', expected: 'negativo', labelSet: SENT },
  { texto: 'positivo | negativo | neutro', expected: ['negativo'], labelSet: SENT },
  { texto: 'A resposta NÃO é urgente.', expected: 'urgente', labelSet: URG },
];
const N1_JSON: Caso[] = [
  { texto: '{"label":"negativo"} ou {"label":"positivo"}', expected: { label: 'negativo' } },
  { texto: '{"label":"positivo","label":"negativo"}', expected: { label: 'negativo' } },
];

describe('IMPL-003 — corpus N1 deixa de dar resolve', () => {
  it('os 7 casos adversariais da N1 davam resolve no legado e dão nao no estrito', () => {
    for (const c of N1) {
      // o "antes": a regressão medida pela N1 (modo lenient = escada legada)
      expect(matchExpected(c.texto, c.expected, { mode: 'lenient' }).verdict, c.texto).toBe('resolve');
      const r = matchExpected(c.texto, c.expected, { labelSet: c.labelSet });
      expect(r.verdict, `${c.texto} → ${r.rule}: ${r.explanation}`).toBe('nao');
      expect(r.deterministic).toBe(true);
    }
  });

  it('mesmo SEM labelSet (record antigo) nenhum dos 7 resolve', () => {
    for (const c of N1) {
      const r = matchExpected(c.texto, c.expected);
      expect(r.verdict, `${c.texto} → ${r.rule}`).not.toBe('resolve');
    }
  });

  it('os 2 casos JSON (dois objetos / chave duplicada) davam resolve e dão nao', () => {
    for (const c of N1_JSON) {
      expect(matchExpected(c.texto, c.expected, { mode: 'lenient' }).verdict, c.texto).toBe('resolve');
      const r = matchExpected(c.texto, c.expected);
      expect(r.verdict, c.texto).toBe('nao');
      expect(r.rule).toBe('json-ambiguous');
    }
    // controle: ordem invertida continua 'nao'
    expect(matchExpected('{"label":"positivo"} ou {"label":"negativo"}', { label: 'negativo' }).verdict).toBe('nao');
  });

  it('negação/hesitação/multi-rótulo são nomeados na regra (painel "onde falhou")', () => {
    expect(matchExpected('A resposta NÃO é urgente.', 'urgente', { labelSet: URG }).rule).toBe('negated');
    expect(matchExpected('Talvez urgente.', 'urgente', { labelSet: URG }).rule).toBe('hedged');
    expect(matchExpected('positivo | negativo | neutro', 'negativo', { labelSet: SENT }).rule).toBe('multi-label');
  });
});

/**
 * Corpus adversarial (métrica R-03b §9: "corpus N1 + variações de negação,
 * hedge, multi-rótulo, JSON duplo" — limiar: 0 falso 'resolve'). Toda linha
 * é uma resposta ERRADA ou não-comprometida para o rótulo esperado.
 */
const ADVERSARIAL: Record<string, Caso[]> = {
  negacao: [
    { texto: 'Não é urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Isso não é urgente', expected: 'urgente', labelSet: URG },
    { texto: 'Nada urgente por aqui.', expected: 'urgente', labelSet: URG },
    { texto: 'Não urgente', expected: 'urgente', labelSet: ['urgente', 'nao urgente'] },
    { texto: 'Não urgente', expected: 'urgente', labelSet: URG },
    { texto: 'Longe de ser urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Nunca foi urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente não, apenas importante.', expected: 'urgente', labelSet: URG },
    { texto: 'It is not urgent.', expected: 'urgent', labelSet: ['urgent', 'normal'] },
    { texto: "This isn't urgent at all", expected: 'urgent', labelSet: ['urgent', 'normal'] },
    { texto: 'Em vez de edit, use create.', expected: 'edit', labelSet: INTENT },
    { texto: 'não-negativo', expected: 'negativo', labelSet: SENT },
    { texto: 'O cliente não está negativo, está neutro.', expected: 'negativo', labelSet: SENT },
    { texto: 'Não é sim.', expected: 'sim', labelSet: SIMNAO },
    // Revisão IMPL-003: rótulo abrindo a linha + separador + negação. Antes a
    // regra 'lead' dava resolve — e 'Urgente não, apenas importante.' (sem
    // vírgula) já dava nao: a pontuação não pode mudar o veredito.
    { texto: 'Urgente: não', expected: 'urgente', labelSet: URG },
    { texto: 'urgente, não', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente - não', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente — não', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente, não; apenas importante.', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente: não se aplica', expected: 'urgente', labelSet: URG },
    { texto: 'Negativo, não.', expected: 'negativo', labelSet: SENT },
    { texto: 'Yes, not really.', expected: 'yes', labelSet: YN },
    { texto: 'Sim, não...', expected: 'sim', labelSet: SIMNAO },
  ],
  hedge: [
    { texto: 'Talvez urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Pode ser urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Provavelmente urgente, mas não tenho certeza.', expected: 'urgente', labelSet: URG },
    { texto: 'Acho que é urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente?', expected: 'urgente', labelSet: URG },
    { texto: 'Urgente? Não sei.', expected: 'urgente', labelSet: URG },
    { texto: 'Depende: pode ser urgente.', expected: 'urgente', labelSet: URG },
    { texto: 'Possivelmente negativo.', expected: 'negativo', labelSet: SENT },
    { texto: 'Maybe urgent.', expected: 'urgent', labelSet: ['urgent', 'normal'] },
    { texto: 'Negativo?', expected: 'negativo', labelSet: SENT },
    { texto: 'Sim, mas não tenho certeza.', expected: 'sim', labelSet: SIMNAO },
    { texto: 'negativo\nmas não tenho certeza', expected: 'negativo', labelSet: SENT },
    { texto: 'Parece negativo.', expected: 'negativo', labelSet: SENT },
    // Revisão IMPL-003: hesitação logo depois do rótulo, prefixo de palpite,
    // e hesitação nas linhas seguintes / na prosa em volta do JSON.
    { texto: 'Negativo, talvez.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo: talvez', expected: 'negativo', labelSet: SENT },
    { texto: 'Palpite: negativo', expected: 'negativo', labelSet: SENT },
    { texto: 'Chute: negativo', expected: 'negativo', labelSet: SENT },
    { texto: 'Talvez: negativo', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\n\nmas pode ser neutro', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\nPorém poderia ser positivo.', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\nneutro também é possível', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo"}\nOu talvez positivo.', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo"}\nMas pode ser neutro.', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo"}\nNão tenho certeza.', expected: 'negativo', labelSet: SENT },
    { texto: 'Acho que: {"label":"negativo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo","confianca":"talvez"}', expected: 'negativo', labelSet: SENT },
  ],
  multiRotulo: [
    { texto: 'positivo, negativo, neutro', expected: 'negativo', labelSet: SENT },
    { texto: 'positivo/negativo/neutro', expected: 'positivo', labelSet: SENT },
    { texto: 'negativo ou neutro', expected: 'negativo', labelSet: SENT },
    { texto: 'Pode ser positivo ou negativo.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Positivo. Neutro.', expected: 'negativo', labelSet: SENT },
    { texto: 'positivo\nnegativo\nneutro', expected: 'positivo', labelSet: SENT },
    { texto: 'positivo\nnegativo\nneutro', expected: 'negativo', labelSet: SENT },
    { texto: '- positivo\n- negativo\n- neutro', expected: 'positivo', labelSet: SENT },
    { texto: 'negativo\nou talvez positivo', expected: 'negativo', labelSet: SENT },
    { texto: 'Rótulos possíveis: positivo | negativo | neutro. Escolho negativo.', expected: 'negativo', labelSet: SENT },
    { texto: 'edit, create, delete, help', expected: 'help', labelSet: INTENT },
    { texto: 'sim e não', expected: 'sim', labelSet: SIMNAO },
    { texto: 'Negativo? Positivo? Difícil dizer.', expected: 'negativo', labelSet: SENT },
    // Revisão IMPL-003: alternativa, autocorreção, adição e lista emendada ao
    // rótulo que abre a linha; afirmação de outro rótulo nas linhas seguintes.
    { texto: 'Negativo (ou neutro)', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo; na verdade neutro', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Na verdade, neutro.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo, ou melhor, neutro.', expected: 'negativo', labelSet: SENT },
    { texto: 'Sim, mas também não.', expected: 'sim', labelSet: SIMNAO },
    { texto: 'Negativo, positivo', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Positivo.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. É positivo.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo, positivo e neutro são as opções.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negative, or maybe neutral', expected: 'negative', labelSet: EN },
    { texto: 'Negative; actually neutral', expected: 'negative', labelSet: EN },
    { texto: 'negativo\nTambém positivo.', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\nÉ positivo.', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\nou talvez neutro', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo\nNa verdade, o sentimento é neutro.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo\nO sentimento correto é positivo.', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo"}\nNa verdade é positivo.', expected: 'negativo', labelSet: SENT },
  ],
  jsonDuplo: [
    { texto: '{"label":"negativo"} ou {"label":"positivo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"positivo"} ou {"label":"negativo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"positivo","label":"negativo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo","label":"positivo"}', expected: { label: 'negativo' } },
    { texto: '["positivo","negativo","neutro"]', expected: 'negativo', labelSet: SENT },
    { texto: '{"label":"negativo","categoria":"positivo"}', expected: 'negativo', labelSet: SENT },
    { texto: '```json\n{"label":"positivo"}\n```\n{"label":"negativo"}', expected: 'negativo', labelSet: SENT },
    { texto: '```json\n{"label":"positivo"}\n```\n```json\n{"label":"negativo"}\n```', expected: { label: 'negativo' } },
    { texto: '{"intent":"edit"}\n{"intent":"help"}', expected: { intent: 'edit' } },
    // Revisão IMPL-003: segundo rótulo em OUTRO campo (topo ou aninhado) e
    // prosa que desmente o campo no modo objeto.
    { texto: '{"resposta":"negativo","outro":"positivo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"a": {"label":"positivo"}, "label":"negativo"}', expected: 'negativo', labelSet: SENT },
    { texto: '{"resultado": {"label": "negativo"}, "extra": {"label": "positivo"}}', expected: 'negativo', labelSet: SENT },
    { texto: '{"intent":"edit"}\nNa verdade é help.', expected: { intent: 'edit' }, labelSet: INTENT },
  ],
  // Revisão IMPL-003: dúvida/negação/alternativa SOLTA depois do rótulo, sem
  // outro rótulo afirmado. Não é resposta firme (nunca resolve); como o
  // rótulo em si não foi negado nem trocado, o teto é 'parcial'.
  duvidaSolta: [
    { texto: 'Negativo... ou não.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo… ou não.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Não.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Talvez.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Não sei.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo. Na verdade, não.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negative. Not really.', expected: 'negative', labelSet: EN },
    { texto: 'negativo\nOu não.', expected: 'negativo', labelSet: SENT },
    { texto: 'negativo\nTalvez.', expected: 'negativo', labelSet: SENT },
    { texto: 'Negativo\nNegativo? Não.', expected: 'negativo', labelSet: SENT },
  ],
  nulo: [
    { texto: ':', expected: 'negativo', labelSet: SENT },
    { texto: 'N/A', expected: 'negativo', labelSet: SENT },
    { texto: '{}', expected: 'negativo', labelSet: SENT },
    { texto: '{}', expected: { label: 'negativo' } },
    { texto: 'Não sei.', expected: 'sim', labelSet: SIMNAO },
  ],
};

describe('IMPL-003 — corpus adversarial: 0 falso resolve', () => {
  for (const [familia, casos] of Object.entries(ADVERSARIAL)) {
    it(`família ${familia} (${casos.length} casos) nunca resolve`, () => {
      const falsos = casos
        .map((c) => ({ c, r: matchExpected(c.texto, c.expected, { labelSet: c.labelSet }) }))
        .filter(({ r }) => r.verdict === 'resolve')
        .map(({ c, r }) => `${JSON.stringify(c.texto)} → ${r.rule}`);
      expect(falsos).toEqual([]);
    });
  }

  it('negação e hesitação sobre o rótulo dão nao (não só "não resolve")', () => {
    for (const c of [...ADVERSARIAL.negacao, ...ADVERSARIAL.hedge]) {
      const r = matchExpected(c.texto, c.expected, { labelSet: c.labelSet });
      expect(r.verdict, `${c.texto} → ${r.rule}`).toBe('nao');
    }
  });

  it('lista/multi-rótulo e JSON duplo dão nao', () => {
    for (const c of [...ADVERSARIAL.multiRotulo, ...ADVERSARIAL.jsonDuplo]) {
      const r = matchExpected(c.texto, c.expected, { labelSet: c.labelSet });
      expect(r.verdict, `${c.texto} → ${r.rule}`).toBe('nao');
    }
  });

  it('a pontuação não muda o veredito da negação ("urgente não" ≡ "urgente, não" ≡ "Urgente: não")', () => {
    const variantes = [
      'Urgente não, apenas importante.',
      'Urgente, não; apenas importante.',
      'urgente, não',
      'Urgente: não',
      'Urgente - não',
    ];
    for (const t of variantes) {
      const r = matchExpected(t, 'urgente', { labelSet: URG });
      expect(r.verdict, `${t} → ${r.rule}`).toBe('nao');
      expect(r.rule, t).toBe('negated');
    }
    // e o lado inverso: com esperado 'normal', o rótulo NEGADO não conta como "afirma urgente"
    for (const t of ['Urgente: não', 'Urgente? Não.']) {
      const r = matchExpected(t, 'normal', { labelSet: URG });
      expect(r.verdict, t).toBe('nao');
      expect(r.explanation, t).not.toContain('afirma outro rótulo');
    }
  });

  // Revisão 2 (defeito 5): dúvida/negação solta depois do rótulo é hedge SOBRE
  // o rótulo — a ação e agent-docs/train.md dizem 'nao', não 'parcial'.
  it('dúvida solta depois do rótulo dá nao (hesitação/negação sobre a resposta), com explicação', () => {
    for (const c of ADVERSARIAL.duvidaSolta) {
      const r = matchExpected(c.texto, c.expected, { labelSet: c.labelSet });
      expect(r.verdict, `${c.texto} → ${r.rule}`).toBe('nao');
      expect(['hedged', 'negated'], c.texto).toContain(r.rule);
      expect(r.explanation, c.texto).toContain('não é inequívoca');
    }
  });
});

/**
 * Positivos LEGÍTIMOS: respostas corretas num formato de resposta documentado
 * (rótulo seco, rótulo na primeira linha com ou sem explicação, "chave:
 * rótulo", JSON). Limiar R-03b §9: ≥95% de 'resolve'.
 */
const LEGITIMOS: Caso[] = [
  { texto: 'negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'NEGATIVO.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo!', expected: 'negativo', labelSet: SENT },
  { texto: '**Negativo**', expected: 'negativo', labelSet: SENT },
  { texto: '`negativo`', expected: 'negativo', labelSet: SENT },
  { texto: '- negativo', expected: 'negativo', labelSet: SENT },
  { texto: '"negativo"', expected: 'negativo', labelSet: SENT },
  { texto: 'Resposta: negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Classificação: Negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Categoria: NEGATIVO', expected: 'negativo', labelSet: SENT },
  { texto: 'Rótulo: negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Label: negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Sentimento: negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'negativo\n\nO cliente reclama do atraso na entrega.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\nMotivo: o cliente não ficou satisfeito e não é neutro.', expected: 'negativo', labelSet: SENT },
  { texto: 'negativo\nNão é positivo porque há reclamação explícita.', expected: 'negativo', labelSet: SENT },
  { texto: 'Resposta: Negativo.\nO cliente reclamou do prazo.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo. O cliente reclama do atraso.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo — o cliente pede reembolso.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo - o cliente pede reembolso.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo (reclamação de atraso)', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo: o cliente ameaça cancelar.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo. O início é positivo, mas o fim reclama.', expected: 'negativo', labelSet: SENT },
  { texto: '{"label": "negativo"}', expected: 'negativo', labelSet: SENT },
  { texto: '```json\n{"sentimento": "negativo"}\n```', expected: 'negativo', labelSet: SENT },
  { texto: '{"label": "negativo", "justificativa": "cliente irritado"}', expected: 'negativo', labelSet: SENT },
  { texto: '{"sentimento":"negativo","motivo":"atraso","resposta":"Entendo sua frustração"}', expected: 'negativo', labelSet: SENT },
  { texto: 'Segue a classificação:\n```json\n{"label":"negativo"}\n```', expected: 'negativo', labelSet: SENT },
  { texto: '["negativo"]', expected: 'negativo', labelSet: SENT },
  { texto: 'Sim.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'Sim, o cliente tem direito ao reembolso.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'sim\nO prazo de 7 dias foi respeitado.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'Não.', expected: 'nao', labelSet: SIMNAO },
  { texto: 'Não, o prazo de 7 dias expirou.', expected: 'nao', labelSet: SIMNAO },
  { texto: 'Não\nO pedido foi feito há 10 dias.', expected: 'nao', labelSet: SIMNAO },
  { texto: 'Não. Não há direito a reembolso.', expected: 'nao', labelSet: SIMNAO },
  { texto: 'edit', expected: 'edit', labelSet: INTENT },
  { texto: 'Intent: edit', expected: 'edit', labelSet: INTENT },
  { texto: 'Ação: delete', expected: 'delete', labelSet: INTENT },
  { texto: '{"intent":"edit"}', expected: 'edit', labelSet: INTENT },
  { texto: 'help', expected: ['help', 'edit'], labelSet: INTENT },
  { texto: 'edit\nO usuário pediu para alterar o texto, não criar um novo.', expected: ['help', 'edit'], labelSet: INTENT },
  { texto: 'urgente', expected: 'urgente', labelSet: URG },
  { texto: 'Prioridade: URGENTE', expected: 'urgente', labelSet: URG },
  { texto: 'Urgente, com certeza.', expected: 'urgente', labelSet: URG },
  { texto: 'pt-BR', expected: 'pt', labelSet: ['pt', 'en', 'es'] },
  { texto: '42', expected: '42', labelSet: ['42'] },
  { texto: 'Resposta: 42', expected: '42', labelSet: ['42'] },
  { texto: '42\nPorque 6×7=42.', expected: '42', labelSet: ['42'] },
  { texto: '{"intent": "edit"}', expected: { intent: 'edit' } },
  { texto: 'Claro: {"intent": "edit"} — pronto!', expected: { intent: 'edit' } },
  { texto: '```json\n{"intent": "edit", "confidence": 0.9}\n```', expected: { intent: 'edit' } },
  { texto: '{"intent":"edit"}\n{"intent":"edit"}', expected: { intent: 'edit' } },
  // Revisão IMPL-003 — formatos comuns que caíam para parcial/nao:
  // rótulo na linha seguinte a um cabeçalho, JSON aninhado, lista numerada,
  // objeto de metadado ao lado, prefixo firme "Sem dúvida:".
  { texto: 'Sentimento:\nnegativo', expected: 'negativo', labelSet: SENT },
  { texto: '## Resultado\n\nNegativo', expected: 'negativo', labelSet: SENT },
  { texto: '**Sentimento:**\nNegativo\nO cliente reclama.', expected: 'negativo', labelSet: SENT },
  { texto: '{"resultado": {"label": "negativo"}}', expected: 'negativo', labelSet: SENT },
  { texto: '{"label":"negativo"}\n{"confidence":0.9}', expected: 'negativo', labelSet: SENT },
  { texto: '1. Negativo', expected: 'negativo', labelSet: SENT },
  { texto: 'Sem dúvida: negativo', expected: 'negativo', labelSet: SENT },
  // ... citação do cliente com incerteza (a incerteza NÃO é do modelo),
  // pergunta retórica rejeitada, "sim" conversacional numa resposta "não".
  { texto: 'Negativo\n\nO cliente disse: "não tenho certeza se volto a comprar".', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo.\n\nNeutro? Não, há raiva explícita.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\n\nNeutro não, porque há raiva.', expected: 'negativo', labelSet: SENT },
  { texto: 'Não. Sim, entendo a frustração, mas não.', expected: 'nao', labelSet: SIMNAO },
  // ... explicações que citam outro rótulo com SUJEITO, contraste ou contrafactual —
  // as guardas novas não podem derrubá-las.
  { texto: 'Negativo\n\nO texto parece neutro no início, mas é negativo.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\n\nAlguns diriam neutro, mas as reclamações pesam.', expected: 'negativo', labelSet: SENT },
  { texto: 'Sentimento: negativo\nJustificativa: embora haja elogio (positivo), a queixa domina.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\n\nNota: poderia ser neutro se não houvesse a ameaça de cancelar.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo, ou seja, o cliente está insatisfeito.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo, sem dúvida.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo, não só pelo atraso, mas pelo tom.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo. Não há elogios, apenas reclamações.', expected: 'negativo', labelSet: SENT },
  { texto: 'Normal, não urgente.', expected: 'normal', labelSet: URG },
  { texto: 'Normal (não urgente)', expected: 'normal', labelSet: URG },
  { texto: 'Não, não tem direito.', expected: 'nao', labelSet: SIMNAO },
  { texto: 'Sim\n\nNão há impedimento.', expected: 'sim', labelSet: SIMNAO },
  // Revisão 3: rótulo-partícula de OUTRO rótulo usado como operador da prosa
  // ("o prazo não expirou", "there is no exception") não é menção.
  { texto: 'Sim. O prazo não expirou.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'Sim, ele tem direito — não há exceção aplicável.', expected: 'sim', labelSet: SIMNAO },
  { texto: 'Yes. There is no exception here.', expected: 'yes', labelSet: ['yes', 'no'] },
  // ... e a hesitação numa frase SEGUINTE (sobre outra coisa) vale o mesmo que
  // com quebra de linha: a quebra de linha não muda o veredito.
  { texto: 'Negativo. O cliente não sabe se volta; talvez cancele.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\nO cliente não sabe se volta; talvez cancele.', expected: 'negativo', labelSet: SENT },
  { texto: 'Urgente. Provavelmente é incidente de produção.', expected: 'urgente', labelSet: URG },
  // ... contraste com aparência ("parece <outro>, mas…") descarta a menção.
  { texto: 'Negativo\nParece neutro, mas não é.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo\n\nPode parecer neutro, mas há ironia.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negativo. Pode soar neutro, mas há ironia.', expected: 'negativo', labelSet: SENT },
  { texto: 'Normal\n\nEmbora pareça urgente, é só uma dúvida.', expected: 'normal', labelSet: URG },
  { texto: 'Aqui está: {"label":"negativo"}. Não é positivo.', expected: 'negativo', labelSet: SENT },
  { texto: 'Negative\n\nThe first sentence is positive, but the complaint dominates.', expected: 'negative', labelSet: EN },
];

describe('IMPL-003 — positivos legítimos: ≥95% resolve', () => {
  it(`acerto ≥95% em ${LEGITIMOS.length} respostas corretas bem-formadas`, () => {
    const erros = LEGITIMOS.map((c) => ({ c, r: matchExpected(c.texto, c.expected, { labelSet: c.labelSet }) }))
      .filter(({ r }) => r.verdict !== 'resolve')
      .map(({ c, r }) => `${JSON.stringify(c.texto)} → ${r.verdict}/${r.rule}`);
    const acerto = (LEGITIMOS.length - erros.length) / LEGITIMOS.length;
    expect(acerto, erros.join('\n')).toBeGreaterThanOrEqual(0.95);
    // Hoje o corpus inteiro passa — o piso acima é o contrato; isto trava regressão.
    expect(erros).toEqual([]);
  });

  it('prosa correta cai para parcial (rebaixamento EXPLÍCITO, nunca nao)', () => {
    const prosa: Caso[] = [
      { texto: 'O sentimento do cliente é negativo.', expected: 'negativo', labelSet: SENT },
      { texto: 'Classifico como negativo, pois o cliente reclama.', expected: 'negativo', labelSet: SENT },
      { texto: 'Pelo tom da mensagem, eu diria negativo', expected: 'negativo', labelSet: SENT },
      { texto: 'O usuário quer edit do parágrafo', expected: 'edit', labelSet: INTENT },
      // revisão IMPL-003: rótulo + separador + prosa que começa com negação ou
      // hesita em outra coisa — a guarda da regra 'lead' rebaixa, não zera.
      { texto: 'Negativo: não gostou do atendimento.', expected: 'negativo', labelSet: SENT },
      { texto: 'Urgente, provavelmente por causa do servidor.', expected: 'urgente', labelSet: URG },
      // revisão 2 (sem heurística de sujeito): explicação que AFIRMA outro rótulo
      // sem negá-lo/descartá-lo tira o 'resolve' — rebaixa, não zera (risco R-03b).
      { texto: 'Não\n\nNão há direito, pois o prazo expirou; sim, o cliente pode recorrer.', expected: 'nao', labelSet: SIMNAO },
      { texto: 'Negativo\nO tom do início é neutro.', expected: 'negativo', labelSet: SENT },
    ];
    for (const c of prosa) {
      const r = matchExpected(c.texto, c.expected, { labelSet: c.labelSet });
      expect(r.verdict, `${c.texto} → ${r.rule}`).toBe('parcial');
      expect(r.explanation).toContain('modo estrito');
    }
  });

  it('JSON com o valor errado dá nao (field-mismatch)', () => {
    expect(matchExpected('{"label":"positivo"}', 'negativo', { labelSet: SENT }).rule).toBe('field-mismatch');
    expect(matchExpected('{"label":"positivo"}', 'negativo', { labelSet: SENT }).verdict).toBe('nao');
  });
});

describe('IMPL-003 — modo e labelSet', () => {
  it('strict é o default (sem opções = { mode: "strict" })', () => {
    const textos = ['edit o texto', 'A resposta NÃO é urgente.', 'Resposta: edit', '{"a":1}'];
    for (const t of textos) {
      expect(matchExpected(t, 'edit')).toEqual(matchExpected(t, 'edit', { mode: 'strict' }));
    }
  });

  it('rótulo curto = ≤5 palavras; objeto campo→valor não conta', () => {
    expect(SHORT_LABEL_MAX_WORDS).toBe(5);
    expect(isShortLabelExpected('negativo')).toBe(true);
    expect(isShortLabelExpected('um dois tres quatro cinco')).toBe(true);
    expect(isShortLabelExpected('um dois tres quatro cinco seis')).toBe(false);
    expect(isShortLabelExpected(['frase longa demais com seis palavras', 'curto'])).toBe(true);
    expect(isShortLabelExpected({ intent: 'edit' })).toBe(false);
    expect(isShortLabelExpected(undefined)).toBe(false);
  });

  it('labelSetIssue: rótulo curto SEM labelSet é erro; com labelSet que o contém, ok', () => {
    expect(labelSetIssue({ expected: 'negativo' })).toMatch(/labelSet obrigatório/);
    expect(labelSetIssue({ expected: ['edit', 'help'] })).toMatch(/labelSet obrigatório/);
    expect(labelSetIssue({ expected: 'negativo', labelSet: SENT })).toBeNull();
    // normalização: acento/caixa não importam
    expect(labelSetIssue({ expected: 'Não', labelSet: ['sim', 'nao'] })).toBeNull();
    // o esperado precisa estar no conjunto
    expect(labelSetIssue({ expected: 'raiva', labelSet: SENT })).toMatch(/não está em labelSet/);
    expect(labelSetIssue({ expected: ['help', 'outro'], labelSet: INTENT })).toMatch(/'outro'/);
    // labelSet vazio/sem expected
    expect(labelSetIssue({ expected: 'negativo', labelSet: ['  '] })).toMatch(/vazio/);
    expect(labelSetIssue({ labelSet: SENT })).toMatch(/junto com expected/);
    // revisão: [expected] sozinho desligaria a detecção de lista → erro (numérico é resposta aberta)
    expect(labelSetIssue({ expected: 'negativo', labelSet: ['negativo'] })).toMatch(/pelo menos 2 rótulos distintos/);
    expect(labelSetIssue({ expected: ['negativo'], labelSet: ['Negativo', 'negativo'] })).toMatch(/pelo menos 2/);
    expect(labelSetIssue({ expected: '42', labelSet: ['42'] })).toBeNull();
    expect(labelSetIssue({ expected: 'negativo', labelSet: ['negativo', 'positivo'] })).toBeNull();
    // rótulo longo e objeto não exigem
    expect(labelSetIssue({ expected: 'um dois tres quatro cinco seis' })).toBeNull();
    expect(labelSetIssue({ expected: { intent: 'edit' } })).toBeNull();
    expect(labelSetIssue({})).toBeNull();
  });

  it('stageLabelIssues aponta o índice de cada etapa com problema', () => {
    const issues = stageLabelIssues([
      { expected: 'negativo', labelSet: SENT },
      { expected: 'negativo' },
      {},
      { expected: 'x', labelSet: ['y'] },
    ]);
    expect(issues.map((i) => i.index)).toEqual([1, 3]);
    expect(stageLabelIssues(undefined)).toEqual([]);
  });

  it('pergunta nunca resolve, nem pela regra de idioma BCP-47', () => {
    expect(matchExpected('pt-BR?', 'pt', { labelSet: ['pt', 'en'] }).verdict).not.toBe('resolve');
    expect(matchExpected('Edit?', 'edit', { labelSet: INTENT }).verdict).toBe('nao');
  });

  it('labelSet enxerga a lista; sem ele, a mesma resposta cai só para parcial', () => {
    const lista = 'As opções são edit, create ou delete.';
    expect(matchExpected(lista, 'edit', { labelSet: INTENT }).verdict).toBe('nao');
    expect(matchExpected(lista, 'edit').verdict).toBe('parcial');
  });
});
