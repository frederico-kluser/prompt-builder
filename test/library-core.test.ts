// Contratos de curadoria por item (IMPL-087, R-22:REC-2) e da política de itens
// não aprovados (IMPL-090, R-22:REC-7). O núcleo é PURO em
// `src/engine/libraryCore.ts` (fonte única — o web re-exporta por shim) e estes
// testes entram no `npm test` como contrato: schema preserva os campos novos,
// edição invalida aprovação por `contentHash`, proveniência acumula origens e
// run sem curadoria DENUNCIA (k de n) sem bloquear por default.

import { describe, expect, it } from 'vitest';
import {
  applyItemEdit,
  computeContentHash,
  contentHashIssue,
  curatedKofN,
  curationStatus,
  curationWarnings,
  isApproved,
  markItemReviewed,
  mergeItemVersion,
  normalizeLibraryItem,
  normalizeLibraryItemPreserving,
  requireApprovedIssue,
  stampGeneration,
  transitionIssue,
  type LibraryItem,
} from '../src/engine/libraryCore.js';

function itemBase(sobrescreve: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'wf-001',
    title: 'Prazo de troca',
    tier: 'mft',
    question: 'Qual o prazo para trocar um tênis comprado na loja online?',
    productContext: 'Política de trocas: 30 dias corridos, com nota fiscal.',
    maxTokens: 300,
    reference: '30 dias corridos a partir do recebimento, com nota fiscal.',
    origin: 'manual',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...sobrescreve,
  };
}

const GERADOR = {
  modelId: 'openai/gpt-fake',
  temperature: 0,
  seed: 7,
  generatedAt: '2026-02-01T00:00:00.000Z',
};

const itemGerado = (): LibraryItem => stampGeneration(itemBase(), GERADOR);

const itemAprovado = (): LibraryItem =>
  markItemReviewed(itemGerado(), {
    state: 'aprovado',
    reviewer: 'dono',
    now: '2026-02-02T00:00:00.000Z',
  });

describe('curadoria por item — campos e schema (IMPL-087)', () => {
  it('normalizeLibraryItem aceita e preserva state/provenance/rejectReason/contentHash/parentHash/generator', () => {
    const bruto = {
      ...itemBase(),
      state: 'aprovado',
      reviewer: 'dono',
      reviewedAt: '2026-02-02T00:00:00.000Z',
      rejectReason: { kind: 'gabarito_errado', note: 'rascunho' },
      provenance: { question: { origem: 'ai', model: 'openai/gpt-fake', prompt: 'gerar cenário' } },
      contentHash: 'sha256:abc',
      parentHash: 'sha256:def',
      generator: GERADOR,
    };
    const r = normalizeLibraryItem(bruto);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.state).toBe('aprovado');
    expect(r.item.provenance?.question).toEqual({ origem: 'ai', model: 'openai/gpt-fake', prompt: 'gerar cenário' });
    expect(r.item.rejectReason).toEqual({ kind: 'gabarito_errado', note: 'rascunho' });
    expect(r.item.contentHash).toBe('sha256:abc');
    expect(r.item.parentHash).toBe('sha256:def');
    expect(r.item.generator).toEqual(GERADOR);
  });

  it('estado/proveniência fora do contrato são recusados com o campo na mensagem', () => {
    const ruim = normalizeLibraryItem({ ...itemBase(), state: 'aprovado_pelo_chat' });
    expect(ruim.ok).toBe(false);
    if (ruim.ok) return;
    expect(ruim.error).toMatch(/state/u);
    const ruim2 = normalizeLibraryItem({
      ...itemBase(),
      provenance: { question: { origem: 'vibes' } },
    });
    expect(ruim2.ok).toBe(false);
    if (ruim2.ok) return;
    expect(ruim2.error).toMatch(/origem/u);
  });

  it('normalizeLibraryItemPreserving NÃO descarta chave desconhecida (ida e volta = identidade)', () => {
    const bruto = { ...itemBase(), campoDoFuturo: { x: 1 }, outroCampo: 'vive' };
    const r = normalizeLibraryItemPreserving(bruto);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.campoDoFuturo).toEqual({ x: 1 });
    expect(r.item.outroCampo).toBe('vive');
    expect(r.lostFields).toEqual([]);
    // E o que se perde é SEMPRE declarado (nunca descarte mudo).
    const comPerda = normalizeLibraryItemPreserving({ ...itemBase(), efemero: undefined });
    expect(comPerda.ok).toBe(true);
    if (!comPerda.ok) return;
    expect(comPerda.lostFields).toContain('efemero');
  });
});

describe('aprovação amarrada ao contentHash (IMPL-087)', () => {
  it('editar um item aprovado transiciona para "gerado" via invalidação de contentHash', () => {
    const aprovado = itemAprovado();
    expect(isApproved(aprovado)).toBe(true);

    const editado = applyItemEdit(
      aprovado,
      { question: 'Qual o prazo para trocar um sapato comprado na loja online?' },
      { now: '2026-02-03T00:00:00.000Z' },
    );
    expect(editado.state).toBe('gerado');
    expect(editado.contentHash).not.toBe(aprovado.contentHash);
    expect(editado.parentHash).toBe(aprovado.contentHash);
    expect(isApproved(editado)).toBe(false);
    // a revisão do conteúdo antigo não arrasta para o novo
    expect(editado.reviewer).toBeUndefined();
    expect(editado.reviewedAt).toBeUndefined();
  });

  it('provenance regista ≥ 2 origens distintas num item gerado e depois editado', () => {
    const editado = applyItemEdit(itemGerado(), { title: 'Prazo de troca (ajustado)' });
    const origens = new Set(Object.values(editado.provenance ?? {}).map((p) => p.origem));
    expect(origens.has('ai')).toBe(true);
    expect(origens.has('editado')).toBe(true);
    expect(origens.size).toBeGreaterThanOrEqual(2);
    expect(editado.provenance?.title).toEqual({ origem: 'editado' });
    expect(editado.provenance?.question).toEqual({ origem: 'ai', model: GERADOR.modelId });
  });

  it('edição que NÃO muda conteúdo não gera versão nova nem derruba a aprovação', () => {
    const aprovado = itemAprovado();
    const mesmo = applyItemEdit(aprovado, { question: aprovado.question });
    expect(mesmo.state).toBe('aprovado');
    expect(mesmo.parentHash).toBeUndefined();
    expect(isApproved(mesmo)).toBe(true);
  });

  it('edição FORA do fluxo (JSON mexido direto) também invalida: o hash não mente', () => {
    const aprovado = itemAprovado();
    const adulterado: LibraryItem = { ...aprovado, reference: 'qualquer coisa' };
    expect(contentHashIssue(adulterado)).toMatch(/contentHash/u);
    expect(isApproved(adulterado)).toBe(false);
  });

  it('contentHash é estável para o mesmo conteúdo e muda com qualquer campo de conteúdo', () => {
    const a = itemBase();
    const b = itemBase();
    expect(computeContentHash(a)).toBe(computeContentHash(b));
    expect(computeContentHash(itemBase({ rubric: 'extra' }))).not.toBe(computeContentHash(a));
    // metadados de curadoria NÃO entram no hash (revisar não muda a identidade)
    expect(computeContentHash({ ...a, state: 'aprovado', reviewer: 'dono' })).toBe(computeContentHash(a));
  });

  it('revisões: rejeição exige rejectReason e transições ilegais são recusadas', () => {
    expect(() =>
      markItemReviewed(itemGerado(), { state: 'rejeitado', reviewer: 'dono' }),
    ).toThrow(/rejectReason/u);
    const rejeitado = markItemReviewed(itemGerado(), {
      state: 'rejeitado',
      reviewer: 'dono',
      rejectReason: { kind: 'gabarito_errado', note: 'gab errado' },
    });
    expect(rejeitado.state).toBe('rejeitado');
    expect(rejeitado.rejectReason).toEqual({ kind: 'gabarito_errado', note: 'gab errado' });
    expect(rejeitado.contentHash).toBe(computeContentHash(rejeitado));
    expect(transitionIssue('aprovado', 'em_revisao')).toMatch(/transição inválida/u);
    expect(transitionIssue('gerado', 'aprovado')).toBeNull();
  });

  it('mescla: fast-forward por parentHash e conflito explícito (mantém as duas versões, marca "ajustar")', () => {
    const v1 = itemGerado();
    const v2 = applyItemEdit(v1, { title: 'v2' });
    const ff = mergeItemVersion(v1, v2);
    expect(ff.kind).toBe('fast-forward');
    if (ff.kind !== 'fast-forward') return;
    expect(ff.item).toBe(v2);

    const ramoA = applyItemEdit(v1, { title: 'ramo A' });
    const ramoB = applyItemEdit(v1, { title: 'ramo B' });
    const conflito = mergeItemVersion(ramoA, ramoB);
    expect(conflito.kind).toBe('conflito');
    if (conflito.kind !== 'conflito') return;
    expect(conflito.local).toBe(ramoA);
    expect(conflito.incoming).toBe(ramoB);
    expect(conflito.item.state).toBe('ajustar');
  });
});

describe('política de itens não aprovados (IMPL-090)', () => {
  it('run reporta k de n curados (curatedKofN) — só aprovado com hash válido conta', () => {
    const itens = [
      itemAprovado(),
      itemGerado(),
      itemBase({ id: 'wf-003' }), // nunca passou pelo fluxo novo
    ];
    const status = curationStatus(itens);
    expect(status).toMatchObject({ total: 3, curated: 1 });
    expect(status.unapproved.map((u) => u.id)).toEqual(['wf-001', 'wf-003']);
    expect(status.unapproved[1].state).toBe('sem_estado');
    expect(curatedKofN(itens)).toBe('1 de 3 itens curados');
  });

  it('item aprovado e depois editado sai da conta de curados (invalidação por hash)', () => {
    const editado = applyItemEdit(itemAprovado(), { question: 'mexeu depois da aprovação' });
    expect(curationStatus([editado])).toMatchObject({ curated: 0, total: 1 });
    expect(curationStatus([itemAprovado()])).toMatchObject({ curated: 1, total: 1 });
  });

  it('run.warning é AGREGADO (uma entrada, com ids) e some quando tudo está aprovado', () => {
    const naoAprovados = [itemGerado(), itemGerado(), itemBase({ id: 'wf-009' })];
    const avisos = curationWarnings(naoAprovados);
    expect(avisos).toHaveLength(1); // agregado — não uma entrada por item
    expect(avisos[0]).toMatch(/itens não aprovados/u);
    expect(avisos[0]).toContain('gerado');
    expect(avisos[0]).toContain('wf-009');
    expect(curationWarnings([itemAprovado()])).toEqual([]);
    expect(curationWarnings([])).toEqual([]);
  });

  it('bloqueio só quando pedido: --require-approved/holdout recusam, o default não', () => {
    const comPendente = [itemAprovado(), itemGerado()];
    const problema = requireApprovedIssue(comPendente);
    expect(problema).toMatch(/não aprovado/u);
    expect(problema).toContain('wf-001');
    expect(requireApprovedIssue([itemAprovado()])).toBeNull();
    // holdout e finais: a MESMA regra (100% aprovados) — recusa com mensagem legível
    expect(requireApprovedIssue([itemBase({ id: 'hold-1' })])).toMatch(/hold-1=sem_estado/u);
  });
});
