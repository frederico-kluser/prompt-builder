// Testes de CONTRATO do multi-prompt (coordinate ascent, F2/P0.4).

import { describe, expect, it } from 'vitest';
import {
  composePrompt,
  frozenSiblings,
  siblingsContext,
  targetFragment,
  validatePromptGroup,
  type PromptGroup,
} from '../src/engine/promptGroup.js';

const grupo: PromptGroup = {
  prompts: [
    { id: 'regras', label: 'Regras', text: 'REGRAS: sempre responda em pt-BR.' },
    { id: 'criticas', text: 'CRITICAS: nunca invente números.' },
    { id: 'formato', text: 'FORMATO: JSON.' },
  ],
};

describe('promptGroup — validatePromptGroup', () => {
  it('grupo com >1 prompt exige promptId (sem ele não há coordinate ascent)', () => {
    const r = validatePromptGroup(grupo, undefined);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/promptId/);
  });

  it('promptId precisa existir no grupo', () => {
    expect(validatePromptGroup(grupo, 'nao-existe').ok).toBe(false);
    expect(validatePromptGroup(grupo, 'regras').ok).toBe(true);
  });

  it('grupo de 1 prompt não exige promptId; sem grupo tudo passa', () => {
    expect(validatePromptGroup({ prompts: [{ id: 'a', text: 'x' }] }, undefined).ok).toBe(true);
    expect(validatePromptGroup(undefined, undefined).ok).toBe(true);
  });

  it('id/texto vazios e id duplicado são recusados (PT-BR)', () => {
    expect(validatePromptGroup({ prompts: [{ id: '', text: 'x' }] }, undefined).ok).toBe(false);
    expect(validatePromptGroup({ prompts: [{ id: 'a', text: '  ' }] }, undefined).ok).toBe(false);
    const dup = validatePromptGroup(
      { prompts: [{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }] },
      'a',
    );
    expect(dup.ok).toBe(false);
    expect(dup.error).toMatch(/duplicado/);
  });
});

describe('promptGroup — coordinate ascent', () => {
  it('frozenSiblings = todos menos o alvo, na ordem', () => {
    expect(frozenSiblings(grupo, 'criticas').map((p) => p.id)).toEqual(['regras', 'formato']);
    expect(frozenSiblings(grupo, undefined).map((p) => p.id)).toEqual(['criticas', 'formato']);
  });

  it('composePrompt substitui SÓ o fragmento alvo pela variante', () => {
    const composto = composePrompt(grupo, 'criticas', 'CRITICAS v2: números só com fonte.');
    expect(composto).toContain('REGRAS: sempre responda em pt-BR.');
    expect(composto).toContain('CRITICAS v2: números só com fonte.');
    expect(composto).not.toContain('CRITICAS: nunca invente números.');
    expect(composto).toContain('FORMATO: JSON.');
    // Ordem dos fragmentos preservada.
    expect(composto.indexOf('REGRAS')).toBeLessThan(composto.indexOf('CRITICAS v2'));
    expect(composto.indexOf('CRITICAS v2')).toBeLessThan(composto.indexOf('FORMATO'));
  });

  it('siblingsContext traz os irmãos com a regra de congelamento', () => {
    const ctx = siblingsContext(grupo, 'regras');
    expect(ctx).toContain('CONGELADOS');
    expect(ctx).toContain('CRITICAS: nunca invente números.');
    expect(ctx).toContain('FORMATO: JSON.');
    expect(ctx).not.toContain('REGRAS: sempre responda');
  });

  it('grupo de 1 prompt: sem irmãos, sem contexto congelado', () => {
    const solo: PromptGroup = { prompts: [{ id: 'a', text: 'texto' }] };
    expect(siblingsContext(solo, 'a')).toBe('');
    expect(composePrompt(solo, 'a', 'variante')).toBe('variante');
  });

  it('targetFragment cai no único prompt quando não há promptId', () => {
    const solo: PromptGroup = { prompts: [{ id: 'a', text: 'x' }, { id: 'b', text: 'y' }] };
    expect(targetFragment(solo, undefined)?.id).toBe('a');
    expect(targetFragment(solo, 'b')?.id).toBe('b');
  });
});
