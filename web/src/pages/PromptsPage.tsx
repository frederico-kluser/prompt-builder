import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, FilePenLine, Pencil, Search } from 'lucide-react';
import type { SavedPrompt } from '../api';
import { deletePrompt, listPrompts, updatePrompt } from '../api';
import { diffLines } from '../diff';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionPanel,
} from '@/components/motion-ui/accordion';
import { CopyButton } from '@/components/motion-ui/copy-button';
import { HoldToConfirmButton } from '@/components/motion-ui/hold-to-confirm';
import { SkeletonResolveList, SkeletonResolveRow, Skeleton } from '@/components/motion-ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DiffView, EmptyState, MiniLabel, PageHeader, Pre, Screen, Tag } from '../components/primitives';
import { useToasts } from '../components/AppShell';

// Biblioteca de prompts salvos (store 'prompts' do IndexedDB): lista, busca,
// renomeia, exclui, EDITA o texto (cada edição vira uma versão nova — o
// histórico e o diff entre versões ficam alcançáveis, web-live#15) e compara
// as versões. Hoje quem salva é a tela de Treino ("Melhor prompt"), que também
// pode gravar como nova versão de um prompt já salvo da mesma sessão.
// "Usar como base" semeia o rascunho da Nova Run no localStorage (chave
// 'arena:prompt-draft' — o NewRun lê e remove a chave ao abrir).

const DRAFT_KEY = 'arena:prompt-draft';

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Origin = SavedPrompt['origin'];

function originLabel(origin: Origin): string {
  if (origin?.kind === 'training') return 'treino';
  if (origin?.kind === 'variation') return 'variação';
  return 'manual';
}

/**
 * Técnica/rodada de proveniência, quando registradas no save. A rodada é
 * 1-based como na tela de Treino ("Rodada 1" é a iteração 0 — web-code#14);
 * a run de holdout não é rodada nenhuma.
 */
function originDetail(origin: Origin): string {
  if (!origin) return '';
  const parts: string[] = [];
  if (origin.techniqueId) parts.push(origin.techniqueId);
  if (origin.holdout) parts.push('holdout');
  else if (origin.iteration !== undefined) parts.push(`rodada ${origin.iteration + 1}`);
  return parts.join(' · ');
}

/** Link para a sessão de treino ou run que originou o prompt, quando houver. */
function originLink(origin: Origin): { to: string; label: string } | null {
  if (!origin) return null;
  if (origin.sessionId) return { to: `/training/${origin.sessionId}`, label: 'ver treino' };
  if (origin.runId) return { to: `/runs/${origin.runId}`, label: 'ver run' };
  return null;
}

interface PromptItemProps {
  prompt: SavedPrompt;
  onUpdated: (p: SavedPrompt) => void;
  onDeleted: (id: string) => void;
}

function PromptItem({ prompt: p, onUpdated, onDeleted }: PromptItemProps) {
  const navigate = useNavigate();
  const { notify } = useToasts();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(p.name);
  const [saving, setSaving] = useState(false);
  const [selVersion, setSelVersion] = useState(p.version);
  // Edição do TEXTO (web-live#15): é o que cria versão nova no promptStore.
  const [editingText, setEditingText] = useState(false);
  const [draftText, setDraftText] = useState(p.text);
  const [draftNote, setDraftNote] = useState('');
  const editId = useId();

  // Versão nova (edição aqui ou "nova versão" salva do treino) passa a ser a
  // selecionada — senão o seletor ficava parado na anterior.
  useEffect(() => {
    setSelVersion(p.version);
  }, [p.version]);

  // Versões ordenadas; por construção do promptStore a corrente é a última.
  const versions = useMemo(() => [...p.history].sort((a, b) => a.version - b.version), [p.history]);
  const selIdx = versions.findIndex((v) => v.version === selVersion);
  const sel = selIdx >= 0 ? versions[selIdx] : versions[versions.length - 1];
  const prev = selIdx > 0 ? versions[selIdx - 1] : undefined;
  const diff = useMemo(() => (sel && prev ? diffLines(prev.text, sel.text) : []), [sel, prev]);

  const link = originLink(p.origin);
  const detail = originDetail(p.origin);

  async function saveRename() {
    const name = draftName.trim();
    if (!name || saving) return;
    setSaving(true);
    try {
      const updated = await updatePrompt(p.id, { name });
      if (updated) onUpdated(updated);
      setEditing(false);
    } catch (err) {
      // IMPL-022: o IndexedDB agora REJEITA (antes engolia e o nome "voltava").
      notify(`Não foi possível renomear: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  function cancelRename() {
    setDraftName(p.name);
    setEditing(false);
  }

  function startEditText() {
    setDraftText(p.text);
    setDraftNote('');
    setEditingText(true);
  }

  async function saveText() {
    if (saving || !draftText.trim()) return;
    if (draftText === p.text) {
      notify('O texto não mudou — nenhuma versão nova.');
      setEditingText(false);
      return;
    }
    setSaving(true);
    try {
      const note = draftNote.trim();
      const updated = await updatePrompt(p.id, { text: draftText, ...(note ? { note } : {}) });
      if (updated) {
        onUpdated(updated);
        notify(`“${updated.name}” salvo como v${updated.version}.`);
      }
      setEditingText(false);
    } catch (err) {
      // IMPL-022: falha do IndexedDB chega aqui com a causa (ex.: sem espaço).
      notify(`Não foi possível salvar a versão: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    try {
      await deletePrompt(p.id);
    } catch (err) {
      notify(`Não foi possível excluir: ${err instanceof Error ? err.message : String(err)}`, 'error');
      return;
    }
    onDeleted(p.id);
    notify(`“${p.name}” excluído.`);
  }

  function useAsBase() {
    // Contrato com o NewRun: ele lê e remove a chave ao montar a tela.
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ text: p.text, name: p.name }));
    navigate('/new');
  }

  return (
    <AccordionItem value={p.id} className="border-b border-border last:border-b-0">
      {editing ? (
        // Renomear substitui o gatilho: um <input> dentro do <button> do
        // accordion roubaria o clique e o teclado do próprio gatilho.
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <Input
            className="h-8 min-w-[14rem] flex-1"
            aria-label="Novo nome do prompt"
            value={draftName}
            autoFocus
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void saveRename();
              if (e.key === 'Escape') cancelRename();
            }}
          />
          <Button size="sm" disabled={saving || !draftName.trim()} onClick={() => void saveRename()}>
            Salvar
          </Button>
          <Button variant="ghost" size="sm" onClick={cancelRename}>
            Cancelar
          </Button>
        </div>
      ) : (
        <AccordionTrigger className="px-4 py-3" headingLevel={3}>
          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium">{p.name}</span>
              <Tag>v{p.version}</Tag>
              <Tag>{originLabel(p.origin)}</Tag>
            </span>
            <span className="text-[12px] font-normal text-muted-foreground">
              atualizado em {formatDate(p.updatedAt)}
            </span>
          </span>
        </AccordionTrigger>
      )}

      <AccordionPanel className="px-4 pb-4">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={useAsBase}>
            Usar como base
            <ArrowRight aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="sm" onClick={startEditText} disabled={editingText}>
            <FilePenLine aria-hidden="true" />
            Editar texto
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraftName(p.name);
              setEditing(true);
            }}
          >
            <Pencil aria-hidden="true" />
            Renomear
          </Button>
          {/* variant="icon": o default é uma pílula primary em mono-caixa-alta,
              que destoa da fileira de botões outline. */}
          <CopyButton
            variant="icon"
            value={p.text}
            label="Copiar prompt"
            copiedLabel="Prompt copiado"
            className="h-7 rounded-lg"
          />
          {link && (
            <Link to={link.to} className="text-[13px] text-primary underline-offset-4 hover:underline">
              {link.label}
            </Link>
          )}
          {/* Segurar para excluir: sem diálogo de confirmação e sem clique
              acidental — a barra de destructive só completa após 1,2 s de
              pressão. O componente vem `h-[3.25rem] w-60` (alvo de gesto de
              página inteira); numa fileira de botões pequenos isso domina a
              tela, daí o override com `!` (a ordem da classe não decide o
              desempate no Tailwind). */}
          <HoldToConfirmButton
            holdSeconds={1.2}
            onConfirm={() => void confirmDelete()}
            className="ml-auto !h-7 !w-auto rounded-lg px-3 !text-[0.8rem]"
          >
            Segure para excluir
          </HoldToConfirmButton>
        </div>

        {detail && (
          <p className="mb-4 text-[13px] text-muted-foreground">
            Origem: {originLabel(p.origin)} · {detail}
          </p>
        )}

        {editingText ? (
          <div className="mb-4 flex flex-col gap-2">
            <label htmlFor={`${editId}-texto`}>
              <MiniLabel>Novo texto (vira a v{p.version + 1})</MiniLabel>
            </label>
            <Textarea
              id={`${editId}-texto`}
              className="max-h-96 min-h-40 font-mono text-[12.5px]"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
            />
            <Input
              className="h-8"
              aria-label="Nota da versão (opcional)"
              placeholder="Nota da versão (opcional) — o que mudou e por quê"
              value={draftNote}
              onChange={(e) => setDraftNote(e.target.value)}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={saving || !draftText.trim()} onClick={() => void saveText()}>
                {saving ? 'Salvando…' : 'Salvar nova versão'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditingText(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        ) : (
          <div className="mb-4">
            <MiniLabel>Prompt atual (v{p.version})</MiniLabel>
            <Pre>{p.text}</Pre>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            <MiniLabel className="mb-0">Versão</MiniLabel>
            <select
              className="h-7 rounded-lg border border-input bg-background px-2 text-[12.5px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label="Versão para comparar"
              value={sel?.version ?? p.version}
              onChange={(e) => setSelVersion(Number(e.target.value))}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  {`v${v.version} — ${formatDate(v.savedAt)}${v.version === p.version ? ' (atual)' : ''}`}
                </option>
              ))}
            </select>
            {prev && sel && (
              <span className="text-[12px] text-muted-foreground">
                diff de v{sel.version} vs. v{prev.version}
              </span>
            )}
          </div>
          {sel?.note && (
            <p className="mb-1.5 text-[12.5px] text-muted-foreground">
              Nota da v{sel.version}: {sel.note}
            </p>
          )}
          {prev && sel ? (
            <DiffView diff={diff} />
          ) : (
            <p className="text-[13px] text-muted-foreground">
              Primeira versão — não há versão anterior para comparar. “Editar texto” cria a próxima.
            </p>
          )}
        </div>
      </AccordionPanel>
    </AccordionItem>
  );
}

export function PromptsPage() {
  const [prompts, setPrompts] = useState<SavedPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let active = true;
    listPrompts()
      .then((list) => {
        if (active) setPrompts(list);
      })
      .catch(() => undefined) // promptStore já degrada p/ [] sem IndexedDB
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return prompts;
    return prompts.filter((p) => p.name.toLowerCase().includes(q) || p.text.toLowerCase().includes(q));
  }, [prompts, query]);

  function handleUpdated(updated: SavedPrompt) {
    setPrompts((list) => list.map((p) => (p.id === updated.id ? updated : p)));
  }

  function handleDeleted(id: string) {
    setPrompts((list) => list.filter((p) => p.id !== id));
  }

  return (
    <Screen>
      <PageHeader
        title="Prompts"
        subtitle="Biblioteca dos prompts salvos dos treinos, com histórico de versões — editar o texto cria uma versão nova."
      />

      <div className="relative mb-4">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          className="pl-8"
          placeholder="Buscar por nome ou conteúdo…"
          aria-label="Buscar prompt"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading ? (
        <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <SkeletonResolveList loading>
            {[0, 1, 2].map((i) => (
              <SkeletonResolveRow
                key={i}
                index={i}
                className="border-b border-border px-4 py-4 last:border-b-0"
                skeleton={<Skeleton className="h-8 w-full rounded-md" />}
                content={null}
              />
            ))}
          </SkeletonResolveList>
        </div>
      ) : prompts.length === 0 ? (
        <EmptyState>
          Nenhum prompt salvo ainda — salve o campeão de um treino (tela do treino → “Melhor prompt” → “Salvar na
          biblioteca”).
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>Nenhum prompt corresponde à busca.</EmptyState>
      ) : (
        <Accordion className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {visible.map((p) => (
            <PromptItem key={p.id} prompt={p} onUpdated={handleUpdated} onDeleted={handleDeleted} />
          ))}
        </Accordion>
      )}
    </Screen>
  );
}
