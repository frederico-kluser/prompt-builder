import { useMemo } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, Scale, TrendingUp, type LucideIcon } from 'lucide-react';
import {
  SmoothTabs,
  SmoothTabsList,
  SmoothTabsTab,
  SmoothTabsPanels,
  SmoothTabsPanel,
} from '@/components/motion-ui/smooth-tabs';
import { Button } from '@/components/ui/button';
import { ModelSelector, type ModelTuning } from './ModelSelector';
import { AreaRow, NumRow, SwitchRow, TxtNumRow } from './formRows';
import { SettingGroup, SettingRow } from './primitives';
import { cn } from '@/lib/utils';
import type { OpenRouterModel, RunMode } from '../api';

/**
 * Fluxo GUIADO da Nova Run (pedido do dono: "configuração totalmente guiada").
 *
 * Uma pergunta por passo, em linguagem natural, sobre o MESMO estado do
 * formulário completo (`pages/NewRun.tsx`): o `GuidedSetup` não monta nenhum
 * `RunConfig` — ele só escreve nos setters que o `submit()` do NewRun já lê.
 * O rodapé (pendências + estimativa + Iniciar) continua único nos dois modos.
 *
 * `SmoothTabs` faz de trilho de passos: 5 painéis estáveis (os MESMOS em todos
 * os modos — nada de painel condicional), navegação livre (voltar/avançar e
 * clique direto no trilho), pois nada aqui é obrigatório antes do envio.
 *
 * IMPL-106 (d) na superfície GUIADA (decisão do dono, ef07ce2: o guiado é o
 * default e é um assistente — os campos de um passo não ficam à vista nos
 * outros). O critério "nenhum obrigatório oculto" vira aqui "nenhum obrigatório
 * oculto SEM pista visível": o passo com pendência ganha um ponto no TRILHO
 * (sempre à vista, com "pendente" no nome acessível), o rodapé fixo nomeia a
 * 1ª pendência e leva ao passo, e a Revisão lista todas com link. Contrato E2E
 * em test/ux-nova-run-e2e.test.ts (superfície guiada).
 */

/** As 5 seções da página única (IMPL-106) — mesmo vocabulário do NewRun. */
export type FormSection = 'cenarios' | 'sujeitos' | 'juizes' | 'avancado';

/** Pendência vinda do `problems()` do NewRun. */
export interface GuidedProblem {
  section: FormSection;
  text: string;
  /** Passo que mostra o campo, quando não é o da seção (ver `stepOfProblem`). */
  step?: GuidedStep;
  /** O campo só existe na configuração completa: o link a abre. */
  onlyComplete?: boolean;
}

export type GuidedStep = 'objetivo' | 'teste' | 'participantes' | 'limites' | 'revisao';

export const GUIDED_STEPS: GuidedStep[] = ['objetivo', 'teste', 'participantes', 'limites', 'revisao'];

const STEP_LABEL: Record<GuidedStep, string> = {
  objetivo: 'Objetivo',
  teste: 'Teste',
  participantes: 'Participantes',
  limites: 'Limites',
  revisao: 'Revisão',
};

/** Passo que resolve cada pendência do formulário (usado pelo rodapé e aqui). */
export const SECTION_STEP: Record<FormSection, GuidedStep> = {
  cenarios: 'teste',
  sujeitos: 'participantes',
  juizes: 'participantes',
  avancado: 'limites',
};

/**
 * Passo que RESOLVE a pendência: o explícito (campo que mora num passo diferente
 * do da sua seção — ex.: o gabarito, no Avançado da completa e em
 * "Participantes" aqui) ou o da seção.
 */
export function stepOfProblem(pr: GuidedProblem): GuidedStep {
  return pr.step ?? SECTION_STEP[pr.section];
}

/* ---------------------------------------------------------------- objetivos */

export interface GuidedGoal {
  id: RunMode;
  icon: LucideIcon;
  title: string;
  /** A pergunta do usuário, nas palavras dele. */
  question: string;
  /** O que roda, em 1 linha. */
  detail: string;
}

/** Os objetivos do fluxo guiado — o `id` é o modo do benchmark. */
export const GOALS: GuidedGoal[] = [
  {
    id: 'compare',
    icon: Scale,
    title: 'Comparar modelos',
    question: 'Qual modelo responde melhor ao meu caso?',
    detail: 'Vários modelos respondem aos mesmos cenários; um juiz decide quem foi melhor em cada um.',
  },
  {
    id: 'variation',
    icon: Copy,
    title: 'Testar o meu prompt',
    question: 'Esta versão do prompt é melhor que a atual?',
    detail: 'Um modelo responde com várias versões do system prompt; o juiz diz qual resolve melhor.',
  },
  {
    id: 'training',
    icon: TrendingUp,
    title: 'Treinar um prompt',
    question: 'Melhore o meu prompt automaticamente.',
    detail: 'O prompt evolui rodada a rodada, com campeã só quando há ganho real, e termina num teste cego.',
  },
];

/* -------------------------------------------------------------------- props */

export interface GuidedSetupProps {
  step: GuidedStep;
  onStepChange: (s: GuidedStep) => void;
  mode: RunMode;
  setMode: (m: RunMode) => void;
  theme: string;
  setTheme: (v: string) => void;
  basePrompt: string;
  setBasePrompt: (v: string) => void;
  stages: number;
  /** Nº de cenários EFETIVO (clamp 1–50 + seeds) — o que o plano descreve. */
  plannedStages: number;
  setStages: (v: number) => void;
  budget: string;
  setBudget: (v: string) => void;
  competitors: string[];
  setCompetitors: (v: string[]) => void;
  contestantModel: string[];
  setContestantModel: (v: string[]) => void;
  datagen: string[];
  setDatagen: (v: string[]) => void;
  judge: string[];
  setJudge: (v: string[]) => void;
  /** Gabarito (IMPL-048): obrigatório em teste/treino, distinto de juízes e do modelo sob teste. */
  referenceModel: string[];
  setReferenceModel: (v: string[]) => void;
  duelsOn: boolean;
  setDuelsOn: (v: boolean) => void;
  finalists: number;
  setFinalists: (v: number) => void;
  models: OpenRouterModel[];
  modelsLoading: boolean;
  tuning: Record<string, ModelTuning>;
  onTuningChange: (modelId: string, patch: Partial<ModelTuning>) => void;
  problems: GuidedProblem[];
  /** Estimativa do rodapé (mesma conta), para o plano em linguagem natural. */
  estimate: { low: number; high: number } | null;
  /** Sai para o formulário completo (mesmo estado). */
  onOpenClassic: () => void;
  /** Já tentou iniciar: o ponto de pendência do trilho fica vermelho (como nas seções). */
  tried?: boolean;
}

function usd(v: number): string {
  if (!v) return 'US$ 0';
  return `US$ ${v.toFixed(v < 1 ? 4 : 2)}`;
}

/** Rótulo de um modelo pelo catálogo (fallback: o id). */
function labelOf(models: OpenRouterModel[], id: string | undefined): string {
  if (!id) return '—';
  const m = models.find((x) => x.id === id);
  return (m as { name?: string } | undefined)?.name ?? id;
}

/* -------------------------------------------------------------------- passos */

export function GoalCard({
  goal,
  selected,
  onPick,
}: {
  goal: GuidedGoal;
  selected: boolean;
  onPick: () => void;
}) {
  const Icon = goal.icon;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onPick}
      className={cn(
        'flex flex-col gap-1.5 rounded-xl p-4 text-left ring-1 transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
        selected
          ? 'bg-primary/10 ring-primary'
          : 'bg-card ring-foreground/10 hover:ring-foreground/25',
      )}
    >
      <span className="flex items-center gap-2.5">
        <span
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-lg',
            selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground',
          )}
        >
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

/** O plano da run em linguagem natural — a representação de ALTO NÍVEL do config. */
function RunPlan({ p }: { p: GuidedSetupProps }) {
  const isCompare = p.mode === 'compare';
  const tema = p.theme.trim();
  const gerador = labelOf(p.models, p.datagen[0]);
  const juizes = p.judge.map((id) => labelOf(p.models, id)).filter(Boolean);
  const competidores = isCompare
    ? p.competitors.map((id) => labelOf(p.models, id))
    : [labelOf(p.models, p.contestantModel[0])];
  const lista =
    competidores.length > 1
      ? `${competidores.slice(0, -1).join(', ')} e ${competidores.at(-1)}`
      : competidores[0] ?? '—';

  const gabarito = p.referenceModel[0] ? labelOf(p.models, p.referenceModel[0]) : null;
  const passos = [
    `O gerador ${gerador} cria ${p.plannedStages} cenário${p.plannedStages > 1 ? 's' : ''} ${tema ? `sobre “${tema.slice(0, 90)}${tema.length > 90 ? '…' : ''}”` : 'a partir do tema'}.`,
    gabarito ? `O modelo ${gabarito} escreve o gabarito — a resposta ideal — de cada cenário.` : null,
    isCompare
      ? `Os modelos ${lista} respondem a todos os cenários, nas mesmas condições.`
      : `O modelo ${lista} responde a cada cenário ${p.mode === 'training' ? 'com o prompt que evolui a cada rodada' : 'com cada versão do prompt'}.`,
    `O juiz ${juizes.join(' + ') || '—'} compara cada resposta com o gabarito e dá um veredito: resolve, parcial ou não resolve.`,
    p.duelsOn && p.finalists > 0
      ? `No fim, os ${p.finalists} melhores duelam entre si em todos os cenários — o duelo final confirma o vencedor.`
      : 'Sem duelo final: o vencedor sai do placar de vereditos.',
    p.mode === 'training'
      ? 'No treino, uma variante só vira campeã se superar a atual com margem real; a sessão termina num teste cego (holdout).'
      : null,
  ].filter(Boolean) as string[];

  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {passos.map((texto, i) => (
          <li key={i} className="flex gap-3">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground tabular">
              {i + 1}
            </span>
            <span className="text-sm leading-relaxed">{texto}</span>
          </li>
        ))}
      </ol>
      <p className="border-t border-border pt-3 text-[13px] text-muted-foreground">
        {p.budget.trim()
          ? `A run para sozinha antes de passar de ${p.budget.trim()} US$.`
          : 'Sem teto de gasto definido — recomenda-se colocar um.'}{' '}
        {p.estimate ? `Estimativa desta configuração: ${usd(p.estimate.low)} – ${usd(p.estimate.high)}.` : ''}
      </p>
    </div>
  );
}

export function GuidedSetup(p: GuidedSetupProps) {
  const isCompare = p.mode === 'compare';
  const stepIdx = GUIDED_STEPS.indexOf(p.step);

  // Um passo está "resolvido" quando nenhuma pendência vive nele. O objetivo
  // está sempre resolvido (escolher é opcional — o default já roda).
  const pendentes = useMemo(() => {
    const por = new Map<GuidedStep, GuidedProblem[]>();
    for (const pr of p.problems) {
      const s = stepOfProblem(pr);
      por.set(s, [...(por.get(s) ?? []), pr]);
    }
    return por;
  }, [p.problems]);

  function resolvido(step: GuidedStep): boolean {
    return step !== 'revisao' && step !== 'objetivo' && !(pendentes.get(step)?.length);
  }

  /** Passo com campo obrigatório pendente (a Revisão só lista, não pisca). */
  function pendente(step: GuidedStep): boolean {
    return step !== 'revisao' && !!pendentes.get(step)?.length;
  }

  function go(delta: number) {
    const next = GUIDED_STEPS[Math.min(GUIDED_STEPS.length - 1, Math.max(0, stepIdx + delta))];
    p.onStepChange(next);
  }

  // Escolher o objetivo aplica também o preset correspondente: no teste de
  // prompts as variantes nascem automaticamente (o manual fica no modo completo).
  function pickGoal(id: RunMode) {
    p.setMode(id);
    if (id !== 'compare') p.setContestantModel(p.contestantModel.length ? p.contestantModel : []);
  }

  return (
    <div className="mt-5">
      <SmoothTabs value={p.step} onValueChange={(v) => p.onStepChange(v as GuidedStep)}>
        <SmoothTabsList ariaLabel="Passos da configuração guiada" className="w-fit max-w-full overflow-x-auto">
          {GUIDED_STEPS.map((s, i) => (
            <SmoothTabsTab key={s} value={s} className="px-3 py-1.5 text-[13px]">
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <span className="font-mono text-[11px] tabular opacity-70">{i + 1}</span>
                {STEP_LABEL[s]}
                {resolvido(s) && <Check className="size-3.5 text-resolve" aria-hidden="true" />}
                {pendente(s) && (
                  <>
                    {/* Pista VISÍVEL de obrigatório pendente neste passo (IMPL-106 d). */}
                    <span
                      data-pendente=""
                      aria-hidden="true"
                      className={cn('size-1.5 rounded-full', p.tried ? 'bg-destructive' : 'bg-muted-foreground/60')}
                    />
                    <span className="sr-only">(pendente)</span>
                  </>
                )}
              </span>
            </SmoothTabsTab>
          ))}
        </SmoothTabsList>

        <SmoothTabsPanels className="mt-4 min-h-[19rem] rounded-xl bg-card p-4 ring-1 ring-foreground/10 sm:p-5">
          {/* ------------------------------------------------------ objetivo */}
          <SmoothTabsPanel value="objetivo">
            <fieldset className="flex flex-col gap-4">
              <legend className="font-heading text-base font-medium">
                O que você quer descobrir?
              </legend>
              <p className="text-sm leading-relaxed text-muted-foreground">
                Escolha o objetivo — a configuração seguinte adapta-se a ele. Pode mudar depois, e
                qualquer detalhe fino continua disponível na configuração completa.
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {GOALS.map((g) => (
                  <GoalCard
                    key={g.id}
                    goal={g}
                    selected={p.mode === g.id}
                    onPick={() => pickGoal(g.id)}
                  />
                ))}
              </div>
            </fieldset>
          </SmoothTabsPanel>

          {/* --------------------------------------------------------- teste */}
          <SmoothTabsPanel value="teste">
            <div className="flex flex-col gap-4">
              <h2 className="font-heading text-base font-medium">Sobre o que é o teste?</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                O tema guia a geração dos cenários — as perguntas que os participantes vão ter de
                responder. Uma frase chega: assunto + tipo de situação.
              </p>
              <SettingGroup>
                <AreaRow
                  label="Tema"
                  sub="Ex.: atendimento de clínica de exames — FAQs, preparo e agendamento."
                  value={p.theme}
                  onChange={p.setTheme}
                  placeholder="Descreva o assunto e o tipo de situação"
                />
                {!isCompare && (
                  <AreaRow
                    label="O seu system prompt (opcional)"
                    sub="O prompt atual. Ele entra como controlo — as variações competem contra ele."
                    value={p.basePrompt}
                    onChange={p.setBasePrompt}
                    rows={5}
                    placeholder="Cole aqui o prompt que você usa hoje"
                  />
                )}
              </SettingGroup>
              <p className="text-[13px] text-muted-foreground">
                Já tem cenários ou uma configuração pronta? Use «Importar JSON» no topo — o plano
                passa a usar o que veio no arquivo.
              </p>
            </div>
          </SmoothTabsPanel>

          {/* -------------------------------------------------- participantes */}
          <SmoothTabsPanel value="participantes">
            <div className="flex flex-col gap-4">
              <h2 className="font-heading text-base font-medium">
                Quem compete, quem escreve e quem avalia?
              </h2>
              <SettingGroup>
                <SettingRow
                  wide
                  label={isCompare ? 'Modelos competidores' : 'Modelo sob teste'}
                  sub={
                    isCompare
                      ? 'Dois ou mais modelos respondem aos mesmos cenários, nas mesmas condições.'
                      : 'O modelo que executa o prompt em todas as versões.'
                  }
                >
                  <ModelSelector
                    multi={isCompare}
                    title={isCompare ? 'Competidores' : 'Modelo sob teste'}
                    hint={isCompare ? 'Selecione 2 ou mais.' : 'Selecione 1.'}
                    value={isCompare ? p.competitors : p.contestantModel}
                    onChange={(ids) => (isCompare ? p.setCompetitors(ids) : p.setContestantModel(ids))}
                    excludeIds={
                      isCompare ? [...p.datagen, ...p.judge, ...p.referenceModel] : [...p.judge, ...p.referenceModel]
                    }
                    models={p.models}
                    loading={p.modelsLoading}
                    tuning={p.tuning}
                    onTuningChange={p.onTuningChange}
                    tuningFields={isCompare ? ['effort', 'temperature'] : ['effort', 'temperature']}
                  />
                </SettingRow>
                <SettingRow
                  wide
                  label="Gerador de cenários"
                  sub="Escreve as perguntas a partir do tema. Um modelo barato e capaz chega."
                >
                  <ModelSelector
                    multi={false}
                    title="Gerador"
                    value={p.datagen}
                    onChange={p.setDatagen}
                    models={p.models}
                    loading={p.modelsLoading}
                    tuning={p.tuning}
                    onTuningChange={p.onTuningChange}
                    tuningFields={['effort']}
                  />
                </SettingRow>
                <SettingRow
                  wide
                  label="Juízes"
                  sub="Comparam cada resposta com o gabarito e dão o veredito. Com dois ou mais, a nota vira consenso."
                >
                  <ModelSelector
                    multi
                    title="Juízes"
                    hint="Selecione 1 ou mais."
                    value={p.judge}
                    onChange={p.setJudge}
                    excludeIds={[
                      ...p.datagen,
                      ...(isCompare ? p.competitors : p.contestantModel),
                      ...p.referenceModel,
                    ]}
                    models={p.models}
                    loading={p.modelsLoading}
                    tuning={p.tuning}
                    onTuningChange={p.onTuningChange}
                    tuningFields={['effort']}
                  />
                </SettingRow>
                {/* Gabarito (IMPL-048): obrigatório em teste/treino e distinto de
                    juízes e do modelo sob teste — por isso mora AQUI, à vista.
                    No compare é opcional (vazio = 1º juiz) e só aparece se já
                    vier escolhido (import/completa), para poder ser corrigido. */}
                {(!isCompare || p.referenceModel.length > 0) && (
                  <SettingRow
                    wide
                    label="Gabarito"
                    sub={
                      isCompare
                        ? 'Escreve a resposta ideal de cada cenário. Opcional aqui (vazio = o primeiro juiz), mas nunca juiz nem competidor.'
                        : 'Escreve a resposta ideal de cada cenário — a régua do juiz. Obrigatório, e diferente dos juízes e do modelo sob teste.'
                    }
                  >
                    <ModelSelector
                      multi={false}
                      title="Gabarito"
                      hint="Selecione 1."
                      value={p.referenceModel}
                      onChange={p.setReferenceModel}
                      excludeIds={[...p.judge, ...(isCompare ? p.competitors : p.contestantModel)]}
                      models={p.models}
                      loading={p.modelsLoading}
                      tuning={p.tuning}
                      onTuningChange={p.onTuningChange}
                      tuningFields={['effort']}
                    />
                  </SettingRow>
                )}
              </SettingGroup>
            </div>
          </SmoothTabsPanel>

          {/* -------------------------------------------------------- limites */}
          <SmoothTabsPanel value="limites">
            <div className="flex flex-col gap-4">
              <h2 className="font-heading text-base font-medium">Quanto medir e até quanto gastar?</h2>
              <SettingGroup>
                <NumRow
                  label="Cenários"
                  sub="Mais cenários dão mais confiança no resultado e mais chamadas. Cinco é um bom começo."
                  value={p.stages}
                  onChange={p.setStages}
                  min={1}
                  max={50}
                />
                <TxtNumRow
                  label="Teto de gasto (US$)"
                  sub="A run para sozinha antes de passar deste valor. Vazio = sem teto."
                  value={p.budget}
                  onChange={p.setBudget}
                  min={0}
                  step={0.5}
                  placeholder="sem teto"
                />
                <SwitchRow
                  label="Duelo final entre os melhores"
                  sub="Depois de julgar todos os cenários, os melhores duelam entre si em todos eles — o duelo confirma o vencedor."
                  checked={p.duelsOn}
                  onChange={p.setDuelsOn}
                />
                {p.duelsOn && (
                  <NumRow
                    label="Finalistas"
                    sub="Quantos vão ao duelo final."
                    value={p.finalists}
                    onChange={p.setFinalists}
                    min={0}
                    max={12}
                  />
                )}
              </SettingGroup>
            </div>
          </SmoothTabsPanel>

          {/* -------------------------------------------------------- revisão */}
          <SmoothTabsPanel value="revisao">
            <div className="flex flex-col gap-4">
              <h2 className="font-heading text-base font-medium">O plano da run</h2>
              <RunPlan p={p} />

              {p.problems.length > 0 ? (
                <div className="rounded-lg border border-border p-3">
                  <p className="text-[13px] font-medium">Antes de iniciar, falta:</p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {p.problems.map((pr) => (
                      <li key={pr.text}>
                        <button
                          type="button"
                          className="text-left text-[13px] text-primary underline-offset-4 hover:underline"
                          onClick={() => (pr.onlyComplete ? p.onOpenClassic() : p.onStepChange(stepOfProblem(pr)))}
                        >
                          {pr.text}
                          {pr.onlyComplete && ' — na configuração completa'}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
                  <Check className="size-4 text-resolve" aria-hidden="true" />
                  Tudo pronto — «Iniciar» está no rodapé.
                </p>
              )}

              <p className="border-t border-border pt-3 text-[13px] leading-relaxed text-muted-foreground">
                Quer mexer em timeouts, técnicas de prompt, modelos de referência, LGPD ou filtros de
                preço?{' '}
                <button
                  type="button"
                  className="text-primary underline-offset-4 hover:underline"
                  onClick={p.onOpenClassic}
                >
                  Abra a configuração completa
                </button>{' '}
                — o que você já preencheu vai junto.
              </p>
            </div>
          </SmoothTabsPanel>
        </SmoothTabsPanels>
      </SmoothTabs>

      {/* Navegação livre entre passos: nada é obrigatório antes do envio — as
          pendências ficam no rodapé e no passo de revisão. */}
      <div className="mt-4 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={stepIdx === 0}
          onClick={() => go(-1)}
        >
          <ArrowLeft aria-hidden="true" />
          Voltar
        </Button>
        {stepIdx < GUIDED_STEPS.length - 1 && (
          <Button type="button" size="sm" onClick={() => go(1)}>
            {GUIDED_STEPS[stepIdx + 1] === 'revisao' ? 'Rever o plano' : 'Avançar'}
            <ArrowRight aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}