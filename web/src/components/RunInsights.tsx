// Insights de run (F3 do PLANO-PARIDADE): "onde falhou", delta vs controle,
// drawer da variante (completo/diff/lado-a-lado) e diagnóstico do juiz.
//
// Reaproveita o vocabulário de `runShared` (VERDICT_META/verdictOf/trunc) e o
// diff linha-a-linha de `..//diff`. Tokens de veredito são DADO (contraste AA),
// não decoração — usar só os de `VERDICT_META`.
import { useMemo, useState } from 'react';
import type { RunRecord, Verdict } from '../api';
import { diffLines } from '../diff';
import { DiffView, MiniLabel, Pre, SectionHead, Tag } from './primitives';
import { VERDICT_META, verdictOf, trunc } from '../pages/runShared';
import { judgeScaleWarning } from '../../../src/engine/verdictAggregate.js';

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
  const n = record.stages.length;
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
// 4) JudgeDiagnostics — pin do contrato, verbosidade e fairness
// ----------------------------------------------------------------------------

/**
 * Banner de diagnóstico do juiz (F4.2/F3.6): hash do contrato (calibration
 * drift), viés de verbosidade medido e avisos de imparcialidade. Oculto quando
 * não há o que dizer (records antigos).
 */
export function JudgeDiagnostics({ record }: { record: RunRecord }) {
  const diag = (record as unknown as { judgeDiagnostics?: {
    contract: { hash: string; modelIds: string[] };
    verbosity: { n: number; r: number; biased: boolean; warning: string };
  } }).judgeDiagnostics;
  // IMPL-007: record anterior à agregação por maioria => judge-score de painel
  // em outra escala; o aviso vem primeiro porque muda como ler o número.
  const escala = judgeScaleWarning(record);
  const avisos = [
    ...(escala ? [escala] : []),
    ...((record as unknown as { fairnessWarnings?: string[] }).fairnessWarnings ?? []),
  ];
  if (!diag && avisos.length === 0) return null;
  return (
    <section className="flex flex-col gap-1.5">
      <SectionHead>Diagnóstico do juiz</SectionHead>
      {diag ? (
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Tag>contrato {diag.contract.hash.slice(0, 12)}</Tag>
          <span>{diag.contract.modelIds.join(', ')}</span>
          <span>
            verbosidade r={diag.verbosity.r.toFixed(2)} (n={diag.verbosity.n})
          </span>
        </div>
      ) : null}
      {diag?.verbosity.warning ? (
        <p className="text-sm text-muted-foreground">{diag.verbosity.warning}</p>
      ) : null}
      {avisos.map((a, i) => (
        <p key={i} className="text-sm text-muted-foreground">
          {a}
        </p>
      ))}
    </section>
  );
}