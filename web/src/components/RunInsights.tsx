// Insights de run (F3 do PLANO-PARIDADE): "onde falhou", delta vs controle,
// drawer da variante (completo/diff/lado-a-lado) e diagnóstico do juiz.
//
// Reaproveita o vocabulário de `runShared` (VERDICT_META/verdictOf/trunc) e o
// diff linha-a-linha de `..//diff`. Tokens de veredito são DADO (contraste AA),
// não decoração — usar só os de `VERDICT_META`.
import { useMemo, useState } from 'react';
import type { RunRecord, Verdict } from '../api';
import type { RunRecord as EngineRunRecord } from '../engine/types';
import type { HumanReviewReason, VerdictErrorKind } from '../../../src/types.js';
import { diffLines } from '../diff';
import { Banner, DiffView, MiniLabel, Pre, SectionHead } from './primitives';
import { VERDICT_META, verdictOf, trunc, denseStages } from '../pages/runShared';
import { judgeScaleWarning, stageCountsInJudgeScore } from '../../../src/engine/verdictAggregate.js';
import {
  failureCategoryOf,
  groupVerdictFailures,
  verdictFailuresFromStages,
  type VerdictFailureCategory,
} from '../engine/refJudge';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/motion-ui/accordion';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';

// ----------------------------------------------------------------------------
// 1) FailureDigest — "por que perdeu", por variante
// ----------------------------------------------------------------------------

interface Falha {
  question: string;
  verdict: Verdict;
  motivo: string;
}

/**
 * Agrupa as falhas (veredito ≠ 'resolve') por contestant, pior primeiro, com a
 * explicação do juiz (refJudge `explanationByContestant` / listwise `motivo`).
 */
export function FailureDigest({ record }: { record: RunRecord }) {
  const porContestant = useMemo(() => {
    const mapa = new Map<string, Falha[]>();
    const contestants = record.contestants ?? [];
    for (const st of record.stages) {
      const question = st.spec?.question ?? `etapa ${st.index + 1}`;
      for (const c of contestants) {
        const rj = st.referenceJudge;
        const v: Verdict | undefined =
          rj?.verdictByContestant?.[c.id] ??
          st.judge?.verdictByContestant?.[c.id] ??
          verdictOf(st.judge?.judges?.[0]?.verdicts.find((x) => x.contestantId === c.id));
        if (!v || v === 'resolve') continue;
        const motivo =
          rj?.explanationByContestant?.[c.id] ??
          st.judge?.judges
            ?.map((j) => j.verdicts.find((x) => x.contestantId === c.id)?.motivo)
            .find((m) => m && m.trim()) ??
          '';
        const lista = mapa.get(c.id) ?? [];
        lista.push({ question, verdict: v, motivo });
        mapa.set(c.id, lista);
      }
    }
    // Pior primeiro: mais 'nao' acima de mais 'parcial'.
    const peso = (f: Falha[]): number => f.reduce((s, x) => s + (x.verdict === 'nao' ? 2 : 1), 0);
    return [...mapa.entries()].sort((a, b) => peso(b[1]) - peso(a[1]));
  }, [record]);

  if (!porContestant.length) return null;
  const label = (id: string): string =>
    (record.contestants ?? []).find((c) => c.id === id)?.label ?? id;

  return (
    <section className="flex flex-col gap-3">
      <SectionHead>Onde falhou</SectionHead>
      <div className="flex flex-col gap-3">
        {porContestant.map(([cid, falhas]) => (
          <div key={cid} className="rounded-xl border border-border bg-card p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{label(cid)}</span>
              <MiniLabel>{falhas.length} falha(s)</MiniLabel>
            </div>
            <ul className="flex flex-col gap-1.5">
              {falhas.map((f, i) => (
                <li key={i} className="flex flex-col gap-0.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${VERDICT_META[f.verdict].pill}`}
                    >
                      {VERDICT_META[f.verdict].label}
                    </span>
                    <span className="text-muted-foreground">{trunc(f.question, 90)}</span>
                  </div>
                  {f.motivo ? <p className="text-muted-foreground pl-1">{f.motivo}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// 2) DeltaBars — judge-score de cada variante vs o controle
// ----------------------------------------------------------------------------

/**
 * Barras de delta (pp) contra o controle, zero centralizado. Com n<10 etapas o
 * delta é UMA AMOSTRA — o aviso é obrigatório (orientação de amostra, §8.6).
 */
export function DeltaBars({
  record,
  controlId,
  onVariantClick,
}: {
  record: RunRecord;
  controlId?: string;
  onVariantClick?: (contestantId: string) => void;
}) {
  const scores = record.judgeScoreByContestant ?? {};
  const contestants = record.contestants ?? [];
  const control =
    controlId ??
    contestants.find((c) => c.isOriginal)?.id ??
    contestants.find((c) => c.id === 'carry')?.id;
  const base = control ? scores[control] : undefined;
  if (base === undefined || Object.keys(scores).length === 0) return null;
  // web-code#11: n = cenários que FORMAM o judge-score (a régua do delta) —
  // `stages.length` contava pulados, cortados e os julgados sem gabarito.
  const n = denseStages(record.stages).filter(stageCountsInJudgeScore).length;
  const deltas = contestants
    .filter((c) => c.id !== control && scores[c.id] !== undefined)
    .map((c) => ({ c, delta: (scores[c.id] ?? 0) - base }))
    .sort((a, b) => b.delta - a.delta);
  const maxAbs = Math.max(1, ...deltas.map((d) => Math.abs(d.delta)));

  return (
    <section className="flex flex-col gap-2">
      <SectionHead>Delta vs controle</SectionHead>
      {n < 10 ? (
        <p className="text-xs text-muted-foreground">
          n={n} — abaixo de 10 etapas o delta é só uma amostra; não trate como conclusão.
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        {deltas.map(({ c, delta }) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onVariantClick?.(c.id)}
            className="grid grid-cols-[minmax(0,10rem)_1fr_4rem] items-center gap-2 text-left"
            title="ver o prompt da variante"
          >
            <span className="truncate text-sm">{c.label}</span>
            <span className="relative h-4 rounded bg-muted">
              <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
              <span
                className={`absolute inset-y-0.5 rounded ${
                  delta >= 0 ? 'bg-resolve/70' : 'bg-nao/70'
                }`}
                style={
                  delta >= 0
                    ? { left: '50%', width: `${(Math.abs(delta) / maxAbs) * 50}%` }
                    : { right: '50%', width: `${(Math.abs(delta) / maxAbs) * 50}%` }
                }
              />
            </span>
            <span className="text-right text-sm tabular-nums">
              {delta >= 0 ? '+' : ''}
              {delta.toFixed(1)}pp
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// 3) VariantPromptDrawer — Completo / Diff / Lado-a-lado
// ----------------------------------------------------------------------------

type DrawerMode = 'completo' | 'diff' | 'lado';

/**
 * Drawer do system prompt de uma variante: completo, diff contra o controle
 * (`../diff`) ou lado-a-lado. Sem dependência nova — o overlay anima só
 * transform/opacity.
 */
export function VariantPromptDrawer({
  record,
  variantId,
  onClose,
}: {
  record: RunRecord | undefined;
  variantId: string | null;
  onClose: () => void;
}) {
  const [modo, setModo] = useState<DrawerMode>('completo');
  const variante = (record?.contestants ?? []).find((c) => c.id === variantId);
  const controle =
    (record?.contestants ?? []).find((c) => c.isOriginal) ??
    (record?.contestants ?? []).find((c) => c.id === 'carry');
  const diff = useMemo(
    () => (variante ? diffLines(controle?.systemPrompt ?? '', variante.systemPrompt ?? '') : []),
    [variante, controle],
  );
  if (!variante) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/20 sm:items-center"
      onClick={onClose}
    >
      <div
        className="flex max-h-[85vh] w-full max-w-3xl flex-col gap-3 rounded-2xl border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-base font-semibold">{variante.label}</h3>
          <div className="flex items-center gap-1">
            {(['completo', 'diff', 'lado'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setModo(m)}
                className={`rounded-lg px-2.5 py-1 text-xs capitalize ${
                  modo === m ? 'bg-muted font-medium' : 'text-muted-foreground'
                }`}
              >
                {m === 'lado' ? 'lado-a-lado' : m}
              </button>
            ))}
            <button
              type="button"
              onClick={onClose}
              className="ml-1 rounded-lg px-2.5 py-1 text-xs text-muted-foreground"
            >
              fechar
            </button>
          </div>
        </div>
        {modo === 'completo' ? <Pre>{variante.systemPrompt ?? ''}</Pre> : null}
        {modo === 'diff' ? <DiffView diff={diff} /> : null}
        {modo === 'lado' ? (
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <MiniLabel>Controle ({controle?.label ?? '—'})</MiniLabel>
              <Pre>{controle?.systemPrompt ?? ''}</Pre>
            </div>
            <div className="flex flex-col gap-1">
              <MiniLabel>Variante ({variante.label})</MiniLabel>
              <Pre>{variante.systemPrompt ?? ''}</Pre>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// 4) JudgeDiagnostics — contrato (auditoria), verbosidade, fairness, falhas do
//    avaliador agrupadas (IMPL-057) e revisão humana do gabarito (IMPL-112)
// ----------------------------------------------------------------------------

/** Cartão das seções de diagnóstico (mesmo do "Onde falhou"). */
const CARD = 'rounded-xl border border-border bg-card p-3';

/** Diagnóstico do juiz como o motor grava (tipo do espelho do motor). */
type JudgeDiag = NonNullable<EngineRunRecord['judgeDiagnostics']>;

/** Rótulo PT-BR da categoria do ErrorAtlas (quem falhou). */
const CATEGORY_LABEL: Record<VerdictFailureCategory, string> = {
  judge: 'juiz',
  reference: 'gabarito',
  infrastructure: 'infraestrutura',
  gateway: 'moderação',
  competitor: 'competidor',
};

/** Rótulo PT-BR da causa técnica (`VerdictErrorKind`). */
const CAUSE_LABEL: Record<VerdictErrorKind, string> = {
  judge_failed: 'juiz falhou',
  invalid_output: 'saída inválida do juiz',
  timeout: 'tempo esgotado',
  truncated: 'saída do juiz cortada',
  blocked: 'bloqueado pela moderação',
  competitor_error: 'erro do competidor',
  no_reference: 'sem gabarito',
};

/**
 * Linha de AUDITORIA do contrato do juiz (IMPL-057/IMPL-049): "juiz: <modelo>
 * (mesmo contrato desde a última run)"; quando mudou, o aviso "scores não
 * comparáveis". O hash (12 chars) fica SÓ no detalhe — o resumo não o mostra.
 */
function ContractAudit({ diag }: { diag: JudgeDiag }) {
  const audit = diag.contractAudit;
  // Record anterior à auditoria: sem âncora da run anterior, diz só o juiz.
  const line = audit?.line ?? `juiz: ${diag.contract.modelIds.join('+') || '(sem juiz)'}`;
  const detail = audit?.detail ?? `${line} · contrato ${diag.contract.hash.slice(0, 12)}`;
  return (
    <div className="flex flex-col gap-2">
      {audit?.changed ? (
        <Banner tone="warn">
          <strong>Contrato do juiz mudou desde a última run — scores não comparáveis.</strong> {line}
        </Banner>
      ) : (
        <p className="text-sm text-muted-foreground">{line}</p>
      )}
      <Accordion className="rounded-lg border border-border">
        <AccordionItem value="contrato-do-juiz-detalhe">
          <AccordionTrigger className="px-3 py-2 text-[12px] text-muted-foreground" headingLevel={4}>
            Detalhe do contrato
          </AccordionTrigger>
          <AccordionPanel className="px-3 pb-3">
            <p className="font-mono text-[12px] break-all text-muted-foreground">{detail}</p>
          </AccordionPanel>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

/**
 * Falhas de veredito AGRUPADAS por (cenário, categoria, causa técnica) — o
 * ErrorAtlas do IMPL-057: 12 falhas soltas viram ≤ 4 grupos. `degraded`
 * (painel reduzido, veredito presente) nunca entra: não é falha do candidato.
 */
export function VerdictFailuresPanel({ record }: { record: RunRecord }) {
  const [filtro, setFiltro] = useState<'all' | VerdictFailureCategory>('all');
  const [porCausa, setPorCausa] = useState(false);
  const stages = useMemo(() => denseStages(record.stages ?? []), [record]);
  const entradas = useMemo(() => verdictFailuresFromStages(stages), [stages]);
  const grupos = useMemo(
    () =>
      groupVerdictFailures(
        filtro === 'all' ? entradas : entradas.filter((e) => failureCategoryOf(e.kind) === filtro),
        { rollupScenarios: porCausa },
      ),
    [entradas, filtro, porCausa],
  );
  const categorias = useMemo(
    () => [...new Set(entradas.map((e) => failureCategoryOf(e.kind)))],
    [entradas],
  );
  if (entradas.length === 0) return null;
  const labelOf = (id: string): string =>
    (record.contestants ?? []).find((c) => c.id === id)?.label ?? id;
  const cenarioDe = (i: number): number => (stages[i]?.index ?? i) + 1;
  const total = grupos.reduce((s, g) => s + g.count, 0);

  return (
    <div className={`${CARD} flex flex-col gap-2`} data-verdict-failures="">
      <h3 className="text-[13px] font-medium">Falhas de avaliação</h3>
      <p className="text-[12px] text-muted-foreground">
        {entradas.length} veredito(s) ausente(s) em {grupos.length} grupo(s) — ficam fora da nota,
        nunca viram “não resolve”.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {categorias.length > 1 && (
          <SegmentedToggle
            value={filtro}
            onChange={(v) => setFiltro(v as 'all' | VerdictFailureCategory)}
            ariaLabel="Filtrar falhas por quem falhou"
          >
            <SegmentedToggleOption value="all" className="px-2.5 py-1 text-[12px]">
              todas
            </SegmentedToggleOption>
            {categorias.map((c) => (
              <SegmentedToggleOption key={c} value={c} className="px-2.5 py-1 text-[12px]">
                {CATEGORY_LABEL[c]}
              </SegmentedToggleOption>
            ))}
          </SegmentedToggle>
        )}
        <SegmentedToggle
          value={porCausa ? 'causa' : 'cenario'}
          onChange={(v) => setPorCausa(v === 'causa')}
          ariaLabel="Agrupar falhas"
        >
          <SegmentedToggleOption value="cenario" className="px-2.5 py-1 text-[12px]">
            por cenário
          </SegmentedToggleOption>
          <SegmentedToggleOption value="causa" className="px-2.5 py-1 text-[12px]">
            por causa
          </SegmentedToggleOption>
        </SegmentedToggle>
      </div>
      <Accordion className="divide-y divide-border overflow-hidden rounded-lg border border-border" multiple>
        {grupos.map((g, i) => (
          <AccordionItem key={`${g.scenario ?? ''}|${g.category}|${g.cause}`} value={`falhas-grupo-${i}`}>
            <AccordionTrigger className="px-3 py-2.5 text-left text-[13px]" headingLevel={4}>
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2" data-failure-group="">
                <span className="font-medium tabular">{g.count}×</span>
                <span>
                  {CATEGORY_LABEL[g.category]} · {CAUSE_LABEL[g.cause]}
                </span>
                {g.scenario && (
                  <span className="min-w-0 truncate text-muted-foreground">— {trunc(g.scenario, 70)}</span>
                )}
              </span>
            </AccordionTrigger>
            <AccordionPanel className="px-3 pb-3">
              <ul className="flex flex-col gap-1 text-[12px] text-muted-foreground">
                {g.items.map((e, k) => (
                  <li key={k}>
                    <span className="text-foreground">
                      cenário {cenarioDe(e.stageIndex)} · {labelOf(e.contestantId)}
                    </span>
                    : {e.message}
                  </li>
                ))}
              </ul>
            </AccordionPanel>
          </AccordionItem>
        ))}
      </Accordion>
      {filtro !== 'all' && total < entradas.length && (
        <p className="text-[12px] text-muted-foreground">
          Mostrando {total} de {entradas.length} — filtro: {CATEGORY_LABEL[filtro]}.
        </p>
      )}
    </div>
  );
}

/** Acima disto a fila de revisão humana vem recolhida (acordeão). */
const HUMAN_QUEUE_INLINE = 3;

/** Motivo da fila `needs-human-review` (IMPL-055) em PT-BR. */
const HUMAN_REVIEW_LABEL: Record<HumanReviewReason, string> = {
  reference_rubric_divergence: 'gabarito diverge da rubrica',
  reference_disagreement: 'o 2º gabarito discordou',
  reference_audit_sample: 'amostra de auditoria',
  low_confidence_verdict: 'veredito com confiança baixa',
};

/**
 * Revisão HUMANA do gabarito (IMPL-112 + IMPL-055): item com 100% 'resolve'
 * ou 100% 'não' em k execuções vai para a fila — gabarito errado/largo não se
 * distingue de item impossível/trivial sem gente. Nada é descartado.
 */
export function GabaritoReview({ record }: { record: RunRecord }) {
  const sat = record.itemSaturation;
  const humanos = record.needsHumanReview ?? [];
  const contestants = record.contestants ?? [];
  const stages = useMemo(() => denseStages(record.stages ?? []), [record]);
  if ((!sat || sat.items.length === 0) && humanos.length === 0) return null;
  const labelOf = (id: string): string => contestants.find((c) => c.id === id)?.label ?? id;
  const perguntaDe = (idx: number): string | undefined =>
    stages.find((s) => s.index === idx)?.spec?.question;
  const pct = (x: number): string => `${Math.round(x * 100)}%`;
  // Colunas do "item × contestants": só quem aparece em algum item.
  const colunas = sat
    ? contestants.filter((c) => sat.items.some((it) => it.byContestant.some((b) => b.contestantId === c.id)))
    : [];

  return (
    <div className={`${CARD} flex flex-col gap-2`} data-gabarito-review="">
      <h3 className="text-[13px] font-medium">Revisão humana do gabarito</h3>
      {sat && sat.items.length > 0 && (
        <p className="text-[12px] text-muted-foreground">
          Taxa de acerto medida em {sat.items.length} item(ns), com k = {sat.minExecutions} execuções
          para um extremo virar sinal.{' '}
          {sat.reviewQueue.length > 0
            ? `${sat.reviewQueue.length} item(ns) na fila: revise o gabarito — nenhum item é descartado sozinho.`
            : 'Nenhum item saturado.'}
        </p>
      )}
      {sat && sat.reviewQueue.length > 0 && (
        <ul className="flex flex-col gap-2">
          {sat.reviewQueue.map((it) => {
            const todos = it.saturated === 'all-resolve';
            return (
              <li key={it.itemKey} className="rounded-lg border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                      todos ? VERDICT_META.resolve.pill : VERDICT_META.nao.pill
                    }`}
                  >
                    {todos ? '100% resolve' : '100% não resolve'}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={it.question}>
                    {trunc(it.question, 110)}
                  </span>
                </div>
                <p className="mt-1.5 text-[12px] text-muted-foreground">
                  {it.executions} execuções · {it.byContestant.length} participante(s) · cenário
                  {it.stageIndexes.length > 1 ? 's' : ''} {it.stageIndexes.map((i) => i + 1).join(', ')}.{' '}
                  {todos
                    ? 'Todos resolveram sempre: o gabarito pode estar largo demais (aceita qualquer resposta) ou o item é trivial.'
                    : 'Ninguém resolveu nunca: o gabarito pode estar errado — ou o item é impossível. Revise o gabarito antes de concluir.'}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {humanos.length > 0 &&
        (() => {
          const titulo = `Fila de revisão humana (needs-human-review) · ${humanos.length}`;
          const lista = (
            <ul className="flex flex-col gap-1 text-[12px] text-muted-foreground">
              {humanos.map((h, i) => (
                <li key={i}>
                  <span className="text-foreground">
                    cenário {h.stageIndex + 1}
                    {h.contestantId ? ` · ${labelOf(h.contestantId)}` : ''}
                  </span>{' '}
                  — {HUMAN_REVIEW_LABEL[h.reason] ?? h.reason}
                  {h.detail ? `: ${h.detail}` : ''}
                  {!h.detail && perguntaDe(h.stageIndex) ? `: ${trunc(perguntaDe(h.stageIndex)!, 80)}` : ''}
                </li>
              ))}
            </ul>
          );
          // Poucas entradas: à vista. Muitas (ex.: toda a run com confiança
          // baixa): recolhidas — a lista longa empurrava o resto da seção.
          return humanos.length <= HUMAN_QUEUE_INLINE ? (
            <div className="flex flex-col gap-1.5">
              <MiniLabel>{titulo}</MiniLabel>
              {lista}
            </div>
          ) : (
            <Accordion className="rounded-lg border border-border">
              <AccordionItem value="fila-revisao-humana">
                <AccordionTrigger className="px-3 py-2 text-[12px] text-muted-foreground" headingLevel={4}>
                  {titulo}
                </AccordionTrigger>
                <AccordionPanel className="px-3 pb-3">{lista}</AccordionPanel>
              </AccordionItem>
            </Accordion>
          );
        })()}
      {sat && sat.items.length > 0 && colunas.length > 0 && (
        <Accordion className="rounded-lg border border-border">
          <AccordionItem value="saturacao-por-item">
            <AccordionTrigger className="px-3 py-2 text-[12px] text-muted-foreground" headingLevel={4}>
              Taxa de acerto por item × participante
            </AccordionTrigger>
            <AccordionPanel className="px-3 pb-3">
              <div className="scroll-slim relative overflow-x-auto">
                <table className="w-full min-w-fit border-separate border-spacing-x-2 border-spacing-y-1 text-[12px]">
                  <caption className="caption-top pb-1 text-left text-muted-foreground">
                    Fração de “resolve” em cada item (resolveu / execuções) ·{' '}
                    <span aria-hidden="true">⚑</span> na fila de revisão.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col" className="text-left font-normal text-muted-foreground">
                        item
                      </th>
                      <th scope="col" className="text-right font-normal text-muted-foreground">
                        total
                      </th>
                      {colunas.map((c) => (
                        <th key={c.id} scope="col" className="max-w-[8rem] truncate text-right font-normal text-muted-foreground" title={c.label}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sat.items.map((it) => (
                      <tr key={it.itemKey}>
                        <th scope="row" className="max-w-[18rem] truncate text-left font-normal" title={it.question}>
                          {it.needsReview && (
                            <>
                              <span aria-hidden="true">⚑ </span>
                              <span className="sr-only">na fila de revisão: </span>
                            </>
                          )}
                          {trunc(it.question, 60)}
                        </th>
                        <td className="text-right tabular">{pct(it.hitRate)}</td>
                        {colunas.map((c) => {
                          const b = it.byContestant.find((x) => x.contestantId === c.id);
                          return (
                            <td key={c.id} className="text-right text-muted-foreground tabular">
                              {b ? `${b.resolve}/${b.executions}` : '—'}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

/**
 * Seção "Diagnóstico do juiz" (F4.2/F3.6 + IMPL-057/IMPL-112): auditoria do
 * contrato, viés de verbosidade, avisos de imparcialidade, falhas de
 * avaliação agrupadas e a revisão humana do gabarito. Oculta quando não há o
 * que dizer (records antigos).
 */
export function JudgeDiagnostics({ record }: { record: RunRecord }) {
  const diag = (record as unknown as { judgeDiagnostics?: JudgeDiag }).judgeDiagnostics;
  // IMPL-007: record anterior à agregação por maioria => judge-score de painel
  // em outra escala; o aviso vem primeiro porque muda como ler o número.
  const escala = judgeScaleWarning(record);
  const avisos = [
    ...(escala ? [escala] : []),
    ...((record as unknown as { fairnessWarnings?: string[] }).fairnessWarnings ?? []),
    // IMPL-056: idioma fora da política é confundidor no veredito.
    ...(record.languageWarnings ?? []).map((a) => `Idioma: ${a}`),
  ];
  const temFalhas = useMemo(
    () => verdictFailuresFromStages(denseStages(record.stages ?? [])).length > 0,
    [record],
  );
  const temRevisao = Boolean(record.itemSaturation?.items.length) || Boolean(record.needsHumanReview?.length);
  if (!diag && avisos.length === 0 && !temFalhas && !temRevisao) return null;
  return (
    <section className="flex flex-col gap-3">
      <SectionHead>Diagnóstico do juiz</SectionHead>
      {(diag || avisos.length > 0) && (
        <div className={`${CARD} flex flex-col gap-2`}>
          {diag ? <ContractAudit diag={diag} /> : null}
          {diag ? (
            <p className="text-sm text-muted-foreground">
              verbosidade r={diag.verbosity.r.toFixed(2)} (n={diag.verbosity.n})
              {diag.verbosity.warning ? ` — ${diag.verbosity.warning}` : ''}
            </p>
          ) : null}
          {avisos.map((a, i) => (
            <p key={i} className="text-sm text-muted-foreground">
              {a}
            </p>
          ))}
        </div>
      )}
      <VerdictFailuresPanel record={record} />
      <GabaritoReview record={record} />
    </section>
  );
}
