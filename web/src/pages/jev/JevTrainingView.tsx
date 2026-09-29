import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download, FileText } from 'lucide-react';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Banner, Disclosure, EmptyState, PageHeader, Screen, SectionHead, StatusPill, Tag } from '../../components/primitives';
import { CancelHoldButton } from '../../components/RunControls';
import { SpecDiff } from '../../components/jev/SpecDiff';
import {
  JEV_OPERATORS,
  buildJevHandoff,
  fmtNum,
  fmtP,
  fmtPct,
  fmtPp,
  fmtUsd,
  handoffCurl,
  isHandoffBlocked,
  sessionVerdict,
  type JevSessionRecord,
} from '../../engine/jev';
import { cancelJev, markJevInterrupted } from '../../jev/api';
import { useJevRecord } from '../../jev/useJevRecord';

/**
 * Treino JEV (evolução da definição de decisão): ciclos com o gate
 * (p ajustado, ganho mínimo, não-inferioridade de acurácia), a diferença
 * original × campeã, a política ajustada por pergunta, o holdout e o handoff.
 */

const DECISION_LABEL: Record<string, string> = {
  baseline: 'linha de base',
  promoted: 'promovida',
  held: 'mantida',
  inconclusive: 'inconclusivo',
  stopped: 'parou',
};

const VERDICT_TEXT: Record<ReturnType<typeof sessionVerdict>, { tone: 'neutral' | 'warn' | 'error'; text: string }> = {
  melhorou: { tone: 'neutral', text: 'Melhorou: a campeã superou a original no holdout, com significância.' },
  piorou: { tone: 'error', text: 'Piorou: a campeã REGREDIU no holdout — não use esta definição.' },
  'sem-diferenca': { tone: 'neutral', text: 'Sem diferença demonstrada no holdout.' },
  inconclusivo: { tone: 'warn', text: 'Inconclusivo: holdout fraco ou ausente — a melhora não foi confirmada.' },
  'sem-mudanca': { tone: 'neutral', text: 'Sem mudança: nenhuma variante passou o gate; a campeã é a original.' },
};

function baixar(nome: string, texto: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

function Handoff({ s }: { s: JevSessionRecord }) {
  const [motivo, setMotivo] = useState('');
  const h = buildJevHandoff({ kind: 'session', rec: s }, motivo.trim() ? { override: motivo.trim() } : {});
  if (isHandoffBlocked(h)) {
    return (
      <Banner tone="error" className="flex flex-col gap-2">
        <p>{h.message}</p>
        <label className="flex flex-wrap items-center gap-2 text-[13px]">
          Motivo da sobreposição (decisão humana, fica gravado no handoff):
          <Input aria-label="Motivo da sobreposição" className="h-7 w-72" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
        </label>
      </Banner>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[13px] text-muted-foreground">
        A campeã como request pronto (troque <code className="font-mono">{'<<STATE>>'}</code>), com a política por pergunta (temperatura + limiares) no
        handoff completo. O <code className="font-mono">jev.mjs</code> da jev-agent-skill aplica UM par de limiares a todas as perguntas e não aplica temperatura.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton variant="label" value={JSON.stringify(h.request, null, 2)} label="Copiar request (JSON)" copiedLabel="Request copiado" />
        <CopyButton variant="label" value={handoffCurl(h.request)} label="Copiar cURL" copiedLabel="cURL copiado" />
        <Button type="button" variant="outline" size="sm" onClick={() => baixar('jev-handoff.json', JSON.stringify(h, null, 2), 'application/json')}>
          <Download aria-hidden="true" />
          Handoff completo
        </Button>
      </div>
    </div>
  );
}

export function JevTrainingView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { record: s, local, ownership } = useJevRecord('session', sessionId);
  const [avisosAbertos, setAvisosAbertos] = useState(false);

  if (s === undefined) {
    return (
      <Screen wide>
        <p className="text-sm text-muted-foreground">Carregando…</p>
      </Screen>
    );
  }
  if (s === null) {
    return (
      <Screen wide>
        <EmptyState>Treino JEV não encontrado neste navegador.</EmptyState>
      </Screen>
    );
  }

  const planejados = s.config.train?.iterations ?? 0;
  const feitos = s.iterations.filter((i) => i.iteration > 0).length;
  const veredito = s.status === 'running' ? null : sessionVerdict(s);
  const policy = Object.entries(s.policy ?? {});

  return (
    <Screen wide>
      <PageHeader
        title={s.theme}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={s.status} />
            <Tag>JEV · treino</Tag>
            <span className="font-mono text-[12px]">{s.modelId}</span>
          </span>
        }
        actions={
          <>
            {local && s.status === 'running' && <CancelHoldButton onConfirm={() => cancelJev(s.id)} />}
            {s.status !== 'running' && (
              <Link className={buttonVariants({ variant: 'outline', size: 'sm' })} to={`/jev/training/${s.id}/report`}>
                <FileText aria-hidden="true" />
                Relatório de ciclos
              </Link>
            )}
          </>
        }
      />

      {s.status === 'running' && (
        <div className="mb-6 flex flex-col gap-2">
          <ProgressBar value={planejados ? feitos / planejados : 0} size="sm" progressbar aria-label="Ciclos concluídos" />
          <p className="text-[13px] text-muted-foreground tabular">
            ciclo {feitos} de até {planejados} · {fmtUsd(s.totalCostUsd)} medidos{s.budgetUsd !== undefined ? ` · teto ${fmtUsd(s.budgetUsd)}` : ''}
          </p>
          {!local && ownership === 'alive' && <Banner>Este treino está rodando em outra aba deste navegador; aqui aparece o último salvamento.</Banner>}
          {!local && ownership === 'unsupported' && (
            <Banner tone="warn">
              Sem Web Locks não dá para saber se o treino ainda roda. Se a aba dele já fechou,{' '}
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => void markJevInterrupted('session', s.id)}>
                marque como interrompido
              </button>
              .
            </Banner>
          )}
        </div>
      )}

      {veredito && <Banner tone={VERDICT_TEXT[veredito].tone}>{VERDICT_TEXT[veredito].text}</Banner>}
      {s.error && s.status !== 'running' && (
        <Banner tone={s.status === 'error' ? 'error' : 'neutral'} className="mt-3">
          {s.error}
        </Banner>
      )}
      {s.stoppedReason === 'budget' && <Banner tone="warn" className="mt-3">Parou no teto de gasto: o treino fechou com o que já tinha medido.</Banner>}
      {s.stoppedReason === 'snapshot-drift' && (
        <Banner tone="warn" className="mt-3">
          O modelo mudou de snapshot no meio da sessão: os ciclos deixaram de ser comparáveis e o treino parou.
        </Banner>
      )}

      <SectionHead status={`${feitos} de ${planejados}`}>Ciclos</SectionHead>
      <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
        <table className="w-full text-left text-[12.5px] tabular">
          <caption className="sr-only">Ciclos do treino e o gate de cada um</caption>
          <thead className="text-[11px] text-muted-foreground">
            <tr className="border-b border-border">
              <th scope="col" className="px-3 py-2 font-medium">Ciclo</th>
              <th scope="col" className="px-2 py-2 font-medium">Decisão</th>
              <th scope="col" className="px-2 py-2 font-medium">Variantes (operador)</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Campeã (p.p.)</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Melhor Δ</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">p ajustado</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Ganho mín.</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Δ acurácia</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Custo</th>
            </tr>
          </thead>
          <tbody>
            {s.iterations.map((it) => {
              const deltas = it.gate.meanDiffPp.filter((x): x is number => typeof x === 'number');
              const melhor = deltas.length ? Math.max(...deltas) : null;
              const pMin = it.gate.pAdjusted.length ? Math.min(...it.gate.pAdjusted) : null;
              return (
                <tr key={it.iteration} className="border-b border-border align-top last:border-b-0">
                  <th scope="row" className="px-3 py-2 text-left font-normal">
                    {it.runId ? (
                      <Link className="text-primary underline-offset-4 hover:underline" to={`/jev/runs/${it.runId}`}>
                        {it.iteration === 0 ? 'base' : it.iteration}
                      </Link>
                    ) : it.iteration === 0 ? (
                      'base'
                    ) : (
                      it.iteration
                    )}
                  </th>
                  <td className="px-2 py-2">
                    <Tag className={it.gate.decision === 'promoted' ? 'border-resolve/30 bg-resolve-soft text-resolve' : undefined}>{DECISION_LABEL[it.gate.decision] ?? it.gate.decision}</Tag>
                    {it.gate.heldBy?.length ? <span className="mt-1 block text-[11px] text-muted-foreground">{it.gate.heldBy.join('; ')}</span> : null}
                  </td>
                  <td className="px-2 py-2">
                    <ul className="flex flex-col gap-0.5">
                      {it.candidates.map((c) => (
                        <li key={c.specId + c.label} className="text-[12px]">
                          {c.label} <span className="text-muted-foreground">({JEV_OPERATORS[c.operatorId]?.label ?? c.operatorId})</span>
                          {c.status !== 'evaluated' && <span className="block text-[11px] text-muted-foreground">{c.status === 'rejected-local' ? 'recusada sem gasto' : 'proposta falhou'}: {c.reason}</span>}
                        </li>
                      ))}
                    </ul>
                  </td>
                  <td className="px-2 py-2 text-right">{fmtNum(it.gate.controlScorePp, 1)}</td>
                  <td className="px-2 py-2 text-right">{fmtPp(melhor)}</td>
                  <td className="px-2 py-2 text-right">{fmtP(pMin)}</td>
                  <td className="px-2 py-2 text-right">{fmtPp(it.gate.minGainPp)}</td>
                  <td className="px-2 py-2 text-right">{fmtPp(it.gate.accuracyDeltaPp)}</td>
                  <td className="px-3 py-2 text-right">{fmtUsd(it.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[12px] text-muted-foreground">
        Régua do gate: 100·(1 − Brier) com temperatura ajustada por variante, pareada por caso no split de treino (os casos copiados como exemplo saem do gate).
        Promove só com p ajustado ≤ 0,05, ganho ≥ o mínimo e sem perder acurácia além do limite.
      </p>

      <SectionHead>Original × campeã</SectionHead>
      <SpecDiff original={s.originalSpec} champion={s.championSpec} />

      {policy.length > 0 && (
        <>
          <SectionHead>Política ajustada (calibração)</SectionHead>
          <div className="scroll-slim overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
            <table className="w-full text-left text-[12.5px] tabular">
              <caption className="sr-only">Temperatura e limiares por pergunta</caption>
              <thead className="text-[11px] text-muted-foreground">
                <tr className="border-b border-border">
                  <th scope="col" className="px-3 py-2 font-medium">Pergunta</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">Temperatura</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">auto ≥</th>
                  <th scope="col" className="px-2 py-2 text-right font-medium">revisão ≥</th>
                  <th scope="col" className="px-3 py-2 font-medium">Sinal · ajuste</th>
                </tr>
              </thead>
              <tbody>
                {policy.map(([q, p]) => (
                  <tr key={q} className="border-b border-border last:border-b-0">
                    <th scope="row" className="px-3 py-2 text-left font-mono font-normal">
                      {q}
                    </th>
                    <td className="px-2 py-2 text-right">{fmtNum(p.temperature ?? 1, 2)}</td>
                    <td className="px-2 py-2 text-right">{p.auto > 1 ? 'desligada' : fmtNum(p.auto, 2)}</td>
                    <td className="px-2 py-2 text-right">{fmtNum(p.hitl, 2)}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {p.signal}
                      {p.fittedOn ? ` · ${p.fittedOn.n} casos (${p.fittedOn.split})` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {s.holdout && (
        <>
          <SectionHead>Holdout (teste cego)</SectionHead>
          <div className="flex flex-col gap-2 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
            <p className="text-sm">{s.holdout.text}</p>
            <p className="text-[13px] text-muted-foreground tabular">
              {s.holdout.n} casos · força {s.holdout.strength}
              {s.holdout.comparison
                ? ` · Δ ${fmtPp(s.holdout.comparison.meanDiffPp)} (IC ${s.holdout.comparison.ci95Pp ? `${fmtPp(s.holdout.comparison.ci95Pp[0])} … ${fmtPp(s.holdout.comparison.ci95Pp[1])}` : '—'}, p ${fmtP(s.holdout.comparison.pValue)}) · Δ acurácia ${fmtPp(s.holdout.comparison.accuracyDiffPp)}`
                : ''}
            </p>
            {s.holdout.original && s.holdout.champion && (
              <p className="text-[13px] tabular">
                Acurácia {fmtPct(s.holdout.original.accuracy)} → {fmtPct(s.holdout.champion.accuracy)} · Brier {fmtNum(s.holdout.original.brierScore, 1)} →{' '}
                {fmtNum(s.holdout.champion.brierScore, 1)} p.p.
              </p>
            )}
            {s.holdout.regressed && <Banner tone="error">A campeã regrediu no holdout.</Banner>}
          </div>
        </>
      )}

      {s.status !== 'running' && (
        <>
          <SectionHead>Levar para produção</SectionHead>
          <Handoff s={s} />
        </>
      )}

      {s.warnings.length > 0 && (
        <Disclosure id="jev-train-avisos" title={`Avisos (${s.warnings.length})`} open={avisosAbertos} onToggle={() => setAvisosAbertos((o) => !o)}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
            {s.warnings.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Disclosure>
      )}
      <p className="mt-6 text-[12px] text-muted-foreground tabular">
        Custo total medido: {fmtUsd(s.totalCostUsd)} (decisões {fmtUsd(s.cost.byKind.decision)} · proponente {fmtUsd(s.cost.byKind.rewriter)})
        {s.cost.pendingUsd > 0 ? ` · + ${fmtUsd(s.cost.pendingUsd)} pendente` : ''}.
      </p>
    </Screen>
  );
}
