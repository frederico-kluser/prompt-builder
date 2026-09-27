// IMPL-041 (R-16:REC-3) — allowlist LGPD POR ENDPOINT, fail-closed.
//
// Contratos provados aqui (um describe por critério de aceite):
//   (1) o snapshot versionado tem data_geracao ≤ 90 dias e é CONSUMIDO em
//       runtime (Node, SPA, CLI `models allowlist --check`, filtro e pré-voo);
//   (2) deriva: GET /endpoints/zdr SEM o endpoint de um modelo ⇒ o modelo vira
//       bloqueado (na classificação E na run, antes de qualquer LLM);
//   (3) 0 criadores/endpoints desconhecidos liberados em área sensível;
//   (4) as 3 cópias da classificação (src, web, gerador) são UMA só — o teste
//       quebra se alguém reintroduzir uma cópia divergente.
// Zero rede: o gerador e o pipeline rodam com transporte falso.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as core from '../src/engine/lgpdCore.js';
import * as nodeLgpd from '../src/lgpd.js';
import * as webLgpd from '../web/src/lgpd.js';
// @ts-expect-error — script .mjs sem tipos (roda sob tsx; aqui sob vitest)
import { generateAllowlist, reportLines } from '../scripts/gen-lgpd-allowlist.mjs';
import { allowlistCheck, cmdModels } from '../src/cli/commands/models.js';
import { createGateway, setDefaultGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { trainToCompletion as trainNode } from '../src/trainer.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import { startTraining as startWebTraining } from '../web/src/engine/trainer.js';
import { subscribeSession } from '../web/src/engine/events.js';
import type { RunConfig, TrainingConfig } from '../src/types.js';
import { catalogItem, fakeOpenRouter, noSleep, type FakeOpenRouter } from './fakeOpenRouter.js';

// O storage do web é IndexedDB — fora do navegador, um no-op em memória.
vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SNAPSHOT_FILE = join(ROOT, 'src', 'data', 'lgpd-allowlist.generated.json');
const DAY = 86_400_000;
const KEY = 'sk-or-v1-fake-key-para-teste-0000000000';

const BASE: core.LgpdData = { ...nodeLgpd.getLgpdData(), allowlist: null };
const SENSIVEIS = BASE.areas.filter((a) => core.isSensitiveArea(a.id, BASE)).map((a) => a.id);

// --- fixture: catálogo e endpoints ZDR SINTÉTICOS ---------------------------

const MODELOS_FAKE = [
  'mistralai/mistral-large', // família UE (saúde: com ressalvas; jurídico: permitido)
  'anthropic/claude-x', // família EUA
  'nvidia/nemotron', // criador mapeado (EUA) sem família → heurística ocidental
  'desconhecida/modelo-x', // criador DESCONHECIDO (antes: fail-open via defaults_ocidental)
  'deepseek/deepseek-v4', // família China → não recomendado
  'openai/gpt-novo', // só endpoint de provedor FORA do mapa
  'google/gemini-y', // só endpoint de provedor de jurisdição restrita (SG)
  'meta-llama/llama-z', // nenhum endpoint ZDR
];

type ZdrRow = { model_id: string; provider_name: string; tag: string; supports_implicit_caching?: boolean };

const ZDR_FAKE: ZdrRow[] = [
  { model_id: 'mistralai/mistral-large', provider_name: 'Mistral', tag: 'mistral/eu' },
  { model_id: 'mistralai/mistral-large', provider_name: 'Mistral', tag: 'mistral/eu' }, // repetido (faixa de preço)
  { model_id: 'anthropic/claude-x', provider_name: 'Amazon Bedrock', tag: 'amazon-bedrock/us' },
  { model_id: 'anthropic/claude-x', provider_name: 'Google', tag: 'google-vertex/global' },
  { model_id: 'nvidia/nemotron', provider_name: 'DeepInfra', tag: 'deepinfra/bf16' },
  { model_id: 'desconhecida/modelo-x', provider_name: 'DeepInfra', tag: 'deepinfra' },
  { model_id: 'deepseek/deepseek-v4', provider_name: 'DeepInfra', tag: 'deepinfra/fp8' },
  { model_id: 'openai/gpt-novo', provider_name: 'ProvedorNovo', tag: 'provedor-novo' },
  { model_id: 'google/gemini-y', provider_name: 'SiliconFlow', tag: 'siliconflow' },
  { model_id: 'fora/do-catalogo', provider_name: 'DeepInfra', tag: 'deepinfra' },
];

const payloadModels = (ids: string[]) => ({ data: ids.map((id) => ({ id, name: id })) });

function snapshotDe(zdr: ZdrRow[], ids = MODELOS_FAKE, now: Date | number = Date.now()): core.LgpdAllowlistSnapshot {
  return core.buildAllowlistSnapshot({ models: payloadModels(ids), zdr: { data: zdr }, now, fonte: 'teste' });
}

const dataCom = (snap: core.LgpdAllowlistSnapshot | null): core.LgpdData => ({ ...BASE, allowlist: snap });

/** fetch falso para os DOIS endpoints públicos que o gerador consulta. */
function fetchFalso(ids: string[], zdr: ZdrRow[]) {
  const urls: string[] = [];
  const fn = async (url: string): Promise<Response> => {
    urls.push(url);
    const body = url.endsWith('/endpoints/zdr') ? { data: zdr } : url.endsWith('/models') ? payloadModels(ids) : null;
    if (!body) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fn, urls };
}

// ---------------------------------------------------------------------------
// (1) snapshot versionado: fresco e consumido em runtime
// ---------------------------------------------------------------------------

describe('IMPL-041 (1) — snapshot regenerado (≤ 90 dias) e consumido em runtime', () => {
  const arquivo = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf-8')) as core.LgpdAllowlistSnapshot;

  it('o snapshot versionado está no formato atual e tem data_geracao ≤ 90 dias (regenere: npm run lgpd:allowlist)', () => {
    expect(arquivo.format).toBe(core.ALLOWLIST_FORMAT);
    const h = core.allowlistHealth(arquivo);
    expect(h.usable, h.message).toBe(true);
    expect(h.ageDays).toBeGreaterThanOrEqual(0);
    expect(h.ageDays!).toBeLessThanOrEqual(core.ALLOWLIST_MAX_AGE_DAYS);
    expect(arquivo.validade_dias).toBeLessThanOrEqual(core.ALLOWLIST_MAX_AGE_DAYS);
    // Derivado do catálogo inteiro (não de um recorte): todo modelo tem chave.
    expect(Object.keys(arquivo.modelos).length).toBe(arquivo.total_modelos_catalogo);
    expect(h.modelosComZdr).toBeGreaterThan(0);
    // Serialização estável: regenerar o mesmo conteúdo dá o mesmo arquivo.
    expect(core.serializeAllowlistSnapshot(arquivo)).toBe(readFileSync(SNAPSHOT_FILE, 'utf-8'));
  });

  it('Node (CLI/servidor) e SPA carregam o MESMO snapshot junto da base', async () => {
    const node = nodeLgpd.getLgpdData();
    const web = await webLgpd.loadLgpdData();
    expect(node.allowlist?.data_geracao).toBe(arquivo.data_geracao);
    expect(web.allowlist?.data_geracao).toBe(arquivo.data_geracao);
    expect(Object.keys(web.allowlist!.modelos)).toEqual(Object.keys(node.allowlist!.modelos));
    // A SPA lê a base de src/data (sem cópia em web/src/data).
    expect(web.areas).toEqual(node.areas);
    expect(web.providers).toEqual(node.providers);
  });

  it('o filtro de área sensível usa os endpoints do snapshot (liberado ⇒ com a lista p/ provider.only)', () => {
    const data = nodeLgpd.getLgpdData();
    const ids = Object.keys(data.allowlist!.modelos);
    const { allowed, blockedIds, reasons } = nodeLgpd.filterModels(ids.map((id) => ({ id })), 'saude', true, data);
    expect(allowed.length).toBeGreaterThan(0);
    for (const { id } of allowed) {
      const p = nodeLgpd.permissionOf(id, 'saude', data);
      expect(p.endpoints?.length, id).toBeGreaterThan(0);
      const tags = new Set(data.allowlist!.modelos[id].map((e) => e.tag));
      for (const ep of p.endpoints!) expect(tags.has(ep.tag)).toBe(true);
    }
    // Todo modelo SEM endpoint ZDR no snapshot está bloqueado com esse motivo
    // (ou um motivo anterior: criador desconhecido / não recomendado).
    for (const id of ids.filter((i) => data.allowlist!.modelos[i].length === 0)) {
      expect(blockedIds.has(id), id).toBe(true);
      expect(['sem_endpoint_zdr', 'criador_desconhecido', 'nao_recomendado']).toContain(reasons.get(id));
    }
  });

  it('`models allowlist --check` reporta idade e contagem do snapshot do pacote (sem key, sem rede)', async () => {
    const r = allowlistCheck(nodeLgpd.getLgpdData());
    expect(r.ok, r.failures.join('; ')).toBe(true);
    expect(r.data.dataGeracao).toBe(arquivo.data_geracao);
    expect(r.data.ageDays).toBeLessThanOrEqual(90);
    expect((r.data.counts as { modelos: number }).modelos).toBe(arquivo.total_modelos_catalogo);
    expect(r.data.desconhecidosLiberados).toBe(0);
    expect(r.lines.join('\n')).toMatch(/gerada em \d{4}-\d{2}-\d{2}/);

    // O comando de verdade: --json no stdout, exit 0.
    const tmp = mkdtempSync(join(tmpdir(), 'pb-lgpd-cli-'));
    const dirAnterior = getDataDir();
    const saida: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      saida.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    try {
      const code = await cmdModels(['allowlist', '--check', '--json', '--data-dir', tmp]);
      expect(code).toBe(0);
    } finally {
      spy.mockRestore();
      setDataDir(dirAnterior);
      rmSync(tmp, { recursive: true, force: true });
    }
    const obj = JSON.parse(saida.join('')) as { ok: boolean; command: string; data: Record<string, unknown> };
    expect(obj.ok).toBe(true);
    expect(obj.command).toBe('models.allowlist');
    expect(obj.data.dataGeracao).toBe(arquivo.data_geracao);
    expect((obj.data.counts as { modelos: number }).modelos).toBe(arquivo.total_modelos_catalogo);
  });

  it('`--check` reprova snapshot vencido, idade acima de --max-age e snapshot ausente (exit 3 no CLI)', () => {
    const snap = snapshotDe(ZDR_FAKE, MODELOS_FAKE, Date.UTC(2026, 0, 1));
    const venceu = allowlistCheck(dataCom(snap), { now: Date.UTC(2026, 0, 1) + 91 * DAY });
    expect(venceu.ok).toBe(false);
    expect(venceu.data.state).toBe('vencida');
    const velho = allowlistCheck(dataCom(snap), { now: Date.UTC(2026, 0, 1) + 31 * DAY, maxAgeDays: 30 });
    expect(velho.ok).toBe(false);
    expect(velho.data.state).toBe('desatualizada'); // ainda usável, mas a porta de CI reprova
    expect(allowlistCheck(dataCom(null)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (2) deriva: endpoint some da lista ZDR ⇒ modelo bloqueado
// ---------------------------------------------------------------------------

describe('IMPL-041 (2) — deriva do GET /endpoints/zdr', () => {
  const semMistral = ZDR_FAKE.filter((r) => r.model_id !== 'mistralai/mistral-large');

  it('sem o endpoint na lista ZDR, o modelo antes liberado vira BLOQUEADO', () => {
    const antes = dataCom(snapshotDe(ZDR_FAKE));
    const depois = dataCom(snapshotDe(semMistral));
    for (const area of SENSIVEIS) {
      const pa = core.permissionOf('mistralai/mistral-large', area, antes);
      expect(pa.status, area).not.toBe('não recomendado');
      expect(pa.endpoints?.map((e) => e.tag)).toEqual(['mistral/eu']); // deduplicado
      const pd = core.permissionOf('mistralai/mistral-large', area, depois);
      expect(pd.status, area).toBe('não recomendado');
      expect(pd.motivo).toBe('sem_endpoint_zdr');
    }
    expect(core.sensitiveRoute('mistralai/mistral-large', 'saude', antes)).toMatchObject({ ok: true, only: ['mistral/eu'] });
    expect(core.sensitiveRoute('mistralai/mistral-large', 'saude', depois)).toMatchObject({ ok: false, motivo: 'sem_endpoint_zdr' });
  });

  it('pelo GERADOR real (fetch falso): regenerar sem o endpoint bloqueia o modelo', async () => {
    const a = fetchFalso(MODELOS_FAKE, ZDR_FAKE);
    const b = fetchFalso(MODELOS_FAKE, semMistral);
    const snapA = (await generateAllowlist({ baseUrl: 'https://fake.test/api/v1/', fetchImpl: a.fn })) as core.LgpdAllowlistSnapshot;
    const snapB = (await generateAllowlist({ baseUrl: 'https://fake.test/api/v1', fetchImpl: b.fn })) as core.LgpdAllowlistSnapshot;
    expect(a.urls.sort()).toEqual(['https://fake.test/api/v1/endpoints/zdr', 'https://fake.test/api/v1/models']);
    expect(core.isAllowed('mistralai/mistral-large', 'saude', true, dataCom(snapA))).toBe(true);
    expect(core.isAllowed('mistralai/mistral-large', 'saude', true, dataCom(snapB))).toBe(false);
    expect(snapB.modelos['mistralai/mistral-large']).toEqual([]); // conhecido, sem ZDR
    expect(snapA.endpoints_zdr_fora_do_catalogo).toBe(1);
  });

  it('modelo que surgiu DEPOIS da geração (fora do snapshot) é desconhecido ⇒ bloqueado', () => {
    const data = dataCom(snapshotDe(ZDR_FAKE));
    const p = core.permissionOf('mistralai/mistral-novo', 'saude', data);
    expect(p.status).toBe('não recomendado');
    expect(p.motivo).toBe('modelo_desconhecido');
  });

  it('o pré-voo da run recusa o papel cujo endpoint sumiu, nomeando papel e modelo', () => {
    const cfg: core.ComplianceConfigLike = {
      compliance: { area: 'saude', includeRessalvas: true },
      competitorModelIds: ['mistralai/mistral-large', 'anthropic/claude-x'],
      judgeModelIds: ['anthropic/claude-x'],
      datagenModelId: 'anthropic/claude-x',
    };
    expect(core.checkRunCompliance(cfg, dataCom(snapshotDe(ZDR_FAKE))).violations).toEqual([]);
    const chk = core.checkRunCompliance(cfg, dataCom(snapshotDe(semMistral)));
    expect(chk.violations).toEqual([
      expect.objectContaining({ role: 'competitor', modelId: 'mistralai/mistral-large', motivo: 'sem_endpoint_zdr' }),
    ]);
    let erro: unknown;
    try {
      core.assertRunCompliance(cfg, dataCom(snapshotDe(semMistral)));
    } catch (err) {
      erro = err;
    }
    expect(core.isLgpdPolicyError(erro)).toBe(true); // reconhecido sem instanceof
    expect((erro as Error).message).toContain('competidor mistralai/mistral-large');
  });
});

// ---------------------------------------------------------------------------
// (3) desconhecido ⇒ bloqueado
// ---------------------------------------------------------------------------

describe('IMPL-041 (3) — 0 criadores/endpoints desconhecidos liberados em área sensível', () => {
  const data = dataCom(snapshotDe(ZDR_FAKE));

  it('toda área sensível da base é marcada; "geral" é a única consultiva', () => {
    expect(SENSIVEIS.length).toBeGreaterThanOrEqual(5);
    expect(core.isSensitiveArea('geral', BASE)).toBe(false);
    expect(core.isSensitiveArea(core.AREA_LIVRE, BASE)).toBe(false);
    // Área sem o campo `sensivel` ou fora da base ⇒ sensível (fail-closed).
    const semCampo = { ...BASE, areas: BASE.areas.map((a) => ({ ...a, sensivel: undefined })) };
    expect(core.isSensitiveArea('geral', semCampo)).toBe(true);
    expect(core.isSensitiveArea('area-inventada', BASE)).toBe(true);
  });

  it.each(SENSIVEIS)('%s: criador desconhecido, provedor fora do mapa, jurisdição restrita e modelo sem ZDR ficam de fora', (area) => {
    const motivo = (id: string) => core.permissionOf(id, area, data).motivo;
    // Regressão do fail-open: antes 'desconhecida/*' herdava "permitido com ressalvas".
    expect(core.statusFor('desconhecida/modelo-x', area, data)).toBe('não recomendado');
    expect(motivo('desconhecida/modelo-x')).toBe('criador_desconhecido');
    expect(motivo('openai/gpt-novo')).toBe('sem_endpoint_zdr'); // provedor novo, não mapeado
    expect(motivo('google/gemini-y')).toBe('sem_endpoint_zdr'); // só endpoint SG
    expect(motivo('meta-llama/llama-z')).toBe('sem_endpoint_zdr');
    expect(motivo('deepseek/deepseek-v4')).toBe('nao_recomendado');
    // Os conhecidos com endpoint elegível passam (com ressalvas no rigor frouxo).
    expect(core.isAllowed('anthropic/claude-x', area, true, data)).toBe(true);
    expect(core.permissionOf('nvidia/nemotron', area, data).endpoints?.map((e) => e.tag)).toEqual(['deepinfra/bf16']);
  });

  it('exclusão por endpoint explica o porquê (provedor desconhecido / restrito / treina / origem indefinida)', () => {
    const ep = (provider: string) => ({ tag: 'x', provider });
    expect(core.endpointExclusion(ep('ProvedorNovo'), BASE)).toBe('provedor_desconhecido');
    expect(core.endpointExclusion(ep('SiliconFlow'), BASE)).toBe('provedor_origem_restrita');
    expect(core.endpointExclusion(ep('NextBit'), BASE)).toBe('provedor_origem_indefinida');
    const treina = { ...BASE, providers: { ...BASE.providers, Treinador: { origem: 'EUA', zdr: true, treina: true } } };
    expect(core.endpointExclusion(ep('Treinador'), treina)).toBe('provedor_treina');
    expect(core.endpointExclusion(ep('Mistral'), BASE)).toBeNull();
  });

  it('snapshot ausente, vencido, inválido ou do futuro ⇒ TODA área sensível bloqueada; "geral" segue consultiva', () => {
    const gerado = Date.UTC(2026, 5, 1);
    const snap = snapshotDe(ZDR_FAKE, MODELOS_FAKE, gerado);
    const casos: Array<[string, core.LgpdData, number, core.LgpdBlockReason]> = [
      ['ausente', dataCom(null), gerado, 'allowlist_ausente'],
      ['vencido (91 dias)', dataCom(snap), gerado + 91 * DAY, 'allowlist_vencida'],
      ['formato desconhecido', dataCom({ ...snap, format: 'prompt-builder-lgpd-allowlist@1' }), gerado, 'allowlist_invalida'],
      ['data inválida', dataCom({ ...snap, data_geracao: '2026-02-31' }), gerado, 'allowlist_invalida'],
      ['gerado no futuro', dataCom(snap), gerado - 5 * DAY, 'allowlist_invalida'],
      // O arquivo pode ENCURTAR a validade, nunca estender além de 90.
      ['validade_dias=365 não estende', dataCom({ ...snap, validade_dias: 365 }), gerado + 91 * DAY, 'allowlist_vencida'],
      ['validade_dias=10 encurta', dataCom({ ...snap, validade_dias: 10 }), gerado + 11 * DAY, 'allowlist_vencida'],
    ];
    for (const [nome, d, now, motivo] of casos) {
      for (const area of SENSIVEIS) {
        const p = core.permissionOf('anthropic/claude-x', area, d, now);
        expect(p.status, `${nome}/${area}`).toBe('não recomendado');
        expect(p.motivo, `${nome}/${area}`).toBe(motivo);
      }
      expect(core.statusFor('anthropic/claude-x', 'geral', d, now), nome).toBe('permitido');
    }
    // Dentro da validade (89 dias) ainda libera.
    expect(core.isAllowed('anthropic/claude-x', 'saude', true, dataCom(snap), gerado + 89 * DAY)).toBe(true);
  });

  it('área desconhecida na run é recusada (não cai em "livre")', () => {
    const chk = core.checkRunCompliance(
      { compliance: { area: 'area-inventada', includeRessalvas: true }, competitorModelIds: ['anthropic/claude-x'] },
      data,
    );
    expect(chk.violations).toEqual([expect.objectContaining({ role: 'config', motivo: 'area_desconhecida' })]);
  });

  it('snapshot REAL do pacote: desconhecidos_liberados = 0 em toda área sensível', () => {
    const rep = core.allowlistReport(nodeLgpd.getLgpdData());
    expect(rep.health.usable).toBe(true);
    for (const area of SENSIVEIS) {
      expect(rep.porArea[area].sensivel).toBe(true);
      expect(rep.porArea[area].desconhecidos_liberados, area).toBe(0);
      expect(rep.porArea[area].permitidos + rep.porArea[area].com_ressalvas, area).toBeGreaterThan(0);
    }
    // Recontagem independente sobre o catálogo inteiro do snapshot.
    const real = nodeLgpd.getLgpdData();
    for (const id of Object.keys(real.allowlist!.modelos)) {
      for (const area of SENSIVEIS) {
        const p = core.permissionOf(id, area, real);
        if (p.status === 'não recomendado') continue;
        expect(core.isKnownCreator(id, real), `${id}/${area}`).toBe(true);
        expect(p.endpoints?.length, `${id}/${area}`).toBeGreaterThan(0);
        for (const ep of p.endpoints!) {
          expect(real.providers[ep.provider], `${id}/${area}: ${ep.provider}`).toBeDefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (4) fonte única: as três cópias viraram uma
// ---------------------------------------------------------------------------

describe('IMPL-041 (4) — classificação única (src × web × gerador)', () => {
  const FUNCOES = [
    'creatorPrefix',
    'familiaFor',
    'originFor',
    'isKnownCreator',
    'isSensitiveArea',
    'allowlistHealth',
    'endpointExclusion',
    'permissionOf',
    'statusFor',
    'statusAllowed',
    'filterModels',
    'isAllowed',
    'sensitiveRoute',
    'runModelRoles',
    'checkRunCompliance',
    'assertRunCompliance',
    'buildAllowlistSnapshot',
    'serializeAllowlistSnapshot',
    'allowlistReport',
  ] as const;

  it('src/lgpd.ts e web/src/lgpd.ts exportam as MESMAS funções do núcleo (objeto idêntico)', () => {
    const c = core as unknown as Record<string, unknown>;
    const n = nodeLgpd as unknown as Record<string, unknown>;
    const w = webLgpd as unknown as Record<string, unknown>;
    for (const fn of FUNCOES) {
      expect(typeof c[fn], fn).toBe('function');
      expect(n[fn], `src/lgpd.${fn}`).toBe(c[fn]);
      expect(w[fn], `web/src/lgpd.${fn}`).toBe(c[fn]);
    }
  });

  it('o gerador NÃO reimplementa a classificação: importa o núcleo e produz o mesmo snapshot', async () => {
    const fonte = readFileSync(join(ROOT, 'scripts', 'gen-lgpd-allowlist.mjs'), 'utf-8');
    expect(fonte).toContain("from '../src/engine/lgpdCore.ts'");
    for (const proibido of ['creators_origem', 'areas_permitidas', 'defaults_ocidental', 'prefixos', 'function statusFor', 'EU_PATTERNS']) {
      expect(fonte, `gerador voltou a classificar (${proibido})`).not.toContain(proibido);
    }
    const now = Date.UTC(2026, 8, 1);
    const f = fetchFalso(MODELOS_FAKE, ZDR_FAKE);
    const doScript = await generateAllowlist({ baseUrl: 'https://fake.test/api/v1', fetchImpl: f.fn, now });
    const doNucleo = core.buildAllowlistSnapshot({
      models: payloadModels(MODELOS_FAKE),
      zdr: { data: ZDR_FAKE },
      now,
      fonte: 'https://fake.test/api/v1/models + https://fake.test/api/v1/endpoints/zdr (públicos)',
    });
    expect(doScript).toEqual(doNucleo);
    // O relatório do gerador é o mesmo do `--check` (allowlistReport).
    const linhas = (reportLines(doScript, BASE, now) as string[]).join('\n');
    expect(linhas).toContain('desconhecidos_liberados=0');
    expect(linhas).toContain('ProvedorNovo');
  });

  it('Node e SPA classificam o catálogo inteiro do snapshot de forma idêntica (área × modelo)', async () => {
    const node = nodeLgpd.getLgpdData();
    const web = await webLgpd.loadLgpdData();
    const ids = Object.keys(node.allowlist!.modelos);
    const now = Date.now();
    for (const area of [...BASE.areas.map((a) => a.id), core.AREA_LIVRE]) {
      const a = ids.map((id) => nodeLgpd.permissionOf(id, area, node, now));
      const b = ids.map((id) => webLgpd.permissionOf(id, area, web, now));
      expect(b, area).toEqual(a);
    }
  });

  it('não há cópia da base nem do snapshot no web; o núcleo não tem import nenhum (roda em Node, tsx e navegador)', () => {
    expect(existsSync(join(ROOT, 'web', 'src', 'data', 'lgpd-compliance.json'))).toBe(false);
    const naWeb = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? naWeb(join(dir, e.name)) : /lgpd.*\.json$/.test(e.name) ? [join(dir, e.name)] : [],
      );
    expect(naWeb(join(ROOT, 'web', 'src'))).toEqual([]);
    const nucleo = readFileSync(join(ROOT, 'src', 'engine', 'lgpdCore.ts'), 'utf-8');
    const semComentarios = nucleo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(semComentarios).not.toMatch(/^\s*import\s/m);
    expect(semComentarios).not.toMatch(/process\.env|node:/);
    // Sem sintaxe que o strip de tipos do Node não apaga (o gerador roda sem build).
    expect(semComentarios).not.toMatch(/\benum\s|constructor\(\s*(?:readonly|private|public|protected)\s/);
  });
});

// ---------------------------------------------------------------------------
// Runtime fail-closed: o pré-voo roda ANTES de qualquer chamada de LLM
// ---------------------------------------------------------------------------

const CENARIOS = [
  {
    question: 'Qual o prazo para remarcar uma consulta?',
    productContext: 'Politica: remarcacao gratuita ate 24h antes.',
    maxTokens: 300,
    rubric: 'Deve citar 24h.',
  },
  {
    question: 'Posso levar acompanhante no exame?',
    productContext: 'Um acompanhante por paciente.',
    maxTokens: 300,
    rubric: 'Deve citar um acompanhante.',
  },
];

// Criadores CONHECIDOS (família mistral/anthropic) p/ o caminho liberado.
const M = {
  gen: 'mistralai/gen',
  ref: 'mistralai/ref',
  judge: 'anthropic/judge',
  a: 'mistralai/a',
  b: 'anthropic/b',
  opt: 'mistralai/opt',
};

function fakePipeline(): FakeOpenRouter {
  return fakeOpenRouter({
    catalog: Object.values(M).map((id) => catalogItem(id, 1e-6, 1e-6)),
    chat: (req, n) => {
      const usage = { prompt_tokens: 50, completion_tokens: 10, cost: 0.0001 * (n + 1) };
      if (req.model === M.gen) return { text: JSON.stringify({ stages: CENARIOS }), usage };
      if (req.model === M.opt) {
        return {
          text: 'Voce e um atendente cordial e preciso. Responda com base no contexto, cite prazos exatamente e recuse o que estiver fora do escopo.',
          usage,
        };
      }
      if (req.model === M.ref) return { text: `Gabarito: ${req.user.slice(0, 40)}`, usage };
      if (req.stream) return { text: `Resposta de ${req.model}`, usage };
      if (req.system.includes('DUELO')) return { text: '{"winner":"A","explanation":"A melhor"}', usage };
      return { text: '{"verdict":"resolve","explanation":"confere"}', usage };
    },
  });
}

/** Snapshot sintético: os 6 modelos com endpoint ZDR de provedor mapeado. */
function dadosLiberando(semEndpointDe?: string, geradoEm: number = Date.now()): core.LgpdData {
  const zdr: ZdrRow[] = Object.values(M)
    .filter((id) => id !== semEndpointDe)
    .map((id) => ({
      model_id: id,
      provider_name: id.startsWith('mistralai/') ? 'Mistral' : 'Amazon Bedrock',
      tag: id.startsWith('mistralai/') ? 'mistral/eu' : 'amazon-bedrock/us',
    }));
  return dataCom(snapshotDe(zdr, Object.values(M), geradoEm));
}

const COMPARE_SAUDE = {
  mode: 'compare',
  theme: 'agendamento de exames',
  stages: 2,
  datagenModelId: M.gen,
  judgeModelIds: [M.judge],
  referenceModelId: M.ref,
  referenceJudging: true,
  competitorModelIds: [M.a, M.b],
  finalists: 2,
  timeoutMs: 5_000,
  compliance: { area: 'saude', includeRessalvas: true },
} as const;

describe('IMPL-041 — runtime fail-closed nos dois motores (pré-voo antes de qualquer LLM)', () => {
  let tmp: string;
  let dirAnterior: string;
  let silencio: Array<{ mockRestore(): void }> = [];
  const restaurar: Array<() => void> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-impl041-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio = [
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    ];
  });
  afterEach(() => {
    while (restaurar.length) restaurar.pop()!();
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Injeta os dados LGPD nos DOIS loaders (Node e SPA) e o gateway falso. */
  function comDados(data: core.LgpdData): FakeOpenRouter {
    restaurar.push(nodeLgpd.overrideLgpdData(data), webLgpd.overrideLgpdData(data));
    const fake = fakePipeline();
    const anterior = setDefaultGateway(createGateway({ fetch: fake.fetch, sleep: noSleep }));
    restaurar.push(() => setDefaultGateway(anterior));
    return fake;
  }

  it('Node: com os endpoints na allowlist a run sensível roda normalmente', async () => {
    const fake = comDados(dadosLiberando());
    const rec = await runNode(COMPARE_SAUDE as unknown as RunConfig, KEY, {});
    expect(rec.status, rec.error).toBe('finished');
    expect(fake.chatRequests().length).toBeGreaterThan(0);
  });

  it('Node: endpoint do competidor fora da allowlist ⇒ run recusada, ZERO chamadas de LLM', async () => {
    const fake = comDados(dadosLiberando(M.a));
    const rec = await runNode(COMPARE_SAUDE as unknown as RunConfig, KEY, {});
    expect(rec.status).toBe('error');
    expect(rec.error).toMatch(/LGPD.*competidor mistralai\/a.*sem endpoint ZDR/);
    expect(fake.chatRequests()).toEqual([]);
  });

  it('Node: juiz (papel que NÃO passa pelo filtro dos participantes) também é checado', async () => {
    const fake = comDados(dadosLiberando(M.judge));
    const rec = await runNode(COMPARE_SAUDE as unknown as RunConfig, KEY, {});
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('juiz anthropic/judge');
    expect(fake.chatRequests()).toEqual([]);
  });

  it('Node: snapshot vencido bloqueia a run sensível inteira; área "geral" (consultiva) segue', async () => {
    const velho = dadosLiberando(undefined, Date.now() - 120 * DAY);
    const fake = comDados(velho);
    const rec = await runNode(COMPARE_SAUDE as unknown as RunConfig, KEY, {});
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('vencida');
    expect(fake.chatRequests()).toEqual([]);
    const geral = await runNode(
      { ...COMPARE_SAUDE, compliance: { area: 'geral', includeRessalvas: true } } as unknown as RunConfig,
      KEY,
      {},
    );
    expect(geral.status, geral.error).toBe('finished');
  });

  it('SPA: mesmo pré-voo no motor client-side (liberado roda; fora da allowlist recusa sem LLM)', async () => {
    const ok = comDados(dadosLiberando());
    const recOk = await runWeb(COMPARE_SAUDE as never, KEY, {});
    expect(recOk.status, recOk.error).toBe('finished');
    expect(ok.chatRequests().length).toBeGreaterThan(0);
    while (restaurar.length) restaurar.pop()!();

    const fake = comDados(dadosLiberando(M.gen));
    const rec = await runWeb(COMPARE_SAUDE as never, KEY, {});
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('gerador mistralai/gen');
    expect(fake.chatRequests()).toEqual([]);
  });

  const TREINO_SAUDE = {
    mode: 'training',
    theme: 'agendamento de exames',
    stages: 2,
    datagenModelId: M.gen,
    judgeModelIds: [M.judge],
    referenceModelId: M.ref,
    referenceJudging: true,
    contestantModelId: M.a,
    basePrompt: 'Voce e um atendente. Responda com base no contexto do produto.',
    techniqueIds: ['persona', 'constraints'],
    promptOptimization: true,
    optimizerModelId: M.opt,
    iterations: 1,
    holdoutRatio: 0,
    finalists: 2,
    timeoutMs: 5_000,
    compliance: { area: 'saude', includeRessalvas: true },
  } as const;

  it('treino (Node): reescritor fora da allowlist ⇒ sessão recusada antes da iteração 0', async () => {
    const fake = comDados(dadosLiberando(M.opt));
    const rec = await trainNode(TREINO_SAUDE as unknown as TrainingConfig, KEY);
    expect(rec.status).toBe('error');
    expect(rec.error).toContain('reescritor mistralai/opt');
    expect(fake.chatRequests()).toEqual([]);
  });

  it('treino (SPA): mesmo pré-voo no trainer client-side', async () => {
    const fake = comDados(dadosLiberando(M.opt));
    const { sessionId, record } = await startWebTraining(TREINO_SAUDE as never, KEY);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('sessão não terminou')), 10_000);
      const fim = (): void => {
        clearTimeout(t);
        unsub();
        resolve();
      };
      const unsub = subscribeSession(sessionId, (e) => {
        if (e.type === 'session.finished' || e.type === 'session.error') fim();
      });
      if (record.status !== 'running') fim();
    });
    expect(record.status).toBe('error');
    expect(record.error).toContain('reescritor mistralai/opt');
    expect(fake.chatRequests()).toEqual([]);
  });
});
