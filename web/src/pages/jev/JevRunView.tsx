import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Download } from 'lucide-react';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { Button } from '@/components/ui/button';
import { Banner, Disclosure, EmptyState, MiniLabel, PageHeader, Screen, SectionHead, StatusPill, Tag } from '../../components/primitives';
import { CancelHoldButton } from '../../components/RunControls';
import { MetricsTable, ComparisonsTable } from '../../components/jev/MetricsTable';
import { ReliabilityDiagram } from '../../components/jev/ReliabilityDiagram';
import { ConfusionMatrix } from '../../components/jev/ConfusionMatrix';
import { BandBars } from '../../components/jev/BandBars';
import { CaseGrid } from '../../components/jev/CaseGrid';
import { CascadeSimulator } from '../../components/jev/CascadeSimulator';
import {
  buildJevHandoff,
  buildJevRunReport,
  fmtNum,
  fmtPct,
  fmtUsd,
  handoffCurl,
  isHandoffBlocked,
  renderJevRunReportMarkdown,
  runWarnings,
  type JevRunRecord,
} from '../../engine/jev';
import { cancelJev, markJevInterrupted } from '../../jev/api';
import { useJevRecord } from '../../jev/useJevRecord';
import { caseGrid, questionOf, reliabilitySeries, rescoreRun } from '../../jev/view';

/**
 * Resultado de uma run JEV (eval/compare): métricas por competidor, a
 * comparação pareada com o controle, por pergunta (calibração, bandas, matriz
 * de confusão, caso a caso), a cascata Jev → LLM e o handoff da definição.
 */

const MODE_LABEL: Record<string, string> = { eval: 'avaliar', compare: 'comparar', train: 'ciclo de treino' };
const TYPE_LABEL: Record<string, string> = { noul: 'sim/não', choice: 'escolha', score: 'escala' };

function baixar(nome: string, texto: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

function StopInfo({ run }: { run: JevRunRecord }) {
  if (run.status === 'running') return null;
  if (run.stoppedReason === 'budget') {
    return (
      <Banner tone="warn">
        <strong>Parou no teto de gasto ({fmtUsd(run.budgetUsd)}).</strong> {run.incompleteCaseIds.length} caso(s) ficaram incompletos e estão FORA das métricas e das
        comparações — o resultado vale para os casos completos.
      </Banner>
    );
  }
  if (run.stoppedReason === 'spec-rejected') {
    return (
      <Banner tone="error">
        <strong>A API recusou a definição (400).</strong> {run.error}
        {run.rejected && (
          <ul className="mt-1.5 list-disc pl-5 text-[13px]">
            {Object.values(run.rejected)
              .flat()
              .slice(0, 6)
              .map((i, n) => (
                <li key={n}>
                  <code className="font-mono">{i.path || '—'}</code>: {i.message}
                </li>
              ))}
          </ul>
        )}
      </Banner>
    );
  }
  if (run.status === 'aborted') {
    return (
      <Banner>
        <strong>Interrompida.</strong> {run.error ?? 'Cancelada pelo usuário.'} O que já tinha sido respondido ficou; casos incompletos estão fora das métricas.
      </Banner>
    );
  }
  if (run.status === 'error') return <Banner tone="error">{run.error ?? 'A run terminou com erro.'}</Banner>;
  if (run.status === 'inconclusive') {
    return (
      <Banner tone="warn">
        <strong>Inconclusiva:</strong> a evidência não sustenta conclusão.
        <ul className="mt-1.5 list-disc pl-5 text-[13px]">
          {(run.inconclusiveReasons ?? []).map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </Banner>
    );
  }
  return null;
}

export function JevRunView() {
  const { id } = useParams<{ id: string }>();
  const { record: run, local, ownership } = useJevRecord('run', id);
  const [verCalibrado, setVerCalibrado] = useState(true);
  const [avisosAbertos, setAvisosAbertos] = useState(false);
  const [ctConfusao, setCtConfusao] = useState<string | null>(null);

  const scored = useMemo(() => (run && run.status !== 'running' ? rescoreRun(run) : null), [run]);
  const [qTab, setQTab] = useState<string | null>(null);

  if (run === undefined) {
    return (
      <Screen wide>
        <p className="text-sm text-muted-foreground">Carregando…</p>
      </Screen>
    );
  }
  if (run === null) {
    return (
      <Screen wide>
        <EmptyState>
          Run JEV não encontrada neste navegador. Runs JEV da SPA ficam no armazenamento local (IndexedDB) de quem as executou; as do terminal ficam em
          <code className="mx-1 font-mono">~/.prompt-builder/jev-runs</code>(use <code className="font-mono">prompt-builder jev show {id}</code>).
        </EmptyState>
      </Screen>
    );
  }

  const qids = run.questionIds;
  const qAtual = qTab && qids.includes(qTab) ? qTab : qids[0];
  const temPolitica = Boolean(run.policy && Object.keys(run.policy).length);
  const avisos = runWarnings(run);
  const decisao = run.contestants.find((c) => c.kind === 'decision');
  const handoff = decisao ? buildJevHandoff({ kind: 'run', rec: run, contestantId: decisao.id }) : null;
  const request = handoff && !isHandoffBlocked(handoff) ? handoff.request : null;
  const ctConf = ctConfusao && run.contestants.some((c) => c.id === ctConfusao) ? ctConfusao : run.contestants[0]?.id;
  const snapshots = Object.entries(run.resolvedModels);

  return (
    <Screen wide>
      <PageHeader
        title={run.theme}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <StatusPill status={run.status} />
            <Tag>JEV · {MODE_LABEL[run.mode] ?? run.mode}</Tag>
            <span>
              {run.cases.length} casos × {run.config.repeats} rep. · {run.contestants.length} competidor(es) · cliente {run.client === 'browser' ? 'navegador' : 'terminal'}
            </span>
          </span>
        }
        actions={
          <>
            {local && run.status === 'running' && <CancelHoldButton onConfirm={() => cancelJev(run.id)} />}
            {run.status !== 'running' && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => baixar(`jev-run-${run.id.slice(0, 8)}.md`, renderJevRunReportMarkdown(buildJevRunReport(run)), 'text/markdown')}
              >
                <Download aria-hidden="true" />
                Relatório (Markdown)
              </Button>
            )}
            {run.status !== 'running' && (
              <Button type="button" variant="outline" size="sm" onClick={() => baixar(`jev-run-${run.id.slice(0, 8)}.json`, JSON.stringify(buildJevRunReport(run), null, 2), 'application/json')}>
                <Download aria-hidden="true" />
                JSON
              </Button>
            )}
          </>
        }
      />

      {run.sessionId && (
        <p className="mb-4 text-[13px] text-muted-foreground">
          Run do ciclo {run.iteration ?? '—'} de um treino —{' '}
          <Link className="text-primary underline-offset-4 hover:underline" to={`/jev/training/${run.sessionId}`}>
            abrir a sessão
          </Link>
          .
        </p>
      )}

      {run.status === 'running' && (
        <div className="mb-6 flex flex-col gap-2">
          <ProgressBar
            value={run.progress.requestsPlanned ? run.progress.requestsDone / run.progress.requestsPlanned : 0}
            size="sm"
            progressbar
            aria-label="Requests concluídos"
          />
          <p className="text-[13px] text-muted-foreground tabular">
            {run.progress.requestsDone} de {run.progress.requestsPlanned} requests · {fmtUsd(run.progress.spentUsd)} medidos até aqui
            {run.budgetUsd !== undefined ? ` · teto ${fmtUsd(run.budgetUsd)}` : ''}
          </p>
          {!local && ownership === 'alive' && (
            <Banner>
              <strong>Esta run está rodando em outra aba deste navegador.</strong> Aqui aparece o último salvamento; se aquela aba for fechada, a run vira
              "interrompida" com o parcial.
            </Banner>
          )}
          {!local && ownership === 'unsupported' && (
            <Banner tone="warn">
              Este navegador não oferece Web Locks: não dá para saber se a run ainda roda. Se a aba que a executava já foi fechada,{' '}
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => void markJevInterrupted('run', run.id)}>
                marque como interrompida
              </button>
              .
            </Banner>
          )}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <StopInfo run={run} />
      </div>

      {run.status !== 'running' && (
        <>
          <SectionHead
            status={
              temPolitica ? (
                <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => setVerCalibrado((v) => !v)}>
                  {verCalibrado ? 'ver só o cru' : 'ver com a política ajustada'}
                </button>
              ) : undefined
            }
          >
            Competidores
          </SectionHead>
          <MetricsTable contestants={run.contestants} metrics={run.metrics} rejected={run.rejected} calibrated={temPolitica && verCalibrado} />
          {temPolitica && verCalibrado && (
            <p className="mt-2 text-[12px] text-muted-foreground">
              Com a política ajustada (temperatura + limiares no split de calibração), medida FORA da calibração. A acurácia não muda: a temperatura não
              troca a classe prevista.
            </p>
          )}

          {(run.comparisons?.length ?? 0) > 0 && (
            <>
              <SectionHead>Comparação com o controle</SectionHead>
              <ComparisonsTable comparisons={run.comparisons!} contestants={run.contestants} />
            </>
          )}

          <SectionHead>Bandas de ação</SectionHead>
          <BandBars
            rows={run.contestants
              .filter((c) => run.metrics[c.id])
              .map((c) => ({ contestant: c, metrics: run.metrics[c.id], calibrated: temPolitica && verCalibrado }))}
          />

          {qids.length > 0 && scored && (
            <>
              <SectionHead>Por pergunta</SectionHead>
              <SmoothTabs value={qAtual} onValueChange={(v) => setQTab(String(v))}>
                <SmoothTabsList ariaLabel="Perguntas" className="w-fit max-w-full overflow-x-auto">
                  {qids.map((q) => (
                    <SmoothTabsTab key={q} value={q} className="px-3 py-1.5 font-mono text-[12.5px]">
                      {q}
                    </SmoothTabsTab>
                  ))}
                </SmoothTabsList>
                <SmoothTabsPanels className="mt-4">
                  {qids.map((q) => {
                    const qq = questionOf(run, q);
                    return (
                      <SmoothTabsPanel key={q} value={q}>
                        <div className="flex flex-col gap-6">
                          <p className="text-[13px] text-muted-foreground">
                            <Tag>{TYPE_LABEL[qq?.type ?? ''] ?? qq?.type}</Tag>{' '}
                            {typeof qq?.instructions === 'string' ? qq.instructions : JSON.stringify(qq?.instructions ?? '')}
                          </p>
                          <MetricsTable
                            contestants={run.contestants}
                            metrics={Object.fromEntries(run.contestants.map((c) => [c.id, run.byQuestion[c.id]?.[q]]))}
                            calibrated={temPolitica && verCalibrado}
                          />
                          <div className="grid gap-6 lg:grid-cols-2">
                            <ReliabilityDiagram series={reliabilitySeries(run, q)} title={`Calibração — ${q}`} />
                            <div className="flex flex-col gap-2">
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <MiniLabel className="mb-0">Matriz de confusão</MiniLabel>
                                {run.contestants.length > 1 && (
                                  <select
                                    aria-label="Competidor da matriz"
                                    className="rounded-md border border-border bg-background px-2 py-1 text-[12.5px]"
                                    value={ctConf}
                                    onChange={(e) => setCtConfusao(e.target.value)}
                                  >
                                    {run.contestants.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.label}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                              {ctConf && <ConfusionMatrix run={run} contestantId={ctConf} qid={q} />}
                              {run.policy?.[ctConf ?? '']?.[q] && (
                                <p className="text-[12px] text-muted-foreground tabular">
                                  Política ajustada: T = {fmtNum(run.policy[ctConf!][q].temperature ?? 1, 2)} · auto ≥ {fmtNum(run.policy[ctConf!][q].auto, 2)} · revisão ≥{' '}
                                  {fmtNum(run.policy[ctConf!][q].hitl, 2)} (sinal {run.policy[ctConf!][q].signal})
                                </p>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-col gap-2">
                            <MiniLabel className="mb-0">Caso a caso</MiniLabel>
                            <CaseGrid run={run} rows={caseGrid(run, scored, q)} />
                          </div>
                        </div>
                      </SmoothTabsPanel>
                    );
                  })}
                </SmoothTabsPanels>
              </SmoothTabs>
            </>
          )}

          {(run.cascade?.length ?? 0) > 0 && (
            <>
              <SectionHead>Cascata Jev → LLM</SectionHead>
              <CascadeSimulator cascades={run.cascade!} contestants={run.contestants} />
            </>
          )}

          <SectionHead>Custo e snapshot</SectionHead>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border px-3 py-2">
              <span className="block text-[11px] text-muted-foreground">Total medido (usage.cost)</span>
              <span className="text-lg font-semibold">{fmtUsd(run.cost.totalUsd)}</span>
              {run.cost.pendingUsd > 0 && <span className="block text-[11px] text-muted-foreground">+ {fmtUsd(run.cost.pendingUsd)} pendente de conciliação</span>}
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <span className="block text-[11px] text-muted-foreground">Decisão · LLM</span>
              <span className="text-sm font-medium tabular">
                {fmtUsd(run.cost.byKind.decision)} · {fmtUsd(run.cost.byKind.llm)}
              </span>
            </div>
            <div className="rounded-lg border border-border px-3 py-2">
              <span className="block text-[11px] text-muted-foreground">Snapshot respondido</span>
              {snapshots.length === 0 ? (
                <span className="text-sm">—</span>
              ) : (
                snapshots.map(([pedido, vistos]) => (
                  <span key={pedido} className="block font-mono text-[11.5px]">
                    {vistos.join(', ')}
                    {vistos.length > 1 && <span className="text-parcial"> (deriva!)</span>}
                  </span>
                ))
              )}
            </div>
          </div>

          {request && (
            <>
              <SectionHead>Levar para produção</SectionHead>
              <p className="mb-2 text-[13px] text-muted-foreground">
                O request da definição de {decisao?.label} (troque <code className="font-mono">{'<<STATE>>'}</code> pelo estado real). Serve direto no
                <code className="mx-1 font-mono">jev.mjs ask --file</code> da jev-agent-skill.
                {temPolitica && ' A política ajustada vai no handoff completo (JSON).'}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton variant="label" value={JSON.stringify(request, null, 2)} label="Copiar request (JSON)" copiedLabel="Request copiado" />
                <CopyButton variant="label" value={handoffCurl(request)} label="Copiar cURL" copiedLabel="cURL copiado" />
                {handoff && !isHandoffBlocked(handoff) && (
                  <Button type="button" variant="outline" size="sm" onClick={() => baixar('jev-handoff.json', JSON.stringify(handoff, null, 2), 'application/json')}>
                    <Download aria-hidden="true" />
                    Handoff completo
                  </Button>
                )}
              </div>
            </>
          )}

          {avisos.length > 0 && (
            <Disclosure id="jev-avisos" title={`Avisos (${avisos.length})`} open={avisosAbertos} onToggle={() => setAvisosAbertos((o) => !o)}>
              <ul className="flex list-disc flex-col gap-1 pl-5 text-[13px] text-muted-foreground">
                {avisos.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </Disclosure>
          )}
          <p className="mt-6 text-[12px] text-muted-foreground">
            Acurácia geral do controle: {fmtPct(run.metrics[run.contestants[0]?.id]?.accuracy)} · latências medidas no {run.client === 'browser' ? 'navegador' : 'terminal'} (não
            comparáveis entre clientes).
          </p>
        </>
      )}
    </Screen>
  );
}
