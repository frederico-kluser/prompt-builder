// Testes de CONTRATO do ground-truth determinístico (`src/engine/groundTruth.ts`) —
// o veredito decodificado SEM juiz LLM quando o cenário traz o rótulo esperado
// (padrão do prompt-arena `gabaritoSpec kind:'labels'`). Travam a normalização
// de rótulo, o casamento BCP-47, a extração de campo em JSON e a escada
// resolve/parcial/nao antes de qualquer refactor.

import { describe, expect, it } from 'vitest';
import {
  extractJsonField,
  languageMatches,
  matchExpected,
  normalizeLabel,
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

  it('rótulo standalone no texto resolve', () => {
    const r = matchExpected('edit o texto', 'edit');
    expect(r.verdict).toBe('resolve');
    expect(r.explanation).toContain('standalone');
  });

  it('rótulo só dentro de outra palavra/frase é parcial', () => {
    const r = matchExpected('O editor de texto é útil', 'edit');
    expect(r.verdict).toBe('parcial');
    expect(r.explanation).toContain('dentro de outra palavra/frase');
  });

  it('standalone exige fronteira alfanumérica ("2" não casa em "2024")', () => {
    expect(matchExpected('2024', '2').verdict).toBe('parcial');
    expect(matchExpected('foram 2 gatos', '2').verdict).toBe('resolve');
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
