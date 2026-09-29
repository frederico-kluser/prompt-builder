// Contratos puros da onda web-views-b (tela de Treino × relatório × CLI).
//
//  web-live#17 — a MESMA sessão mostrava p=0.002 bilateral na TrainingView e
//    0,001 (o unilateral do gate, sem rótulo) no relatório. Agora o relatório
//    exibe o BILATERAL de `reportPValue` (o mesmo número da tela), rotulado, e
//    guarda o unilateral do gate à parte (`pValueGate`) — HTML, Markdown e a
//    página da SPA usam o mesmo formatador.
//  IMPL-046 — o veredito de recomendação (recusa honesta) é UM objeto,
//    `sessionRecommendationOf`, chamado igual por `sessions show`/`winner` e
//    pela TrainingView, com os braços ROTULADOS (nunca `holdout-control`).
//  web-live#1 / web-code#5 — o campeão da sessão é a ÚLTIMA entrada de
//    `bestPromptByIteration` (nunca o argmax de `score`, que são ouros de
//    rodadas não comparáveis) — a regra única de CLI, job manager e UI.
//
// O comportamento na tela (render real no browser) está em
// test/web-views-e2e.test.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionRecord } from '../src/types.js';
import { formatPValue, reportPValue, type StoredSignificance } from '../src/stats.js';
import {
  buildSessionReport,
  fmtReportP,
  fmtReportPLine,
  renderSessionReportMarkdown,
  reportPLabel,
} from '../src/engine/sessionReport.js';
import { renderSessionReportHtml } from '../src/engine/sessionReportHtml.js';
import { pairingArmLabel, sessionRecommendationOf } from '../src/engine/sessionDecision.js';
import { fixture } from './support/sessionReportFixture.js';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Sessão da fixture com um teste EXATO gravado (unilateral 0,001; bilateral 0,002). */
function sessaoExata(over: Partial<StoredSignificance> = {}): { session: SessionRecord; runs: ReturnType<typeof fixture>['runs'] } {
  const { session, runs } = fixture();
  const s = {
    ...session,
    significance: {
      ...(session.significance as StoredSignificance),
      pValue: 0.001,
      pValueTwoSided: 0.002,
      method: 'exact',
      ...over,
    },
  } as SessionRecord;
  return { session: s, runs };
}

describe('web-live#17 — relatório e TrainingView mostram o MESMO p (bilateral, rotulado)', () => {
  it('quality.pValue = reportPValue(sig).p (o bilateral da tela), pKind two-sided, gate à parte', () => {
    const { session, runs } = sessaoExata();
    const q = buildSessionReport(session, runs).quality;
    const naTela = reportPValue(session.significance as StoredSignificance);
    expect(naTela).toEqual({ p: 0.002, kind: 'two-sided' });
    expect(q.pValue).toBe(naTela.p);
    expect(q.pKind).toBe('two-sided');
    expect(q.pValueGate).toBe(0.001);
    // O que a TrainingView escreve (formatPValue) e o que o relatório escreve
    // (fmtReportP) são o MESMO número — só o separador decimal é do idioma.
    expect(formatPValue(naTela.p)).toBe('p=0.002');
    expect(fmtReportP(q.pValue)).toBe('0,002');
  });

  it('a decisão "significativo" continua no p UNILATERAL do gate (espelha a promoção)', () => {
    // bilateral 0,08 > 0,05, mas o gate (unilateral 0,04) passa: é o que promoveu.
    const { session, runs } = sessaoExata({ pValue: 0.04, pValueTwoSided: 0.08, ci95Pp: [2, 60] });
    const q = buildSessionReport(session, runs).quality;
    expect(q.pValue).toBe(0.08);
    expect(q.pValueGate).toBe(0.04);
    expect(q.significant).toBe(true);
    expect(fmtReportPLine(q)).toBe('p 0,080 bilateral (gate unilateral 0,040)');
  });

  it('sessão legada (só o bootstrap antigo) sai rotulada como legado, nunca como bilateral', () => {
    const { session, runs } = fixture(); // significance sem pValueTwoSided
    const q = buildSessionReport(session, runs).quality;
    expect(q.pKind).toBe('legacy');
    expect(reportPLabel(q)).toBe('p-valor (legado)');
    expect(fmtReportPLine(q)).toMatch(/^p 0,031 \(bootstrap, legado\)$/);
  });

  it('HTML e Markdown trazem o bilateral rotulado (e não o unilateral nu)', () => {
    const { session, runs } = sessaoExata();
    const r = buildSessionReport(session, runs);
    const md = renderSessionReportMarkdown(r);
    expect(md).toContain('p 0,002 bilateral (gate unilateral 0,001)');
    expect(md).not.toMatch(/· p 0,0010/);
    const html = renderSessionReportHtml(r);
    expect(html).toContain('p 0,002 bilateral (gate unilateral 0,001)');
  });

  it('a página da SPA usa os MESMOS formatadores (sem toFixed próprio do p)', () => {
    const page = read('web/src/pages/TrainingReport.tsx');
    expect(page).toMatch(/value=\{fmtReportP\(q\.pValue\)\}/);
    expect(page).toMatch(/label=\{reportPLabel\(q\)\}/);
    expect(page).toMatch(/\{fmtReportPLine\(q\)\}/);
    expect(page).not.toMatch(/pValue\.toFixed/);
    // E a TrainingView segue no reportPValue (bilateral rotulado).
    const tela = read('web/src/pages/TrainingView.tsx');
    expect(tela).toMatch(/reportPValue\(sig\)/);
    expect(tela).toMatch(/'bilateral'/);
  });
});

describe('IMPL-046 — veredito de recomendação: um objeto para CLI e UI, braços rotulados', () => {
  it('pareamento do holdout: nunca vaza o id interno holdout-control/holdout-champion', () => {
    const { session } = fixture(); // pairing.source = holdout
    const rec = sessionRecommendationOf(session);
    expect(rec).not.toBeNull();
    expect(rec!.text).not.toMatch(/holdout-(control|champion)/);
    expect(rec!.text).toContain('campeão');
    expect(rec!.text).toContain('controle (base)');
    expect(rec!.ruler).toBe('judge-score+ci');
  });

  it('rótulos dos braços', () => {
    expect(pairingArmLabel('control', 'holdout-control')).toBe('controle (base)');
    expect(pairingArmLabel('control', 'original')).toBe('original');
    expect(pairingArmLabel('control', 'carry')).toBe('campeão anterior');
    expect(pairingArmLabel('control', undefined)).toBe('controle');
    expect(pairingArmLabel('candidate', 'holdout-champion')).toBe('campeão');
    expect(pairingArmLabel('candidate', 'v1')).toBe('campeão');
  });

  it('sem significância gravada (< 5 pares) = null, quem chama mostra "amostra insuficiente"', () => {
    const { session } = fixture();
    expect(sessionRecommendationOf({ ...session, significance: null })).toBeNull();
  });

  it('a mesma função no CLI (sessions show/winner) e na TrainingView', () => {
    expect(read('src/cli/commands/misc.ts')).toMatch(/const recommendation = sessionRecommendationOf\(record\)/);
    const tela = read('web/src/pages/TrainingView.tsx');
    expect(tela).toMatch(/sessionRecommendationOf\(session\)/);
    expect(tela).toMatch(/data-testid="session-recommendation"/);
    // Nem o CLI nem a tela montam rótulo à mão com o id do pareamento.
    expect(read('src/cli/commands/misc.ts')).not.toMatch(/candidate: record\.pairing\?\.championId/);
  });
});

describe('web-live#1 / web-code#5 — campeão da sessão = última entrada (nunca argmax de ouros)', () => {
  it('a TrainingView usa bestPromptByIteration.at(-1), como o CLI e o job manager', () => {
    const tela = read('web/src/pages/TrainingView.tsx');
    expect(tela).toMatch(/const best = session\.bestPromptByIteration\.at\(-1\);/);
    // O argmax por score (ouros de rodadas diferentes) não volta.
    expect(tela).not.toMatch(/bestPromptByIteration\.reduce\(/);
    // O "Pacote" usa o MESMO `best` (antes recalculava o seu).
    expect(tela).not.toMatch(/lastBest/);
  });
});
