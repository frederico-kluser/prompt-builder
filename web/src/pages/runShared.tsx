// Utilitarios de visualizacao de run compartilhados entre RunView (por run) e
// TrainingView (cockpit de treino). A UNICA visualizacao de progresso/resultado
// e o heatmap (cenario x variante); o bloco de finais so aparece no fim.
import { useMemo } from 'react';
import type { RunRecord, StageRecord, Verdict } from '../api';
import { normalizeContestants } from '../api';
import {
  judgeScoreTally,
  stageCountsInJudgeScore,
  type JudgeScoreStageLike,
} from '../../../src/engine/verdictAggregate.js';
import {
  seedFromId,
  sortStandings,
  winnerFromStandings,
  type StandingsWinner,
} from '../../../src/engine/duelCore.js';
import { panelAgreement, type PanelAgreement } from '../engine/refJudge';
import type { VerdictErrorKind } from '../../../src/types.js';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/motion-ui/accordion';
import { ProgressBar } from '@/components/motion-ui/progress-bar';
import { Sparkline } from '@/components/motion-ui/sparkline';
import { Tag } from '../components/primitives';
import { cn } from '@/lib/utils';

// Veredito ternario -> rotulo + classes do token semantico correspondente.
export const VERDICT_META: Record<Verdict, { label: string; cell: string; pill: string }> = {
  resolve: {
    label: 'resolve',
    cell: 'bg-resolve-soft text-resolve',
    pill: 'border-resolve/30 bg-resolve-soft/60 text-resolve',
  },
  parcial: {
    label: 'parcial',
    cell: 'bg-parcial-soft text-parcial',
    pill: 'border-parcial/30 bg-parcial-soft/60 text-parcial',
  },
  nao: {
    label: 'não resolve',
    cell: 'bg-nao-soft text-nao',
    pill: 'border-nao/30 bg-nao-soft/60 text-nao',
  },
};

/** Glifo de cada veredito no heatmap (pendente = ponto). */
const VERDICT_GLYPH: Record<Verdict, string> = {
  resolve: '✓',
  parcial: '◐',
  nao: '✕',
};

/** Veredito de um item, com retrocompat ao binario antigo (acceptable). */
export function verdictOf(v?: { verdict?: Verdict; acceptable?: boolean }): Verdict | undefined {
  if (!v) return undefined;
  if (v.verdict) return v.verdict;
  if (typeof v.acceptable === 'boolean') return v.acceptable ? 'resolve' : 'nao';
  return undefined;
}

export function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Etapas sem buracos (array pode ficar esparso/fora de ordem sob execucao
// paralela) e ordenadas por index. Toda a UI de resultados usa isto — sem o
// filtro, `stages.map(s => s.index)` quebra em buracos (foi o bug do heatmap).
export function denseStages(stages: StageRecord[]): StageRecord[] {
  return stages.filter((s): s is StageRecord => Boolean(s)).slice().sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Empate e tendência (IMPL-109): a informação de posição/score é TEXTO. A cor
// só carrega o veredito (tokens semânticos + glifo), nunca a posição — a rampa
// contínua verde→vermelho colapsava sob deuteranopia e reprovava em contraste.
// ---------------------------------------------------------------------------

/** Sufixo não cromático de empate — idêntico em todas as linhas empatadas. */
export const TIE_MARKER = 'E';

export interface TieMark {
  /** Sufixo do valor (`''` quando a linha não está empatada). */
  marker: string;
  /** Resumo textual: `empatado com X` / `empatado com X e Y`. */
  summary: string;
}

/**
 * Empates por valor (score, win-rate…): linhas com o MESMO valor recebem o
 * mesmo marcador textual, e o resumo nomeia as demais — nada de "mesma cor"
 * como único sinal (e nem cor: o marcador é igual nas duas linhas).
 */
export function tieMarks(
  ids: string[],
  valueOf: (id: string) => number | undefined,
  labelOf: (id: string) => string,
): Map<string, TieMark> {
  const out = new Map<string, TieMark>();
  const porValor = new Map<string, string[]>();
  for (const id of ids) {
    const v = valueOf(id);
    if (v === undefined || !Number.isFinite(v)) continue;
    const chave = String(v);
    const lista = porValor.get(chave) ?? [];
    lista.push(id);
    porValor.set(chave, lista);
  }
  for (const grupo of porValor.values()) {
    if (grupo.length < 2) continue;
    for (const id of grupo) {
      const outros = grupo.filter((o) => o !== id).map(labelOf);
      out.set(id, { marker: TIE_MARKER, summary: `empatado com ${outros.join(' e ')}` });
    }
  }
  return out;
}

/**
 * Texto alternativo da sparkline de evolução: `'Evolução de X: subiu de 40
 * para 72 em 5 rodadas'`. Sem isto o gráfico é um traço mudo para leitor de
 * tela (IMPL-108).
 */
export function sparklineTrend(
  label: string,
  history: number[],
  kind: 'evolution' | 'technique' = 'evolution',
): string {
  // web-code#4: a linha de uma TÉCNICA não é o mesmo prompt evoluindo — a cada
  // rodada ela reescreve a partir do campeão novo. O texto diz isso.
  const sujeito = kind === 'technique' ? `Nota da técnica ${label} por rodada` : `Evolução de ${label}`;
  const n = history.length;
  if (!n) return `${sujeito}: sem rodadas julgadas`;
  const first = Math.round(history[0]);
  const last = Math.round(history[n - 1]);
  const rodadas = `${n} ${n === 1 ? 'rodada' : 'rodadas'}`;
  if (last === first) return `${sujeito}: estável em ${last} ao longo de ${rodadas}`;
  const verbo = last > first ? 'subiu' : 'caiu';
  return `${sujeito}: ${verbo} de ${first} para ${last} em ${rodadas}`;
}

/** Medalha textual do pódio — o número é texto, a medalha também (IMPL-109). */
export const MEDAL_TEXT = ['ouro', 'prata', 'bronze'] as const;

// ---------------------------------------------------------------------------
// Heatmap de vereditos: cenario x variante. E a unica visualizacao durante a
// execucao — nada de numero que sobe e desce, so glifos que se preenchem.
// ---------------------------------------------------------------------------

/** Uma linha do heatmap: uma variante/modelo e como ela foi em cada cenário. */
export interface HeatRow {
  contestantId: string;
  label: string;
  isControl: boolean;
  isFinalist: boolean;
  /** Veredito por índice de cenário (denso, alinhado com `stages`). */
  verdicts: (Verdict | undefined)[];
  /**
   * Contagens que FORMAM o judge-score (web-code#12): numa run julgada por
   * referência, só as etapas que `stageCountsInJudgeScore` aceita — o veredito
   * listwise de etapa sem gabarito continua visível na célula, mas fica fora
   * da conta, como no número oficial.
   */
  resolve: number;
  parcial: number;
  nao: number;
  judged: number;
  /**
   * Judge-score 0–100: o OFICIAL (`record.judgeScoreByContestant`) quando o
   * motor já o gravou; senão (resolve + 0,5·parcial) / judged × 100 pela
   * mesma regra. `null` enquanto nada foi julgado.
   */
  score: number | null;
}

/**
 * Motivo do veredito AUSENTE de um contestant numa etapa (IMPL-004): juiz que
 * falhou, saída inválida, competidor bloqueado… `undefined` = sem registro.
 */
export function verdictErrorInStage(stage: StageRecord, contestantId: string): string | undefined {
  const e =
    stage.referenceJudge?.verdictErrorByContestant?.[contestantId] ??
    stage.judge?.verdictErrorByContestant?.[contestantId];
  return e ? e.message : undefined;
}

// ---------------------------------------------------------------------------
// Painel do juiz por célula (IMPL-057): concordância "2 de 3: resolve" com o
// divergente destacado, e o badge 'avaliador falhou' — que é do JUIZ, nunca
// nota do candidato.
// ---------------------------------------------------------------------------

/** Causas técnicas em que quem falhou foi o AVALIADOR (juiz), não o candidato. */
const AVALIADOR_FALHOU: ReadonlySet<VerdictErrorKind> = new Set<VerdictErrorKind>([
  'judge_failed',
  'invalid_output',
  'truncated',
  'timeout',
]);

/** O que o painel de juízes disse (ou deixou de dizer) sobre UM contestant numa etapa. */
export interface PanelInfo {
  /** Concordância do painel — só com 2+ juízes gravados (`judgeVotesByContestant`). */
  agreement?: PanelAgreement;
  /** Painel sem unanimidade: algum juiz votou diferente do veredito gravado. */
  split: boolean;
  /** Veredito PRESENTE com painel reduzido (algum juiz falhou) — `verdictSource=degraded`. */
  degraded: boolean;
  /** Veredito AUSENTE porque o avaliador falhou (motivo). */
  judgeFailed?: string;
}

/** Lê o painel gravado de uma célula (etapa × contestant). */
export function panelInfo(stage: StageRecord, contestantId: string): PanelInfo {
  const ref = stage.referenceJudge;
  const votos = ref?.judgeVotesByContestant?.[contestantId];
  const veredito = ref?.verdictByContestant?.[contestantId];
  const agreement = votos && votos.length >= 2 ? panelAgreement(votos, veredito) : undefined;
  const fonte =
    ref?.verdictSourceByContestant?.[contestantId] ?? stage.judge?.verdictSourceByContestant?.[contestantId];
  const erro =
    ref?.verdictErrorByContestant?.[contestantId] ?? stage.judge?.verdictErrorByContestant?.[contestantId];
  return {
    ...(agreement ? { agreement } : {}),
    split: Boolean(agreement && agreement.divergentJudgeIds.length > 0),
    degraded: fonte === 'degraded',
    ...(erro && AVALIADOR_FALHOU.has(erro.kind) ? { judgeFailed: erro.message } : {}),
  };
}

/** Frase curta da concordância: "painel 2 de 3 (divergente: x/juiz)". */
export function panelPhrase(info: PanelInfo): string | undefined {
  const a = info.agreement;
  if (!a) return undefined;
  const div = a.divergentJudgeIds.length ? ` (divergente: ${a.divergentJudgeIds.join(', ')})` : '';
  return `painel ${a.agreeCount} de ${a.total}${div}`;
}

/** Veredito de um contestant numa etapa (gabarito > juiz > avaliador antigo). */
function verdictInStage(stage: StageRecord, contestantId: string): Verdict | undefined {
  const ref = stage.referenceJudge?.verdictByContestant?.[contestantId];
  if (ref) return ref;
  const doJuiz = verdictOf({
    verdict: stage.judge?.verdictByContestant?.[contestantId],
    acceptable: stage.judge?.acceptableByContestant?.[contestantId],
  });
  if (doJuiz) return doJuiz;
  // Retrocompat: records antigos guardavam o binario no avaliador separado.
  return verdictOf(stage.evaluation?.verdicts.find((v) => v.contestantId === contestantId));
}

/**
 * Etapa julgada POR REFERÊNCIA cujo `referenceJudge` ainda não chegou à tela.
 * Ao vivo o evento `stage.judged` só traz o `judge` SINTETIZADO (com os MESMOS
 * vereditos); o `referenceJudge` só vem no snapshot/`run.finished`. O motor
 * escolhe o caminho pelo gabarito da spec (`spec.reference` presente ⇒
 * pointwise por referência), então a mesma condição identifica a etapa — sem
 * isto, depois de recarregar a página no meio da run, as etapas julgadas ao
 * vivo sumiam da contagem e a célula dizia "fora do score".
 */
function liveReferenceStage(stage: StageRecord): boolean {
  return (
    !stage.referenceJudge &&
    !stage.incomplete &&
    !stage.error &&
    Boolean(stage.judge) &&
    Boolean(stage.spec?.reference?.trim())
  );
}

/**
 * A etapa FORMA o judge-score? No record gravado, exatamente a regra do motor
 * (`stageCountsInJudgeScore`). Com `live` (run em andamento), também a etapa
 * por referência cujo `referenceJudge` ainda não chegou (ver acima).
 */
export function stageInJudgeScore(stage: StageRecord, live = false): boolean {
  return stageCountsInJudgeScore(stage) || (live && liveReferenceStage(stage));
}

/**
 * A run é julgada POR REFERÊNCIA (alguma etapa tem `referenceJudge` — ou, ao
 * vivo, gabarito na spec)? Aí a nota segue `stageCountsInJudgeScore` — a regra
 * única dos dois motores. Run só listwise (compare clássico, sem gabarito) não
 * tem outra régua: conta tudo.
 */
export function isReferenceRun(stages: ReadonlyArray<StageRecord>, live = false): boolean {
  return stages.some(
    (s) => Boolean(s?.referenceJudge) || (live && Boolean(s?.spec?.reference?.trim())),
  );
}

/** Deriva as linhas do heatmap. Ordem = ordem de `record.contestants` (ESTÁVEL). */
export function heatRows(record: RunRecord): { rows: HeatRow[]; stages: StageRecord[] } {
  const stages = denseStages(record.stages);
  const contestants = normalizeContestants(record);
  const finalistas = new Set(record.finalists ?? []);
  // Controle = ancora da run: o prompt original ou o 'carry' do treino. Sem
  // fallback para o 1o contestant — em compare ninguem e "base".
  const controlId = contestants.find((c) => c.isOriginal || c.id === 'carry')?.id;
  // web-code#12: contagem e nota pela MESMA regra do `judgeScoreByContestant`
  // (src/engine/verdictAggregate.ts) — antes o veredito listwise de etapa cujo
  // gabarito falhou/foi cortado entrava aqui e a ordem divergia da oficial.
  const live = record.status === 'running';
  const porReferencia = isReferenceRun(stages, live);
  // Ao vivo, a etapa por referência ainda sem `referenceJudge` entra pelos
  // vereditos do `judge` sintetizado (idênticos); no record gravado, só a
  // regra do motor.
  const etapasDaNota: JudgeScoreStageLike[] = live
    ? stages.map((s) =>
        liveReferenceStage(s) ? { referenceJudge: { verdictByContestant: s.judge?.verdictByContestant ?? {} } } : s,
      )
    : stages;
  const oficial = record.judgeScoreByContestant ?? {};
  const rows = contestants.map((c) => {
    const verdicts = stages.map((s) => verdictInStage(s, c.id));
    let resolve = 0;
    let parcial = 0;
    let nao = 0;
    if (porReferencia) {
      ({ resolve, parcial, nao } = judgeScoreTally(etapasDaNota, c.id));
    } else {
      for (const v of verdicts) {
        if (v === 'resolve') resolve++;
        else if (v === 'parcial') parcial++;
        else if (v === 'nao') nao++;
      }
    }
    const judged = resolve + parcial + nao;
    const nota = typeof oficial[c.id] === 'number' && Number.isFinite(oficial[c.id]) ? oficial[c.id] : undefined;
    return {
      contestantId: c.id,
      label: c.label,
      isControl: c.id === controlId,
      isFinalist: finalistas.has(c.id),
      verdicts,
      resolve,
      parcial,
      nao,
      judged,
      // Sem veredito legítimo não há nota: o motor grava 0 (`judgeScoreFromVerdicts`
      // com n = 0), mas "sem evidência" não é zero — a tela mostra '—'.
      score: judged ? (nota ?? ((resolve + 0.5 * parcial) / judged) * 100) : null,
    };
  });
  return { rows, stages };
}

// ---------------------------------------------------------------------------
// Vencedor da run (web-code#10 / web-live#4): a MESMA régua de `runs winner`
// e do MCP (`winnerFromStandings`, src/engine/duelCore.ts) — finais primeiro
// (taxa de vitória → vitórias → judge-score → rank cego), senão judge-score.
// O empate NUNCA some: `unresolved` = não há vencedor claro.
// ---------------------------------------------------------------------------

export interface RunWinnerView extends StandingsWinner {
  /** Rodada de TREINO: quem promove é o gate da sessão (judge-score), não a final. */
  training: boolean;
}

export function runWinner(record: RunRecord): RunWinnerView {
  const training = Boolean(record.sessionId);
  let js = record.judgeScoreByContestant;
  if (!js || Object.keys(js).length === 0) {
    // Run só listwise (sem gabarito): o placar de vereditos é a única régua.
    const pelasLinhas: Record<string, number> = {};
    for (const r of heatRows(record).rows) if (r.score !== null) pelasLinhas[r.contestantId] = r.score;
    js = pelasLinhas;
  }
  const w = winnerFromStandings({
    id: record.id,
    // No treino a escolha da rodada é por judge-score (rank.ts) e a promoção é
    // do gate — a final da rodada é só desempate/diagnóstico.
    standings: training ? undefined : record.standings,
    judgeScoreByContestant: js,
  });
  return { ...w, training };
}

/** Estado de UMA célula do heatmap: glifo decorativo + rótulo textual. */
export interface HeatCellState {
  /** Glifo visível. Decoração: vai sempre `aria-hidden` (IMPL-108). */
  glyph: string;
  /** Classes do token semântico da célula (veredito) ou do neutro. */
  cls: string;
  /** Rótulo TEXTUAL do estado — é o que a célula anuncia (IMPL-108). */
  label: string;
}

/**
 * Fan-out ao vivo (F3/§7.2): a célula mostra a FASE do par (variante × cenário)
 * — pendente → resposta recebida → julgada, com erro à parte. É o que faz a run
 * longa não parecer travada. O rótulo é TEXTO: o glifo nunca é o nome acessível.
 */
export function heatmapCellState(
  stage: StageRecord,
  row: HeatRow,
  cenario: number,
  /** `referenceRun`: a run é julgada por referência; `live`: a run ainda roda. */
  opts: { referenceRun?: boolean; live?: boolean } = {},
): HeatCellState {
  const v = row.verdicts[cenario];
  const resp = (stage.responses ?? []).find((r) => r.contestantId === row.contestantId);
  // IMPL-004: juiz que falhou NÃO vira nota — a célula diz "sem veredito" e o
  // motivo, e o score da linha ignora a etapa.
  const semVeredito = v ? undefined : verdictErrorInStage(stage, row.contestantId);
  // IMPL-057: concordância do painel e 'avaliador falhou' (≠ veredito).
  const painel = panelInfo(stage, row.contestantId);
  // Bloqueio (moderação/guardrail) vem ANTES do veredito: o cenário é
  // inconclusivo para o prompt, nunca um 'não' (IMPL-010).
  if (resp?.status === 'blocked') {
    return {
      glyph: '⊘',
      cls: 'bg-muted text-muted-foreground',
      label: 'bloqueado pela moderação — sem veredito para o prompt',
    };
  }
  if (resp?.truncated) {
    // IMPL-014: cortada no teto mesmo após o retry x2 — a etapa inteira sai do placar.
    return {
      glyph: '✂',
      cls: 'bg-muted text-muted-foreground',
      label: 'resposta truncada no teto de tokens — etapa fora do placar',
    };
  }
  if (stage.incompleteReason === 'truncation' && !v) {
    return {
      glyph: '–',
      cls: 'bg-muted/50 text-muted-foreground',
      label: 'etapa fora do placar (outra resposta foi truncada)',
    };
  }
  if (v) {
    const extras = [
      panelPhrase(painel),
      painel.degraded ? 'avaliador falhou (painel reduzido — não é nota do candidato)' : undefined,
      // web-code#12: veredito listwise de etapa sem gabarito fica FORA do score.
      opts.referenceRun && !stageInJudgeScore(stage, opts.live) ? 'julgado sem gabarito, fora do score' : undefined,
    ].filter(Boolean);
    return {
      // '*' = painel não unânime ou avaliador falhou (legenda no caption).
      glyph: VERDICT_GLYPH[v] + (painel.split || painel.degraded ? '*' : ''),
      cls: VERDICT_META[v].cell,
      label: [VERDICT_META[v].label, ...extras].join(' — '),
    };
  }
  if (stage.incomplete) {
    // Cortado por orçamento/cancelamento (IMPL-020): sem nota e fora do score —
    // nunca um ✕ que o competidor não mereceu. ⏹ (não ⊘): ⊘ é o bloqueio da
    // moderação (IMPL-010).
    return {
      glyph: '⏹',
      cls: 'bg-muted/50 text-muted-foreground',
      label:
        stage.incompleteReason === 'budget'
          ? 'cortado pelo orçamento — fora do placar'
          : 'interrompido — fora do placar',
    };
  }
  if (semVeredito && resp?.status !== 'error') {
    return {
      glyph: '?',
      cls: 'bg-muted text-muted-foreground',
      label: painel.judgeFailed
        ? `sem veredito — avaliador falhou: ${painel.judgeFailed}`
        : `sem veredito — ${semVeredito}`,
    };
  }
  if (resp?.status === 'error') {
    // bg-nao/15 (não /20): medido em WCAG — /20 reprovava em dark (4,43:1).
    return { glyph: '!', cls: 'bg-nao/15 text-nao', label: 'resposta com erro' };
  }
  if (resp) {
    return {
      glyph: '⏳',
      cls: 'bg-muted text-muted-foreground',
      label: 'resposta recebida — aguardando julgamento',
    };
  }
  return { glyph: '·', cls: 'bg-muted/50 text-muted-foreground', label: 'pendente' };
}

interface ScoreHeatmapProps {
  record: RunRecord;
  /** Ordena por score desc (só use quando a run terminou). Default false. */
  ranked?: boolean;
  /**
   * Clique no CABEÇALHO de uma coluna abre o cenário correspondente (recebe o
   * index da etapa). Só o cabeçalho é interativo — as células nunca são
   * (IMPL-108: M+N·M paradas de Tab viram M+1).
   */
  onStageClick?: (index: number) => void;
}

/**
 * A ÚNICA visualização de progresso/resultado: linhas = variantes (ordem
 * estável), colunas = cenários, célula = ✓ (resolve) / ◐ (parcial) / ✕ (não) /
 * · (pendente). Coluna final = score 0–100 + contagem `n✓ n◐ n✕`.
 *
 * É uma `<table>` NATIVA (IMPL-108): `<caption>` com a legenda, `<th
 * scope="col">` por cenário (o clique mora aqui), `<th scope="row">` por
 * variante e `<td>` não focáveis com veredito em TEXTO — o glifo é `aria-hidden`.
 */
export function ScoreHeatmap({ record, ranked = false, onStageClick }: ScoreHeatmapProps) {
  const { rows, stages } = useMemo(() => heatRows(record), [record]);
  const live = record.status === 'running';
  const referenceRun = useMemo(() => isReferenceRun(stages, live), [stages, live]);
  // Ordenacao so quando pedida (fim da run): sort e estavel, entao empate
  // preserva a ordem de `contestants` — por isso o empate vira TEXTO (marcador
  // + resumo) na coluna de score: a ordem sozinha não diz quem empatou.
  const linhas = useMemo(
    () => (ranked ? [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1)) : rows),
    [rows, ranked],
  );
  const empates = useMemo(
    () =>
      ranked
        ? tieMarks(
            rows.map((r) => r.contestantId),
            (id) => rows.find((r) => r.contestantId === id)?.score ?? undefined,
            (id) => rows.find((r) => r.contestantId === id)?.label ?? id,
          )
        : new Map<string, TieMark>(),
    [rows, ranked],
  );

  if (!linhas.length || !stages.length) {
    return (
      <div className="rounded-xl bg-card px-4 py-10 text-center text-sm text-muted-foreground ring-1 ring-foreground/10">
        <p>Aguardando os primeiros resultados…</p>
        <p className="mt-1.5 text-[12px]">
          Cada linha é uma variante e cada coluna, um cenário. A célula mostra o veredito do juiz
          (resolve, parcial ou não resolve) assim que ele terminar.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="scroll-slim relative overflow-x-auto p-3">
        <table className="w-full min-w-fit border-separate border-spacing-x-1 border-spacing-y-0.5">
          <caption className="caption-top border-b border-border px-1 pb-2 text-left text-[12px] text-muted-foreground">
            Heatmap de vereditos — linhas: variantes; colunas: cenários.{' '}
            <span aria-hidden="true">✓</span> resolve · <span aria-hidden="true">◐</span> parcial ·{' '}
            <span aria-hidden="true">✕</span> não resolve · <span aria-hidden="true">?</span> sem
            veredito · <span aria-hidden="true">⏳</span> aguardando julgamento ·{' '}
            <span aria-hidden="true">⊘</span> bloqueado · <span aria-hidden="true">✂</span>{' '}
            truncada · <span aria-hidden="true">⏹</span> cortado ·{' '}
            <span aria-hidden="true">!</span> erro · <span aria-hidden="true">·</span> pendente ·{' '}
            <span aria-hidden="true">*</span> painel de juízes não unânime ou avaliador falhou (detalhe
            no cenário)
            {ranked && (
              <>
                {' '}
                · <span aria-hidden="true">{TIE_MARKER}</span> empatado na nota
              </>
            )}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="min-w-[8rem] px-1 pb-1 text-left text-[11px] font-normal text-muted-foreground">
                variante
              </th>
              {stages.map((s, i) => {
                // IMPL-014: gabarito truncado mesmo após o retry x2 foi descartado —
                // o cenário é julgado SEM régua (listwise). Marca visível no cabeçalho.
                const semRegua = s.gabaritoCall?.truncated === true;
                const titulo = `Cenário ${i + 1}${semRegua ? ' — gabarito truncado no teto e descartado: julgado sem gabarito' : ''}`;
                return (
                  <th key={s.index} scope="col" className="px-0.5 pb-1 align-bottom font-normal">
                    {onStageClick ? (
                      <button
                        type="button"
                        title={`${titulo} — clique para abrir`}
                        aria-label={`${titulo}. Abrir o cenário`}
                        onClick={() => onStageClick(s.index)}
                        className={cn(
                          'grid h-6 w-7 place-items-center rounded-[5px] text-[11px] font-normal text-muted-foreground tabular cursor-pointer hover:bg-muted focus-visible:bg-muted focus-visible:outline-none',
                          semRegua && 'underline decoration-dotted underline-offset-2',
                        )}
                      >
                        {semRegua ? (
                          <>
                            {i + 1}
                            <span aria-hidden="true">✂</span>
                          </>
                        ) : (
                          i + 1
                        )}
                      </button>
                    ) : (
                      <span
                        title={titulo}
                        className={cn(
                          'grid h-6 w-7 place-items-center text-[11px] text-muted-foreground tabular',
                          semRegua && 'underline decoration-dotted underline-offset-2',
                        )}
                      >
                        {semRegua ? (
                          <>
                            {i + 1}
                            <span aria-hidden="true">✂</span>
                          </>
                        ) : (
                          i + 1
                        )}
                      </span>
                    )}
                  </th>
                );
              })}
              <th
                scope="col"
                className="w-20 px-1 pb-1 text-right text-[11px] font-normal text-muted-foreground"
                title={
                  referenceRun
                    ? 'judge-score: (resolve + ½·parcial) ÷ julgados × 100, só nos cenários julgados com gabarito'
                    : '(resolve + ½·parcial) ÷ julgados × 100'
                }
              >
                score
              </th>
            </tr>
          </thead>
          <tbody>
            {linhas.map((row) => (
              <tr key={row.contestantId}>
                <th scope="row" className="min-w-0 py-0.5 pr-3 text-left font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px]" title={row.label}>
                      {row.label}
                    </span>
                    {row.isControl && <Tag>base</Tag>}
                    {row.isFinalist && <Tag className="border-primary/30 bg-primary/10 text-primary">final</Tag>}
                  </span>
                </th>
                {stages.map((s, i) => {
                  const estado = heatmapCellState(s, row, i, { referenceRun, live });
                  return (
                    <td
                      key={s.index}
                      title={`Cenário ${i + 1}: ${estado.label}`}
                      className={cn(
                        'h-7 rounded-[5px] px-0.5 text-center text-[13px] leading-none select-none',
                        estado.cls,
                      )}
                    >
                      <span aria-hidden="true">{estado.glyph}</span>
                      <span className="sr-only">{estado.label}</span>
                    </td>
                  );
                })}
                <td className="px-1 py-0.5 text-right leading-tight">
                  <span
                    className="text-[13px] font-medium tabular"
                    title={empates.get(row.contestantId)?.summary}
                  >
                    {row.score === null ? '—' : row.score.toFixed(0)}
                    {empates.get(row.contestantId)?.marker}
                    {empates.has(row.contestantId) && (
                      <span className="sr-only"> — {empates.get(row.contestantId)!.summary}</span>
                    )}
                  </span>
                  <span className="block text-[10px] text-muted-foreground tabular">
                    <span aria-hidden="true">
                      {row.resolve}✓ {row.parcial}◐ {row.nao}✕
                    </span>
                    <span className="sr-only">
                      {row.resolve} resolve, {row.parcial} parcial, {row.nao} não resolve
                    </span>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Chave ESTÁVEL da linha no placar de evolução (web-code#4). Os ids de
 * contestant são POSICIONAIS por rodada (`v0`, `v1`… = i-ésima técnica que
 * sobreviveu ao filtro, com a lista de técnicas rodando entre rodadas) — ligar
 * as rodadas por `c.id` juntava prompts sem relação numa linha e a sparkline
 * inventava uma evolução. A técnica é estável; `original`, `carry` (o campeão
 * re-testado) e as manuais `m<i>` (verbatim a cada rodada) mantêm o id.
 */
export function evolutionRowKey(c: { id: string; techniqueId?: string }): string {
  return c.techniqueId ? `t:${c.techniqueId}` : c.id;
}

/** Heatmap de evolucao: técnica/controle x rodada; celula = judge-score arredondado. */
export function EvolutionHeatmap({
  rounds,
  holdoutAt,
}: {
  rounds: RunRecord[];
  holdoutAt?: number;
}) {
  const cols = useMemo(
    () =>
      rounds.map((r) => {
        const js = r.judgeScoreByContestant ?? {};
        // Nota da rodada re-chaveada pela linha estável.
        const scores: Record<string, number> = {};
        for (const c of r.contestants ?? []) {
          const s = js[c.id];
          if (s !== undefined) scores[evolutionRowKey(c)] = s;
        }
        return {
          iteration: r.iteration ?? 0,
          isHoldout: r.iteration === holdoutAt,
          scores,
        };
      }),
    [rounds, holdoutAt],
  );
  // Ordem estavel: primeira aparicao da linha ao longo das rodadas.
  const vars = useMemo(() => {
    const seen = new Set<string>();
    const out: { id: string; label: string; isOriginal?: boolean; technique: boolean }[] = [];
    for (const r of rounds) {
      for (const c of r.contestants ?? []) {
        const key = evolutionRowKey(c);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          id: key,
          // 'carry' muda de prompt a cada promoção e de rótulo a cada rodada
          // ("Melhor it.N"): a linha é o PAPEL — o campeão re-testado.
          label: c.id === 'carry' ? 'Campeão anterior (re-testado)' : c.label,
          isOriginal: c.isOriginal,
          technique: Boolean(c.techniqueId),
        });
      }
    }
    return out;
  }, [rounds]);

  // IMPL-109: empate por rodada é TEXTO — marcador 'E' idêntico em todas as
  // linhas empatadas + resumo que nomeia as demais. Sem cor por posição.
  const ties = useMemo(() => {
    const out = new Map<string, TieMark>();
    for (const col of cols) {
      const ids = vars.map((v) => v.id).filter((id) => col.scores[id] !== undefined);
      const marks = tieMarks(
        ids,
        (id) => col.scores[id],
        (id) => vars.find((v) => v.id === id)?.label ?? id,
      );
      for (const [id, m] of marks) out.set(`${col.iteration}:${id}`, m);
    }
    return out;
  }, [cols, vars]);

  if (!cols.length || !vars.length) return null;

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="scroll-slim relative overflow-x-auto p-3">
        {/* Tabela NATIVA (IMPL-108): caption, th scope="col"/"row" e td com o
            valor em texto — a associação cabeçalho/célula existe na árvore de
            acessibilidade e o Tab só passa pelos cabeçalhos. */}
        <table className="w-full min-w-fit border-separate border-spacing-x-1 border-spacing-y-0.5">
          <caption className="caption-top px-1 pb-2 text-left text-[12px] text-muted-foreground">
            Evolução do treino — linhas: técnica ou controle; colunas: rodadas; célula: judge-score.
            Cada técnica reescreve a partir do campeão da rodada, então a linha é a técnica — não o
            mesmo prompt evoluindo; “Campeão anterior” é o campeão re-testado em cada rodada.{' '}
            <span aria-hidden="true">–</span> não participou ·{' '}
            <span aria-hidden="true">E</span> empatado com a mesma nota.
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="min-w-[8rem] px-1 pb-1 text-left text-[11px] font-normal text-muted-foreground"
              >
                técnica / controle
              </th>
              {cols.map((col) => (
                <th
                  key={col.iteration}
                  scope="col"
                  className="px-1 pb-1 text-[11px] font-normal text-muted-foreground tabular"
                  title={col.isHoldout ? 'Holdout (fora do treino)' : `Rodada ${col.iteration + 1}`}
                >
                  {col.isHoldout ? 'H' : `R${col.iteration + 1}`}
                </th>
              ))}
              <th
                scope="col"
                className="w-20 px-1 pb-1 text-right text-[11px] font-normal text-muted-foreground"
              >
                curva
              </th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => {
              // A trilha da variante ao longo das rodadas alimenta a sparkline.
              const history = cols.map((c) => c.scores[v.id]).filter((s): s is number => s !== undefined);
              return (
                <tr key={v.id}>
                  <th scope="row" className="min-w-0 py-0.5 pr-3 text-left font-normal">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[13px]" title={v.label}>
                        {v.label}
                      </span>
                      {v.isOriginal && <Tag>base</Tag>}
                    </span>
                  </th>
                  {cols.map((col) => {
                    const rodada = col.isHoldout ? 'Holdout' : `Rodada ${col.iteration + 1}`;
                    const score = col.scores[v.id];
                    if (score === undefined) {
                      // IMPL-109: "não participou" tem TEXTO — não um '·' mudo.
                      return (
                        <td
                          key={col.iteration}
                          title={`${rodada}: não participou`}
                          className="h-7 rounded-[5px] bg-muted/50 px-1 text-center text-[13px] text-muted-foreground tabular"
                        >
                          <span aria-hidden="true">–</span>
                          <span className="sr-only">não participou</span>
                        </td>
                      );
                    }
                    const tie = ties.get(`${col.iteration}:${v.id}`);
                    // Score em texto NEUTRO (IMPL-109): a cor não carrega
                    // posição — empate é o marcador textual idêntico.
                    return (
                      <td
                        key={col.iteration}
                        title={`${rodada}: judge-score ${score.toFixed(1)}${tie ? ` — ${tie.summary}` : ''}`}
                        className="h-7 rounded-[5px] bg-muted/50 px-1 text-center text-[13px] font-medium text-foreground tabular"
                      >
                        {Math.round(score)}
                        {tie?.marker}
                        {tie && <span className="sr-only"> — {tie.summary}</span>}
                      </td>
                    );
                  })}
                  <td className="px-1 py-0.5 text-right">
                    {history.length > 1 ? (
                      <span className="flex justify-end">
                        <Sparkline
                          history={history}
                          width={64}
                          height={22}
                          tone="primary"
                          label={sparklineTrend(v.label, history, v.technique ? 'technique' : 'evolution')}
                        />
                      </span>
                    ) : (
                      <span
                        className="text-[12px] text-muted-foreground"
                        title="Curva disponível a partir da 2ª rodada julgada"
                      >
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finais: os N melhores por judge-score duelam entre si em todos os cenarios.
// Podio (taxa de vitoria nos duelos) + confrontos agregados por par.
// ---------------------------------------------------------------------------

/** Linha do pódio: stats de duelo quando ja houve duelo, senao o judge-score. */
interface FinalsRow {
  id: string;
  label: string;
  /** Taxa de vitória nos duelos (0..1) — IMPL-007: o placar é win-rate. */
  winRate?: number;
  wins?: number;
  ties?: number;
  losses?: number;
  score?: number;
}

/** Taxa de vitória em % — rótulo honesto do placar dos duelos (IMPL-007, R-11a:DEC-4). */
function formatWinRate(winRate: number): string {
  return `${Math.round(winRate * 100)}%`;
}

/** Confronto agregado de um par de finalistas em TODOS os cenários. */
interface PairSummary {
  key: string;
  labelA: string;
  labelB: string;
  winsA: number;
  winsB: number;
  total: number;
}

interface FinalsPanelProps {
  record: RunRecord;
  /** Progresso agregado dos duelos (evento `duel.progress`). */
  progress?: { done: number; total: number } | null;
}

/**
 * Bloco "Final": os N finalistas (top judge-score) e o resultado dos duelos
 * entre eles — pódio com taxa de vitória e V–E–D, e um accordion enxuto com os
 * confrontos.
 */
export function FinalsPanel({ record, progress }: FinalsPanelProps) {
  const stagesComDuelos = useMemo(
    () => denseStages(record.stages).filter((s) => s.duels),
    [record],
  );
  const finalistIds = useMemo(() => record.finalists ?? [], [record]);

  const rows = useMemo<FinalsRow[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const finalistas = new Set(finalistIds);
    // Mesma ordem da régua única (`winnerFromStandings`): records gravados
    // antes do desempate guardavam a ordem de cadastro no empate (controle 1º)
    // — sem re-ordenar, o pódio contradizia o vencedor do resumo.
    const standings = sortStandings(
      (record.standings ?? []).filter((s) => !finalistas.size || finalistas.has(s.id)),
      record.judgeScoreByContestant,
      seedFromId(record.id),
    );
    if (standings.length) {
      return standings.map((s) => ({
        id: s.id,
        label: s.label,
        winRate: s.winRate,
        wins: s.wins,
        ties: s.ties,
        losses: s.losses,
      }));
    }
    // Ainda sem duelos (rodando): pódio provisório por judge-score.
    return finalistIds.map((id) => ({
      id,
      label: labelOf(id),
      score: record.judgeScoreByContestant?.[id] ?? 0,
    }));
  }, [record, finalistIds]);

  // IMPL-109: empate é TEXTO (sufixo idêntico nas linhas empatadas + resumo que
  // nomeia as demais) — nunca uma cor parecida ou um lugar inventado.
  const ties = useMemo(
    () =>
      tieMarks(
        rows.map((r) => r.id),
        (id) => {
          const r = rows.find((x) => x.id === id);
          return r?.winRate ?? r?.score;
        },
        (id) => rows.find((x) => x.id === id)?.label ?? id,
      ),
    [rows],
  );

  const pares = useMemo<PairSummary[]>(() => {
    const labelOf = (id: string) => record.contestants?.find((c) => c.id === id)?.label ?? id;
    const acc = new Map<string, PairSummary>();
    for (const s of stagesComDuelos) {
      for (const d of s.duels!.duels) {
        // Chave por par NAO-ordenado: agrega os dois sentidos num confronto so.
        const [a, b] = d.a < d.b ? [d.a, d.b] : [d.b, d.a];
        const key = `${a}|${b}`;
        let p = acc.get(key);
        if (!p) {
          p = { key, labelA: labelOf(a), labelB: labelOf(b), winsA: 0, winsB: 0, total: 0 };
          acc.set(key, p);
        }
        p.total++;
        const vencedor = d.outcome === 'a' ? d.a : d.outcome === 'b' ? d.b : undefined;
        if (vencedor === a) p.winsA++;
        else if (vencedor === b) p.winsB++;
      }
    }
    return [...acc.values()];
  }, [record, stagesComDuelos]);

  if (!finalistIds.length && !stagesComDuelos.length) return null;

  const running = progress && progress.done < progress.total;

  return (
    <div className="rounded-xl bg-card ring-1 ring-foreground/10">
      {running && (
        <div className="border-b border-border px-4 py-3">
          <ProgressBar
            value={progress.done / Math.max(1, progress.total)}
            size="sm"
            progressbar
            label="Duelos"
            valueLabel={`${progress.done}/${progress.total}`}
            aria-label="Progresso dos duelos"
          />
        </div>
      )}

      {rows.some((r) => typeof r.winRate === 'number') && (
        <div className="flex items-center gap-3 px-4 pt-3 text-[11px] text-muted-foreground">
          <span className="flex-1">Finalista</span>
          <span className="shrink-0">taxa de vitória</span>
          <span className="w-16 shrink-0 text-right">V–E–D</span>
        </div>
      )}
      <ol className="p-2">
        {rows.map((r, i) => {
          const tie = ties.get(r.id);
          const temWinRate = typeof r.winRate === 'number';
          const valor = temWinRate ? formatWinRate(r.winRate!) : (r.score ?? 0).toFixed(0);
          const valorTitle = tie
            ? `${temWinRate ? 'Taxa de vitória' : 'judge-score'} — ${tie.summary}`
            : temWinRate
              ? 'Taxa de vitória: (vitórias + ½ empate) / duelos disputados'
              : 'judge-score';
          return (
            <li key={r.id} className="flex items-center gap-3 rounded-lg px-2 py-2">
              {/* Pódio: número em TEXTO sobre fundo neutro + medalha textual
                  (IMPL-109) — nada de cor por posição, nada de texto branco
                  sobre rampa hue (reprovava AA em 2,36–3,16:1). */}
              <span
                className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground tabular"
                title={`${i + 1}º lugar${tie ? ` — ${tie.summary}` : ''}`}
              >
                {i + 1}
              </span>
              {i < MEDAL_TEXT.length && (
                <span className="shrink-0 text-[11px] text-muted-foreground">{MEDAL_TEXT[i]}</span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm" title={r.label}>
                {r.label}
              </span>
              <span className="shrink-0 text-[13px] font-medium tabular" title={valorTitle}>
                {valor}
                {tie?.marker}
                {tie && <span className="sr-only"> — {tie.summary}</span>}
              </span>
              {temWinRate && (
                <span className="w-16 shrink-0 text-right text-[12px] text-muted-foreground tabular">
                  {r.wins}–{r.ties}–{r.losses}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {pares.length > 0 && (
        <Accordion className="border-t border-border">
          <AccordionItem value="confrontos">
            <AccordionTrigger className="px-4 py-3 text-[13px]" headingLevel={3}>
              Confrontos
            </AccordionTrigger>
            <AccordionPanel className="px-4 pb-4 text-[13px] text-muted-foreground">
              <ul className="space-y-1">
                {pares.map((p) => (
                  <li key={p.key}>
                    {p.labelA} × {p.labelB} —{' '}
                    {p.winsA === p.winsB
                      ? `empate (${p.winsA}–${p.winsB} de ${p.total})`
                      : `venceu ${p.winsA > p.winsB ? p.labelA : p.labelB} (${Math.max(p.winsA, p.winsB)} de ${p.total})`}
                  </li>
                ))}
              </ul>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reducer client-side: dobra os eventos granulares (chegam FORA de ordem sob
// execucao paralela) sobre o RunRecord vivo. Usado por RunView e pela cockpit.
// ---------------------------------------------------------------------------

export function applyEvent(prev: RunRecord, event: any): RunRecord {
  const next: RunRecord = {
    ...prev,
    stages: prev.stages.map((s) => ({ ...s, responses: [...s.responses] })),
  };
  switch (event.type) {
    case 'run.started':
      // Cópia rasa: o motor da SPA MUTA o record vivo no lugar. Devolver a
      // mesma referência que já está no estado faz o React ignorar a
      // atualização (Object.is) — a run cancelada ainda na geração, sem
      // nenhum evento entre o snapshot e o fim, ficava "em andamento" na tela.
      return { ...event.record };
    case 'variants.generated':
      return { ...next, contestants: event.contestants };
    case 'stage.generating': {
      // Coloca POR INDICE (nao push): sob execucao paralela os eventos chegam
      // fora de ordem; o push desalinhava o array (era o bug do heatmap/resumo).
      if (!next.stages[event.stageIndex]) {
        next.stages[event.stageIndex] = {
          index: event.stageIndex,
          responses: [],
          startedAt: new Date().toISOString(),
        };
      }
      return next;
    }
    case 'stage.generated': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.spec = event.spec;
        // IMPL-014: sinais do gabarito (inclusive "truncado e descartado").
        if (event.gabaritoCall) s.gabaritoCall = event.gabaritoCall;
      }
      return next;
    }
    case 'stage.incomplete': {
      // IMPL-014: etapa fora do placar e das médias (hoje: truncamento). Por
      // índice, como os demais — os eventos chegam fora de ordem.
      const s = next.stages[event.stageIndex];
      if (s) {
        s.incomplete = true;
        s.incompleteReason = event.reason;
        s.finishedAt = new Date().toISOString();
      }
      return next;
    }
    case 'stage.failed': {
      let s = next.stages[event.stageIndex];
      if (!s) {
        s = { index: event.stageIndex, responses: [], startedAt: new Date().toISOString() };
        next.stages[event.stageIndex] = s;
      }
      s.error = event.error;
      s.finishedAt = new Date().toISOString();
      return next;
    }
    case 'competitor.finished': {
      const s = next.stages[event.stageIndex];
      if (s) {
        const idx = s.responses.findIndex((r) => r.contestantId === event.response.contestantId);
        if (idx >= 0) s.responses[idx] = event.response;
        else s.responses.push(event.response);
        next.totalCostUsd = (next.totalCostUsd ?? 0) + event.response.costUsd;
      }
      return next;
    }
    case 'finals.started': {
      // Finalistas escolhidos (top-N por judge-score) — o heatmap marca "final".
      // Guarda TAMBEM os scores que vem no evento: `judgeScoreByContestant` so
      // chega no `run.finished`, entao sem isto o podio provisorio ficaria "0"
      // durante toda a fase de duelos (a mais longa da run).
      const finalists = event.finalists as { id: string; label: string; score: number }[];
      const scores = { ...(next.judgeScoreByContestant ?? {}) };
      for (const f of finalists) scores[f.id] = f.score;
      return { ...next, finalists: finalists.map((f) => f.id), judgeScoreByContestant: scores };
    }
    case 'stage.dueled': {
      // Duelos da etapa — rodam DEPOIS de todas as etapas, na fase
      // de finais. Por indice, como os demais handlers: sob execucao paralela
      // os eventos chegam fora de ordem e push desalinharia o array.
      const s = next.stages[event.stageIndex];
      if (s) s.duels = event.duels;
      return next;
    }
    case 'stage.gabarito':
    case 'duel.progress':
      // Progresso AGREGADO: `stage.gabarito` vem com stageIndex -1 (NUNCA
      // indexar `stages` com ele) e `duel.progress` nem stageIndex tem. O
      // record nao muda — as paginas guardam esse progresso em estado proprio.
      // Retorna `prev` (sem copia) p/ evitar re-render inutil.
      return prev;
    case 'stage.judged': {
      const s = next.stages[event.stageIndex];
      if (s) {
        s.judge = event.judge;
        s.finishedAt = new Date().toISOString();
      }
      next.scoreboard = event.scoreboard;
      next.totalCostUsd = event.totalCostUsd;
      return next;
    }
    case 'run.spend':
      // Gasto acumulado do LEDGER (todos os papéis) — é o número que o teto
      // de orçamento compara; mais fiel que somar competidores.
      return { ...next, totalCostUsd: event.spentUsd };
    case 'run.budget':
      // Decisão de uma porta de orçamento: o record final (run.finished) traz
      // stoppedReason/stoppedAtPhase. Nada a dobrar aqui.
      return prev;
    case 'run.finished':
      return { ...event.record }; // nova referência (ver 'run.started')
    case 'run.error':
      return { ...next, status: 'error', error: event.error };
    default:
      return next;
  }
}
