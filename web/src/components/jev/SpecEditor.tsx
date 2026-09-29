import { useId, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, CircleAlert, Info, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { SegmentedToggle, SegmentedToggleOption } from '@/components/motion-ui/segmented-toggle';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Tag } from '../primitives';
import { cn } from '@/lib/utils';
import type { JevLintIssue, JevPrimitive } from '../../engine/jev';
import {
  addOption,
  addQuestion,
  isExitKey,
  isStructuredRubric,
  moveLevel,
  moveOption,
  moveQuestion,
  patchQuestion,
  removeOption,
  removeQuestion,
  renameOption,
  renameQuestion,
  setQuestionType,
  toggleStructured,
  type QuestionInput,
  type StructuredRubric,
} from '../../jev/form';

/**
 * Editor da DEFINIÇÃO DE DECISÃO (o "prompt" do modo JEV): perguntas tipadas
 * `noul` (sim/não), `choice` (1 de N opções) e `score` (régua ordenada), cada
 * uma com instrução + rubrica. Edita o mapa `spec.questions` do `jev-config@1`
 * direto — o que se vê aqui é o que vai ao fio.
 *
 * Lint AO VIVO: os problemas de cada pergunta aparecem sob ela (código,
 * mensagem PT-BR, correção sugerida). `lockShape` (variantes) trava o que
 * mudaria o espaço de rótulos: id, tipo, chaves de opção e nº de níveis.
 */

const TYPE_LABEL: Record<JevPrimitive, string> = {
  noul: 'Sim/não',
  choice: 'Escolha',
  score: 'Escala',
};

const TYPE_HINT: Record<JevPrimitive, string> = {
  noul: 'Responde a probabilidade de "sim". Rubrica opcional — mas, se vier, com as DUAS chaves (sim e não).',
  choice: 'Escolhe 1 de N opções. O NOME da opção é lido pelo modelo: prefira nomes descritivos e inclua uma saída ("outro").',
  score: 'Escolhe um nível numa régua ordenada, do mais baixo ao mais alto. Descreva cada nível de forma absoluta.',
};

const LEVEL_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const LEVEL_TONE = {
  error: 'text-destructive',
  warning: 'text-parcial',
  info: 'text-muted-foreground',
} as const;

/** Lista de problemas de lint (código + mensagem + correção). */
export function IssueList({ issues, className }: { issues: readonly JevLintIssue[]; className?: string }) {
  if (!issues.length) return null;
  return (
    <ul className={cn('flex flex-col gap-1.5', className)} aria-label="Problemas encontrados">
      {issues.map((i, n) => {
        const Icon = LEVEL_ICON[i.level];
        return (
          <li key={`${i.code}-${n}`} className="flex gap-2 text-[13px] leading-snug">
            <Icon className={cn('mt-0.5 size-3.5 shrink-0', LEVEL_TONE[i.level])} aria-hidden="true" />
            <span className="min-w-0">
              <span className="sr-only">{i.level === 'error' ? 'Erro' : i.level === 'warning' ? 'Aviso' : 'Nota'}: </span>
              <code className="font-mono text-[11.5px] text-muted-foreground">{i.code}</code>{' '}
              <span className="text-foreground">{i.message}</span>
              {i.fix && <span className="block text-muted-foreground">Sugestão: {i.fix}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function IconBtn(p: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <Button type="button" variant="ghost" size="icon-sm" aria-label={p.label} title={p.label} disabled={p.disabled} onClick={p.onClick}>
      {p.children}
    </Button>
  );
}

function textOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  return JSON.stringify(v, null, 2);
}

/** Rubrica de UMA opção/nível: texto, estruturada {what, not_for, examples} ou vazia (null). */
function RubricField({
  value,
  onChange,
  allowNull,
  label,
}: {
  value: unknown;
  onChange: (v: unknown) => void;
  allowNull: boolean;
  label: string;
}) {
  if (value === null) {
    return (
      <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <span className="italic">sem rubrica (a opção se explica pelo nome)</span>
        <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => onChange('')}>
          escrever rubrica
        </button>
      </div>
    );
  }
  if (isStructuredRubric(value)) {
    const v = value as Partial<StructuredRubric>;
    const set = (patch: Partial<StructuredRubric>) => onChange({ ...v, ...patch });
    return (
      <div className="flex flex-col gap-1.5">
        <Textarea rows={2} aria-label={`${label}: o que é`} placeholder="O que é (critério de inclusão)" value={v.what ?? ''} onChange={(e) => set({ what: e.target.value })} />
        <Textarea rows={1} aria-label={`${label}: o que NÃO é`} placeholder="O que NÃO é (o vizinho com que costuma ser confundida)" value={v.not_for ?? ''} onChange={(e) => set({ not_for: e.target.value })} />
        <Textarea
          rows={2}
          aria-label={`${label}: exemplos`}
          placeholder="Exemplos curtos, um por linha"
          value={(v.examples ?? []).join('\n')}
          onChange={(e) => set({ examples: e.target.value.split('\n').filter((x, i, a) => x.trim() !== '' || i === a.length - 1) })}
        />
      </div>
    );
  }
  if (typeof value !== 'string') {
    return <pre className="scroll-slim max-h-32 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[12px]">{textOf(value)}</pre>;
  }
  return (
    <Textarea
      rows={2}
      aria-label={label}
      placeholder={allowNull ? 'Rubrica (opcional)' : 'Rubrica'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ChoiceEditor({
  qid,
  criteria,
  onChange,
  lockShape,
}: {
  qid: string;
  criteria: Record<string, unknown>;
  onChange: (c: Record<string, unknown>) => void;
  lockShape?: boolean;
}) {
  const ents = Object.entries(criteria);
  return (
    <div className="flex flex-col gap-2">
      {ents.map(([key, rub], i) => (
        <div key={`${qid}-opt-${i}`} className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5 sm:flex-row sm:items-start">
          <div className="flex items-center gap-1.5 sm:w-44 sm:shrink-0 sm:flex-col sm:items-stretch">
            {lockShape ? (
              <code className="font-mono text-[12.5px]">{key}</code>
            ) : (
              <Input
                aria-label={`Chave da opção ${i + 1} de ${qid}`}
                className="h-7 font-mono text-[12.5px]"
                value={key}
                onChange={(e) => onChange(renameOption(criteria, key, e.target.value))}
              />
            )}
            {isExitKey(key) && <Tag className="w-fit">saída</Tag>}
          </div>
          <div className="min-w-0 flex-1">
            <RubricField value={rub} allowNull label={`Rubrica da opção ${key}`} onChange={(v) => onChange({ ...criteria, [key]: v })} />
          </div>
          <div className="flex shrink-0 items-center gap-0.5 self-end sm:self-start">
            <button
              type="button"
              className="px-1 text-[12px] text-primary underline-offset-4 hover:underline"
              onClick={() => onChange({ ...criteria, [key]: rub === null ? '' : toggleStructured(rub) })}
            >
              {isStructuredRubric(rub) ? 'texto' : 'estruturar'}
            </button>
            {!lockShape && (
              <>
                <IconBtn label={`Subir a opção ${key}`} disabled={i === 0} onClick={() => onChange(moveOption(criteria, key, -1))}>
                  <ArrowUp aria-hidden="true" />
                </IconBtn>
                <IconBtn label={`Descer a opção ${key}`} disabled={i === ents.length - 1} onClick={() => onChange(moveOption(criteria, key, 1))}>
                  <ArrowDown aria-hidden="true" />
                </IconBtn>
                <IconBtn label={`Remover a opção ${key}`} onClick={() => onChange(removeOption(criteria, key))}>
                  <Trash2 aria-hidden="true" />
                </IconBtn>
              </>
            )}
          </div>
        </div>
      ))}
      {!lockShape && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange(addOption(criteria))}>
          <Plus aria-hidden="true" />
          Opção
        </Button>
      )}
    </div>
  );
}

function ScoreEditor({
  qid,
  levels,
  onChange,
  lockShape,
}: {
  qid: string;
  levels: unknown[];
  onChange: (l: unknown[]) => void;
  lockShape?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12px] text-muted-foreground">Do nível mais BAIXO (0) ao mais ALTO. O ouro do caso é o índice do nível.</p>
      <ol className="flex flex-col gap-2">
        {levels.map((lv, i) => (
          <li key={`${qid}-lv-${i}`} className="flex items-start gap-2">
            <span className="mt-1.5 grid size-5 shrink-0 place-items-center rounded-full bg-muted font-mono text-[11px] text-muted-foreground tabular">
              {i}
            </span>
            <div className="min-w-0 flex-1">
              <RubricField value={lv} allowNull label={`Nível ${i} de ${qid}`} onChange={(v) => onChange(levels.map((x, j) => (j === i ? v : x)))} />
            </div>
            {!lockShape && (
              <div className="flex shrink-0 items-center gap-0.5">
                <IconBtn label={`Subir o nível ${i}`} disabled={i === 0} onClick={() => onChange(moveLevel(levels, i, -1))}>
                  <ArrowUp aria-hidden="true" />
                </IconBtn>
                <IconBtn label={`Descer o nível ${i}`} disabled={i === levels.length - 1} onClick={() => onChange(moveLevel(levels, i, 1))}>
                  <ArrowDown aria-hidden="true" />
                </IconBtn>
                <IconBtn label={`Remover o nível ${i}`} onClick={() => onChange(levels.filter((_, j) => j !== i))}>
                  <Trash2 aria-hidden="true" />
                </IconBtn>
              </div>
            )}
          </li>
        ))}
      </ol>
      {!lockShape && (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => onChange([...levels, ''])}>
          <Plus aria-hidden="true" />
          Nível
        </Button>
      )}
    </div>
  );
}

function NoulEditor({
  qid,
  criteria,
  onChange,
}: {
  qid: string;
  criteria: unknown;
  onChange: (c: unknown) => void;
}) {
  const on = criteria !== undefined && criteria !== null;
  const c = (on && typeof criteria === 'object' ? criteria : {}) as Record<string, unknown>;
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-sw`} className="flex items-center gap-2 text-[13px]">
        <Switch id={`${id}-sw`} checked={on} onCheckedChange={(v) => onChange(v ? { true: '', false: '' } : undefined)} aria-label={`Rubrica de ${qid}`} />
        Com rubrica (as duas chaves: quando é SIM e quando é NÃO)
      </label>
      {on && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">Quando é SIM</span>
            <RubricField value={c.true ?? ''} allowNull={false} label={`${qid}: quando é sim`} onChange={(v) => onChange({ ...c, true: v })} />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-muted-foreground">Quando é NÃO</span>
            <RubricField value={c.false ?? ''} allowNull={false} label={`${qid}: quando é não`} onChange={(v) => onChange({ ...c, false: v })} />
          </div>
        </div>
      )}
    </div>
  );
}

export interface SpecEditorProps {
  questions: Record<string, QuestionInput>;
  onChange: (q: Record<string, QuestionInput>) => void;
  /** Lint ao vivo (todas as perguntas); cada cartão mostra os seus. */
  issues?: readonly JevLintIssue[];
  /** Variante: só o TEXTO muda (id, tipo, chaves e nº de níveis travados). */
  lockShape?: boolean;
  /** Prefixo dos ids de âncora (várias instâncias na página). */
  idPrefix?: string;
}

export function SpecEditor({ questions, onChange, issues = [], lockShape, idPrefix = 'jev-q' }: SpecEditorProps) {
  const ents = Object.entries(questions);
  const soltos = issues.filter((i) => !i.questionId || !(i.questionId in questions));
  return (
    <div className="flex flex-col gap-3">
      {ents.map(([qid, q], idx) => {
        const tipo = (['noul', 'choice', 'score'].includes(q.type) ? q.type : 'noul') as JevPrimitive;
        const doCartao = issues.filter((i) => i.questionId === qid);
        const temErro = doCartao.some((i) => i.level === 'error');
        return (
          <section
            key={`${idPrefix}-${idx}`}
            id={`${idPrefix}-${qid}`}
            aria-label={`Pergunta ${qid}`}
            className={cn('rounded-xl bg-card p-3.5 ring-1 sm:p-4', temErro ? 'ring-destructive/40' : 'ring-foreground/10')}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-muted-foreground tabular">{idx + 1}</span>
              {lockShape ? (
                <code className="font-mono text-sm font-medium">{qid}</code>
              ) : (
                <Input
                  aria-label={`Id da pergunta ${idx + 1}`}
                  className="h-7 w-44 font-mono text-[12.5px]"
                  value={qid}
                  onChange={(e) => onChange(renameQuestion(questions, qid, e.target.value))}
                />
              )}
              {lockShape ? (
                <Tag>{TYPE_LABEL[tipo]}</Tag>
              ) : (
                <SegmentedToggle value={tipo} onChange={(v) => onChange(setQuestionType(questions, qid, v as JevPrimitive))} ariaLabel={`Tipo da pergunta ${qid}`}>
                  {(['noul', 'choice', 'score'] as const).map((t) => (
                    <SegmentedToggleOption key={t} value={t} className="px-2.5 py-1 text-[12.5px]">
                      {TYPE_LABEL[t]}
                    </SegmentedToggleOption>
                  ))}
                </SegmentedToggle>
              )}
              {q.guard && <Tag>guarda</Tag>}
              {!lockShape && (
                <div className="ml-auto flex items-center gap-0.5">
                  <IconBtn label={`Subir a pergunta ${qid}`} disabled={idx === 0} onClick={() => onChange(moveQuestion(questions, qid, -1))}>
                    <ArrowUp aria-hidden="true" />
                  </IconBtn>
                  <IconBtn label={`Descer a pergunta ${qid}`} disabled={idx === ents.length - 1} onClick={() => onChange(moveQuestion(questions, qid, 1))}>
                    <ArrowDown aria-hidden="true" />
                  </IconBtn>
                  <IconBtn label={`Remover a pergunta ${qid}`} onClick={() => onChange(removeQuestion(questions, qid))}>
                    <Trash2 aria-hidden="true" />
                  </IconBtn>
                </div>
              )}
            </div>
            <p className="mt-1.5 text-[12px] text-muted-foreground">{TYPE_HINT[tipo]}</p>

            <div className="mt-3 flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted-foreground">Instrução (a pergunta inteira — o id nunca vai ao modelo)</span>
              {typeof q.instructions === 'string' || q.instructions === undefined ? (
                <Textarea
                  rows={2}
                  aria-label={`Instrução de ${qid}`}
                  placeholder="Ex.: O cliente relata um defeito do produto descrito em `ticket`?"
                  value={q.instructions ?? ''}
                  onChange={(e) => onChange(patchQuestion(questions, qid, { instructions: e.target.value }))}
                />
              ) : (
                <div className="flex flex-col gap-1">
                  <pre className="scroll-slim max-h-40 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[12px]">{textOf(q.instructions)}</pre>
                  <button
                    type="button"
                    className="self-start text-[12px] text-primary underline-offset-4 hover:underline"
                    onClick={() => onChange(patchQuestion(questions, qid, { instructions: textOf(q.instructions) }))}
                  >
                    converter para texto
                  </button>
                </div>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted-foreground">
                {tipo === 'choice' ? 'Opções' : tipo === 'score' ? 'Níveis' : 'Rubrica'}
              </span>
              {tipo === 'choice' && (
                <ChoiceEditor
                  qid={qid}
                  lockShape={lockShape}
                  criteria={(q.criteria && typeof q.criteria === 'object' && !Array.isArray(q.criteria) ? q.criteria : {}) as Record<string, unknown>}
                  onChange={(c) => onChange(patchQuestion(questions, qid, { criteria: c }))}
                />
              )}
              {tipo === 'score' && (
                <ScoreEditor
                  qid={qid}
                  lockShape={lockShape}
                  levels={Array.isArray(q.criteria) ? q.criteria : []}
                  onChange={(l) => onChange(patchQuestion(questions, qid, { criteria: l }))}
                />
              )}
              {tipo === 'noul' && <NoulEditor qid={qid} criteria={q.criteria} onChange={(c) => onChange(patchQuestion(questions, qid, { criteria: c }))} />}
            </div>

            {q.keyMap && Object.keys(q.keyMap).length > 0 && (
              <p className="mt-2 text-[12px] text-muted-foreground">
                keyMap (chave no fio → rótulo do ouro):{' '}
                {Object.entries(q.keyMap).map(([w, c]) => (
                  <code key={w} className="mr-2 font-mono">
                    {w}→{c}
                  </code>
                ))}
              </p>
            )}

            {!lockShape && (
              <label className="mt-3 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Switch
                  size="sm"
                  checked={Boolean(q.guard)}
                  onCheckedChange={(v) => onChange(patchQuestion(questions, qid, { guard: v ? true : undefined }))}
                  aria-label={`Pergunta de guarda: ${qid}`}
                />
                Pergunta de guarda (ex.: injeção) — o otimizador nunca a reescreve
              </label>
            )}

            <IssueList issues={doCartao} className="mt-3 border-t border-border pt-2.5" />
          </section>
        );
      })}

      {!lockShape && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted-foreground">Adicionar pergunta:</span>
          {(['noul', 'choice', 'score'] as const).map((t) => (
            <Button key={t} type="button" variant="outline" size="sm" onClick={() => onChange(addQuestion(questions, t))}>
              <Plus aria-hidden="true" />
              {TYPE_LABEL[t]}
            </Button>
          ))}
        </div>
      )}
      <IssueList issues={soltos} />
    </div>
  );
}
