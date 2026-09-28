// Bateria de ida-e-volta do formato de troca `prompt-builder-exchange@1`
// (IMPL-089, R-22:REC-1/REC-9): campo desconhecido PRESERVADO (ida e volta =
// identidade), perda sempre declarada em `lostFields`, identidade por
// contentHash JCS/RFC 8785 (mesma fórmula Node × navegador — os dois lados
// importam a MESMA implementação via shim) e roundtrip(item)==item para ≥ 100
// itens gerados aleatoriamente (gerador determinístico — sem rede, sem flake).

import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_FILES,
  EXCHANGE_FORMAT,
  EXCHANGE_MANIFEST_FILE,
  buildExchangeBundle,
  parseExchangeBundle,
  undeclaredLoss,
  type ExchangeHeader,
} from '../src/engine/exchange.js';
import {
  computeContentHash,
  normalizeLibraryItemPreserving,
  type LibraryItem,
} from '../src/engine/libraryCore.js';
import * as canonico from '../src/engine/libraryCore.js';
import * as navegador from '../web/src/engine/libraryCore.js';

/** Item de ouro: TODOS os campos do LibraryItem + campos desconhecidos. */
function itemDeOuro(): LibraryItem & Record<string, unknown> {
  return {
    id: 'wf-001',
    title: 'Prazo de troca (ç ã é)',
    tier: 'invariance',
    persona: 'cliente com pressa',
    context: 'compra online na sexta',
    successCriteria: ['citar 30 dias', 'citar nota fiscal'],
    rationale: 'cobrir o caso comum de troca',
    dimensionTags: ['extracao', 'pt-BR', 'inv:prazo'],
    question: 'Qual o prazo para trocar um tênis comprado na loja online?',
    productContext: 'Política de trocas: 30 dias corridos, com nota fiscal.',
    maxTokens: 300,
    rubric: 'Deve citar 30 dias e a nota fiscal.',
    reference: '30 dias corridos a partir do recebimento.',
    expected: { rotulo: 'prazo_30_dias' },
    labelSet: ['prazo_30_dias', 'outro'],
    origin: 'ai',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    seed: 'prompt-builder:seed@1',
    state: 'aprovado',
    reviewer: 'dono',
    reviewedAt: '2026-01-03T00:00:00.000Z',
    rejectReason: { kind: 'outro', note: 'não se aplica' },
    provenance: {
      question: { origem: 'ai', model: 'openai/gpt-fake', prompt: 'gerar cenário' },
      title: { origem: 'editado' },
    },
    contentHash: 'sha256:abc',
    parentHash: 'sha256:def',
    generator: { modelId: 'openai/gpt-fake', temperature: 0, seed: 7, generatedAt: '2026-01-01T00:00:00.000Z' },
    // campos DESCONHECidos pelo schema — a régua manda preservá-los
    campoDoFuturo: { aninhado: [1, 2, 3] },
    outroCampo: 'sobrevive à ida e volta',
  };
}

/** Gerador determinístico (LCG) — "aleatório" sem depender de semente da VM. */
function lcg(semente: number): () => number {
  let s = semente >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const TIERS = ['mft', 'invariance', 'adversarial', 'edge'] as const;
const ORIGENS = ['official', 'ai', 'manual', 'import'] as const;

/** ≥ 100 itens arbitrários (JSON-safe: nada de undefined como valor de chave). */
function itensAleatorios(qtd: number, semente: number): Array<LibraryItem & Record<string, unknown>> {
  const rnd = lcg(semente);
  const escolhe = <T>(lista: readonly T[]): T => lista[Math.floor(rnd() * lista.length)];
  const itens: Array<LibraryItem & Record<string, unknown>> = [];
  for (let i = 0; i < qtd; i++) {
    const temReference = rnd() < 0.5;
    const item: LibraryItem & Record<string, unknown> = {
      id: `gen-${i}`,
      title: `Cenário ${i} — ${Math.floor(rnd() * 1e6)}`,
      tier: escolhe(TIERS),
      question: `Pergunta ${i}? `.repeat(1 + Math.floor(rnd() * 3)),
      productContext: `Contexto ${i}`,
      maxTokens: 100 + Math.floor(rnd() * 2000),
      origin: escolhe(ORIGENS),
      createdAt: new Date(1700000000000 + Math.floor(rnd() * 1e10)).toISOString(),
    };
    if (temReference) item.reference = `Referência ${i}`;
    else item.expected = rnd() < 0.5 ? `rótulo-${i}` : [`a-${i}`, `b-${i}`];
    if (rnd() < 0.4) item.persona = `persona ${i}`;
    if (rnd() < 0.4) item.dimensionTags = [`d-${i}`, `inv:g${i % 7}`];
    if (rnd() < 0.3) item.state = escolhe(['gerado', 'em_revisao', 'aprovado', 'rejeitado', 'ajustar'] as const);
    if (rnd() < 0.3) item.provenance = { question: { origem: escolhe(['ai', 'humano', 'editado'] as const) } };
    if (rnd() < 0.3) item.contentHash = `sha256:${i.toString(16).padStart(64, '0')}`;
    if (rnd() < 0.2) item.campoDesconhecido = { valor: i, lista: [i, null] };
    itens.push(item);
  }
  return itens;
}

describe('prompt-builder-exchange@1 — ida e volta (IMPL-089)', () => {
  it('item de ouro com TODOS os campos (incluindo desconhecidos) volta idêntico', () => {
    const item = itemDeOuro();
    const pacote = buildExchangeBundle({ producer: 'teste@1', exportedAt: '2026-03-01T00:00:00.000Z', library: [item] });
    const lido = parseExchangeBundle(pacote.files);
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.library).toEqual([item]); // roundtrip(item) == item
    expect(lido.lostFields).toEqual({});
  });

  it('roundtrip(item)==item para ≥ 100 itens gerados aleatoriamente', () => {
    const itens = itensAleatorios(120, 42);
    const pacote = buildExchangeBundle({
      producer: 'teste@1',
      exportedAt: '2026-03-01T00:00:00.000Z',
      library: itens,
      runs: [{ id: 'run-1', qualquer: true }],
      sessions: [{ id: 'sess-1' }],
    });
    const lido = parseExchangeBundle(pacote.files);
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.library).toHaveLength(120);
    expect(lido.library).toEqual(itens);
    expect(lido.runs).toEqual([{ id: 'run-1', qualquer: true }]);
    expect(lido.sessions).toEqual([{ id: 'sess-1' }]);
  });

  it('o campo desconhecido também sobrevive ao caminho de validação (zod não descarta em silêncio)', () => {
    const item = itemDeOuro();
    const r = normalizeLibraryItemPreserving(item);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.campoDoFuturo).toEqual({ aninhado: [1, 2, 3] });
    expect(r.item.outroCampo).toBe('sobrevive à ida e volta');
    expect(r.lostFields).toEqual([]);
  });
});

describe('prompt-builder-exchange@1 — discriminador e manifesto', () => {
  it('manifesto traz format/exportedAt/producer e cada JSONL abre com o discriminador completo', () => {
    const pacote = buildExchangeBundle({
      producer: 'prompt-builder-cli@0.1.1',
      exportedAt: '2026-03-01T00:00:00.000Z',
      library: [itemDeOuro()],
    });
    expect(pacote.manifest).toMatchObject({
      format: EXCHANGE_FORMAT,
      exportedAt: '2026-03-01T00:00:00.000Z',
      producer: 'prompt-builder-cli@0.1.1',
      manifest: [{ kind: 'library', file: EXCHANGE_FILES.library, count: 1 }],
    });
    expect(pacote.files[EXCHANGE_MANIFEST_FILE]).toContain(EXCHANGE_FORMAT);
    const linhas = pacote.files[EXCHANGE_FILES.library].trim().split('\n');
    const header = JSON.parse(linhas[0]) as ExchangeHeader;
    expect(header).toMatchObject({
      format: EXCHANGE_FORMAT,
      kind: 'library',
      exportedAt: '2026-03-01T00:00:00.000Z',
      producer: 'prompt-builder-cli@0.1.1',
    });
    expect(Array.isArray(header.manifest)).toBe(true);
  });

  it('manifesto é contrato: contagem errada, header que não casa ou arquivo faltando são ERRO (nunca silêncio)', () => {
    const pacote = buildExchangeBundle({ producer: 'teste@1', library: [itemDeOuro()] });
    const comContagemErrada = {
      ...pacote.files,
      [EXCHANGE_MANIFEST_FILE]: JSON.stringify({
        ...pacote.manifest,
        manifest: [{ ...pacote.manifest.manifest[0], count: 2 }],
      }),
    };
    expect(parseExchangeBundle(comContagemErrada)).toMatchObject({ ok: false });
    expect(parseExchangeBundle({})).toMatchObject({ ok: false });
    const semArquivo = { [EXCHANGE_MANIFEST_FILE]: pacote.files[EXCHANGE_MANIFEST_FILE] };
    expect(parseExchangeBundle(semArquivo)).toMatchObject({ ok: false });
  });
});

describe('prompt-builder-exchange@1 — perda declarada (régua do N1)', () => {
  it('um mapeamento que descarta campo sem declarar fica VERMELHO; declarado em lostFields, ok', () => {
    const itens = [itemDeOuro()];
    // caso real do gap: export antigo (toStageSpec) descartava 8 campos do item
    const soStageSpec = itens.map((i) => ({
      id: i.id,
      tier: i.tier,
      question: i.question,
      productContext: i.productContext,
      maxTokens: i.maxTokens,
    }));
    const perdidosNaoDeclarados = undeclaredLoss(itens, soStageSpec);
    expect(perdidosNaoDeclarados).toContain('title');
    expect(perdidosNaoDeclarados).toContain('persona');
    expect(perdidosNaoDeclarados).toContain('contentHash');
    expect(perdidosNaoDeclarados.length).toBeGreaterThanOrEqual(8);

    const declarados = ['title', 'persona', 'context', 'successCriteria', 'rationale', 'reference', 'contentHash', 'outroCampo'];
    const restantes = undeclaredLoss(itens, soStageSpec, [
      ...declarados,
      'dimensionTags', 'updatedAt', 'seed', 'state', 'reviewer', 'reviewedAt', 'rejectReason',
      'provenance', 'parentHash', 'generator', 'campoDoFuturo', 'createdAt', 'origin', 'rubric',
      'expected', 'labelSet',
    ]);
    expect(restantes).toEqual([]);
  });

  it('buildExchangeBundle registra lostFields no manifesto e o parse os devolve', () => {
    const pacote = buildExchangeBundle({
      producer: 'teste@1',
      library: [itemDeOuro()],
      lostFields: { library: ['campoDoFuturo', 'outroCampo'] },
    });
    expect(pacote.manifest.manifest[0].lostFields).toEqual(['campoDoFuturo', 'outroCampo']);
    const lido = parseExchangeBundle(pacote.files);
    expect(lido.ok).toBe(true);
    if (!lido.ok) return;
    expect(lido.lostFields.library).toEqual(['campoDoFuturo', 'outroCampo']);
  });
});

describe('identidade por contentHash — idêntica Node × navegador (JCS/RFC 8785)', () => {
  it('vetor JCS de ouro: o hash do conteúdo é fixo e reproduzível', () => {
    const item = {
      id: 'x',
      title: 'Título acentuado ç',
      tier: 'mft',
      question: 'Qual o prazo?',
      productContext: 'Ctx',
      maxTokens: 300,
      origin: 'manual',
      createdAt: '2026-01-01T00:00:00.000Z',
    } as LibraryItem;
    expect(computeContentHash(item)).toBe(
      'sha256:95b57e2a1ad6860b23698bb87826af644207102889a0089e985b77dbaca47d02',
    );
  });

  it('os mesmos 100 itens hasham igual pelo shim do navegador (mesma implementação, sem 3ª cópia)', () => {
    const itens = itensAleatorios(100, 7);
    for (const item of itens) {
      expect(navegador.computeContentHash(item)).toBe(canonico.computeContentHash(item));
    }
    // o shim NÃO é uma cópia: é o MESMO objeto de função
    expect(navegador.computeContentHash).toBe(canonico.computeContentHash);
  });
});
