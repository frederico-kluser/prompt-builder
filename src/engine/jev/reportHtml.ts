// Modo JEV — relatórios em HTML AUTOCONTIDO (um arquivo, CSS inline, claro e
// escuro por `prefers-color-scheme`, sem script nem recurso externo). É o que a
// SPA baixa em "Relatório (HTML)" e o que o CLI pode gravar. Todo texto que
// vem do usuário/modelo (tema, rubricas, avisos) passa por `escapeHtml`.

import type { JevRunReport, JevSessionReport, JevHeadline } from './report.js';
import { fmtNum, fmtP, fmtPLabel, fmtPct, fmtPp, fmtUsd } from './report.js';

export function escapeHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Diff linha a linha (LCS) — próprio, sem depender do web. */
export function diffLinesJev(a: string, b: string): { type: 'eq' | 'add' | 'del'; text: string }[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { type: 'eq' | 'add' | 'del'; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: 'eq', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: 'del', text: A[i++] });
    else out.push({ type: 'add', text: B[j++] });
  }
  while (i < n) out.push({ type: 'del', text: A[i++] });
  while (j < m) out.push({ type: 'add', text: B[j++] });
  return out;
}

const CSS = `
:root{--bg:#f9fafb;--card:#fff;--fg:#1a1d23;--muted:#5b6170;--border:#e3e5ea;--ok:#1f7a45;--ok-soft:#e3f4e9;--bad:#b3261e;--bad-soft:#fbe7e5;--warn-soft:#fbf1dc}
@media (prefers-color-scheme: dark){:root{--bg:#0b0d10;--card:#15171b;--fg:#eceef2;--muted:#a3a9b6;--border:#2a2e35;--ok:#5fd08e;--ok-soft:#173826;--bad:#ff8a7d;--bad-soft:#3a1714;--warn-soft:#3a2f14}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:24px;margin:0 0 6px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:32px 0 10px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px}.muted{color:var(--muted)}.lead{font-size:15px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:6px 8px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
td.n,th.n{text-align:right}.wrap{overflow-x:auto}.pill{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;border:1px solid var(--border)}
.ok{background:var(--ok-soft);color:var(--ok)}.bad{background:var(--bad-soft);color:var(--bad)}.warn{background:var(--warn-soft)}
pre{margin:0;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap}.add{background:var(--ok-soft)}.del{background:var(--bad-soft)}
ul{padding-left:20px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
`;

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>\n`;
}

const ms = (v: number | null | undefined): string => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

function headlineRow(nome: string, h: JevHeadline): string {
  return `<tr><th>${escapeHtml(nome)}</th><td class="n">${fmtPct(h.accuracy)}</td><td class="n">${fmtNum(h.brierScore, 1)}</td><td class="n">${fmtNum(h.ece, 3)}</td><td class="n">${fmtPct(h.coverageAtAuto)}</td><td class="n">${fmtPct(h.precisionAtAuto)}</td></tr>`;
}

const VEREDITO_CLASSE: Record<string, string> = { melhorou: 'ok', piorou: 'bad', inconclusivo: 'warn', 'sem-diferenca': '', 'sem-mudanca': '' };

/** Relatório de ciclos (treino) em HTML autocontido. */
export function renderJevSessionReportHtml(r: JevSessionReport): string {
  const B: string[] = [];
  B.push(`<h1>Relatório de ciclos JEV — ${escapeHtml(r.session.theme)}</h1>`);
  B.push(
    `<p class="muted">Sessão <code>${escapeHtml(r.session.id)}</code> · ${escapeHtml(r.session.modelId)}${r.session.resolvedModels.length ? ` (${escapeHtml(r.session.resolvedModels.join(', '))})` : ''} · ${r.session.cyclesRun}/${r.session.iterationsPlanned} ciclos · ${r.session.promotions} promoção(ões) · gerado em ${escapeHtml(r.generatedAt)}</p>`,
  );
  B.push(`<div class="card"><span class="pill ${VEREDITO_CLASSE[r.verdict] ?? ''}">${escapeHtml(r.verdict)}</span><p class="lead">${escapeHtml(r.headline)}</p></div>`);
  B.push('<h2>Qualidade (holdout, política ajustada)</h2>');
  B.push(
    `<div class="card wrap"><table><thead><tr><th></th><th class="n">Acurácia</th><th class="n">Brier (p.p.)</th><th class="n">ECE</th><th class="n">Cobertura auto</th><th class="n">Precisão auto</th></tr></thead><tbody>${headlineRow('Original', r.quality.original)}${headlineRow('Campeã', r.quality.champion)}</tbody></table>` +
      `<p class="muted">Δ acurácia ${fmtPp(r.quality.deltaPp.accuracy)} · Δ Brier ${fmtPp(r.quality.deltaPp.brierScore)} · IC95% ${r.quality.ci95Pp ? `[${fmtNum(r.quality.ci95Pp[0], 2)}; ${fmtNum(r.quality.ci95Pp[1], 2)}]` : '—'} · ${fmtPLabel(r.quality.pValue)} · ${escapeHtml(r.quality.basis)}</p></div>`,
  );
  B.push('<h2>Ciclos</h2>');
  B.push(
    `<div class="card wrap"><table><thead><tr><th>Ciclo</th><th>Decisão</th><th>Operadores</th><th class="n">Ganho</th><th class="n">Corrigido</th><th class="n">p ajustado</th><th class="n">minGain</th><th class="n">Δ acurácia</th><th class="n">Custo</th><th class="n">Acumulado</th></tr></thead><tbody>` +
      r.cycles
        .map(
          (c) =>
            `<tr><td>${c.iteration}</td><td><span class="pill ${c.decision === 'promoted' ? 'ok' : ''}">${escapeHtml(c.decision)}</span>${c.heldBy.length ? `<div class="muted">${escapeHtml(c.heldBy.join('; '))}</div>` : ''}</td><td>${escapeHtml(c.operators.join(', ') || '—')}</td><td class="n">${fmtPp(c.bestGainPp, 2)}</td><td class="n">${fmtPp(c.gainCorrectedPp, 2)}</td><td class="n">${fmtP(c.pAdjusted)}</td><td class="n">${fmtNum(c.minGainPp, 2)}</td><td class="n">${fmtPp(c.accuracyDeltaPp, 1)}</td><td class="n">${fmtUsd(c.costUsd)}</td><td class="n">${fmtUsd(c.cumulativeCostUsd)}</td></tr>`,
        )
        .join('') +
      '</tbody></table></div>',
  );
  B.push('<h2>Custo de usar a definição (só entrada: a saída é grátis)</h2>');
  B.push(
    `<div class="card wrap"><p class="muted">Base: ${escapeHtml(r.cost.basis)}.</p><table><thead><tr><th></th><th class="n">Tokens de entrada / request</th><th class="n">US$ / request (medido)</th><th class="n">p50</th></tr></thead><tbody>` +
      `<tr><th>Original</th><td class="n">${fmtNum(r.cost.original.meanTokensIn, 0)}</td><td class="n">${fmtUsd(r.cost.original.meanCostUsd)}</td><td class="n">${ms(r.cost.original.p50Ms)}</td></tr>` +
      `<tr><th>Campeã</th><td class="n">${fmtNum(r.cost.champion.meanTokensIn, 0)}</td><td class="n">${fmtUsd(r.cost.champion.meanCostUsd)}</td><td class="n">${ms(r.cost.champion.p50Ms)}</td></tr></tbody></table>` +
      (r.cost.projection
        ? `<p>Em ${r.cost.projection.requestsPerMonth.toLocaleString('pt-BR')} decisões/mês: original ${fmtUsd(r.cost.projection.originalUsd)} → campeã ${fmtUsd(r.cost.projection.championUsd)} (${r.cost.projection.deltaUsd >= 0 ? '+' : ''}${fmtUsd(r.cost.projection.deltaUsd)}).</p>`
        : '') +
      (r.cost.paybackRequests !== null ? `<p>A otimização se paga em ${r.cost.paybackRequests.toLocaleString('pt-BR')} requests.</p>` : '') +
      (r.cost.extraUsdPer1kPerPp !== null ? `<p>Custo extra: ${fmtUsd(r.cost.extraUsdPer1kPerPp)} por 1k requests para cada p.p. de Brier ganho.</p>` : '') +
      '</div>',
  );
  if (Object.keys(r.policy).length) {
    B.push('<h2>Política ajustada por pergunta</h2>');
    B.push(
      `<div class="card wrap"><table><thead><tr><th>Pergunta</th><th class="n">T</th><th class="n">auto</th><th class="n">hitl</th><th>sinal</th></tr></thead><tbody>` +
        Object.entries(r.policy)
          .map(([q, p]) => `<tr><td><code>${escapeHtml(q)}</code></td><td class="n">${fmtNum(p.temperature ?? 1, 2)}</td><td class="n">${p.auto > 1 ? 'desligada' : fmtNum(p.auto, 2)}</td><td class="n">${fmtNum(p.hitl, 2)}</td><td>${escapeHtml(p.signal)}</td></tr>`)
          .join('') +
        '</tbody></table></div>',
    );
  }
  B.push('<h2>Quanto custou otimizar</h2>');
  B.push(
    `<div class="card"><p>Total <strong>${fmtUsd(r.optimization.totalUsd)}</strong> (decisões ${fmtUsd(r.optimization.byKind.decision)}, proponente ${fmtUsd(r.optimization.byKind.rewriter)})${r.optimization.budgetUsd ? ` de ${fmtUsd(r.optimization.budgetUsd)}` : ''}${r.optimization.pendingUsd > 0 ? ` · pendente ${fmtUsd(r.optimization.pendingUsd)}` : ''}.</p></div>`,
  );
  if (r.spec.changedQuestions.length) {
    B.push('<h2>O que mudou na definição</h2>');
    for (const q of r.spec.changedQuestions) {
      const o = r.spec.original.questions.find((x) => x.id === q);
      const c = r.spec.champion.questions.find((x) => x.id === q);
      const linhas = diffLinesJev(JSON.stringify(o ?? null, null, 2), JSON.stringify(c ?? null, null, 2));
      B.push(
        `<div class="card"><p><code>${escapeHtml(q)}</code> <span class="muted">(${escapeHtml(r.spec.diff[q]?.operators.join(', ') || '—')})</span></p><pre>${linhas
          .map((l) => `<div class="${l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : ''}">${l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}${escapeHtml(l.text)}</div>`)
          .join('')}</pre></div>`,
      );
    }
  }
  if (r.warnings.length) {
    B.push('<h2>Avisos</h2>');
    B.push(`<div class="card"><ul>${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`);
  }
  return page(`Relatório JEV — ${r.session.theme}`, B.join('\n'));
}

/** Relatório de run (eval/compare) em HTML autocontido. */
export function renderJevRunReportHtml(r: JevRunReport): string {
  const B: string[] = [];
  B.push(`<h1>Relatório JEV — ${escapeHtml(r.run.theme)}</h1>`);
  B.push(`<p class="muted">Run <code>${escapeHtml(r.run.id)}</code> · modo ${escapeHtml(r.run.mode)} · status ${escapeHtml(r.run.status)} · ${r.run.cases} casos × ${r.run.repeats} rep. · cliente ${escapeHtml(r.run.client)}</p>`);
  B.push('<h2>Competidores</h2>');
  B.push(
    `<div class="card wrap"><table><thead><tr><th>Competidor</th><th class="n">Acurácia</th><th class="n">Macro-F1</th><th class="n">Brier (p.p.)</th><th class="n">ECE</th><th class="n">Cobertura auto</th><th class="n">Precisão auto</th><th class="n">Errados c/ confiança</th><th class="n">p50 / p95</th><th class="n">US$ / 1k decisões</th></tr></thead><tbody>` +
      r.contestants
        .map(
          (c) =>
            `<tr><th>${escapeHtml(c.label)}${c.rejected ? ' <span class="pill bad">recusado</span>' : ''}</th><td class="n">${fmtPct(c.accuracy)}</td><td class="n">${fmtPct(c.macroF1)}</td><td class="n">${fmtNum(c.brierScore, 1)}</td><td class="n">${fmtNum(c.ece, 3)}</td><td class="n">${fmtPct(c.coverageAtAuto)}</td><td class="n">${fmtPct(c.precisionAtAuto)}</td><td class="n">${c.wrongAuto}</td><td class="n">${ms(c.p50Ms)} / ${ms(c.p95Ms)}</td><td class="n">${fmtUsd(c.costPer1kDecisions)}${c.costExact ? '' : ' *'}</td></tr>`,
        )
        .join('') +
      '</tbody></table></div>',
  );
  if (r.comparisons.length) {
    const nome = (id: string): string => r.contestants.find((c) => c.id === id)?.label ?? id;
    B.push('<h2>Comparação pareada com o controle</h2>');
    B.push(
      `<div class="card wrap"><table><thead><tr><th>Competidor</th><th class="n">Δ primária</th><th class="n">IC 95%</th><th class="n">p</th><th class="n">Δ acurácia</th><th class="n">McNemar p</th></tr></thead><tbody>` +
        r.comparisons
          .map(
            (c) =>
              `<tr><th>${escapeHtml(nome(c.contestantId))} <span class="muted">vs ${escapeHtml(nome(c.controlId))}</span></th><td class="n">${fmtPp(c.meanDiffPp)}</td><td class="n">${c.ci95Pp ? `${fmtPp(c.ci95Pp[0])} … ${fmtPp(c.ci95Pp[1])}` : '—'}</td><td class="n">${fmtP(c.pValue)}</td><td class="n">${fmtPp(c.accuracyDiffPp)}</td><td class="n">${fmtP(c.mcnemarP)}</td></tr>`,
          )
          .join('') +
        '</tbody></table></div>',
    );
  }
  if (r.byQuestion.length) {
    B.push('<h2>Por pergunta</h2>');
    B.push(
      `<div class="card wrap"><table><thead><tr><th>Pergunta</th><th>Competidor</th><th class="n">Acurácia</th><th class="n">Brier</th><th class="n">ECE</th><th class="n">Cobertura auto</th><th class="n">n</th></tr></thead><tbody>` +
        r.byQuestion
          .map(
            (q) =>
              `<tr><td><code>${escapeHtml(q.question)}</code></td><td>${escapeHtml(q.contestant)}</td><td class="n">${fmtPct(q.accuracy)}</td><td class="n">${fmtNum(q.brierScore, 1)}</td><td class="n">${fmtNum(q.ece, 3)}</td><td class="n">${fmtPct(q.coverageAtAuto)}</td><td class="n">${q.nScored}</td></tr>`,
          )
          .join('') +
        '</tbody></table></div>',
    );
  }
  if (r.cascade.length) {
    B.push('<h2>Cascata Jev → LLM</h2>');
    for (const k of r.cascade) {
      B.push(
        `<div class="card"><p>${escapeHtml(k.decisionId)} → ${escapeHtml(k.llmId)} (${k.n} decisões): na política, acurácia ${fmtPct(k.atDefault.accuracy)} com ${fmtPct(k.atDefault.escalatedRate)} escalado (${fmtUsd(k.atDefault.costPer1kDecisions)}/1k); LLM sozinho ${fmtPct(k.llmOnly.accuracy)} (${fmtUsd(k.llmOnly.costPer1kDecisions)}/1k)${k.escalationToMatchLlm !== null ? `; empata com o LLM escalando ${fmtPct(k.escalationToMatchLlm)}` : ''}.</p></div>`,
      );
    }
  }
  B.push('<h2>Custo</h2>');
  B.push(`<div class="card"><p>Total medido ${fmtUsd(r.cost.totalUsd)} (decisão ${fmtUsd(r.cost.byKind.decision)}, LLM ${fmtUsd(r.cost.byKind.llm)})${r.cost.pendingUsd > 0 ? ` · pendente ${fmtUsd(r.cost.pendingUsd)}` : ''}.</p></div>`);
  if (r.warnings.length) {
    B.push('<h2>Avisos</h2>');
    B.push(`<div class="card"><ul>${r.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>`);
  }
  return page(`Relatório JEV — ${r.run.theme}`, B.join('\n'));
}
