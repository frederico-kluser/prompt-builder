// Contrato do RELATÓRIO DE CICLOS (`src/engine/sessionReport.ts` +
// `sessionReportHtml.ts` + `sessions report` no CLI).
//
// O relatório responde: quanto o prompt melhorou (original × campeão, por
// ciclo e no fim) e quanto a MUDANÇA mexe no custo de usá-lo (custo, tokens e
// latência por chamada, pareados pela MESMA pergunta) — além do custo da
// otimização e do ponto de retorno. Provamos com records construídos à mão:
//   1. holdout presente → qualidade e custo vêm do holdout (mesma run);
//   2. sem holdout → cai nas runs de treino, pareando por pergunta, com aviso;
//   3. campeão == original → "sem mudança", Δ custo 0;
//   4. campeão mais barato → ponto de retorno (payback) calculado;
//   5. run ausente / custo 0 → aviso, nunca exceção nem "grátis";
//   6. HTML autocontido: tema do Plannotator, sem rede, prompt ESCAPADO;
//   7. CLI: --json, --html, --markdown, validações de uso e subcomando inválido.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SessionRecord } from '../src/types.js';
import { CHAMP, ORIG, fixture } from './support/sessionReportFixture.js';
import {
  buildSessionReport,
  renderSessionReportMarkdown,
  SESSION_REPORT_FORMAT,
} from '../src/engine/sessionReport.js';
import { diffLines, renderSessionReportHtml } from '../src/engine/sessionReportHtml.js';
import * as webShim from '../web/src/engine/sessionReport.js';
import * as webShimHtml from '../web/src/engine/sessionReportHtml.js';
import { nodeOrTsx, ROOT } from './support/cli.js';

describe('buildSessionReport — holdout presente', () => {
  const { session, runs } = fixture();
  const r = buildSessionReport(session, runs, { generatedAt: '2026-09-28T11:00:00.000Z', callsPerMonth: 50_000 });

  it('formato e metadados', () => {
    expect(r.format).toBe(SESSION_REPORT_FORMAT);
    expect(r.generatedAt).toBe('2026-09-28T11:00:00.000Z');
    expect(r.session).toMatchObject({ id: 's1', cyclesRun: 2, iterationsPlanned: 3, promotions: 1, durationMs: 330_000 });
  });

  it('qualidade vem do holdout (original × campeão na mesma run)', () => {
    expect(r.quality.source).toBe('holdout');
    expect(r.quality.originalScorePp).toBeCloseTo(41.67, 2);
    expect(r.quality.championScorePp).toBeCloseTo(91.67, 2);
    expect(r.quality.gainPp).toBe(50);
    expect(r.quality.relativeGainPct).toBeCloseTo(119.99, 1);
    expect(r.quality.pOrigin).toBe('holdout');
    expect(r.quality.significant).toBe(true);
    expect(r.quality.verdicts).toEqual({
      original: { resolve: 0, parcial: 5, nao: 1, semVeredito: 0 },
      champion: { resolve: 5, parcial: 1, nao: 0, semVeredito: 0 },
    });
    expect(r.verdict).toBe('melhorou');
  });

  it('custo por chamada pareado no holdout: +30% e +120 tokens de entrada', () => {
    expect(r.cost.source).toBe('holdout');
    expect(r.cost.pairs).toBe(6);
    expect(r.cost.original.meanCostUsd).toBeCloseTo(0.001, 9);
    expect(r.cost.champion.meanCostUsd).toBeCloseTo(0.0013, 9);
    expect(r.cost.deltaCostPct).toBe(30);
    expect(r.cost.deltaTokensIn).toBe(120);
    expect(r.cost.deltaTokensOut).toBe(10);
    expect(r.cost.deltaLatencyPct).toBe(20);
    expect(r.cost.per1kCalls).toEqual({ originalUsd: 1, championUsd: 1.3, deltaUsd: 0.3 });
    expect(r.cost.projection).toEqual({ callsPerMonth: 50_000, originalUsd: 50, championUsd: 65, deltaUsd: 15 });
    // Custa mais E melhorou: preço do p.p.; nada de payback.
    expect(r.cost.paybackCalls).toBeNull();
    expect(r.cost.extraUsdPer1kPerPp).toBeCloseTo(0.3 / 50, 6);
  });

  it('ciclos: decisão, custo com a re-avaliação e acumulado', () => {
    expect(r.cycles.map((c) => [c.label, c.decision])).toEqual([
      ['Ciclo 1', 'promoted'],
      ['Ciclo 2', 'held'],
    ]);
    expect(r.cycles[0]).toMatchObject({ controlId: 'original', championId: 'v1', technique: 'persona', variants: 2, costUsd: 0.14 });
    expect(r.cycles[0].reeval).toEqual({ gainPp: 40, confirmed: true, size: 5 });
    expect(r.cycles[0].pAdjusted).toBe(0.031);
    expect(r.cycles[1]).toMatchObject({ controlId: 'carry', heldBy: ['min-gain'], costUsd: 0.1, cumulativeCostUsd: 0.24 });
    expect(r.cycles[0].originalScorePp).toBe(25);
    expect(r.cycles[1].championScorePp).toBeCloseTo(91.67, 2);
  });

  it('otimização: total, papéis ordenados por gasto e uso do teto', () => {
    expect(r.optimization.totalUsd).toBe(0.32);
    expect(r.optimization.byRole.map((x) => x.role)).toEqual(['judge', 'competitor', 'optimizer']);
    expect(r.optimization.byRole[0].pct).toBe(50);
    expect(r.optimization.budgetUsedPct).toBe(16);
  });

  it('prompt: diff de linhas e Δ aproximado de tokens', () => {
    expect(r.prompts.changed).toBe(true);
    expect(r.prompts.promotedAtIteration).toBe(0);
    expect(r.prompts.championLabel).toBe('Persona sênior');
    expect(r.prompts.diff.linesAdded).toBeGreaterThan(0);
    expect(r.prompts.diff.charsDelta).toBe(CHAMP.length - ORIG.length);
  });

  it('manchete diz quanto melhorou E quanto muda o custo', () => {
    expect(r.headline).toMatch(/\+50,0 p\.p\./);
    expect(r.headline).toMatch(/MAIOR em 30,0%/);
    expect(r.headline).toMatch(/US\$ 0,3200/);
    expect(r.warnings).toEqual([]);
  });

  it('Markdown traz a tabela de ciclos e os dois prompts', () => {
    const md = renderSessionReportMarkdown(r);
    expect(md).toContain('## Ciclos');
    expect(md).toContain('| Ciclo 1 |');
    expect(md).toContain(ORIG);
    expect(md).toContain('Cite a política quando houver.');
  });
});

describe('buildSessionReport — degradações honestas', () => {
  it('sem holdout: pareia original × campeão pela pergunta nas runs de treino e avisa', () => {
    const { session, runs } = fixture({ withHoldout: false });
    const r = buildSessionReport(session, runs);
    expect(r.quality.source).toBe('training');
    expect(r.quality.pOrigin).toBe('selecao');
    expect(r.cost.source).toBe('training');
    expect(r.cost.pairs).toBe(6);
    expect(r.cost.deltaCostPct).toBe(30);
    expect(r.warnings.join(' ')).toMatch(/cenários de TREINO/);
  });

  it('campeão mais barato: calcula o ponto de retorno da otimização', () => {
    const { session, runs } = fixture({ champCall: { cost: 0.0008, tin: 300, tout: 190, lat: 900 } });
    const r = buildSessionReport(session, runs);
    expect(r.cost.deltaCostPct).toBe(-20);
    // 0,32 / 0,0002 = 1600 chamadas.
    expect(r.cost.paybackCalls).toBe(1600);
    expect(r.cost.extraUsdPer1kPerPp).toBeNull();
    expect(r.headline).toMatch(/MENOR em 20,0%/);
  });

  it('campeão == original: sem mudança, custo idêntico por construção', () => {
    const { session, runs } = fixture({ champion: ORIG, withHoldout: false });
    const s = { ...session, pairing: undefined, significance: null } as unknown as SessionRecord;
    const r = buildSessionReport(s, runs);
    expect(r.prompts.changed).toBe(false);
    expect(r.verdict).toBe('sem-mudanca');
    expect(r.quality.gainPp).toBe(0);
    expect(r.cost.deltaCostPerCallUsd).toBe(0);
    expect(r.headline).toMatch(/nenhuma variante superou/);
  });

  it('run ausente e custo 0 viram AVISO — nunca exceção nem "grátis"', () => {
    const { session, runs } = fixture();
    const semHoldout = runs.filter((x) => x.id !== 'rh');
    const r = buildSessionReport(session, semHoldout);
    expect(r.warnings.join(' ')).toMatch(/1 run\(s\) da sessão não foram encontradas/);
    const zerado = fixture({ champCall: { cost: 0, tin: 520, tout: 210, lat: 1200 } });
    const r2 = buildSessionReport(zerado.session, zerado.runs);
    expect(r2.cost.champion.zeroCostCalls).toBe(6);
    expect(r2.warnings.join(' ')).toMatch(/custo 0/);
  });

  it('recusa conta como chamada paga; retry por truncamento e pendente viram aviso; gasto fora das runs', () => {
    const { session, runs } = fixture();
    const rh = runs.find((r) => r.id === 'rh')!;
    const st = rh.stages[0].responses.find((x) => x.contestantId === 'holdout-champion')!;
    st.status = 'refused';
    const st2 = rh.stages[1].responses.find((x) => x.contestantId === 'holdout-champion')!;
    st2.truncationRetried = true;
    const s = { ...session, costLedger: { spentUsd: 0.32, committedUsd: 0, pendingUsd: 0.01, pendingCalls: 1, conservativeUsd: 0, conservativeCalls: 0 } } as unknown as SessionRecord;
    const r = buildSessionReport(s, runs);
    expect(r.cost.pairs).toBe(6);
    expect(r.cost.champion.refusedCalls).toBe(1);
    expect(r.cost.champion.retriedCalls).toBe(1);
    expect(r.warnings.join(' ')).toMatch(/teto ×2/);
    expect(r.warnings.join(' ')).toMatch(/pendentes/);
    expect(r.optimization.pendingUsd).toBe(0.01);
    // 0,32 − (0,12 + 0,10 + 0,02 + 0,08) = 0 → sem gasto fora das runs neste fixture.
    expect(r.optimization.sessionOverheadUsd).toBe(0);
  });

  it('latência: Δ é a MEDIANA dos pares (robusta a um outlier)', () => {
    const { session, runs } = fixture();
    const rh = runs.find((r) => r.id === 'rh')!;
    rh.stages[0].responses.find((x) => x.contestantId === 'holdout-champion')!.latencyMs = 60_000;
    const r = buildSessionReport(session, runs);
    expect(r.cost.deltaLatencyMs).toBe(200);
  });

  it('sessão sem linhagem (interrompida) não quebra', () => {
    const { session, runs } = fixture();
    const s = { ...session, bestPromptByIteration: [], holdout: undefined, pairing: undefined, significance: undefined } as unknown as SessionRecord;
    const r = buildSessionReport(s, runs);
    expect(r.cycles.length).toBeGreaterThan(0);
    expect(r.cycles.every((c) => c.decision === 'stopped')).toBe(true);
  });
});

describe('renderSessionReportHtml — página autocontida no tema do Plannotator', () => {
  const { session, runs } = fixture();
  const hostil = { ...session, config: { ...session.config, basePrompt: '<script>alert("x")</script>' } } as SessionRecord;
  const html = renderSessionReportHtml(buildSessionReport(hostil, runs));

  it('opt-in de tema do Plannotator e tokens semânticos', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta name="plannotator-theme" content="host">');
    expect(html).toContain('--primary:');
    expect(html).toContain('prefers-color-scheme:dark');
  });

  it('sem rede: nenhum recurso externo', () => {
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/src="https?:/i);
  });

  it('texto do prompt é ESCAPADO (prompt hostil não vira HTML)', () => {
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('seções do relatório presentes', () => {
    for (const id of ['qualidade', 'ciclos', 'custo', 'otimizacao', 'prompt', 'ressalvas', 'metodo']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('diffLines: LCS preserva as linhas comuns', () => {
    const ops = diffLines('a\nb\nc', 'a\nx\nc');
    expect(ops).toEqual([
      { kind: 'eq', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'eq', text: 'c' },
    ]);
  });

  it('web usa a MESMA implementação (shim)', () => {
    expect(webShim.buildSessionReport).toBe(buildSessionReport);
    expect(webShimHtml.renderSessionReportHtml).toBe(renderSessionReportHtml);
  });
});

// --- CLI (processo real) ---------------------------------------------------------

const { cmd: CMD, entry: ENTRY } = nodeOrTsx(path.join(ROOT, 'src', 'cli', 'index.ts'));
let home = '';
let work = '';

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'pb-report-home-'));
  work = mkdtempSync(path.join(tmpdir(), 'pb-report-work-'));
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  mkdirSync(path.join(home, 'runs'), { recursive: true });
  const { session, runs } = fixture();
  writeFileSync(path.join(home, 'sessions', 's1.json'), JSON.stringify(session));
  for (const r of runs) writeFileSync(path.join(home, 'runs', `${r.id}.json`), JSON.stringify(r));
});

afterAll(() => {
  for (const d of [home, work]) if (d) rmSync(d, { recursive: true, force: true });
});

function cli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, PROMPT_BUILDER_HOME: home, OPENROUTER_BASE_URL: 'http://127.0.0.1:9/api/v1' };
  delete env.OPENROUTER_API_KEY;
  const r = spawnSync(CMD, [ENTRY, ...args], { env, encoding: 'utf-8', timeout: 60_000, cwd: work });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('CLI `sessions report`', () => {
  it('--json devolve o relatório no envelope (stdout = payload)', () => {
    const r = cli(['sessions', 'report', 's1', '--json', '--calls-per-month', '20000']);
    expect(r.status, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout);
    expect(env).toMatchObject({ ok: true, command: 'sessions.report' });
    expect(env.data.report.format).toBe(SESSION_REPORT_FORMAT);
    expect(env.data.report.cost.projection.callsPerMonth).toBe(20000);
    expect(env.data.report.cycles).toHaveLength(2);
  });

  it('texto: Markdown no stdout', () => {
    const r = cli(['sessions', 'report', 's1']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('# Relatório de ciclos');
    expect(r.stdout).toContain('## Quanto a mudança mexe no custo de uso');
  });

  it('--html e --markdown gravam os arquivos', () => {
    const html = path.join(work, 'out', 'rel.html');
    const md = path.join(work, 'out', 'rel.md');
    const r = cli(['sessions', 'report', 's1', '--html', html, '--markdown', md, '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(html)).toBe(true);
    expect(readFileSync(html, 'utf-8')).toContain('plannotator-theme');
    expect(readFileSync(md, 'utf-8')).toContain('# Relatório de ciclos');
    expect(JSON.parse(r.stdout).data.files).toEqual({ html, markdown: md });
  });

  it('uso inválido sai com 2', () => {
    expect(cli(['sessions', 'report', 's1', '--calls-per-month', 'muitas']).status).toBe(2);
    expect(cli(['sessions', 'report']).status).toBe(2);
    // Subcomando desconhecido não cai mais em silêncio no `show`.
    const r = cli(['sessions', 'relatorio', 's1', '--json']);
    expect(r.status).toBe(2);
    expect(JSON.parse(r.stdout).error.message).toMatch(/Subcomando desconhecido/);
  });
});
