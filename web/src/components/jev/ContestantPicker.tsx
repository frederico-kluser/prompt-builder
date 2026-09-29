import { useState } from 'react';
import { ChevronRight, Copy, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ModelSelector, type ModelTuning } from '../ModelSelector';
import { Banner, SettingGroup, SettingRow, Tag } from '../primitives';
import { SpecEditor } from './SpecEditor';
import { cn } from '@/lib/utils';
import { DEFAULT_DECISION_MODEL, isAliasModel, type JevMode } from '../../engine/jev';
import type { OpenRouterModel as SrcModel } from '../../../../src/types.js';
import type { OpenRouterModel as WebModel, ReasoningLevel } from '../../api';
import type { JevDraft, LlmInput, QuestionInput } from '../../jev/form';

/**
 * Participantes da run JEV: modelos de DECISÃO (catálogo
 * `/models?output_modalities=decisions`, público) — o Jev fixado é o
 * controle; os outros entram como desafiantes —, variantes da definição e,
 * opcionalmente, LLMs nos MESMOS casos (saída estruturada, mesma rubrica).
 *
 * Área LGPD sensível: o modelo aparece DESABILITADO com o motivo (D-15), em
 * vez de sumir — o Jev não é ZDR, então na v1 o modo fica indisponível ali.
 */

export interface ContestantPickerProps {
  draft: JevDraft;
  onChange: (patch: Partial<JevDraft>) => void;
  decisionCatalog: SrcModel[];
  decisionLoading: boolean;
  decisionError: string | null;
  chatModels: WebModel[];
  chatLoading: boolean;
  /** modelo → motivo da recusa LGPD (área sensível). */
  blocked: Record<string, string>;
}

function usdPorM(p: number | null | undefined): string {
  if (typeof p !== 'number') return '—';
  if (p < 0) return 'preço variável';
  const v = p * 1e6;
  return `US$ ${v < 0.01 ? v.toFixed(4) : v.toFixed(2)}/M entrada`;
}

function DecisionRow({
  m,
  checked,
  single,
  onToggle,
  motivo,
}: {
  m: { id: string; name?: string; contextLength?: number; pricing?: { prompt?: number | null } };
  checked: boolean;
  single: boolean;
  onToggle: () => void;
  motivo?: string;
}) {
  const recomendado = m.id === DEFAULT_DECISION_MODEL;
  const alias = isAliasModel(m.id);
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-3 border-b border-border px-4 py-3 last:border-b-0',
        motivo && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        type={single ? 'radio' : 'checkbox'}
        name={single ? 'jev-decision-model' : undefined}
        className="mt-1 accent-[var(--primary)]"
        checked={checked}
        disabled={Boolean(motivo)}
        onChange={onToggle}
        aria-describedby={motivo ? `motivo-${m.id}` : undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{m.name ?? m.id}</span>
          {recomendado && <Tag>recomendado · versão fixada</Tag>}
          {alias && <Tag>alias móvel</Tag>}
          {m.id.endsWith(':free') && <Tag>grátis</Tag>}
          {!recomendado && !alias && <Tag>desafiante</Tag>}
        </span>
        <code className="block font-mono text-[11.5px] text-muted-foreground">{m.id}</code>
        <span className="block text-[12px] text-muted-foreground tabular">
          {usdPorM(m.pricing?.prompt)} · saída grátis · contexto {m.contextLength ? m.contextLength.toLocaleString('pt-BR') : 'desconhecido'}
        </span>
        {alias && (
          <span className="block text-[12px] text-muted-foreground">
            Alias muda de snapshot sem aviso: limiares calibrados nele não se reproduzem. Para treinar ou calibrar, fixe a versão.
          </span>
        )}
        {motivo && (
          <span id={`motivo-${m.id}`} className="block text-[12px] text-destructive">
            Indisponível: {motivo}
          </span>
        )}
      </span>
    </label>
  );
}

export function ContestantPicker(p: ContestantPickerProps) {
  const { draft } = p;
  const mode: JevMode = draft.mode;
  const single = mode !== 'compare';
  const escolhidos = draft.models.decision ?? [];
  const [aberta, setAberta] = useState<number | null>(null);

  // Catálogo + os ids escolhidos que (ainda) não estão nele (import, rede fora).
  const linhas: { id: string; name?: string; contextLength?: number; pricing?: { prompt?: number | null } }[] = [...p.decisionCatalog];
  for (const id of escolhidos) if (!linhas.some((m) => m.id === id)) linhas.push({ id });
  linhas.sort((a, b) => (a.id === DEFAULT_DECISION_MODEL ? -1 : b.id === DEFAULT_DECISION_MODEL ? 1 : a.id.localeCompare(b.id)));

  function toggleDecision(id: string) {
    if (single) {
      p.onChange({ models: { ...draft.models, decision: [id] } });
      return;
    }
    const tem = escolhidos.includes(id);
    // O 1º da lista é o CONTROLE: quem entra vai para o fim.
    const prox = tem ? escolhidos.filter((x) => x !== id) : [...escolhidos, id];
    p.onChange({ models: { ...draft.models, decision: prox } });
  }

  const llm = draft.models.llm ?? [];
  const tuning: Record<string, ModelTuning> = Object.fromEntries(
    llm.map((l) => [l.modelId, { effort: (l.reasoning ?? '') as ModelTuning['effort'], temperature: l.temperature === undefined ? '' : String(l.temperature) }]),
  );
  function setLlmIds(ids: string[]) {
    const porId = new Map(llm.map((l) => [l.modelId, l]));
    const prox: LlmInput[] = ids.map((id) => porId.get(id) ?? { modelId: id, temperature: 0 });
    p.onChange({ models: { ...draft.models, llm: prox } });
  }
  function tune(modelId: string, patch: Partial<ModelTuning>) {
    const prox = llm.map((l) => {
      if (l.modelId !== modelId) return l;
      const n: LlmInput = { ...l };
      if (patch.effort !== undefined) {
        if (patch.effort) n.reasoning = patch.effort as ReasoningLevel;
        else delete n.reasoning;
      }
      if (patch.temperature !== undefined) {
        const t = parseFloat(patch.temperature);
        if (Number.isFinite(t)) n.temperature = t;
        else delete n.temperature;
      }
      return n;
    });
    p.onChange({ models: { ...draft.models, llm: prox } });
  }

  const variantes = draft.variants ?? [];
  function addVariant() {
    const n = variantes.length + 1;
    const qs = JSON.parse(JSON.stringify(draft.spec.questions)) as Record<string, QuestionInput>;
    p.onChange({ variants: [...variantes, { label: `variante-${n}`, spec: { questions: qs } }] });
    setAberta(variantes.length);
  }

  const bloqueados = Object.keys(p.blocked);

  return (
    <div className="flex flex-col gap-4">
      {bloqueados.length > 0 && (
        <Banner tone="warn">
          Área LGPD sensível: o modo JEV fica indisponível na v1 — o Jev não tem retenção zero (ZDR) e a allowlist
          ainda não cobre os outros modelos de decisão. Escolha a área "Livre"/"Geral" (dados sintéticos) no passo
          Limites, ou use o benchmark LLM.
        </Banner>
      )}

      <SettingGroup
        title={single ? 'Modelo de decisão' : 'Modelos de decisão'}
        status={p.decisionLoading ? 'carregando…' : `${linhas.length} no catálogo`}
        footer={
          single
            ? 'Um modelo: a run mede UMA definição nele.'
            : 'O primeiro marcado é o CONTROLE: os outros (e os LLMs) são comparados contra ele, caso a caso.'
        }
      >
        {p.decisionError && (
          <p className="border-b border-border px-4 py-2 text-[12.5px] text-muted-foreground">
            Catálogo de decisões indisponível ({p.decisionError}) — seguem os modelos já escolhidos.
          </p>
        )}
        {linhas.map((m) => (
          <DecisionRow key={m.id} m={m} single={single} checked={escolhidos.includes(m.id)} onToggle={() => toggleDecision(m.id)} motivo={p.blocked[m.id]} />
        ))}
      </SettingGroup>

      {mode === 'compare' && (
        <>
          <SettingGroup
            title="Variantes da definição"
            status={`${variantes.length}`}
            footer="Cada variante reescreve o TEXTO das perguntas (instrução e rubricas) e roda em todos os modelos de decisão marcados. Id, tipo e opções ficam iguais — o ouro é o mesmo."
          >
            {variantes.length === 0 && <p className="px-4 py-3 text-[13px] text-muted-foreground">Nenhuma variante: a comparação é só entre modelos.</p>}
            {variantes.map((v, i) => (
              <div key={`var-${i}`} className="border-b border-border px-4 py-3 last:border-b-0">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    aria-expanded={aberta === i}
                    aria-controls={`jev-var-${i}`}
                    onClick={() => setAberta(aberta === i ? null : i)}
                    className="flex items-center gap-1 rounded-sm text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <ChevronRight className={cn('size-3.5', aberta === i && 'rotate-90')} aria-hidden="true" />
                    Variante
                  </button>
                  <Input
                    aria-label={`Rótulo da variante ${i + 1}`}
                    className="h-7 w-44 text-[13px]"
                    value={v.label}
                    onChange={(e) => p.onChange({ variants: variantes.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remover a variante ${v.label}`}
                    className="ml-auto"
                    onClick={() => p.onChange({ variants: variantes.filter((_, j) => j !== i) })}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                <div id={`jev-var-${i}`} hidden={aberta !== i} className="mt-3">
                  <SpecEditor
                    lockShape
                    idPrefix={`jev-var-${i}`}
                    questions={v.spec.questions ?? {}}
                    onChange={(qs) => p.onChange({ variants: variantes.map((x, j) => (j === i ? { ...x, spec: { ...x.spec, questions: qs } } : x)) })}
                  />
                </div>
              </div>
            ))}
            <div className="px-4 py-3">
              <Button type="button" variant="outline" size="sm" onClick={addVariant}>
                <Copy aria-hidden="true" />
                Adicionar variante (cópia da definição)
              </Button>
            </div>
          </SettingGroup>

          <SettingGroup
            title="LLMs nos mesmos casos (opcional)"
            footer="Cada LLM recebe a MESMA instrução e rubrica, responde com saída estruturada (uma chamada por pergunta) e vira competidor. A probabilidade dele é verbalizada — compare acurácia, custo e latência; o Brier, com cautela."
          >
            <SettingRow wide label="LLMs" sub="Temperatura 0 por padrão; raciocínio ligado e desligado são competidores diferentes.">
              <ModelSelector
                multi
                title="LLMs competidores"
                hint="Selecione 0 ou mais."
                value={llm.map((l) => l.modelId)}
                onChange={setLlmIds}
                models={p.chatModels}
                loading={p.chatLoading}
                tuning={tuning}
                onTuningChange={tune}
                tuningFields={['effort', 'temperature']}
              />
            </SettingRow>
          </SettingGroup>
        </>
      )}
    </div>
  );
}
