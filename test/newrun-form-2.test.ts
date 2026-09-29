// Onda 2 — cluster web-form-2 (Nova Run): as regras PURAS que a tela usa e o
// que os dois motores gravam por causa delas.
//
//  web-live#5  o treino default (5 cenários) quase nunca promovia: o gate da
//              melhor de K (IMPL-002) é um max-T por troca de sinais EXATA e o
//              menor p ajustado possível com n cenários de treino é 1/2ⁿ. Com 5,
//              um único empate já dá 0,0625 > α (medido na auditoria: +50 p.p.
//              em todos os cenários e 0 promoções). A regra fica amarrada ao
//              `bestOfKTest` REAL — se o gate mudar, este teste acusa.
//  web-live#10 comparando modelos (sem gabarito) o motor avisava que "a
//              referência escreve o gabarito" — papel que ninguém exerceu.
//  IMPL-056    `languages` virou campo da tela: texto ⇄ lista com a MESMA
//              regra do CLI e dos schemas (Node e arena-config@1).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bestOfKTest, GATE_ALPHA } from '../src/engine/bestOfK.js';
import { HOLDOUT_RATIO_DEFAULT } from '../src/holdout.js';
import { runConfigSchema } from '../src/runConfigSchema.js';
import { parseArenaConfig as parseArenaNode } from '../src/configFile.js';
import { parseArenaConfig as parseArenaWeb } from '../web/src/engine/configFile';
import { createGateway, setDefaultGateway, type OpenRouterGateway } from '../src/openrouter.js';
import { getDataDir, setDataDir } from '../src/storage.js';
import { runToCompletion as runNode } from '../src/orchestrator.js';
import { runToCompletion as runWeb } from '../web/src/engine/orchestrator.js';
import type { RunConfig, RunRecord } from '../src/types.js';
import {
  ARENA_FIELD_HANDLING,
  MAX_LANGUAGES,
  TRAINING_DEFAULT_STAGES,
  TRAINING_RECOMMENDED_STAGES,
  applyArenaConfigToForm,
  defaultArenaFormState,
  exportArenaConfig,
  formatLanguages,
  minAchievablePAdjusted,
  minScenariosForPromotion,
  parseLanguages,
  stagesForModeChange,
  trainingGateScenarios,
  trainingPowerNotice,
} from '../web/src/arenaForm';
import { catalogItem, fakeOpenRouter, noSleep } from './fakeOpenRouter.js';
import { duelReply, listwiseReply, pointwiseReply } from './judgeReplies.js';

vi.mock('../web/src/engine/storage', () => ({
  saveRun: async () => undefined,
  saveSession: async () => undefined,
  loadRun: async () => null,
  loadSession: async () => null,
  listRuns: async () => [],
  listSessions: async () => [],
}));

const ROOT = process.cwd();

/* ================================================================ web-live#5 */

/** Régua em 0; K variantes; `vence` = a melhor vence em cada cenário. */
function gate(n: number, opts: { empatesTotais?: number } = {}) {
  const empates = opts.empatesTotais ?? 0;
  // Cenário empatado em TODAS (régua e variantes com a mesma nota).
  const control = Array.from({ length: n }, (_, i) => (i < empates ? 1 : 0));
  const vence = Array.from({ length: n }, () => 1);
  const meia = control.map((c, i) => (i < empates ? 1 : 0.5));
  return bestOfKTest(control, [vence, meia, meia, control]);
}

describe('web-live#5 — poder do gate de promoção do treino (amarrado ao bestOfKTest real)', () => {
  it('1/2ⁿ é o menor p ajustado que o gate dá (todas as variantes vencendo tudo)', () => {
    for (let n = 3; n <= 10; n += 1) {
      expect(Math.min(...gate(n).pAdjusted), `n=${n}`).toBeCloseTo(minAchievablePAdjusted(n), 12);
    }
  });

  it('o caso da auditoria: 5 cenários + 1 empate total → p ajustado 0,0625 > α (segura)', () => {
    expect(Math.min(...gate(5, { empatesTotais: 1 }).pAdjusted)).toBeCloseTo(0.0625, 12);
    expect(0.0625).toBeGreaterThan(GATE_ALPHA);
    // Sem nenhum empate, 5 ainda promove (1/32) — e 4 nunca (1/16).
    expect(Math.min(...gate(5).pAdjusted)).toBeLessThanOrEqual(GATE_ALPHA);
    expect(Math.min(...gate(4).pAdjusted)).toBeGreaterThan(GATE_ALPHA);
  });

  it('minScenariosForPromotion = o menor n com 1/2ⁿ ≤ α (5 para α = 0,05)', () => {
    const n = minScenariosForPromotion();
    expect(n).toBe(5);
    expect(minAchievablePAdjusted(n)).toBeLessThanOrEqual(GATE_ALPHA);
    expect(minAchievablePAdjusted(n - 1)).toBeGreaterThan(GATE_ALPHA);
    expect(minScenariosForPromotion(0.01)).toBe(7);
  });

  it('o gate vê os cenários de TREINO: o holdout só sai com o piso (≥ 20 no total)', () => {
    expect(trainingGateScenarios(10, HOLDOUT_RATIO_DEFAULT)).toBe(10);
    expect(trainingGateScenarios(19, HOLDOUT_RATIO_DEFAULT)).toBe(19); // fatia de 9 = confirmação fraca: tudo treina
    expect(trainingGateScenarios(20, HOLDOUT_RATIO_DEFAULT)).toBe(10);
    expect(trainingGateScenarios(30, HOLDOUT_RATIO_DEFAULT)).toBe(20);
    expect(trainingGateScenarios(30, 0)).toBe(30);
  });

  it('aviso: 4 trava; 5 só vencendo TODOS; 6–7 uma derrota segura; ≥ 8 silencia', () => {
    const quatro = trainingPowerNotice(4, HOLDOUT_RATIO_DEFAULT);
    expect(quatro).toMatchObject({ blocking: true, gateScenarios: 4 });
    expect(quatro!.text).toMatch(/não consegue promover nenhuma variante: o menor p ajustado possível é 0,0625 \(> 0,05\)/);

    const cinco = trainingPowerNotice(5, HOLDOUT_RATIO_DEFAULT);
    expect(cinco).toMatchObject({ blocking: false, gateScenarios: 5 });
    expect(cinco!.text).toMatch(/só é promovida se vencer em TODOS: um único empate ou derrota/);

    for (const n of [6, 7]) {
      const aviso = trainingPowerNotice(n, HOLDOUT_RATIO_DEFAULT);
      expect(aviso, `n=${n}`).toMatchObject({ blocking: false });
      expect(aviso!.text).toMatch(/uma única derrota da variante costuma bastar/);
    }
    for (const n of [TRAINING_RECOMMENDED_STAGES, TRAINING_DEFAULT_STAGES, 20, 50]) {
      expect(trainingPowerNotice(n, HOLDOUT_RATIO_DEFAULT), `n=${n}`).toBeNull();
    }
    // Com holdout (≥ 20 no total, fatia ≤ metade) sobram ≥ 10 de treino: o
    // gate conta só eles, e mesmo com a fatia máxima nunca cai no aviso.
    expect(trainingPowerNotice(20, 0.5)).toBeNull();
  });

  it('as frases batem com o gate real: 6–7 seguram com UMA derrota; 8 não', () => {
    const umaDerrota = (n: number) => {
      const control = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0));
      const melhor = Array.from({ length: n }, (_, i) => (i === 0 ? 0 : 1));
      return Math.min(...bestOfKTest(control, [melhor, control, control, control]).pAdjusted);
    };
    expect(umaDerrota(6)).toBeGreaterThan(GATE_ALPHA);
    expect(umaDerrota(7)).toBeGreaterThan(GATE_ALPHA);
    expect(umaDerrota(TRAINING_RECOMMENDED_STAGES)).toBeLessThanOrEqual(GATE_ALPHA);
  });

  it('o default do treino tem folga (nenhum aviso) e é o que a troca de modo aplica', () => {
    expect(TRAINING_DEFAULT_STAGES).toBeGreaterThanOrEqual(TRAINING_RECOMMENDED_STAGES);
    expect(trainingPowerNotice(TRAINING_DEFAULT_STAGES, HOLDOUT_RATIO_DEFAULT)).toBeNull();
    // O default da TELA (compare) segue 5 — comparar modelos não tem gate.
    expect(defaultArenaFormState().stages).toBe(5);
  });

  it('troca de modo: entrar no treino sobe para 10; sair devolve o anterior se intocado', () => {
    const entra = stagesForModeChange({ from: 'compare', to: 'training', stages: 5, auto: null });
    expect(entra).toEqual({ stages: TRAINING_DEFAULT_STAGES, auto: { from: 5, to: TRAINING_DEFAULT_STAGES } });
    // Sai sem mexer → volta a 5.
    expect(stagesForModeChange({ from: 'training', to: 'compare', stages: 10, auto: entra.auto })).toEqual({
      stages: 5,
      auto: null,
    });
    // Sai depois de o usuário escolher outro nº → o dele fica.
    expect(stagesForModeChange({ from: 'training', to: 'variation', stages: 12, auto: entra.auto })).toEqual({
      stages: 12,
      auto: null,
    });
    // Já tinha 15 → nada muda (e nada a devolver).
    expect(stagesForModeChange({ from: 'variation', to: 'training', stages: 15, auto: null })).toEqual({
      stages: 15,
      auto: null,
    });
    // Troca que não envolve o treino não toca no nº.
    expect(stagesForModeChange({ from: 'compare', to: 'variation', stages: 3, auto: null }).stages).toBe(3);
  });

  it('a Nova Run liga as peças: import não sobe o nº (o arquivo manda) e o bloqueante é pendência', () => {
    const src = readFileSync(join(ROOT, 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');
    expect(src).toMatch(/setMode\(f\.mode, \{ keepStages: true \}\)/);
    expect(src).toMatch(/stagesForModeChange\(\{ from: mode, to: m, stages, auto: autoStages\.current \}\)/);
    expect(src).toMatch(/trainingPower\?\.blocking/);
    // A promessa que a auditoria achou falsa saiu das duas superfícies.
    expect(src).not.toMatch(/O prompt evolui a cada rodada até convergir/);
  });
});

/* =============================================================== web-live#10 */

describe('web-live#10 — o aviso "quem escreve o gabarito" só existe com gabarito (Node e SPA)', () => {
  let anterior: OpenRouterGateway | undefined;
  let dirAnterior: string;
  let tmp: string;
  const silencio: Array<{ mockRestore(): void }> = [];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pb-wf2-'));
    dirAnterior = getDataDir();
    setDataDir(tmp);
    silencio.push(
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
    );
  });
  afterAll(() => {
    silencio.forEach((s) => s.mockRestore());
    setDataDir(dirAnterior);
    rmSync(tmp, { recursive: true, force: true });
  });

  const fake = () =>
    fakeOpenRouter({
      catalog: ['fake/gen', 'fake/judge', 'fake/a', 'fake/b'].map((id) => catalogItem(id, 1e-6, 1e-6)),
      chat: (req) => {
        if (req.model === 'fake/gen') {
          return {
            text: JSON.stringify({
              stages: [{ question: 'Posso trocar sem nota fiscal?', productContext: 'Trocas só com nota.', maxTokens: 300, rubric: 'Citar a nota.' }],
            }),
          };
        }
        if (req.stream) return { text: `Resposta de ${req.model}` };
        if (req.system.includes('DUELO')) return { text: duelReply(req, 'A') };
        if (req.system.includes('juiz imparcial')) {
          const labels = JSON.parse(/rotulos (\[[^\]]*\])/.exec(req.user)![1]) as string[];
          return { text: listwiseReply(req, labels, labels.map((label) => ({ label, justificativa: 'ok', veredito: 'resolve' }))) };
        }
        // Sem referenceModelId o 1º juiz escreve o gabarito (texto livre).
        if (!req.user.includes('CANDIDATO')) return { text: 'Gabarito: só com nota fiscal.' };
        return { text: pointwiseReply(req, 'resolve') };
      },
    });

  async function rodar(motor: 'node' | 'web', config: Record<string, unknown>): Promise<RunRecord> {
    const f = fake();
    anterior = setDefaultGateway(createGateway({ fetch: f.fetch, sleep: noSleep }));
    try {
      return motor === 'node'
        ? await runNode(config as unknown as RunConfig, 'sk-or-v1-fake-key-para-teste-0000000000', {})
        : ((await runWeb(config as never, 'sk-or-v1-fake-key-para-teste-0000000000', {})) as unknown as RunRecord);
    } finally {
      setDefaultGateway(anterior!);
    }
  }

  const BASE = {
    mode: 'compare',
    theme: 'trocas',
    stages: 1,
    datagenModelId: 'fake/gen',
    judgeModelIds: ['fake/judge'],
    competitorModelIds: ['fake/a', 'fake/b'],
    finalists: 0,
    duels: false,
    timeoutMs: 5_000,
  };
  const avisoDaReferencia = (r: RunRecord) => (r.fairnessWarnings ?? []).filter((w) => w.includes('quem escreve o gabarito'));

  for (const motor of ['node', 'web'] as const) {
    it(`${motor}: comparar modelos SEM gabarito → nenhum aviso sobre a referência`, async () => {
      const rec = await rodar(motor, { ...BASE, referenceJudging: false });
      expect(rec.stages.some((s) => s.spec?.reference?.trim())).toBe(false);
      expect(avisoDaReferencia(rec)).toEqual([]);
    });

    it(`${motor}: com gabarito escrito pelo 1º juiz → o aviso continua (o default é denunciado)`, async () => {
      const rec = await rodar(motor, { ...BASE, referenceJudging: true });
      expect(rec.stages.some((s) => s.spec?.reference?.trim())).toBe(true);
      expect(avisoDaReferencia(rec)).toEqual([
        expect.stringContaining('A referência "fake/judge" (quem escreve o gabarito) é também juiz desta run'),
      ]);
    });
  }
});

/* ================================================================== IMPL-056 */

describe('IMPL-056 — idiomas dos cenários na tela (texto ⇄ languages)', () => {
  it('vazio = sem opt-in (o motor gera só pt-BR)', () => {
    expect(parseLanguages('')).toEqual({ ok: true });
    expect(parseLanguages(' , ; ')).toEqual({ ok: true });
  });

  it('vírgula/ponto e vírgula separam; repetição (sem caixa) sai; a ordem fica', () => {
    expect(parseLanguages('pt-BR, en ; es-419, EN')).toEqual({ ok: true, languages: ['pt-BR', 'en', 'es-419'] });
    expect(formatLanguages(['pt-BR', 'en'])).toBe('pt-BR, en');
    expect(parseLanguages(formatLanguages(['pt-BR', 'en']))).toEqual({ ok: true, languages: ['pt-BR', 'en'] });
  });

  it('espaço NÃO separa ("pt BR" é erro, como no --languages do CLI — nunca vira [pt, BR])', () => {
    const r = parseLanguages('pt BR');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/"pt BR" não é tag de idioma/);
    const dois = parseLanguages('português, en_US');
    expect(dois.ok).toBe(false);
    if (!dois.ok) expect(dois.error).toMatch(/"português", "en_US" não são tags de idioma/);
  });

  it(`no máximo ${MAX_LANGUAGES} idiomas (o .max(10) dos schemas)`, () => {
    const onze = Array.from({ length: 11 }, (_, i) => `l${String.fromCharCode(97 + i)}`).join(', ');
    const r = parseLanguages(onze);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no máximo 10 \(hoje 11\)/);
  });

  it('a tela aceita EXATAMENTE o que o runConfigSchema e os dois arena-config@1 aceitam', () => {
    const amostras = ['pt-BR', 'en', 'es-419', 'zh-Hant-TW', 'pt BR', 'p', 'português', 'en_US', 'abcd', 'en-', '-en'];
    const base = {
      mode: 'compare',
      theme: 't',
      stages: 1,
      datagenModelId: 'g/1',
      judgeModelIds: ['j/1'],
      competitorModelIds: ['a/1', 'b/1'],
    };
    const arena = { format: 'arena-config@1', mode: 'compare', theme: 't', models: { datagen: 'g/1', judges: ['j/1'], competitors: ['a/1', 'b/1'] } };
    for (const tag of amostras) {
      const tela = parseLanguages(tag).ok;
      expect(runConfigSchema.safeParse({ ...base, languages: [tag] }).success, `runConfigSchema ${tag}`).toBe(tela);
      expect(parseArenaNode({ ...arena, languages: [tag] }).ok, `arena Node ${tag}`).toBe(tela);
      expect(parseArenaWeb({ ...arena, languages: [tag] }).ok, `arena SPA ${tag}`).toBe(tela);
    }
  });

  it('é campo da tela (não mais só-JSON "ignorado") e faz round-trip no arquivo', () => {
    expect(ARENA_FIELD_HANDLING.languages).toMatchObject({ kind: 'ui' });
    const s = { ...defaultArenaFormState(), languages: 'pt-BR, en' };
    const { config, omitted } = exportArenaConfig(s);
    expect(omitted).toEqual([]);
    expect(config.languages).toEqual(['pt-BR', 'en']);
    const parsed = parseArenaWeb(JSON.parse(JSON.stringify(config)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const volta = applyArenaConfigToForm(defaultArenaFormState(), parsed.config, { raw: config, now: '2026-09-29T00:00:00.000Z' });
    expect(volta.warnings).toEqual([]);
    expect(volta.state.languages).toBe('pt-BR, en');
  });

  it('texto inválido não vai para o arquivo — e o export DIZ que ficou de fora', () => {
    const { config, omitted } = exportArenaConfig({ ...defaultArenaFormState(), languages: 'pt BR' });
    expect(config.languages).toBeUndefined();
    expect(omitted).toEqual([
      { path: 'languages', message: expect.stringMatching(/^"pt BR" não é uma lista de idiomas válida — ficou fora do arquivo/) },
    ]);
    // Vazio: nada a exportar e nada a avisar.
    const vazio = exportArenaConfig(defaultArenaFormState());
    expect(vazio.config.languages).toBeUndefined();
    expect(vazio.omitted).toEqual([]);
  });

  it('a Nova Run manda `languages` só quando válido e trava o inválido como pendência', () => {
    const src = readFileSync(join(ROOT, 'web', 'src', 'pages', 'NewRun.tsx'), 'utf8');
    expect(src).toMatch(/languagesParsed\.ok && languagesParsed\.languages \? \{ languages: languagesParsed\.languages \} : \{\}/);
    expect(src).toMatch(/if \(!languagesParsed\.ok\) out\.push\(\{ section: 'avancado', text: languagesParsed\.error, onlyComplete: true \}\)/);
  });
});
