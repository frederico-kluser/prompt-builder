import { useRef, useState } from 'react';
import { Download, FileUp, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Banner, MiniLabel } from '../primitives';
import { IssueList } from './SpecEditor';
import { expectedList, parseJevDataset, toJsonl, type JevCase, type JevLintIssue, type JevSpec, type ResolvedJevConfig } from '../../engine/jev';
import { labelDistribution, splitPreview, statePreview } from '../../jev/form';

/**
 * Casos ROTULADOS do modo JEV (D-14: na v1 o caso chega por importação — o
 * modo MEDE contra o rótulo-ouro; rótulo gerado por IA criaria eco).
 *
 * Aceita os formatos do `jev import` do CLI (o MESMO parser, fonte única):
 * JSONL, CSV (`state` / `state.<campo>`, `expected.<pergunta>`, `a|b` =
 * alternativas), `jev-dataset@1` e o `evals.json` da jev-agent-skill (que traz
 * as próprias perguntas). Erros com linha e coluna; nada é importado se houver
 * erro — o arquivo inteiro ou nada.
 */

export interface CasesImportProps {
  /** Definição atual (normaliza o ouro por tipo: sim/não, rótulo, índice do nível). */
  spec: Omit<JevSpec, 'id'> | null;
  cases: unknown[];
  onChange: (cases: unknown[]) => void;
  /** Config resolvido (splits e distribuição). null = ainda não resolve. */
  resolved: Pick<ResolvedJevConfig, 'cases' | 'specs'> | null;
  /** O arquivo trouxe perguntas (evals.json da skill): oferece trocar a definição. */
  onUseSpec?: (spec: Omit<JevSpec, 'id'>) => void;
}

/** Caso normalizado → objeto inline do jev-config (sem campos vazios). */
function inline(c: JevCase): Record<string, unknown> {
  return {
    id: c.id,
    state: c.state,
    expected: c.expected,
    ...(c.split ? { split: c.split } : {}),
    ...(c.tags?.length ? { tags: c.tags } : {}),
    ...(c.language ? { language: c.language } : {}),
  };
}

function ouroTexto(c: { expected?: Record<string, unknown> }): string {
  return Object.entries(c.expected ?? {})
    .map(([q, v]) => `${q}=${expectedList(v as never).map(String).join('|')}`)
    .join(' · ');
}

function baixar(nome: string, texto: string, tipo: string): void {
  const url = URL.createObjectURL(new Blob([texto], { type: tipo }));
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  a.click();
  URL.revokeObjectURL(url);
}

export function CasesImport({ spec, cases, onChange, resolved, onUseSpec }: CasesImportProps) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [colado, setColado] = useState('');
  const [issues, setIssues] = useState<JevLintIssue[]>([]);
  const [origem, setOrigem] = useState<string | null>(null);
  const [specDoArquivo, setSpecDoArquivo] = useState<Omit<JevSpec, 'id'> | null>(null);

  function ler(texto: string, nome: string) {
    const r = parseJevDataset(texto, 'auto', spec ?? undefined);
    setIssues(r.issues);
    setSpecDoArquivo(r.spec ?? null);
    if (r.issues.some((i) => i.level === 'error')) {
      setOrigem(`${nome}: nada foi importado — corrija os erros abaixo.`);
      return;
    }
    if (!r.cases.length) {
      setOrigem(`${nome}: nenhum caso encontrado.`);
      return;
    }
    onChange(r.cases.map(inline));
    setOrigem(`${r.cases.length} caso(s) de ${nome} (${r.format}).`);
  }

  const dist = resolved ? labelDistribution(resolved) : {};
  const splits = resolved ? splitPreview(resolved) : null;
  const linhas = (cases as { id?: string; state?: unknown; expected?: Record<string, unknown>; split?: string }[]).slice(0, 20);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
          <FileUp aria-hidden="true" />
          Importar arquivo
        </Button>
        <span className="text-[12px] text-muted-foreground">JSONL, CSV, JSON (`jev-dataset@1`) ou o `evals.json` da jev-agent-skill.</span>
        <input
          ref={fileRef}
          type="file"
          accept=".jsonl,.csv,.json,.ndjson,application/json,text/csv"
          className="hidden"
          aria-label="Arquivo de casos"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void f.text().then((t) => ler(t, f.name));
            e.target.value = '';
          }}
        />
        {cases.length > 0 && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => baixar('casos.jsonl', toJsonl((resolved?.cases ?? []) as JevCase[]), 'application/x-ndjson')}
              disabled={!resolved}
            >
              <Download aria-hidden="true" />
              Baixar JSONL
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange([])}>
              <Trash2 aria-hidden="true" />
              Limpar casos
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <MiniLabel>ou cole aqui</MiniLabel>
        <Textarea
          rows={4}
          aria-label="Casos colados"
          className="font-mono text-[12.5px]"
          placeholder={'{"id":"t1","state":{"ticket":"Fui cobrado duas vezes"},"expected":{"team":"pagamentos","is_bug":false}}'}
          value={colado}
          onChange={(e) => setColado(e.target.value)}
        />
        <Button type="button" size="sm" variant="outline" className="self-start" disabled={!colado.trim()} onClick={() => ler(colado, 'texto colado')}>
          Ler casos colados
        </Button>
      </div>

      {origem && <p className="text-[13px] text-foreground">{origem}</p>}
      <IssueList issues={issues.slice(0, 12)} />
      {issues.length > 12 && <p className="text-[12px] text-muted-foreground">+{issues.length - 12} problema(s) — corrija os primeiros e importe de novo.</p>}

      {specDoArquivo && onUseSpec && (
        <Banner tone="neutral" className="flex flex-wrap items-center justify-between gap-2">
          <span>
            O arquivo traz {specDoArquivo.questions.length} pergunta(s) ({specDoArquivo.questions.map((q) => q.id).join(', ')}).
          </span>
          <Button type="button" size="sm" variant="outline" onClick={() => onUseSpec(specDoArquivo)}>
            Usar as perguntas do arquivo
          </Button>
        </Banner>
      )}

      {cases.length > 0 && (
        <>
          <div className="flex flex-col gap-1.5">
            <MiniLabel>
              Prévia — {Math.min(20, cases.length)} de {cases.length} caso(s)
            </MiniLabel>
            <div className="scroll-slim max-h-80 overflow-auto rounded-lg border border-border">
              <table className="w-full text-left text-[12.5px]">
                <caption className="sr-only">Primeiros casos importados</caption>
                <thead className="sticky top-0 bg-muted text-[11px] tracking-wide text-muted-foreground uppercase">
                  <tr>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">id</th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">estado</th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">ouro</th>
                    <th scope="col" className="px-2.5 py-1.5 font-medium">split</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((c, i) => (
                    <tr key={`${c.id ?? i}`} className="border-t border-border align-top">
                      <td className="px-2.5 py-1.5 font-mono text-[11.5px] text-muted-foreground">{c.id ?? '—'}</td>
                      <td className="max-w-[18rem] px-2.5 py-1.5">{statePreview(c.state)}</td>
                      <td className="px-2.5 py-1.5 font-mono text-[11.5px]">{ouroTexto(c)}</td>
                      <td className="px-2.5 py-1.5 text-muted-foreground">
                        {resolved?.cases.find((x) => x.id === c.id)?.split ?? c.split ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {splits && (
            <p className="text-[13px] text-muted-foreground tabular">
              Splits: treino {splits.train} · calibração {splits.calib} · holdout {splits.holdout}
            </p>
          )}

          {Object.keys(dist).length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {Object.entries(dist).map(([qid, barras]) => {
                const max = Math.max(1, ...barras.map((b) => b.n));
                return (
                  <figure key={qid} className="rounded-lg border border-border p-2.5">
                    <figcaption className="mb-1.5 text-[12px] font-medium">
                      Ouro de <code className="font-mono">{qid}</code>
                      {barras.length === 0 && <span className="font-normal text-muted-foreground"> — nenhum caso rotula esta pergunta</span>}
                    </figcaption>
                    <ul className="flex flex-col gap-1">
                      {barras.map((b) => (
                        <li key={b.label} className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-[12px]" title={`${b.label}: ${b.n}`}>
                          <span className="truncate text-muted-foreground">{b.label}</span>
                          <span className="h-2 rounded-r-[4px] bg-chart-1" style={{ width: `${(b.n / max) * 100}%` }} aria-hidden="true" />
                          <span className="tabular">{b.n}</span>
                        </li>
                      ))}
                    </ul>
                  </figure>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
