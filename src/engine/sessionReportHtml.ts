// Relatório de ciclos em HTML AUTOCONTIDO, no design system do Plannotator
// (skill `plannotator-visual-explainer`: tokens semânticos, títulos em serifa,
// rótulos em mono caixa-alta, cartões de estatística, linha do tempo, SVG inline).
//
// Um arquivo só, sem rede (nenhuma fonte/CDN): abre direto no navegador, vai
// anexado num PR e é entregue pela UI de anotação (`plannotator annotate
// <arq>`), que troca os tokens pelo tema ativo graças ao
// `<meta name="plannotator-theme" content="host">`. A web (`/training/:id/report`)
// usa ESTE renderizador no botão "Baixar HTML" — a mesma página nos dois lados.
//
// Puro (string → string), sem Node: fonte única em src/engine/, shim no web.

import {
  DECISION_LABEL,
  ROLE_LABEL,
  VERDICT_LABEL,
  fmtDuration,
  fmtInt,
  fmtPct,
  cycleReevalText,
  cycleHoldLabels,
  cycleHoldText,
  noChangeText,
  fmtPp,
  fmtReportP,
  fmtReportPLine,
  fmtSignedNumber,
  fmtSignedUsd,
  fmtUsd,
  reportPLabel,
  type CycleRow,
  type SessionReport,
} from './sessionReport.js';

// ---------------------------------------------------------------------------
// diff de linhas (para exibição)
// ---------------------------------------------------------------------------

export type DiffOp = { kind: 'eq' | 'add' | 'del'; text: string };

/** Diff de linhas por LCS (prompts são pequenos; acima do teto cai num diff grosso). */
export function diffLines(a: string, b: string): DiffOp[] {
  const la = a.split('\n');
  const lb = b.split('\n');
  const n = la.length;
  const m = lb.length;
  if (n * m > 4_000_000) {
    return [...la.map((text) => ({ kind: 'del' as const, text })), ...lb.map((text) => ({ kind: 'add' as const, text }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = la[i] === lb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (la[i] === lb[j]) {
      out.push({ kind: 'eq', text: la[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: la[i] });
      i += 1;
    } else {
      out.push({ kind: 'add', text: lb[j] });
      j += 1;
    }
  }
  while (i < n) out.push({ kind: 'del', text: la[i++] });
  while (j < m) out.push({ kind: 'add', text: lb[j++] });
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

function tone(x: number | null | undefined, goodWhenPositive: boolean): 'good' | 'bad' | 'flat' {
  if (x == null || !Number.isFinite(x) || x === 0) return 'flat';
  return (x > 0) === goodWhenPositive ? 'good' : 'bad';
}

function stat(value: string, label: string, t: 'good' | 'bad' | 'flat' = 'flat', hint?: string): string {
  return `<div class="stat-card ${t}"><span class="stat-value">${e(value)}</span><span class="stat-label">${e(label)}</span>${
    hint ? `<span class="stat-hint">${e(hint)}</span>` : ''
  }</div>`;
}

function section(n: number, title: string, body: string, id: string): string {
  return `<section id="${id}"><div class="section-header"><span class="section-number">${String(n).padStart(2, '0')}</span><h2>${e(
    title,
  )}</h2></div>${body}</section>`;
}

const DECISION_BADGE: Record<CycleRow['decision'], string> = {
  promoted: 'low',
  held: 'med',
  inconclusive: 'med',
  baseline: 'neutral',
  stopped: 'high',
};

// ---------------------------------------------------------------------------
// gráficos (SVG inline, cores por token)
// ---------------------------------------------------------------------------

/** Linha por ciclo: régua, melhor variante e campeão vigente (0–100). */
function cyclesChart(r: SessionReport): string {
  const cy = r.cycles;
  if (cy.length === 0) return '';
  const W = 960;
  const H = 300;
  const padL = 48;
  const padR = 24;
  const padT = 34;
  const padB = 40;
  // Recuo interno: o 1º e o último ciclo não encostam no eixo (rótulos inteiros).
  const inset = 56;
  const iw = W - padL - padR - 2 * inset;
  const ih = H - padT - padB;
  const xs = (i: number): number => padL + inset + (cy.length === 1 ? iw / 2 : (iw * i) / (cy.length - 1));
  const ys = (v: number): number => padT + ih - (Math.max(0, Math.min(100, v)) / 100) * ih;
  const grid = [0, 25, 50, 75, 100]
    .map(
      (v) =>
        `<line x1="${padL}" x2="${W - padR}" y1="${ys(v)}" y2="${ys(v)}" class="grid"/><text x="${padL - 8}" y="${ys(v) + 4}" class="axis" text-anchor="end">${v}</text>`,
    )
    .join('');
  const series = (key: 'controlScorePp' | 'bestScorePp' | 'championScorePp', cls: string, label: string): string => {
    const pts = cy
      .map((c, i) => (c[key] == null ? null : `${xs(i).toFixed(1)},${ys(c[key] as number).toFixed(1)}`))
      .filter(Boolean) as string[];
    if (pts.length === 0) return '';
    const dots = cy
      .map((c, i) =>
        c[key] == null
          ? ''
          : `<circle cx="${xs(i).toFixed(1)}" cy="${ys(c[key] as number).toFixed(1)}" r="4" class="${cls}-dot"><title>${e(
              `${c.label} · ${label}: ${fmtPp(c[key], false)}`,
            )}</title></circle>`,
      )
      .join('');
    return `<polyline points="${pts.join(' ')}" class="${cls}"/>${dots}`;
  };
  const labels = cy
    .map((c, i) => `<text x="${xs(i).toFixed(1)}" y="${H - 14}" class="axis" text-anchor="middle">${e(c.label)}</text>`)
    .join('');
  const promoted = cy
    .map((c, i) => {
      if (c.decision !== 'promoted') return '';
      const top = Math.max(c.championScorePp ?? 0, c.bestScorePp ?? 0, c.controlScorePp ?? 0);
      return `<text x="${xs(i).toFixed(1)}" y="${(ys(top) - 14).toFixed(1)}" class="flag" text-anchor="middle">▲ promovida</text>`;
    })
    .join('');
  return `<div class="diagram-panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Judge-score por ciclo: régua, melhor variante e campeão" style="width:100%">${grid}${series(
    'controlScorePp',
    's-control',
    'régua',
  )}${series('bestScorePp', 's-best', 'melhor variante')}${series('championScorePp', 's-champ', 'campeão vigente')}${labels}${promoted}</svg>
<div class="legend"><span><i class="k s-control-k"></i>régua do ciclo</span><span><i class="k s-best-k"></i>melhor variante</span><span><i class="k s-champ-k"></i>campeão vigente</span></div>
<span class="diagram-caption">Judge-score (0–100) por ciclo — a régua é o original no ciclo 1 e o campeão anterior re-testado nos demais</span></div>`;
}

/** Barras lado a lado original × campeão, normalizadas pelo maior valor da linha. */
function compareBars(rows: { label: string; a: number | null; b: number | null; fmt: (x: number | null) => string }[]): string {
  const W = 960;
  const rowH = 54;
  const H = rows.length * rowH + 10;
  const labelW = 170;
  const barMax = W - labelW - 130;
  const body = rows
    .map((row, i) => {
      const y = 10 + i * rowH;
      const max = Math.max(row.a ?? 0, row.b ?? 0) || 1;
      const wa = row.a == null ? 0 : Math.max(2, (row.a / max) * barMax);
      const wb = row.b == null ? 0 : Math.max(2, (row.b / max) * barMax);
      return `<text x="0" y="${y + 16}" class="rowlabel">${e(row.label)}</text>
<rect x="${labelW}" y="${y + 2}" width="${wa.toFixed(1)}" height="16" rx="3" class="bar-a"/><text x="${(labelW + wa + 8).toFixed(1)}" y="${y + 15}" class="barval">${e(row.fmt(row.a))}</text>
<rect x="${labelW}" y="${y + 22}" width="${wb.toFixed(1)}" height="16" rx="3" class="bar-b"/><text x="${(labelW + wb + 8).toFixed(1)}" y="${y + 35}" class="barval">${e(row.fmt(row.b))}</text>`;
    })
    .join('');
  return `<div class="diagram-panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Original × campeão por chamada" style="width:100%">${body}</svg>
<div class="legend"><span><i class="k bar-a-k"></i>original</span><span><i class="k bar-b-k"></i>campeão</span></div>
<span class="diagram-caption">Médias por chamada nos cenários pareados (mesma pergunta nos dois lados)</span></div>`;
}

function roleBars(r: SessionReport): string {
  const rows = r.optimization.byRole;
  if (rows.length === 0) return '<p class="muted">Sem quebra por papel neste record.</p>';
  const W = 960;
  const rowH = 30;
  const H = rows.length * rowH + 6;
  const labelW = 210;
  const barMax = W - labelW - 150;
  const max = Math.max(...rows.map((x) => x.usd)) || 1;
  const body = rows
    .map((x, i) => {
      const y = 4 + i * rowH;
      const w = Math.max(2, (x.usd / max) * barMax);
      return `<text x="0" y="${y + 15}" class="rowlabel">${e(ROLE_LABEL[x.role] ?? x.role)}</text><rect x="${labelW}" y="${y + 3}" width="${w.toFixed(
        1,
      )}" height="16" rx="3" class="bar-role"/><text x="${(labelW + w + 8).toFixed(1)}" y="${y + 16}" class="barval">${e(
        `${fmtUsd(x.usd)} · ${fmtPct(x.pct, false)}`,
      )}</text>`;
    })
    .join('');
  return `<div class="diagram-panel"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Custo da otimização por papel" style="width:100%">${body}</svg><span class="diagram-caption">Gasto MEDIDO da sessão por papel (usage.cost cobrado)</span></div>`;
}

// ---------------------------------------------------------------------------
// seções
// ---------------------------------------------------------------------------

function header(r: SessionReport): string {
  const s = r.session;
  const tags = [
    `modelo ${s.modelId}`,
    `${s.cyclesRun}/${s.iterationsPlanned} ciclos`,
    `${s.promotions} promoção(ões)`,
    `duração ${fmtDuration(s.durationMs)}`,
    `status ${s.status}`,
  ];
  return `<header><span class="eyebrow">Relatório de ciclos · prompt-builder · sessão ${e(s.id.slice(0, 8))}</span>
<h1>${e(s.theme || 'Treino de prompt')}</h1>
<div class="prompt-box verdict-${r.verdict}"><span class="prompt-label">${e(VERDICT_LABEL[r.verdict])}</span><p>${e(r.headline)}</p></div>
<div class="tags">${tags.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</div></header>`;
}

function summaryStrip(r: SessionReport): string {
  const q = r.quality;
  const c = r.cost;
  const cards = [
    stat(fmtPp(q.gainPp), 'Δ qualidade', tone(q.gainPp, true), q.source === 'holdout' ? 'holdout' : q.source === 'training' ? 'cenários de treino' : 'sem par'),
    stat(`${fmtPp(q.originalScorePp, false)} → ${fmtPp(q.championScorePp, false)}`, 'Judge-score', 'flat', 'original → campeão'),
    stat(fmtPct(c.deltaCostPct), 'Δ custo por chamada', tone(c.deltaCostPct, false), fmtSignedUsd(c.per1kCalls?.deltaUsd) + ' / mil'),
    stat(fmtSignedNumber(c.deltaTokensIn), 'Δ tokens de entrada', tone(c.deltaTokensIn, false), 'por chamada'),
    stat(fmtUsd(r.optimization.totalUsd), 'Custo da otimização', 'flat', r.optimization.budgetUsd != null ? `de ${fmtUsd(r.optimization.budgetUsd)}` : undefined),
    c.paybackCalls != null
      ? stat(fmtInt(c.paybackCalls), 'Chamadas p/ se pagar', 'good')
      : stat(fmtReportP(q.pValue), reportPLabel(q), q.significant ? 'good' : 'flat', q.pOrigin === 'holdout' ? 'confirmação' : q.pOrigin === 'selecao' ? 'da seleção' : undefined),
  ];
  return `<div class="summary-strip">${cards.join('')}</div>`;
}

function qualitySection(r: SessionReport): string {
  const q = r.quality;
  const v = q.verdicts;
  const verdictRow = (label: string, x: NonNullable<typeof v>['original']): string => {
    const total = x.resolve + x.parcial + x.nao || 1;
    const seg = (n: number, cls: string, t: string): string =>
      n > 0 ? `<span class="seg ${cls}" style="flex:${n}" title="${e(`${t}: ${n}`)}">${n}</span>` : '';
    return `<div class="vrow"><span class="vlabel">${e(label)}</span><div class="vbar">${seg(x.resolve, 'v-resolve', 'resolve')}${seg(
      x.parcial,
      'v-parcial',
      'parcial',
    )}${seg(x.nao, 'v-nao', 'não resolve')}</div><span class="vpct">${fmtPct(((x.resolve + 0.5 * x.parcial) / total) * 100, false)}</span></div>`;
  };
  return `<div class="callout"><h3>${e(VERDICT_LABEL[r.verdict])}</h3><p>${e(q.basis)}</p>
<span class="decide-with">n = ${q.n} (efetivo ${q.nEfetivo}) · IC95 ${
    q.ci95Pp ? `${e(fmtPp(q.ci95Pp[0]))} a ${e(fmtPp(q.ci95Pp[1]))}` : '—'
  } · ${e(fmtReportPLine(q))}${
    q.pOrigin ? ` · ${q.pOrigin === 'holdout' ? 'teste de confirmação (holdout)' : 'p da própria seleção (anti-conservador)'}` : ''
  }</span></div>
${
  v
    ? `<div class="verdicts"><div class="legend"><span><i class="k v-resolve"></i>resolve</span><span><i class="k v-parcial"></i>parcial</span><span><i class="k v-nao"></i>não resolve</span></div>${verdictRow(
        'Original',
        v.original,
      )}${verdictRow('Campeão', v.champion)}</div>`
    : ''
}`;
}

function cyclesSection(r: SessionReport): string {
  const rows = r.cycles
    .map(
      (c) => `<tr><td>${e(c.label)}</td><td>${e(fmtPp(c.controlScorePp, false))}</td><td>${e(fmtPp(c.bestScorePp, false))}</td><td class="${tone(
        c.gainPp,
        true,
      )}">${e(fmtPp(c.gainPp))}</td><td>${e(fmtPp(c.gainCorrectedPp))}</td><td>${
        c.pAdjusted == null ? '—' : e(c.pAdjusted.toFixed(3).replace('.', ','))
      }</td><td><span class="badge ${DECISION_BADGE[c.decision]}">${e(DECISION_LABEL[c.decision])}</span>${
        cycleHoldLabels(c).length ? `<span class="why">${e(cycleHoldLabels(c).join(', '))}</span>` : ''
      }</td><td>${e(fmtUsd(c.costUsd))}</td><td>${e(fmtUsd(c.cumulativeCostUsd))}</td></tr>`,
    )
    .join('');
  const timeline = r.cycles
    .map(
      (c) => `<div class="milestone"><div class="when">${e(c.label)}</div><div class="dot-col"><span class="dot ${
        c.decision === 'promoted' ? 'done' : c.decision === 'stopped' ? 'stop' : ''
      }"></span><span class="line"></span></div><div class="body"><h3>${
        c.decision === 'promoted'
          ? `Promovida: ${e(c.championLabel)}`
          : c.decision === 'stopped'
            ? 'Ciclo interrompido'
            : `Régua manteve o título (${e(DECISION_LABEL[c.decision])})`
      }</h3><p>${e(
        `${c.variants} variante(s) contra a régua (${c.controlId === 'original' ? 'prompt original' : 'campeão anterior'}). Δ bruto ${fmtPp(
          c.gainPp,
        )}${c.gainCorrectedPp != null ? `, corrigido ${fmtPp(c.gainCorrectedPp)}` : ''}${
          c.minGainPp != null ? `, margem exigida ${fmtPp(c.minGainPp)}` : ''
        }${c.reeval ? `; ${cycleReevalText(c.reeval)}` : ''}${cycleHoldText(c) ? `; ${cycleHoldText(c)}` : ''}.`.replace(/\.\.$/, '.'),
      )}</p><div class="tags"><span class="tag">custo ${e(fmtUsd(c.costUsd))}</span>${
        c.technique ? `<span class="tag highlight">${e(c.technique)}</span>` : ''
      }<span class="tag">run ${e(c.runId.slice(0, 8))}</span></div></div></div>`,
    )
    .join('');
  // left#2: sessão sem mudança diz POR QUE o original segurou e o que mudar.
  const porque = r.noChange
    ? `<div class="callout warn"><h3>Por que o original segurou</h3><p>${e(noChangeText(r.noChange))}</p></div>`
    : '';
  return `${porque}${cyclesChart(r)}<div class="milestones">${timeline}</div>
<div class="table-wrap"><table><thead><tr><th>Ciclo</th><th>Régua</th><th>Melhor</th><th>Δ bruto</th><th>Δ corrigido</th><th>p aj.</th><th>Decisão</th><th>Custo</th><th>Acumulado</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function costSection(r: SessionReport): string {
  const c = r.cost;
  if (c.pairs === 0) {
    return `<div class="callout warn"><h3>Custo por chamada não medido</h3><p>${e(c.basis)}</p></div>`;
  }
  const bars = compareBars([
    { label: 'Custo por chamada', a: c.original.meanCostUsd, b: c.champion.meanCostUsd, fmt: (x) => fmtUsd(x) },
    { label: 'Tokens de entrada', a: c.original.meanTokensIn, b: c.champion.meanTokensIn, fmt: (x) => fmtInt(x) },
    { label: 'Tokens de saída', a: c.original.meanTokensOut, b: c.champion.meanTokensOut, fmt: (x) => fmtInt(x) },
    { label: 'Latência (ms)', a: c.original.meanLatencyMs, b: c.champion.meanLatencyMs, fmt: (x) => fmtInt(x) },
  ]);
  const proj = c.projection
    ? `<div class="table-wrap"><table><thead><tr><th>Volume</th><th>Original</th><th>Campeão</th><th>Δ</th></tr></thead><tbody>
<tr><td>1 chamada</td><td>${e(fmtUsd(c.original.meanCostUsd))}</td><td>${e(fmtUsd(c.champion.meanCostUsd))}</td><td class="${tone(c.deltaCostPerCallUsd, false)}">${e(fmtSignedUsd(c.deltaCostPerCallUsd))}</td></tr>
${c.per1kCalls ? `<tr><td>1.000 chamadas</td><td>${e(fmtUsd(c.per1kCalls.originalUsd))}</td><td>${e(fmtUsd(c.per1kCalls.championUsd))}</td><td class="${tone(c.per1kCalls.deltaUsd, false)}">${e(fmtSignedUsd(c.per1kCalls.deltaUsd))}</td></tr>` : ''}
<tr><td>${e(fmtInt(c.projection.callsPerMonth))} / mês</td><td>${e(fmtUsd(c.projection.originalUsd))}</td><td>${e(fmtUsd(c.projection.championUsd))}</td><td class="${tone(c.projection.deltaUsd, false)}">${e(fmtSignedUsd(c.projection.deltaUsd))}</td></tr>
</tbody></table></div>`
    : '';
  const notes: string[] = [];
  if (c.paybackCalls != null) notes.push(`O campeão é mais barato: a otimização (${fmtUsd(r.optimization.totalUsd)}) se paga em ${fmtInt(c.paybackCalls)} chamada(s).`);
  if (c.extraUsdPer1kPerPp != null) notes.push(`O campeão custa mais: cada p.p. de qualidade sai por ${fmtUsd(c.extraUsdPer1kPerPp)} a mais a cada 1.000 chamadas.`);
  if (c.deltaTokensIn != null) notes.push(`Δ de ${fmtSignedNumber(c.deltaTokensIn)} tokens de entrada por chamada ≈ o tamanho do system prompt (a pergunta é a mesma nos dois lados).`);
  return `<p class="basis">${e(c.basis)} — ${c.pairs} par(es).</p>${bars}${proj}${notes.map((n) => `<div class="callout"><p>${e(n)}</p></div>`).join('')}`;
}

function optimizationSection(r: SessionReport): string {
  const o = r.optimization;
  const acc = o.accuracy
    ? `<div class="tags"><span class="tag">${o.accuracy.exact} chamada(s) com custo exato</span><span class="tag">${o.accuracy.estimated} estimada(s)</span>${
        o.accuracy.unknown ? `<span class="tag warn">${o.accuracy.unknown} desconhecida(s)</span>` : ''
      }</div>`
    : '';
  const budget =
    o.budgetUsd != null
      ? `<div class="meter" role="img" aria-label="Uso do orçamento"><div class="meter-fill" style="width:${Math.min(100, o.budgetUsedPct ?? 0)}%"></div></div><p class="muted">${e(
          `${fmtUsd(o.totalUsd)} de ${fmtUsd(o.budgetUsd)} (${fmtPct(o.budgetUsedPct, false)} do teto)`,
        )}</p>`
      : `<p class="muted">${e(`Total gasto: ${fmtUsd(o.totalUsd)} (sessão sem teto registrado).`)}</p>`;
  const extra = [
    o.pendingUsd > 0 ? `pendente sem custo apurado: ${fmtUsd(o.pendingUsd)}` : '',
    o.sessionOverheadUsd != null && o.sessionOverheadUsd > 0 ? `fora das runs (reescritor/reflexão): ${fmtUsd(o.sessionOverheadUsd)}` : '',
  ].filter(Boolean);
  const extraHtml = extra.length ? `<div class="tags">${extra.map((t) => `<span class="tag">${e(t)}</span>`).join('')}</div>` : '';
  return `${budget}${roleBars(r)}${acc}${extraHtml}`;
}

function promptSection(r: SessionReport): string {
  const p = r.prompts;
  if (!p.changed) {
    return `<div class="callout"><p>${e(
      r.noChange ? `Nenhuma variante foi promovida: o prompt campeão é o original. ${noChangeText(r.noChange)}` : 'Nenhuma variante foi promovida: o prompt campeão é o original.',
    )}</p></div><details><summary>Prompt original</summary><div class="details-body"><pre class="prompt">${e(
      p.original || '(vazio)',
    )}</pre></div></details>`;
  }
  const ops = diffLines(p.original, p.champion);
  const diff = ops
    .map(
      (o) =>
        `<div class="dl ${o.kind}"><span class="sign">${o.kind === 'add' ? '+' : o.kind === 'del' ? '−' : ' '}</span><span class="txt">${e(
          o.text || ' ',
        )}</span></div>`,
    )
    .join('');
  return `<div class="tags"><span class="tag highlight">${e(p.championLabel)}</span>${
    p.promotedAtIteration != null ? `<span class="tag">promovido no ciclo ${p.promotedAtIteration + 1}</span>` : ''
  }<span class="tag">+${p.diff.linesAdded} / −${p.diff.linesRemoved} linhas</span><span class="tag">${e(fmtSignedNumber(p.diff.charsDelta))} caracteres (≈ ${e(
    fmtSignedNumber(p.diff.approxTokensDelta),
  )} tokens)</span></div>
<div class="code-panel diff"><span class="code-label">diff original → campeão</span>${diff}</div>
<details><summary>Prompt campeão (texto integral)</summary><div class="details-body"><pre class="prompt">${e(p.champion)}</pre></div></details>
<details><summary>Prompt original (texto integral)</summary><div class="details-body"><pre class="prompt">${e(p.original || '(vazio)')}</pre></div></details>`;
}

function warningsSection(r: SessionReport): string {
  if (r.warnings.length === 0) return '<p class="muted">Nenhuma ressalva: a leitura acima vale como está.</p>';
  return `<div class="risk-grid">${r.warnings
    .map((w) => `<div class="risk-row"><div><span class="badge med">RESSALVA</span></div><div class="risk-name">${e(w)}</div></div>`)
    .join('')}</div>`;
}

function methodSection(r: SessionReport): string {
  const s = r.session;
  const rows: [string, string][] = [
    ['Modelo sob teste', s.modelId],
    ['Juízes', s.judgeModelIds.join(', ') || '—'],
    ['Gerador de cenários', s.datagenModelId],
    ['Reescritor', s.optimizerModelId ?? s.datagenModelId],
    ['Início', s.startedAt],
    ['Fim', s.finishedAt ?? '—'],
    ['Convergência', s.convergedAtIteration != null ? `ciclo ${s.convergedAtIteration + 1} (${s.convergenceReason ?? '—'})` : '—'],
    ['Parada', s.stoppedReason ? `${s.stoppedReason}${s.stoppedAtPhase ? ` em ${s.stoppedAtPhase}` : ''}` : '—'],
  ];
  return `<div class="table-wrap"><table class="kv"><tbody>${rows
    .map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`)
    .join('')}</tbody></table></div>
<div class="code-panel"><span class="code-label">reproduzir / aprofundar</span><pre><code>prompt-builder sessions show ${e(s.id)}
prompt-builder sessions report ${e(s.id)} --json
prompt-builder sessions winner ${e(s.id)} --prompt-only</code></pre></div>`;
}

// ---------------------------------------------------------------------------
// CSS (tokens do Plannotator; claro por padrão, escuro por preferência)
// ---------------------------------------------------------------------------

const CSS = `
:root{--background:oklch(0.97 0.005 260);--foreground:oklch(0.18 0.02 260);--card:oklch(1 0 0);--card-foreground:oklch(0.18 0.02 260);--primary:oklch(0.50 0.25 280);--primary-foreground:oklch(1 0 0);--secondary:oklch(0.50 0.18 180);--muted:oklch(0.92 0.01 260);--muted-foreground:oklch(0.40 0.02 260);--accent:oklch(0.60 0.22 50);--destructive:oklch(0.50 0.25 25);--success:oklch(0.45 0.20 150);--warning:oklch(0.55 0.18 85);--border:oklch(0.88 0.01 260);--code-bg:oklch(0.92 0.01 260);--font-sans:'Inter',system-ui,-apple-system,sans-serif;--font-mono:'JetBrains Mono','Fira Code',ui-monospace,monospace;--font-display:ui-serif,Georgia,'Times New Roman',serif;--radius:0.625rem;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--background:oklch(0.15 0.02 260);--foreground:oklch(0.90 0.01 260);--card:oklch(0.22 0.02 260);--card-foreground:oklch(0.90 0.01 260);--muted:oklch(0.26 0.02 260);--muted-foreground:oklch(0.72 0.02 260);--primary:oklch(0.75 0.18 280);--primary-foreground:oklch(0.15 0.02 260);--accent:oklch(0.70 0.20 60);--border:oklch(0.35 0.02 260);--code-bg:oklch(0.26 0.02 260);--destructive:oklch(0.65 0.20 25);--success:oklch(0.72 0.17 150);--warning:oklch(0.75 0.15 85)}}
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font-sans);background:var(--background);color:var(--foreground);line-height:1.65;font-size:15px;-webkit-font-smoothing:antialiased}
.container{max-width:1080px;margin:0 auto;padding:64px 24px}
.eyebrow{font-family:var(--font-mono);font-size:.72rem;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground)}
header h1{font-family:var(--font-display);font-size:2rem;font-weight:500;margin:8px 0 24px;line-height:1.2}
.prompt-box{background:var(--muted);border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 24px;border-left:4px solid var(--primary)}
.prompt-box.verdict-melhorou{border-left-color:var(--success)}.prompt-box.verdict-piorou{border-left-color:var(--destructive)}.prompt-box.verdict-inconclusivo{border-left-color:var(--warning)}
.prompt-label{font-family:var(--font-mono);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);display:block;margin-bottom:4px}
.prompt-box p{font-size:1rem;line-height:1.55}
.summary-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin:32px 0}
.stat-card{border:1.5px solid var(--border);border-radius:var(--radius);padding:16px 18px;text-align:center;background:var(--card)}
.stat-value{font-family:var(--font-display);font-size:1.45rem;font-weight:500;display:block;color:var(--foreground);line-height:1.25}
.stat-card.good .stat-value{color:var(--success)}.stat-card.bad .stat-value{color:var(--destructive)}
.stat-label{font-family:var(--font-mono);font-size:.68rem;font-weight:500;text-transform:uppercase;letter-spacing:.06em;color:var(--muted-foreground);margin-top:6px;display:block}
.stat-hint{font-size:.72rem;color:var(--muted-foreground);display:block;margin-top:2px}
section{margin-top:64px}
.section-header{display:flex;align-items:baseline;gap:16px;margin-bottom:24px;padding-bottom:8px;border-bottom:1.5px solid var(--border)}
.section-number{font-family:var(--font-mono);font-size:.75rem;font-weight:600;color:var(--primary)}
.section-header h2{font-family:var(--font-display);font-size:1.4rem;font-weight:500}
.callout{border-left:3px solid var(--primary);padding:16px 24px;margin:16px 0;background:var(--card);border-radius:0 var(--radius) var(--radius) 0}
.callout.warn{border-left-color:var(--warning)}
.callout h3{font-family:var(--font-display);font-size:1.05rem;font-weight:500;margin-bottom:4px}
.callout p{font-size:.92rem;color:var(--muted-foreground);line-height:1.55}
.decide-with{font-family:var(--font-mono);font-size:.72rem;color:var(--primary);font-weight:500;display:block;margin-top:8px}
.tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.tag{font-family:var(--font-mono);font-size:.68rem;padding:2px 8px;border-radius:calc(var(--radius) - 4px);background:var(--muted);color:var(--muted-foreground)}
.tag.highlight{background:color-mix(in oklab,var(--primary) 12%,transparent);color:var(--primary)}
.tag.warn{background:color-mix(in oklab,var(--warning) 15%,transparent);color:var(--warning)}
.badge{font-family:var(--font-mono);font-size:.66rem;font-weight:600;padding:2px 8px;border-radius:calc(var(--radius) - 4px);text-transform:uppercase;letter-spacing:.04em;white-space:nowrap}
.badge.high{background:color-mix(in oklab,var(--destructive) 15%,transparent);color:var(--destructive)}
.badge.med{background:color-mix(in oklab,var(--warning) 15%,transparent);color:var(--warning)}
.badge.low{background:color-mix(in oklab,var(--success) 15%,transparent);color:var(--success)}
.badge.neutral{background:var(--muted);color:var(--muted-foreground)}
.why{display:block;font-size:.7rem;color:var(--muted-foreground);margin-top:2px}
.diagram-panel{border:1.5px solid var(--border);border-radius:var(--radius);padding:24px;margin:24px 0;background:var(--card)}
.diagram-caption{font-family:var(--font-mono);font-size:.72rem;color:var(--muted-foreground);display:block;margin-top:8px;text-align:center}
svg text{font-family:var(--font-mono);font-size:13px;fill:var(--muted-foreground)}
svg .rowlabel{font-family:var(--font-sans);font-size:14px;fill:var(--foreground)}
svg .barval{fill:var(--foreground)}
svg .flag{fill:var(--success);font-size:12px;font-weight:600}
svg .grid{stroke:var(--border);stroke-width:1}
svg polyline{fill:none;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round}
.s-control{stroke:var(--muted-foreground);stroke-dasharray:6 5}.s-control-dot{fill:var(--muted-foreground)}
.s-best{stroke:var(--accent)}.s-best-dot{fill:var(--accent)}
.s-champ{stroke:var(--primary)}.s-champ-dot{fill:var(--primary)}
.bar-a{fill:var(--muted-foreground);opacity:.55}.bar-b{fill:var(--primary)}.bar-role{fill:var(--secondary)}
.legend{display:flex;gap:18px;justify-content:center;flex-wrap:wrap;margin-top:10px;font-family:var(--font-mono);font-size:.72rem;color:var(--muted-foreground)}
.legend .k{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.s-control-k{background:var(--muted-foreground)}.s-best-k{background:var(--accent)}.s-champ-k{background:var(--primary)}
.bar-a-k{background:var(--muted-foreground);opacity:.55}.bar-b-k{background:var(--primary)}
.v-resolve{background:var(--success)}.v-parcial{background:var(--warning)}.v-nao{background:var(--destructive)}
.verdicts{margin:24px 0}.vrow{display:grid;grid-template-columns:90px 1fr 64px;gap:14px;align-items:center;margin-top:10px}
.vlabel{font-size:.9rem;font-weight:500}.vpct{font-family:var(--font-mono);font-size:.8rem;text-align:right;color:var(--muted-foreground)}
.vbar{display:flex;height:22px;border-radius:6px;overflow:hidden;border:1px solid var(--border)}
.seg{display:flex;align-items:center;justify-content:center;font-family:var(--font-mono);font-size:.7rem;color:var(--primary-foreground);min-width:18px}
.v-parcial.seg{color:oklch(0.18 0.02 260)}
.milestones{display:flex;flex-direction:column;margin:32px 0}
.milestone{display:grid;grid-template-columns:90px 28px 1fr;gap:0 18px}
.milestone .when{text-align:right;font-family:var(--font-mono);font-size:.75rem;color:var(--muted-foreground);padding-top:4px}
.milestone .dot-col{display:flex;flex-direction:column;align-items:center}
.milestone .dot{width:14px;height:14px;border-radius:50%;background:var(--card);border:3px solid var(--primary);flex-shrink:0;margin-top:6px}
.milestone .dot.done{background:var(--success);border-color:var(--success)}.milestone .dot.stop{background:var(--destructive);border-color:var(--destructive)}
.milestone .line{width:2px;flex:1;background:var(--border);margin:4px 0}.milestone:last-child .line{display:none}
.milestone .body{padding-bottom:30px}.milestone .body h3{font-family:var(--font-display);font-size:1.1rem;font-weight:500;margin-bottom:4px}
.milestone .body p{font-size:.88rem;color:var(--muted-foreground);max-width:680px}
.table-wrap{overflow-x:auto;border:1.5px solid var(--border);border-radius:var(--radius);margin:16px 0;background:var(--card)}
table{width:100%;border-collapse:collapse;font-size:.86rem}
th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
thead th{font-family:var(--font-mono);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);background:var(--muted)}
tbody tr:last-child td,tbody tr:last-child th{border-bottom:none}
td.good{color:var(--success);font-weight:600}td.bad{color:var(--destructive);font-weight:600}
table.kv th{width:220px;font-weight:500;color:var(--muted-foreground)}
.basis{color:var(--muted-foreground);font-size:.92rem}
.muted{color:var(--muted-foreground);font-size:.9rem}
.meter{height:12px;border-radius:999px;background:var(--muted);overflow:hidden;border:1px solid var(--border);margin:8px 0}
.meter-fill{height:100%;background:var(--primary)}
.code-panel{background:var(--code-bg);border-radius:var(--radius);padding:20px 24px;overflow-x:auto;margin:16px 0;border:1.5px solid var(--border)}
.code-label{font-family:var(--font-mono);font-size:.7rem;color:var(--muted-foreground);display:block;margin-bottom:8px}
.code-panel pre{font-family:var(--font-mono);font-size:.84rem;line-height:1.55;color:var(--foreground);white-space:pre-wrap}
.diff .dl{display:grid;grid-template-columns:18px 1fr;font-family:var(--font-mono);font-size:.82rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;border-radius:4px;padding:0 6px}
.diff .dl.add{background:color-mix(in oklab,var(--success) 14%,transparent)}.diff .dl.add .sign{color:var(--success)}
.diff .dl.del{background:color-mix(in oklab,var(--destructive) 12%,transparent);text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--destructive) 50%,transparent)}.diff .dl.del .sign{color:var(--destructive)}
.diff .dl.eq{color:var(--muted-foreground)}
pre.prompt{font-family:var(--font-mono);font-size:.82rem;white-space:pre-wrap;word-break:break-word;line-height:1.55}
details{border:1.5px solid var(--border);border-radius:var(--radius);margin:12px 0;background:var(--card)}
summary{font-weight:500;padding:14px 20px;cursor:pointer;list-style:none}
summary::before{content:'▸';display:inline-block;margin-right:8px;transition:transform .2s}
details[open] summary::before{transform:rotate(90deg)}
.details-body{padding:0 20px 20px}
.risk-grid{border:1.5px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--card)}
.risk-row{display:grid;grid-template-columns:auto 1fr;gap:20px;padding:14px 20px;align-items:center;border-bottom:1px solid var(--border)}
.risk-row:last-child{border-bottom:none}.risk-name{font-size:.9rem}
footer{margin-top:72px;padding-top:16px;border-top:1.5px solid var(--border);font-family:var(--font-mono);font-size:.7rem;color:var(--muted-foreground)}
@media (max-width:720px){.container{padding:40px 16px}.milestone{grid-template-columns:64px 24px 1fr;gap:0 10px}.vrow{grid-template-columns:70px 1fr 54px}}
@media print{body{background:#fff}.container{padding:0}details{break-inside:avoid}}
`;

/** Página HTML completa do relatório (autocontida, sem rede). */
export function renderSessionReportHtml(r: SessionReport): string {
  const body = [
    header(r),
    summaryStrip(r),
    section(1, 'Quanto melhorou', qualitySection(r), 'qualidade'),
    section(2, 'Ciclos de melhoria', cyclesSection(r), 'ciclos'),
    section(3, 'Quanto a mudança mexe no custo de uso', costSection(r), 'custo'),
    section(4, 'Quanto custou otimizar', optimizationSection(r), 'otimizacao'),
    section(5, 'O que mudou no prompt', promptSection(r), 'prompt'),
    section(6, 'Ressalvas', warningsSection(r), 'ressalvas'),
    section(7, 'Método e reprodução', methodSection(r), 'metodo'),
  ].join('\n');
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="plannotator-theme" content="host">
<meta name="generator" content="prompt-builder ${e(r.format)}">
<title>${e(`Relatório de ciclos — ${r.session.theme || r.session.id}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main class="container">
${body}
<footer>prompt-builder · ${e(r.format)} · sessão ${e(r.session.id)} · gerado em ${e(r.generatedAt)}</footer>
</main>
</body>
</html>
`;
}
