// IMPL-065 × IMPL-087 (left#3, onda 3) — item da BIBLIOTECA nascido de IA e
// APROVADO por gente conta como âncora humana.
//
// O defeito: `toStageSpec` descartava o estado de curadoria (state/reviewer/
// contentHash) e a régua da âncora (`trainingPolicy`) olhava só `origin`: um
// item gerado por IA (`origin: 'ai'`) NUNCA contava, nem depois de revisado e
// aprovado — a curadoria da biblioteca não destravava a declaração de campeão.
// Agora a aprovação VIGENTE (estado `aprovado` + hash do conteúdo atual) viaja
// na spec (`humanApproval`) e a âncora/demos a aceitam; aprovação velha
// (conteúdo editado depois) não viaja.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  applyItemEdit,
  markItemReviewed,
  stageHasHumanApproval,
  toStageSpec,
  type LibraryItem,
} from '../src/engine/libraryCore.js';
import {
  championDeclarationFor,
  humanReferenceIndex,
  isCuratedItem,
  trainingLabeledPool,
} from '../src/engine/trainingPolicy.js';
import * as webTrainer from '../web/src/engine/trainer.js';
import { labeledScenariosFrom } from '../src/techniques.js';
import { parseRunConfig } from '../src/runConfigSchema.js';
import { unknownKeyIssues } from '../src/configKeys.js';
import { readConfigFile } from '../src/cli/commands/run.js';
import { exportProfilePackDeclared, saveItems, saveProfile } from '../src/library.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import type { StageSpec } from '../src/types.js';

const NOW = '2026-09-29T00:00:00.000Z';

function itemIa(i: number, over: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: `ia-${String(i).padStart(2, '0')}`,
    title: `item ${i}`,
    tier: 'mft',
    question: `Pergunta gerada ${i}?`,
    productContext: 'Loja ACME: trocas em 30 dias.',
    maxTokens: 200,
    reference: `Gabarito gerado por IA e revisado ${i}.`,
    origin: 'ai',
    createdAt: NOW,
    ...over,
  } as LibraryItem;
}

const aprovar = (x: LibraryItem): LibraryItem =>
  markItemReviewed(x, { state: 'aprovado', reviewer: 'Ana <ana@exemplo.pt>', now: NOW });

describe('toStageSpec carrega a aprovação VIGENTE (e só ela)', () => {
  it('item de IA aprovado → humanApproval {reviewedAt, contentHash}; origin segue "ai"', () => {
    const aprovado = aprovar(itemIa(1));
    const spec = toStageSpec(aprovado);
    expect(spec.origin).toBe('ai');
    expect(spec.humanApproval).toEqual({ reviewedAt: NOW, contentHash: aprovado.contentHash });
    expect(stageHasHumanApproval(spec)).toBe(true);
    // O revisor (nome/e-mail) fica na biblioteca: nada dele na spec da run (LGPD).
    expect(JSON.stringify(spec)).not.toContain('ana@exemplo.pt');
  });

  it('não aprovado, rejeitado ou em revisão → sem humanApproval', () => {
    expect(toStageSpec(itemIa(1)).humanApproval).toBeUndefined();
    const emRevisao = markItemReviewed(itemIa(2), { state: 'em_revisao', reviewer: 'Ana', now: NOW });
    expect(toStageSpec(emRevisao).humanApproval).toBeUndefined();
    const rejeitado = markItemReviewed(itemIa(3), {
      state: 'rejeitado',
      reviewer: 'Ana',
      rejectReason: { kind: 'gabarito_errado' },
      now: NOW,
    });
    expect(toStageSpec(rejeitado).humanApproval).toBeUndefined();
  });

  it('aprovação VELHA (conteúdo editado fora do fluxo) não viaja — o hash não bate', () => {
    const editado = { ...aprovar(itemIa(1)), reference: 'gabarito trocado depois da revisão' } as LibraryItem;
    expect(editado.state).toBe('aprovado');
    expect(toStageSpec(editado).humanApproval).toBeUndefined();
    // Pelo fluxo (applyItemEdit) o estado volta para `gerado`: idem.
    const pelaEdicao = applyItemEdit(aprovar(itemIa(2)), { reference: 'outra régua' }, { now: NOW });
    expect(pelaEdicao.state).toBe('gerado');
    expect(toStageSpec(pelaEdicao).humanApproval).toBeUndefined();
  });

  it('aprovação sem revisor nomeado (item importado) ainda é aprovação — mesma régua do k de n', () => {
    const { reviewer: _r, ...semRevisor } = aprovar(itemIa(4));
    void _r;
    const spec = toStageSpec(semRevisor as LibraryItem);
    expect(spec.humanApproval?.contentHash).toBe(semRevisor.contentHash);
  });
});

describe('a âncora humana (IMPL-065) aceita item de IA APROVADO', () => {
  const aprovados = (n: number): StageSpec[] => Array.from({ length: n }, (_, i) => toStageSpec(aprovar(itemIa(i))));
  const crus = (n: number): StageSpec[] => Array.from({ length: n }, (_, i) => toStageSpec(itemIa(i)));

  it('isCuratedItem / humanReferenceIndex: aprovado conta; o mesmo item sem aprovação não', () => {
    const [a] = aprovados(1);
    const [c] = crus(1);
    expect(isCuratedItem(a)).toBe(true);
    expect(isCuratedItem(c)).toBe(false);
    expect([...humanReferenceIndex([a, c]).keys()]).toEqual([a.question]);
    // Com índice: o gabarito tem de ser O da config (a run não o trocou).
    const idx = humanReferenceIndex([a]);
    expect(isCuratedItem(a, idx)).toBe(true);
    expect(isCuratedItem({ ...a, reference: 'gabarito que a run gerou' }, idx)).toBe(false);
    // Carimbo sem contentHash não é aprovação.
    expect(isCuratedItem({ ...c, humanApproval: { contentHash: '' } })).toBe(false);
  });

  it('20 itens de IA aprovados DECLARAM campeão; os mesmos 20 sem aprovação não (0 curados)', () => {
    const ok = aprovados(20);
    const dOk = championDeclarationFor(ok, { humanReferences: humanReferenceIndex(ok) });
    expect(dOk).toMatchObject({ declared: true, curatedItems: 20 });
    const cru = crus(20);
    const dCru = championDeclarationFor(cru, { humanReferences: humanReferenceIndex(cru) });
    expect(dCru).toMatchObject({ declared: false, curatedItems: 0, reason: 'sem-ancora-humana' });
  });

  it('os dois motores leem a MESMA régua (fonte única)', () => {
    const ok = aprovados(20);
    expect(webTrainer.championDeclarationFor(ok, { humanReferences: humanReferenceIndex(ok) }).declared).toBe(true);
    expect(webTrainer.isCuratedItem(ok[0])).toBe(true);
  });

  it('demos reais (IMPL-061): item de IA aprovado é demo; sem aprovação, não', () => {
    const [a] = aprovados(1);
    const [c] = crus(1);
    expect(labeledScenariosFrom([a, c]).map((d) => d.question)).toEqual([a.question]);
    // Pelo caminho do treino (índice da config + piso da seleção).
    const treino = aprovados(20);
    expect(trainingLabeledPool(treino, humanReferenceIndex(treino)).length).toBe(20);
  });
});

describe('biblioteca → config da run → declaração (caminho do CLI)', () => {
  let dir = '';
  let anterior = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pb-anchor-'));
    anterior = getDataDir();
    setDataDir(dir);
  });
  afterEach(() => {
    setDataDir(anterior);
    rmSync(dir, { recursive: true, force: true });
  });

  it('scenarios.from library: os customStages levam a aprovação e a sessão pode declarar campeão', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    const itens = Array.from({ length: 22 }, (_, i) => (i < 20 ? aprovar(itemIa(i)) : itemIa(i)));
    await saveItems('curado', itens);
    const arquivo = path.join(dir, 'arena.json');
    writeFileSync(
      arquivo,
      JSON.stringify({
        format: 'arena-config@1',
        mode: 'training',
        theme: 'suporte',
        prompt: { text: 'Você é um atendente.' },
        models: { datagen: 'fake/gen', judges: ['fake/judge'], contestant: 'fake/a', reference: 'fake/ref' },
        variation: { techniques: ['persona', 'constraints'] },
        training: { holdoutRatio: 0 },
        scenarios: { from: 'library', profile: 'curado' },
      }),
    );
    const config = await readConfigFile(arquivo);
    const specs = config.customStages ?? [];
    expect(specs).toHaveLength(22);
    expect(specs.filter((s) => stageHasHumanApproval(s))).toHaveLength(20);
    // O trainer indexa os gabaritos humanos DA CONFIG e conta nas specs da run.
    const d = championDeclarationFor(specs, { humanReferences: humanReferenceIndex(config.customStages) });
    expect(d).toMatchObject({ declared: true, curatedItems: 20 });
  });

  it('o schema da run PRESERVA humanApproval (reprodução/HTTP/MCP) — sem chave desconhecida nem PII', () => {
    const aprovado = toStageSpec(aprovar(itemIa(1)));
    const { id: _id, ...semId } = aprovado;
    void _id;
    const cfg = {
      mode: 'training',
      theme: 't',
      stages: 1,
      datagenModelId: 'fake/gen',
      judgeModelIds: ['fake/judge'],
      referenceModelId: 'fake/ref',
      contestantModelId: 'fake/a',
      techniqueIds: ['persona', 'constraints'],
      iterations: 2,
      customStages: [semId],
    };
    const p = parseRunConfig(cfg);
    expect(p.ok, p.ok ? '' : p.error).toBe(true);
    if (!p.ok) return;
    expect(p.config.customStages?.[0].humanApproval).toEqual(aprovado.humanApproval);
    expect(unknownKeyIssues(cfg, p.config)).toEqual([]);
  });

  it('o pacote de seed (pack@1) não carrega o carimbo — a curadoria sai como perda declarada', async () => {
    await saveProfile({ id: 'curado', name: 'curado' });
    await saveItems('curado', [aprovar(itemIa(1))]);
    const { pack, lostFields } = await exportProfilePackDeclared('curado');
    expect(pack.scenarios[0]).not.toHaveProperty('humanApproval');
    expect(lostFields).toEqual(expect.arrayContaining(['state', 'reviewer', 'contentHash']));
  });
});
