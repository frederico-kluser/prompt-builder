import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, Check, Download, FlaskConical, Gauge, LoaderCircle, Scale, TrendingUp, Upload, type LucideIcon } from 'lucide-react';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { MultiStateButton } from '@/components/motion-ui/multi-state-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '../../components/Modal';
import { ModelSelector } from '../../components/ModelSelector';
import { NumRow, SwitchRow, TxtNumRow } from '../../components/formRows';
import {
  Banner,
  Chip,
  Disclosure,
  ImportedLine,
  PageHeader,
  RovingItem,
  RovingToolbar,
  Screen,
  SettingGroup,
  SettingRow,
} from '../../components/primitives';
import { SpecEditor, IssueList } from '../../components/jev/SpecEditor';
import { CasesImport } from '../../components/jev/CasesImport';
import { ContestantPicker } from '../../components/jev/ContestantPicker';
import { cn } from '@/lib/utils';
import {
  JEV_EXAMPLE_KINDS,
  JEV_EXAMPLES,
  JEV_TRAIN_OPERATORS_V1,
  JEV_OPERATORS,
  fmtUsd,
  isJevConfigError,
  jevComplianceView,
  jevExample,
  type JevConfigFile,
  type JevEstimate,
  type JevExampleKind,
  type JevLintIssue,
  type JevMode,
  type JevOperatorId,
} from '../../engine/jev';
import type { OpenRouterModel as SrcModel } from '../../../../src/types.js';
import { fetchLgpd, fetchModels, getStoredKey, isKeyMissing, type OpenRouterModel as WebModel } from '../../api';
import { AREA_LIVRE, checkRunCompliance, checkRunPii, runPiiMessage, runPiiRefusal, type LgpdData } from '../../lgpd';
import { fetchDecisionModels, isJevCostConfirmationRequired, prepareJev, startJev } from '../../jev/api';
import {
  applyMode,
  draftFromJson,
  draftProblems,
  draftToConfig,
  emptyDraft,
  jevUsesLlm,
  lintDraftSpec,
  specOfDraft,
  type JevDraft,
  type JevProblem,
  type JevStep,
} from '../../jev/form';

/**
 * Nova run JEV — o mesmo idioma do `GuidedSetup` (5 passos em linguagem
 * natural, rodapé fixo com pendência + estimativa + Iniciar) e a mesma
 * superfície "Completa" (página única com seções-âncora), escolhida pela MESMA
 * preferência `pb.formStyle` do formulário LLM.
 *
 * O estado É o `jev-config@1` (ver `web/src/jev/form.ts`): Importar/Exportar
 * JSON troca arquivos com o CLI (`prompt-builder jev run -c`) sem conversão.
 */

const STEPS: JevStep[] = ['objetivo', 'decisao', 'casos', 'participantes', 'limites'];
const STEP_LABEL: Record<JevStep, string> = {
  objetivo: 'Objetivo',
  decisao: 'Decisão',
  casos: 'Casos',
  participantes: 'Participantes',
  limites: 'Limites e revisão',
};

interface Goal {
  id: JevMode;
  icon: LucideIcon;
  title: string;
  question: string;
  detail: string;
}

const GOALS: Goal[] = [
  {
    id: 'eval',
    icon: Gauge,
    title: 'Avaliar',
    question: 'Quão bem o Jev decide os meus casos?',
    detail: 'Uma definição num modelo: acurácia, calibração, bandas de ação, latência e custo por decisão.',
  },
  {
    id: 'compare',
    icon: Scale,
    title: 'Comparar',
    question: 'Esta definição (ou modelo) é melhor que a atual?',
    detail: 'Variantes × modelos de decisão × LLMs opcionais nos mesmos casos, pareado por caso, com cascata.',
  },
  {
    id: 'train',
    icon: TrendingUp,
    title: 'Treinar',
    question: 'Melhore a minha definição de decisão.',
    detail: 'Ciclos de variantes com operadores próprios do Jev; só promove com ganho real; termina no holdout.',
  },
];

const MODE_SUBTITLE: Record<JevMode, string> = {
  eval: 'Mede uma definição de decisão num modelo de decisão, contra casos rotulados.',
  compare: 'Compara definições, modelos de decisão e LLMs nos mesmos casos, caso a caso.',
  train: 'Evolui a definição de decisão em ciclos e confirma no holdout.',
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function lerFormStyle(): 'guided' | 'complete' {
  try {
    return localStorage.getItem('pb.formStyle') === 'complete' ? 'complete' : 'guided';
  } catch {
    return 'guided';
  }
}

function baixarJson(nome: string, data: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

function dedupe(issues: readonly JevLintIssue[]): JevLintIssue[] {
  const vistos = new Set<string>();
  const out: JevLintIssue[] = [];
  for (const i of issues) {
    const k = `${i.level}|${i.code}|${i.questionId ?? ''}|${i.message}`;
    if (vistos.has(k)) continue;
    vistos.add(k);
    out.push(i);
  }
  return out;
}

function GoalCard({ goal, selected, onPick }: { goal: Goal; selected: boolean; onPick: () => void }) {
  const Icon = goal.icon;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        'flex flex-col gap-1.5 rounded-xl p-4 text-left ring-1 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        selected ? 'bg-primary/10 ring-primary' : 'bg-card ring-foreground/10 hover:ring-foreground/25',
      )}
    >
      <span className="flex items-center gap-2.5">
        <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="font-heading text-sm font-medium">{goal.title}</span>
        {selected && <Check className="ml-auto size-4 text-primary" aria-hidden="true" />}
      </span>
      <span className="text-[13px] font-medium text-foreground">{goal.question}</span>
      <span className="text-[13px] leading-relaxed text-muted-foreground">{goal.detail}</span>
    </button>
  );
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function NewJevRun() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<JevDraft>(() => emptyDraft());
  const [anterior, setAnterior] = useState<JevDraft | null>(null);
  const [formStyle, setFormStyle] = useState<'guided' | 'complete'>(lerFormStyle);
  const [step, setStep] = useState<JevStep>('objetivo');
  const [decisionCatalog, setDecisionCatalog] = useState<SrcModel[]>([]);
  const [decisionLoading, setDecisionLoading] = useState(true);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [chatModels, setChatModels] = useState<WebModel[]>([]);
  const [chatLoading, setChatLoading] = useState(true);
  const [lgpd, setLgpd] = useState<LgpdData | null>(null);
  const [tried, setTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [erro, setErro] = useState<{ message: string; issues?: JevLintIssue[] } | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [confirmar, setConfirmar] = useState<JevEstimate | null>(null);
  const [bandasAbertas, setBandasAbertas] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const voltarRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let ativo = true;
    fetchDecisionModels(getStoredKey())
      .then((m) => ativo && setDecisionCatalog(m))
      .catch((e: unknown) => ativo && setDecisionError((e as Error).message))
      .finally(() => ativo && setDecisionLoading(false));
    fetchModels()
      .then((m) => ativo && setChatModels(m))
      .catch(() => undefined)
      .finally(() => ativo && setChatLoading(false));
    fetchLgpd()
      .then((d) => ativo && setLgpd(d))
      .catch(() => undefined);
    return () => {
      ativo = false;
    };
  }, []);

  const patch = (p: Partial<JevDraft>) => setDraft((d) => ({ ...d, ...p }));
  const deb = useDebounced(draft, 200);
  const chatSrc = chatModels as unknown as SrcModel[];
  const decisionModel = decisionCatalog.find((m) => m.id === deb.models.decision?.[0]);
  const specIssues = useMemo(() => lintDraftSpec(deb, decisionModel), [deb, decisionModel]);
  const prep = useMemo(
    () => (deb.cases.length ? prepareJev(draftToConfig(deb), { decision: decisionCatalog, chat: chatSrc }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deb, decisionCatalog, chatModels],
  );
  const resolved = prep?.ok ? prep.value.resolved : null;
  const estimate = prep?.ok ? prep.value.estimate : null;
  const issues = useMemo(
    () => dedupe(prep ? (prep.ok ? [...specIssues, ...prep.value.issues] : [...prep.issues, ...specIssues]) : specIssues),
    [prep, specIssues],
  );

  // LGPD: em área sensível cada modelo de decisão aparece DESABILITADO com o motivo.
  const area = draft.compliance?.area ?? AREA_LIVRE;
  const blocked = useMemo<Record<string, string>>(() => {
    if (!lgpd || area === AREA_LIVRE) return {};
    const ids = [...new Set([...decisionCatalog.map((m) => m.id), ...(draft.models.decision ?? []), ...(draft.models.llm ?? []).map((l) => l.modelId)])];
    const chk = checkRunCompliance(
      { compliance: { area, includeRessalvas: draft.compliance?.includeRessalvas ?? false }, competitorModelIds: ids },
      lgpd,
    );
    return Object.fromEntries(chk.violations.filter((v) => v.modelId).map((v) => [v.modelId!, v.message]));
  }, [lgpd, area, decisionCatalog, draft.models, draft.compliance]);

  // PII nos casos (o pré-voo do Iniciar recusa do mesmo jeito; aqui avisa antes).
  const pii = useMemo(() => (resolved ? checkRunPii(jevComplianceView(resolved)) : null), [resolved]);
  const piiRecusa = pii ? runPiiRefusal(pii) : null;

  const problems: JevProblem[] = useMemo(() => {
    const out = draftProblems(draft, issues, { hasKey: Boolean(getStoredKey()) });
    const escolhidos = [...(draft.models.decision ?? []), ...(draft.models.llm ?? []).map((l) => l.modelId)];
    const bloqueado = escolhidos.find((id) => blocked[id]);
    if (bloqueado) out.push({ step: 'participantes', text: `Área LGPD sensível: ${bloqueado} indisponível — ${blocked[bloqueado]}` });
    if (piiRecusa) out.push({ step: 'casos', text: 'Dado pessoal com aparência de dado real nos casos — veja o aviso no passo Casos.' });
    return out;
  }, [draft, issues, blocked, piiRecusa]);
  const primeira = problems[0];

  function mudarFormStyle(s: 'guided' | 'complete') {
    setFormStyle(s);
    try {
      localStorage.setItem('pb.formStyle', s);
    } catch {
      // sem armazenamento: vale só nesta visita
    }
  }

  function irPara(s: JevStep) {
    if (formStyle === 'guided') {
      setStep(s);
      return;
    }
    const el = document.getElementById(`jev-sec-${s}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
  }

  function carregarExemplo(kind: JevExampleKind) {
    setAnterior(draft);
    const r = draftFromJson(jevExample(kind, draft.mode === 'train' ? 'train' : draft.mode));
    if (r.ok) {
      setDraft(r.draft);
      setAviso(`Exemplo "${JEV_EXAMPLES[kind].theme}" carregado (${JEV_EXAMPLES[kind].cases} casos rotulados à mão).`);
    }
  }

  async function importar(file: File) {
    setErro(null);
    try {
      const r = draftFromJson(JSON.parse(await file.text()));
      if (!r.ok) {
        setErro({ message: r.error });
        return;
      }
      setAnterior(draft);
      setDraft(r.draft);
      setAviso(r.notice ?? `Configuração importada de ${file.name}.`);
    } catch (e) {
      setErro({ message: `Não foi possível ler ${file.name}: ${(e as Error).message}` });
    }
  }

  async function iniciar(confirmado: boolean) {
    setTried(true);
    setErro(null);
    if (problems.length) {
      irPara(problems[0].step);
      return;
    }
    setSubmitting(true);
    try {
      const { id, kind } = await startJev(draftToConfig(draft) as unknown as JevConfigFile, { costConfirmed: confirmado });
      navigate(kind === 'session' ? `/jev/training/${id}` : `/jev/runs/${id}`);
    } catch (e) {
      if (isJevCostConfirmationRequired(e)) setConfirmar(e.estimate);
      else if (isKeyMissing(e)) setErro({ message: 'Conecte a sua chave da OpenRouter em Configurações para iniciar.' });
      else if (isJevConfigError(e)) setErro({ message: 'A definição ou os casos têm erro — nada foi gasto.', issues: e.issues.filter((i) => i.level === 'error') });
      else setErro({ message: (e as Error).message ?? String(e) });
    } finally {
      setSubmitting(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void iniciar(false);
  }

  const train = (draft.train ?? {}) as Record<string, unknown>;
  const setTrain = (p: Record<string, unknown>) => patch({ train: { ...train, ...p } });
  const ops = (Array.isArray(train.operators) ? train.operators : ['add_examples']) as JevOperatorId[];
  const precisaRewriter = ops.some((o) => o !== 'add_examples');
  const alvos = (Array.isArray(train.targetQuestions) ? train.targetQuestions : []) as string[];
  const qids = Object.keys(draft.spec.questions);
  const budgetTxt = draft.budgetUsd === undefined ? '' : String(draft.budgetUsd);
  const temPendencia = (s: JevStep) => problems.some((p) => p.step === s);

  /* ------------------------------------------------------------- seções */

  const secObjetivo: ReactNode = (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {GOALS.map((g) => (
          <GoalCard key={g.id} goal={g} selected={draft.mode === g.id} onPick={() => setDraft((d) => applyMode(d, g.id))} />
        ))}
      </div>
      <SettingGroup>
        <SettingRow wide label="Tema" sub="Uma frase que identifica a decisão no histórico (ex.: triagem de tickets de suporte).">
          <Input aria-label="Tema" value={draft.theme ?? ''} placeholder="Do que se trata esta decisão?" onChange={(e) => patch({ theme: e.target.value })} />
        </SettingRow>
      </SettingGroup>
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-muted-foreground">Começar de um exemplo pronto (casos rotulados à mão):</span>
        {JEV_EXAMPLE_KINDS.map((k) => (
          <Button key={k} type="button" variant="outline" size="sm" onClick={() => carregarExemplo(k)}>
            <FlaskConical aria-hidden="true" />
            {JEV_EXAMPLES[k].theme}
          </Button>
        ))}
      </div>
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        O que esperar: o JEV <strong className="font-medium text-foreground">mede</strong> — não promete a acurácia de um LLM grande. O ganho dele é custo e
        latência muito menores (a saída é grátis), e o valor aparece na <em>cascata</em> (o Jev decide o que tem confiança e escala o resto) e na
        cobertura da banda "auto" com precisão-alvo.
      </p>
    </div>
  );

  const secDecisao: ReactNode = (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        A definição é o "prompt" do modo: cada pergunta tem um tipo, a instrução completa e a rubrica. Cite os campos do estado entre crases
        (ex.: <code className="font-mono">`ticket`</code>). O lint roda a cada edição, sem custo.
      </p>
      <SpecEditor questions={draft.spec.questions} issues={issues} onChange={(qs) => patch({ spec: { ...draft.spec, questions: qs } })} />
    </div>
  );

  const secCasos: ReactNode = (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        Cada caso é um estado (texto ou JSON) com o rótulo-ouro de cada pergunta: <code className="font-mono">true/false</code> no sim/não, a CHAVE da
        opção na escolha, o índice do nível na escala. O modo mede contra esse rótulo — revise-o com cuidado.
      </p>
      <CasesImport
        spec={specOfDraft(draft)}
        cases={draft.cases}
        onChange={(cases) => patch({ cases })}
        resolved={resolved}
        onUseSpec={(spec) =>
          patch({
            spec: {
              ...draft.spec,
              questions: Object.fromEntries(spec.questions.map((q) => [q.id, { type: q.type, instructions: q.instructions, ...('criteria' in q && q.criteria !== undefined ? { criteria: q.criteria } : {}) }])),
            },
          })
        }
      />
      {pii && piiRecusa && (
        <Banner tone="warn" className="flex flex-col gap-2">
          <p>{runPiiMessage(pii)}</p>
          {piiRecusa === 'unreviewed' && (
            <Button type="button" size="sm" variant="outline" className="self-start" onClick={() => patch({ allowPii: true })}>
              Revisei — seguir com o dado pseudonimizado
            </Button>
          )}
        </Banner>
      )}
    </div>
  );

  const secParticipantes: ReactNode = (
    <ContestantPicker
      draft={draft}
      onChange={patch}
      decisionCatalog={decisionCatalog}
      decisionLoading={decisionLoading}
      decisionError={decisionError}
      chatModels={chatModels}
      chatLoading={chatLoading}
      blocked={blocked}
    />
  );

  const plano: string[] = [];
  if (resolved) {
    const nCasos = resolved.cases.length;
    const nQ = resolved.specs[0].questions.length;
    const ctrl = resolved.contestants[0];
    if (draft.mode === 'eval') {
      plano.push(`${ctrl?.label ?? '—'} responde às ${nQ} pergunta(s) em ${nCasos} casos rotulados (${resolved.repeats} repetição(ões)).`);
    } else if (draft.mode === 'compare') {
      plano.push(`${resolved.contestants.length} competidores respondem aos MESMOS ${nCasos} casos, intercalados no tempo; o controle é ${ctrl?.label ?? '—'}.`);
      plano.push(`Cada um é comparado ao controle caso a caso: McNemar exato na acurácia e sign-flip pareado no Brier (métrica primária: ${resolved.primary === 'accuracy' ? 'acurácia' : 'Brier'}).`);
      if (resolved.contestants.some((c) => c.kind === 'llm')) plano.push('Com LLM no páreo, a run simula a cascata: o Jev decide a banda "auto" e o resto escala para o LLM.');
    } else if (resolved.train) {
      const t = resolved.train;
      plano.push(`Ciclo 0 mede a definição original em treino+calibração (${t.targetQuestions.join(', ')}).`);
      plano.push(`Até ${t.iterations} ciclo(s) de ${t.variantsPerIteration} variante(s) (${t.operators.join(', ')}); uma variante só vira campeã com ganho ≥ ${t.minGainPp} p.p. e p ajustado ≤ 0,05, sem perder mais de ${t.maxAccuracyDropPp} p.p. de acurácia.`);
      plano.push(`No fim: temperatura e limiares ajustados na calibração, e a confirmação no holdout (original × campeã).`);
    }
    if (resolved.fit && draft.mode !== 'train') plano.push('A política (temperatura + limiares das bandas) é ajustada no split de calibração e mostrada ao lado do resultado cru.');
  }

  const secLimites: ReactNode = (
    <div className="flex flex-col gap-4">
      <SettingGroup title="Quanto medir e até quanto gastar">
        {draft.mode === 'train' ? (
          <>
            <NumRow label="Ciclos" sub="Rodadas de variantes (o treino para antes se nada for promovido por 2 ciclos seguidos)." value={num(train.iterations, 2)} onChange={(v) => setTrain({ iterations: v })} min={1} max={10} />
            <NumRow label="Variantes por ciclo" value={num(train.variantsPerIteration, 2)} onChange={(v) => setTrain({ variantsPerIteration: v })} min={1} max={8} />
            <NumRow label="Repetições" sub="O Jev não é determinístico: 2 repetições estabilizam o gate." value={num(train.repeats, 1)} onChange={(v) => setTrain({ repeats: v })} min={1} max={5} />
            <SettingRow wide label="Perguntas-alvo" sub="Só elas evoluem; as outras ficam congeladas (e as de guarda nunca entram).">
              <RovingToolbar label="Perguntas-alvo" count={qids.length} className="flex flex-wrap gap-1.5">
                {qids.map((q, i) => (
                  <Chip
                    key={q}
                    index={i}
                    on={alvos.includes(q)}
                    label={q}
                    onClick={() => setTrain({ targetQuestions: alvos.includes(q) ? alvos.filter((x) => x !== q) : [...alvos, q] })}
                  />
                ))}
              </RovingToolbar>
            </SettingRow>
            <SettingRow wide label="Operadores" sub="add_examples é determinístico (copia casos do treino para a rubrica, sem LLM). Os outros usam um proponente (LLM) — cobrado à parte.">
              <RovingToolbar label="Operadores" count={JEV_TRAIN_OPERATORS_V1.length} className="flex flex-wrap gap-1.5">
                {JEV_TRAIN_OPERATORS_V1.map((o, i) => (
                  <Chip
                    key={o}
                    index={i}
                    on={ops.includes(o)}
                    label={JEV_OPERATORS[o]?.label ?? o}
                    title={`${JEV_OPERATORS[o]?.label ?? o}: ${JEV_OPERATORS[o]?.what ?? ""}`}
                    onClick={() => setTrain({ operators: ops.includes(o) ? ops.filter((x) => x !== o) : [...ops, o] })}
                  />
                ))}
              </RovingToolbar>
            </SettingRow>
            {precisaRewriter && (
              <SettingRow wide label="Proponente (LLM)" sub="Reescreve UMA pergunta por variante, vendo só casos do treino.">
                <ModelSelector
                  multi={false}
                  title="Proponente"
                  value={typeof train.rewriterModelId === 'string' ? [train.rewriterModelId] : []}
                  onChange={(ids) => setTrain({ rewriterModelId: ids[0] })}
                  models={chatModels}
                  loading={chatLoading}
                  tuningFields={[]}
                />
              </SettingRow>
            )}
            <TxtNumRow label="Ganho mínimo (p.p.)" sub="Margem sobre a campeã para promover (Brier calibrado)." value={String(num(train.minGainPp, 1))} onChange={(v) => setTrain({ minGainPp: v === '' ? undefined : Number(v) })} min={0} step={0.5} />
            <TxtNumRow
              label="Holdout (fração)"
              sub="Casos guardados para a confirmação final (≥ 10 para não sair 'fraca')."
              value={String(draft.split?.holdoutRatio ?? 0.3)}
              onChange={(v) => patch({ split: { ...(draft.split ?? {}), holdoutRatio: v === '' ? undefined : Number(v) } })}
              min={0}
              max={0.5}
              step={0.05}
            />
          </>
        ) : (
          <>
            <NumRow label="Repetições" sub="Cada caso é perguntado N vezes (a resposta varia um pouco); mede a estabilidade (flip rate)." value={draft.repeats ?? 1} onChange={(v) => patch({ repeats: v })} min={1} max={3} />
            <SwitchRow
              label="Ajustar a política na calibração"
              sub="Temperatura pós-hoc e limiares das bandas ajustados num split de calibração (mostrados ao lado do resultado cru)."
              checked={draft.fit ?? draft.mode === 'eval'}
              onChange={(v) => patch({ fit: v })}
            />
            {draft.mode === 'compare' && (
              <SettingRow label="Métrica primária" sub="A que decide a comparação pareada com o controle.">
                <SegmentedToggle value={draft.compare?.primary ?? ((draft.models.llm?.length ?? 0) > 0 ? 'accuracy' : 'brierScore')} onChange={(v) => patch({ compare: { primary: v as 'accuracy' | 'brierScore' } })} ariaLabel="Métrica primária">
                  <SegmentedToggleOption value="accuracy" className="px-2.5 py-1 text-[12.5px]">
                    Acurácia
                  </SegmentedToggleOption>
                  <SegmentedToggleOption value="brierScore" className="px-2.5 py-1 text-[12.5px]">
                    Brier
                  </SegmentedToggleOption>
                </SegmentedToggle>
              </SettingRow>
            )}
          </>
        )}
        <TxtNumRow
          label="Teto de gasto (US$)"
          sub="A run para sozinha antes de passar deste valor (o que não couber sai como caso incompleto, fora das métricas)."
          value={budgetTxt}
          onChange={(v) => patch({ budgetUsd: v === '' ? undefined : Number(v) })}
          min={0}
          step={0.01}
          placeholder={jevUsesLlm(draft) ? 'obrigatório com LLM' : 'sem teto'}
        />
        <TxtNumRow
          label="Precisão-alvo da banda auto"
          sub="A cobertura da banda auto é medida (e o limiar ajustado) para esta precisão."
          value={String(draft.targetPrecision ?? 0.95)}
          onChange={(v) => patch({ targetPrecision: v === '' ? undefined : Number(v) })}
          min={0.5}
          max={1}
          step={0.01}
        />
      </SettingGroup>

      <Disclosure
        id="jev-sec-bandas"
        title="Bandas de ação e LGPD"
        open={bandasAbertas}
        onToggle={() => setBandasAbertas((o) => !o)}
      >
        <SettingGroup
          footer='Sinal ≥ auto → age sozinho; ≥ hitl → revisão humana; abaixo → abstém. No sim/não o sinal é a certeza max(p, 1−p): com hitl 0,5 ele NUNCA abstém — por isso o padrão aqui é 0,6.'
        >
          {(['noul', 'choice', 'score'] as const).map((t) => {
            const def = t === 'noul' ? { auto: 0.9, hitl: 0.6 } : { auto: 0.9, hitl: 0.5 };
            const b = draft.bands?.[t] ?? def;
            const set = (k: 'auto' | 'hitl', v: string) =>
              patch({ bands: { ...(draft.bands ?? {}), [t]: { ...b, [k]: v === '' ? def[k] : Number(v) } } });
            return (
              <SettingRow key={t} label={t === 'noul' ? 'Sim/não' : t === 'choice' ? 'Escolha' : 'Escala'}>
                <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
                  auto
                  <Input type="number" aria-label={`auto (${t})`} className="w-20" min={0} max={1.01} step={0.01} value={b.auto} onChange={(e) => set('auto', e.target.value)} />
                </label>
                <label className="flex items-center gap-1 text-[12px] text-muted-foreground">
                  hitl
                  <Input type="number" aria-label={`hitl (${t})`} className="w-20" min={0} max={1} step={0.01} value={b.hitl} onChange={(e) => set('hitl', e.target.value)} />
                </label>
              </SettingRow>
            );
          })}
          <SettingRow wide label="Área (LGPD)" sub="Em área sensível o JEV fica indisponível na v1: o Jev não tem retenção zero (ZDR).">
            <RovingToolbar label="Área LGPD" count={(lgpd?.areas.length ?? 0) + 1} className="flex flex-wrap gap-1.5">
              <Chip index={0} on={area === AREA_LIVRE} label="Livre" onClick={() => patch({ compliance: undefined })} />
              {lgpd?.areas.map((a, i) => (
                <Chip key={a.id} index={i + 1} on={area === a.id} label={a.label ?? a.id} onClick={() => patch({ compliance: { area: a.id } })} />
              ))}
            </RovingToolbar>
          </SettingRow>
          <SettingRow label="Dado pessoal" sub='"Redigir" pseudonimiza CPF/e-mail/telefone antes de cada envio; "só sintético" recusa qualquer dado de aparência real.'>
            <SegmentedToggle value={draft.piiMode ?? 'redact'} onChange={(v) => patch({ piiMode: v as 'redact' | 'synthetic' })} ariaLabel="Modo de dado pessoal">
              <SegmentedToggleOption value="redact" className="px-2.5 py-1 text-[12.5px]">
                Redigir
              </SegmentedToggleOption>
              <SegmentedToggleOption value="synthetic" className="px-2.5 py-1 text-[12.5px]">
                Só sintético
              </SegmentedToggleOption>
            </SegmentedToggle>
          </SettingRow>
        </SettingGroup>
      </Disclosure>

      <div className="rounded-xl bg-card p-4 ring-1 ring-foreground/10">
        <h3 className="font-heading text-sm font-medium">O plano</h3>
        {plano.length ? (
          <ol className="mt-3 flex flex-col gap-2.5">
            {plano.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground tabular">{i + 1}</span>
                <span className="text-sm leading-relaxed">{t}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="mt-2 text-[13px] text-muted-foreground">O plano aparece quando a definição e os casos resolverem.</p>
        )}
        {estimate && (
          <p className="mt-3 border-t border-border pt-3 text-[13px] text-muted-foreground tabular">
            {estimate.requests.toLocaleString('pt-BR')} request(s) · ~{fmtUsd(estimate.usdLow)} – {fmtUsd(estimate.usdHigh)}
            {estimate.detectableDeltaPp !== null ? ` · diferença detectável ≈ ${estimate.detectableDeltaPp.toLocaleString('pt-BR')} p.p. de Brier` : ''}
            {draft.budgetUsd !== undefined ? ` · teto ${fmtUsd(draft.budgetUsd)}` : ' · sem teto definido'}
          </p>
        )}
        {estimate?.notes.map((n) => (
          <p key={n} className="mt-1 text-[12px] text-muted-foreground">
            {n}
          </p>
        ))}
        {/* Os dois caminhos (web/src/jev/transfer.ts): a aba é o principal; o terminal é o reserva. */}
        <p className="mt-1 text-[12px] text-muted-foreground">
          Roda nesta aba, direto no endpoint de decisões da OpenRouter (sem servidor no meio). Se a sua rede bloquear, o mesmo arquivo de «Exportar JSON» roda no
          terminal com <code className="font-mono">prompt-builder jev run -c</code>, e o resultado volta para o Histórico por «Importar do terminal».
        </p>
        {problems.length > 0 ? (
          <div className="mt-3 rounded-lg border border-border p-3">
            <p className="text-[13px] font-medium">Antes de iniciar, falta:</p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {problems.slice(0, 8).map((pr, i) => (
                <li key={`${pr.text}-${i}`}>
                  <button type="button" className="text-left text-[13px] text-primary underline-offset-4 hover:underline" onClick={() => irPara(pr.step)}>
                    {STEP_LABEL[pr.step]}: {pr.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
            <Check className="size-4 text-resolve" aria-hidden="true" />
            Tudo pronto — «Iniciar» está no rodapé.
          </p>
        )}
      </div>
    </div>
  );

  const SECOES: Record<JevStep, { title: string; body: ReactNode }> = {
    objetivo: { title: 'O que você quer descobrir?', body: secObjetivo },
    decisao: { title: 'Qual decisão o modelo deve tomar?', body: secDecisao },
    casos: { title: 'Em quais casos rotulados?', body: secCasos },
    participantes: { title: 'Quem decide?', body: secParticipantes },
    limites: { title: 'Quanto medir, quanto gastar — e o plano', body: secLimites },
  };
  const stepIdx = STEPS.indexOf(step);

  return (
    <form onSubmit={submit} aria-label="Nova run JEV">
      <Screen className="pb-44 md:pb-32">
        <PageHeader
          title="Nova run JEV"
          subtitle={MODE_SUBTITLE[draft.mode]}
          actions={
            <>
              <RovingToolbar label="Ações da configuração JEV" count={4} className="flex flex-wrap items-center gap-2">
                <RovingItem index={0}>
                  {(roving) => (
                    <Button type="button" variant="outline" size="sm" {...roving} onClick={() => importRef.current?.click()}>
                      <Upload aria-hidden="true" />
                      Importar JSON
                    </Button>
                  )}
                </RovingItem>
                <RovingItem index={1}>
                  {(roving) => (
                    <Button type="button" variant="outline" size="sm" {...roving} onClick={() => baixarJson('jev-config.json', draftToConfig(draft))}>
                      <Download aria-hidden="true" />
                      Exportar JSON
                    </Button>
                  )}
                </RovingItem>
                <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
                <RovingItem index={2}>
                  {(roving) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      {...roving}
                      aria-pressed={formStyle === 'guided'}
                      className={formStyle === 'guided' ? 'bg-muted text-foreground' : 'text-muted-foreground'}
                      onClick={() => mudarFormStyle('guided')}
                    >
                      Guiado
                    </Button>
                  )}
                </RovingItem>
                <RovingItem index={3}>
                  {(roving) => (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      {...roving}
                      aria-pressed={formStyle === 'complete'}
                      className={formStyle === 'complete' ? 'bg-muted text-foreground' : 'text-muted-foreground'}
                      onClick={() => mudarFormStyle('complete')}
                    >
                      Completo
                    </Button>
                  )}
                </RovingItem>
              </RovingToolbar>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                aria-label="Arquivo jev-config@1"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void importar(f);
                  e.target.value = '';
                }}
              />
            </>
          }
        />

        {aviso && (
          <div className="mb-4">
            <ImportedLine
              text={aviso}
              action={anterior ? 'desfazer' : 'dispensar'}
              onAction={() => {
                if (anterior) setDraft(anterior);
                setAnterior(null);
                setAviso(null);
              }}
            />
          </div>
        )}

        {erro && (
          <Banner tone="error" className="mb-4 flex flex-col gap-2">
            <p>{erro.message}</p>
            {erro.issues && <IssueList issues={erro.issues.slice(0, 8)} />}
          </Banner>
        )}

        {formStyle === 'guided' ? (
          <div className="mt-1">
            <SmoothTabs value={step} onValueChange={(v) => setStep(v as JevStep)}>
              {/* left#16: mesmo arranjo do trilho do guiado LLM — a 390 px os
                  passos QUEBRAM em linhas em vez de rolar (a pista de
                  pendência nunca fica atrás de uma rolagem horizontal). */}
              <SmoothTabsList ariaLabel="Passos da configuração JEV" className="w-fit max-w-full flex-wrap overflow-x-auto">
                {STEPS.map((s, i) => (
                  <SmoothTabsTab key={s} value={s} className="px-3 py-1.5 text-[13px]">
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      <span className="font-mono text-[11px] tabular opacity-70">{i + 1}</span>
                      {STEP_LABEL[s]}
                      {s !== 'objetivo' && s !== 'limites' && !temPendencia(s) && <Check className="size-3.5 text-resolve" aria-hidden="true" />}
                    </span>
                  </SmoothTabsTab>
                ))}
              </SmoothTabsList>
              <SmoothTabsPanels className="mt-4 min-h-[19rem] rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
                {STEPS.map((s) => (
                  <SmoothTabsPanel key={s} value={s}>
                    <div className="flex flex-col gap-4">
                      <h2 className="font-heading text-base font-medium">{SECOES[s].title}</h2>
                      {SECOES[s].body}
                    </div>
                  </SmoothTabsPanel>
                ))}
              </SmoothTabsPanels>
            </SmoothTabs>
            <div className="mt-4 flex items-center justify-between">
              <Button type="button" variant="ghost" size="sm" disabled={stepIdx === 0} onClick={() => setStep(STEPS[Math.max(0, stepIdx - 1)])}>
                <ArrowLeft aria-hidden="true" />
                Voltar
              </Button>
              {stepIdx < STEPS.length - 1 && (
                <Button type="button" size="sm" onClick={() => setStep(STEPS[stepIdx + 1])}>
                  {STEPS[stepIdx + 1] === 'limites' ? 'Limites e revisão' : 'Avançar'}
                  <ArrowRight aria-hidden="true" />
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-col">
            {STEPS.map((s) => (
              <section key={s} id={`jev-sec-${s}`} tabIndex={-1} className="mb-8 scroll-mt-28 outline-none" aria-labelledby={`jev-sec-${s}-h`}>
                <div className="mt-6 mb-3 flex items-center gap-3">
                  <h2 id={`jev-sec-${s}-h`} className="text-xs font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                    {STEP_LABEL[s]}
                  </h2>
                  {temPendencia(s) && (
                    <span className={cn('size-1.5 rounded-full', tried ? 'bg-destructive' : 'bg-muted-foreground/60')} aria-label="pendência nesta seção" />
                  )}
                  <span className="h-px flex-1 bg-border" aria-hidden="true" />
                </div>
                {SECOES[s].body}
              </section>
            ))}
          </div>
        )}
      </Screen>

      {/* Rodapé fixo (mesmo idioma do formulário LLM — IMPL-110). */}
      <div className="fixed inset-x-0 z-30 border-t border-border bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur-md bottom-[calc(3.5rem+env(safe-area-inset-bottom))] md:bottom-0">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-5 py-3 sm:px-6">
          <div className="min-w-0 flex-1 text-[13px]">
            {primeira ? (
              <button
                type="button"
                className={cn('text-left underline-offset-4 hover:underline', tried ? 'text-destructive' : 'text-muted-foreground')}
                onClick={() => irPara(primeira.step)}
              >
                {primeira.text}
              </button>
            ) : !getStoredKey() ? (
              <span className="text-muted-foreground">
                Conecte sua chave da OpenRouter em{' '}
                <Link className="text-primary underline-offset-4 hover:underline" to="/settings">
                  Configurações
                </Link>
                .
              </span>
            ) : null}
          </div>
          <span className="shrink-0 text-right text-[12px] text-muted-foreground tabular">
            <span className="block text-[10px] tracking-wide uppercase">
              custo estimado{draft.budgetUsd !== undefined ? ` · teto ${fmtUsd(draft.budgetUsd)}` : ''}
            </span>
            {estimate ? `~${fmtUsd(estimate.usdLow)} – ${fmtUsd(estimate.usdHigh)}` : '—'}
            {estimate && <span className="block text-[10px] text-muted-foreground/80">{estimate.requests.toLocaleString('pt-BR')} requests · saída grátis</span>}
          </span>
          <MultiStateButton
            type="submit"
            state={submitting ? 'submitting' : 'idle'}
            icon={submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="size-4" aria-hidden="true" />}
            disabled={submitting}
            aria-label="Iniciar a run JEV"
            pillClassName="rounded-lg px-4 py-2 text-sm font-medium"
          >
            {submitting ? 'Iniciando…' : 'Iniciar'}
          </MultiStateButton>
        </div>
      </div>

      <Modal open={confirmar !== null} onClose={() => setConfirmar(null)} label="Confirmar custo estimado" initialFocus={voltarRef}>
        {confirmar && (
          <div className="flex flex-col gap-4 overflow-y-auto p-5">
            <div className="pr-8">
              <h2 className="font-heading text-lg font-medium tracking-tight">Confirmar custo estimado</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Esta {draft.mode === 'train' ? 'sessão de treino' : 'run'} pode custar até {fmtUsd(confirmar.usdHigh)} (faixa ~{fmtUsd(confirmar.usdLow)} – {fmtUsd(confirmar.usdHigh)}). O
                custo real sai de <code className="font-mono">usage.cost</code> de cada resposta.
              </p>
              {confirmar.unknownPriceModelIds.length > 0 && (
                <p className="mt-2 text-sm text-destructive">
                  Sem preço no catálogo para {confirmar.unknownPriceModelIds.join(', ')}: a faixa acima NÃO conta o gasto desse modelo. Quem limita é o teto
                  {draft.budgetUsd !== undefined ? ` de ${fmtUsd(draft.budgetUsd)}` : ''}.
                </p>
              )}
            </div>
            <ul className="flex flex-col gap-1 rounded-lg border border-border px-4 py-3 text-[13px] tabular">
              {confirmar.byContestant.map((c) => (
                <li key={c.id} className="flex justify-between gap-3">
                  <span className="min-w-0 truncate">{c.label}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {c.requests} req · {fmtUsd(c.usd)}
                  </span>
                </li>
              ))}
              {confirmar.byKind.rewriter > 0 && (
                <li className="flex justify-between gap-3">
                  <span>proponente (treino)</span>
                  <span className="text-muted-foreground">{fmtUsd(confirmar.byKind.rewriter)}</span>
                </li>
              )}
            </ul>
            <div className="flex justify-end gap-2">
              <Button ref={voltarRef} type="button" variant="outline" onClick={() => setConfirmar(null)}>
                Voltar
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirmar(null);
                  void iniciar(true);
                }}
              >
                Confirmar e iniciar
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </form>
  );
}
