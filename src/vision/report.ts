// BENCHMARK DE VISÃO — relatório (Markdown + HTML).
//
// Todo número sai do RECORD (fonte única): o relatório não recalcula nada, só
// formata. A seção "Metodologia" é parte do contrato — ela diz exatamente como
// o acerto é decidido (ponto na caixa, rótulo normalizado) e o que NÃO foi
// medido, para o número não virar promessa.

import type { VisionContestant, VisionMapAggregate, VisionRunRecord } from '../engine/vision/types.js';

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const usd = (v: number): string => (v === 0 ? '$0' : `$${v.toFixed(v < 0.01 ? 5 : 4)}`);
const lat = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function familiaNome(family: string): string {
  return { bootstrap: 'Bootstrap', react95: 'React95', fluent: 'Fluent UI', material: 'Material 3', macos: 'macOS' }[family] ?? family;
}

/** Tabela de placar (a manchete do relatório). */
function placarRows(rec: VisionRunRecord): string[] {
  const rows = [
    '| # | modelo | nota | mapa F1 | rótulo F1 | ação pass | erro | custo | tokens in/out | latência |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  rec.contestants.forEach((c, i) => {
    rows.push(
      `| ${i + 1} | \`${c.modelId}\` | **${pct(c.score)}** | ${c.map ? pct(c.map.f1) : '—'} | ${
        c.map ? pct(c.map.labelF1) : '—'
      } | ${c.action ? pct(c.action.passRate) : '—'} | ${c.errors + c.parseFailures} | ${usd(c.costUsd)} | ${
        c.tokensIn
      }/${c.tokensOut} | ${lat(c.meanLatencyMs)} |`,
    );
  });
  return rows;
}

function familiaHeaders(rec: VisionRunRecord): string[] {
  return ['família', ...rec.contestants.map((c) => c.modelId)];
}

/** Dados da tabela por família (o `label` de cada linha vem de `familiaNome`). */
function familiaData(rec: VisionRunRecord, campo: 'map' | 'action'): string[][] {
  const familias = new Set<string>();
  for (const c of rec.contestants) {
    for (const f of Object.keys(c[campo]?.byFamily ?? {})) familias.add(f);
  }
  return [...familias].sort().map((f) => [
    familiaNome(f),
    ...rec.contestants.map((c) => {
      const v = c[campo]?.byFamily[f];
      if (!v) return '—';
      if (campo === 'map') {
        const m = v as { f1: number; scenes: number };
        return `${pct(m.f1)} (${m.scenes})`;
      }
      const a = v as { passRate: number; tasks: number };
      return `${pct(a.passRate)} (${a.tasks})`;
    }),
  ]);
}

function familiaRows(contestants: readonly VisionContestant[], campo: 'map' | 'action'): string[] {
  const familias = new Set<string>();
  for (const c of contestants) {
    const agg = c[campo];
    if (!agg) continue;
    for (const f of Object.keys(agg.byFamily)) familias.add(f);
  }
  if (familias.size === 0) return ['—'];
  if (campo === 'map') {
    const rows = [
      `| família | ${contestants.map((c) => `\`${c.modelId}\``).join(' | ')} |`,
      `|---|${contestants.map(() => '---:').join('|')}|`,
    ];
    for (const f of [...familias].sort()) {
      const cells = contestants.map((c) => {
        const v = c.map?.byFamily[f];
        return v ? `${pct(v.f1)} (${v.scenes})` : '—';
      });
      rows.push(`| ${familiaNome(f)} | ${cells.join(' | ')} |`);
    }
    return rows;
  }
  const rows = [
    `| família | ${contestants.map((c) => `\`${c.modelId}\``).join(' | ')} |`,
    `|---|${contestants.map(() => '---:').join('|')}|`,
  ];
  for (const f of [...familias].sort()) {
    const cells = contestants.map((c) => {
      const v = c.action?.byFamily[f];
      return v ? `${pct(v.passRate)} (${v.tasks})` : '—';
    });
    rows.push(`| ${familiaNome(f)} | ${cells.join(' | ')} |`);
  }
  return rows;
}

function tipoRows(map: VisionMapAggregate): string[] {
  const tipos = Object.entries(map.byElementType).sort((a, b) => b[1].elements - a[1].elements);
  if (tipos.length === 0) return ['—'];
  const rows = ['| tipo | elementos | vistos | recall |', '|---|---:|---:|---:|'];
  for (const [tipo, v] of tipos) rows.push(`| ${tipo} | ${v.elements} | ${v.matched} | ${pct(v.recall)} |`);
  return rows;
}

/** O relatório em Markdown (stdout de `vision report`). */
export function renderVisionReportMarkdown(rec: VisionRunRecord): string {
  const linhas: string[] = [];
  linhas.push(`# Benchmark de visão — \`${rec.id}\``);
  linhas.push('');
  linhas.push(
    `- **dataset**: \`vision-dataset@${rec.dataset.version}\` (hash \`${rec.dataset.hash.slice(0, 16)}…\`) · ${rec.dataset.scenes.length} cenário(s)`,
  );
  linhas.push(
    `- **modos**: ${rec.config.tasks.join(' + ')} · **coordenadas pedidas**: ${rec.config.coordSpace === 'pixels' ? 'pixels 0–1920/0–1080' : 'normalizado 0–1000'}`,
  );
  linhas.push(
    `- **modelos**: ${rec.contestants.length} · **células**: ${rec.totals.calls} (erros ${rec.totals.errors}, puladas ${rec.totals.skipped})`,
  );
  linhas.push(`- **custo medido**: ${usd(rec.totals.costUsd)} · **status**: ${rec.status}`);
  linhas.push(`- **prompt**: ${rec.promptVersion} · **início**: ${rec.startedAt}${rec.finishedAt ? ` · **fim**: ${rec.finishedAt}` : ''}`);
  linhas.push('');
  if (rec.warnings.length > 0) {
    linhas.push('> ⚠️ ' + rec.warnings.join('\n> ⚠️ '));
    linhas.push('');
  }
  linhas.push('## Placar');
  linhas.push('');
  linhas.push('Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).');
  linhas.push('');
  linhas.push(...placarRows(rec));
  linhas.push('');
  if (rec.config.tasks.includes('map')) {
    linhas.push('## Modo mapa — todos os elementos interativos');
    linhas.push('');
    if (rec.config.tasks.includes('action')) {
      linhas.push('### Por família');
      linhas.push('');
      linhas.push(...familiaRows(rec.contestants, 'map'));
      linhas.push('');
    }
    const melhor = rec.contestants[0];
    if (melhor?.map) {
      linhas.push(`### Por tipo de elemento — \`${melhor.modelId}\``);
      linhas.push('');
      linhas.push(...tipoRows(melhor.map));
      linhas.push('');
    }
  }
  if (rec.config.tasks.includes('action')) {
    linhas.push('## Modo ação — o que clicar');
    linhas.push('');
    linhas.push(...familiaRows(rec.contestants, 'action'));
    linhas.push('');
    const porAcao = new Set<string>();
    for (const c of rec.contestants) for (const a of Object.keys(c.action?.byAction ?? {})) porAcao.add(a);
    if (porAcao.size > 0) {
      linhas.push('| ação | ' + rec.contestants.map((c) => `\`${c.modelId}\``).join(' | ') + ' |');
      linhas.push('|---|' + rec.contestants.map(() => '---:').join('|') + '|');
      for (const a of [...porAcao].sort()) {
        const cells = rec.contestants.map((c) => {
          const v = c.action?.byAction[a];
          return v ? `${pct(v.passRate)} (${v.tasks})` : '—';
        });
        linhas.push(`| ${a} | ${cells.join(' | ')} |`);
      }
      linhas.push('');
    }
  }
  const problemas = rec.cells.filter((c) => c.status === 'error' || !c.parseOk);
  if (problemas.length > 0) {
    linhas.push('## Células com problema');
    linhas.push('');
    linhas.push('| célula | modelo | status | motivo |');
    linhas.push('|---|---|---|---|');
    for (const c of problemas.slice(0, 20)) {
      const motivo = c.status === 'error' ? (c.error ?? 'erro') : c.error ?? 'saída não parseável';
      linhas.push(`| \`${c.cellId}\` | \`${c.modelId}\` | ${c.status} | ${motivo.replace(/\|/g, '/')} |`);
    }
    if (problemas.length > 20) linhas.push(`| … | | | +${problemas.length - 20} |`);
    linhas.push('');
  }
  linhas.push('## Metodologia');
  linhas.push('');
  linhas.push('- A verdade de cada cenário vem do DOM renderizado: caixa de cada controle interativo em pixels de uma imagem 1920×1080 (não é anotação humana).');
  linhas.push('- **Mapa**: uma previsão casa com um elemento quando o ponto cai DENTRO da caixa. O casamento é um-para-um, guloso, por qualidade (rótulo > tipo > proximidade do centro). Precisão = casados/previsões; recall = casados/elementos; F1 harmônico. Rótulo normaliza acento/caixa e aceita contenção e aliases; tipo compara o vocabulário fechado.');
  linhas.push('- **Ação**: a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto digitado confere (quando há texto).');
  linhas.push('- Erro de chamada conta como resposta errada no denominador; célula pulada por orçamento/cancelamento fica FORA das métricas (o status da run diz que o placar é parcial).');
  linhas.push('- Coordenada fora do espaço pedido é convertida pelo parser (0–1000 ↔ pixels) e registrada na célula (`coordScale`); nenhuma técnica de grade/zoom/SoM é aplicada nesta versão.');
  linhas.push('');
  return linhas.join('\n');
}

function htmlTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const th = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const tr = rows
    .map(
      (r) =>
        `<tr>${r
          .map((c) => {
            // Escapa PRIMEIRO e só depois aplica `code`/`**forte**` — célula vem
            // de modelo/dataset e não pode injetar HTML no relatório.
            const seguro = esc(c)
              .replace(/`([^`]*)`/g, '<code>$1</code>')
              .replace(/\*\*([^*]*)\*\*/g, '<strong>$1</strong>');
            return `<td>${seguro}</td>`;
          })
          .join('')}</tr>`,
    )
    .join('\n');
  return `<table><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

/** HTML autocontido do relatório (mesmos números, tabelas legíveis). */
export function renderVisionReportHtml(rec: VisionRunRecord): string {
  const blocos: string[] = [];
  blocos.push(`<h1>Benchmark de visão — <code>${esc(rec.id)}</code></h1>`);
  blocos.push(
    `<p class="meta"><strong>dataset</strong> <code>vision-dataset@${esc(rec.dataset.version)}</code> ` +
      `(hash <code>${esc(rec.dataset.hash.slice(0, 16))}…</code>) · <strong>${rec.dataset.scenes.length}</strong> cenário(s) · ` +
      `<strong>modos</strong> ${esc(rec.config.tasks.join(' + '))} · <strong>coordenadas</strong> ` +
      `${rec.config.coordSpace === 'pixels' ? 'pixels 1920×1080' : 'normalizado 0–1000'} · ` +
      `<strong>status</strong> ${esc(rec.status)} · <strong>custo medido</strong> ${usd(rec.totals.costUsd)}</p>`,
  );
  if (rec.warnings.length > 0) {
    blocos.push(`<blockquote>⚠️ ${rec.warnings.map(esc).join('<br>⚠️ ')}</blockquote>`);
  }
  blocos.push('<h2>Placar</h2>');
  blocos.push(
    `<p class="sub">Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).</p>` +
      htmlTable(
        ['#', 'modelo', 'nota', 'mapa F1', 'rótulo F1', 'ação pass', 'erros', 'custo', 'tokens in/out', 'latência'],
        rec.contestants.map((c, i) => [
          String(i + 1),
          `\`${c.modelId}\``,
          `**${pct(c.score)}**`,
          c.map ? pct(c.map.f1) : '—',
          c.map ? pct(c.map.labelF1) : '—',
          c.action ? pct(c.action.passRate) : '—',
          String(c.errors + c.parseFailures),
          usd(c.costUsd),
          `${c.tokensIn}/${c.tokensOut}`,
          lat(c.meanLatencyMs),
        ]),
      ),
  );
  if (rec.config.tasks.includes('map')) {
    blocos.push('<h2>Modo mapa — todos os elementos interativos</h2>');
    blocos.push('<h3>Por família</h3>');
    blocos.push(htmlTable(familiaHeaders(rec), familiaData(rec, 'map')));
    const melhor = rec.contestants[0];
    if (melhor?.map) {
      blocos.push(`<h3>Por tipo de elemento — <code>${esc(melhor.modelId)}</code></h3>`);
      blocos.push(
        htmlTable(
          ['tipo', 'elementos', 'vistos', 'recall'],
          Object.entries(melhor.map.byElementType)
            .sort((a, b) => b[1].elements - a[1].elements)
            .map(([tipo, v]) => [tipo, String(v.elements), String(v.matched), pct(v.recall)]),
        ),
      );
    }
  }
  if (rec.config.tasks.includes('action')) {
    blocos.push('<h2>Modo ação — o que clicar</h2>');
    blocos.push('<h3>Por família</h3>');
    blocos.push(htmlTable(familiaHeaders(rec), familiaData(rec, 'action')));
    const acoes = new Set<string>();
    for (const c of rec.contestants) for (const a of Object.keys(c.action?.byAction ?? {})) acoes.add(a);
    if (acoes.size > 0) {
      blocos.push('<h3>Por ação</h3>');
      blocos.push(
        htmlTable(
          ['ação', ...rec.contestants.map((c) => c.modelId)],
          [...acoes].sort().map((a) => [
            a,
            ...rec.contestants.map((c) => {
              const v = c.action?.byAction[a];
              return v ? `${pct(v.passRate)} (${v.tasks})` : '—';
            }),
          ]),
        ),
      );
    }
  }
  const problemas = rec.cells.filter((c) => c.status === 'error' || !c.parseOk);
  if (problemas.length > 0) {
    blocos.push('<h2>Células com problema</h2>');
    blocos.push(
      htmlTable(
        ['célula', 'modelo', 'status', 'motivo'],
        problemas
          .slice(0, 40)
          .map((c) => [`\`${c.cellId}\``, `\`${c.modelId}\``, c.status, (c.status === 'error' ? c.error ?? 'erro' : c.error ?? 'saída não parseável')]),
      ),
    );
  }
  blocos.push('<h2>Metodologia</h2>');
  blocos.push(
    `<ul>
<li>A verdade vem do DOM renderizado: caixa de cada controle em pixels de uma imagem 1920×1080 (não é anotação humana).</li>
<li><strong>Mapa</strong>: casa quando o ponto cai DENTRO da caixa; um-para-um, guloso por qualidade (rótulo &gt; tipo &gt; proximidade). Precisão = casados/previsões, recall = casados/elementos, F1 harmônico. Rótulo normaliza acento/caixa, aceita contenção e aliases.</li>
<li><strong>Ação</strong>: passa quando a ação é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto confere (quando há texto).</li>
<li>Erro de chamada conta como resposta errada; célula pulada por orçamento/cancelamento fica FORA das métricas (status parcial da run).</li>
<li>Coordenada fora do espaço pedido é convertida pelo parser e registrada (<code>coordScale</code>); nenhuma técnica de grade/zoom/SoM nesta versão.</li>
</ul>`,
  );
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Benchmark de visão — ${esc(rec.id)}</title>
<style>
:root{color-scheme:light dark}*{box-sizing:border-box}
body{margin:0;padding:2rem 1.25rem;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0d10;color:#e8ecf1}
main{max-width:76rem;margin:0 auto}
h1{font-size:1.55rem;margin:0 0 .5rem}h2{margin:2rem 0 .6rem;font-size:1.2rem}h3{margin:1.4rem 0 .5rem;font-size:1rem;color:#b9c6d4}
p{margin:.45rem 0}p.meta{color:#c9d4df}p.sub{color:#9fb0c0;font-size:13.5px}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:#1b2129;padding:.1rem .3rem;border-radius:.3rem}
table{width:100%;border-collapse:collapse;margin:.6rem 0 1rem;font-size:13.5px;display:block;overflow-x:auto}
th,td{border-bottom:1px solid #232b35;padding:.45rem .5rem;text-align:right;white-space:nowrap}
th{color:#9fb0c0;font-weight:600}td:first-child,th:first-child{text-align:left}
blockquote{margin:.8rem 0;padding:.6rem .9rem;border-left:3px solid #b7791f;background:#1a1710;color:#f0d9a8}
ul{margin:.6rem 0;padding-left:1.2rem}li{margin:.3rem 0;color:#c9d4df}
</style></head><body><main>
${blocos.join('\n')}
</main></body></html>`;
}

/** Linha de resumo para o stdout em texto (`vision run`). */
export function renderVisionSummary(rec: VisionRunRecord): string {
  const linhas = [`Benchmark de visão ${rec.id} — ${rec.status}`];
  linhas.push(
    `dataset ${rec.dataset.version} · ${rec.dataset.scenes.length} cenário(s) · ${rec.config.tasks.join('+')} · ${usd(rec.totals.costUsd)}`,
  );
  for (const c of rec.contestants) {
    const partes = [`${c.modelId}: ${pct(c.score)}`];
    if (c.map) partes.push(`mapa F1 ${pct(c.map.f1)} (P ${pct(c.map.precision)} · R ${pct(c.map.recall)})`);
    if (c.action) partes.push(`ação ${pct(c.action.passRate)} (${c.action.passed}/${c.action.tasks})`);
    linhas.push(`  ${partes.join(' · ')}`);
  }
  return linhas.join('\n');
}
