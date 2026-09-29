// IMPL-088 (R-22:REC-5) — registro `prompt-approval@1` do handoff.
//
// O `sessions winner --apply` levava o campeão para produção sem rastro: o
// commit dizia só "prompt: atualiza X (sessão Y)" e a evidência que sustentou
// a promoção (holdout n/Δ, IC95%/p, custo, k de n curados) não ficava ligada
// ao prompt aplicado. Agora cada aplicação monta UM registro com:
//
//  • identidade por hash: `promptHash` (sha256 dos BYTES gravados — confere
//    com `sha256sum`), `datasetHash` (JCS do CONJUNTO de cenários, ordem e
//    formatação irrelevantes — estável entre execuções), `configHash` (o mesmo
//    hash do lock/idempotência do CLI) e sessão + runs;
//  • quem aprovou (`--approver` ou a identidade que o git usaria no commit) e
//    quando; a evidência; o override (quando houve) e o ref do git.
//
// Onde vive: SEMPRE embutido na linha da trilha local (`handoffs.jsonl`) — 100%
// das aplicações com o registro; com `--record` ou `--commit`, também
// versionado no repo do usuário em `.prompt-approvals/<approvalId>.json`, e o
// `--commit` leva os trailers `Approved-by:` / `Prompt-Approval:` (parseáveis
// por `git interpret-trailers --parse`) com o arquivo do registro no MESMO
// commit do prompt.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { contentHash } from '../engine/hash.js';
import { configHash } from './runLock.js';
import type { HandoffOverride } from '../engine/handoffGuards.js';
import { CliError, EXIT } from './output.js';
import type { RunRecord, SessionRecord, StageSpec } from '../types.js';

export const PROMPT_APPROVAL_FORMAT = 'prompt-approval@1';
/** Diretório (na raiz do repo do usuário) dos registros versionados. */
export const PROMPT_APPROVALS_DIR = '.prompt-approvals';

export interface PromptApproval {
  format: typeof PROMPT_APPROVAL_FORMAT;
  approvalId: string;
  /** `sha256:<hex>` dos bytes gravados no destino (confere com `sha256sum`). */
  promptHash: string;
  /** `sha256:<hex>` (JCS) do conjunto de cenários; `null` = sessão sem cenários gravados. */
  datasetHash: string | null;
  datasetSize: number;
  /** De onde saiu o conjunto: os customStages do config ou as etapas da iteração 0. */
  datasetSource: 'customStages' | 'iteration-0' | 'pinnedStages' | 'none';
  /** O MESMO hash do lock/idempotência do CLI, sobre o config gravado na sessão. */
  configHash: string;
  sessionId: string;
  runIds: string[];
  /** `Nome <email>`; `null` só em `--apply` sem `--record`/`--commit` e sem identidade git. */
  approver: string | null;
  approvedAt: string;
  /** Destino relativo à raiz do repo (absoluto fora de um repo). */
  file: string;
  evidence: {
    iterations: number;
    champion: { iteration: number; contestantId: string } | null;
    holdoutN: number | null;
    controlScore: number | null;
    championScore: number | null;
    gain: number | null;
    regressed: boolean | null;
    holdoutSkipped: boolean;
    ci95Pp: [number, number] | null;
    pValue: number | null;
    pOrigin: string | null;
    costUsd: number;
    /** Âncora humana da declaração de campeão (IMPL-065), `k de n` do conjunto. */
    curatedKofN: { curated: number; total: number } | null;
    judgeDrift: boolean;
  };
  override: HandoffOverride | null;
  /** Estado do repo NO MOMENTO da aprovação (o commit do handoff vem depois). */
  git: { branch: string | null; head: string | null } | null;
}

/** Campos que DEFINEM um cenário (o que se pergunta + a régua). O resto é execução. */
const CAMPOS_DO_CENARIO = [
  'id',
  'question',
  'productContext',
  'reference',
  'expected',
  'labelSet',
  'rubric',
  'agentTask',
  'language',
  'tier',
  'dimensionTags',
  'persona',
  'invarianceGroup',
  'adversarialCategory',
] as const;

function conteudoDoCenario(spec: unknown): Record<string, unknown> {
  const s = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of CAMPOS_DO_CENARIO) if (s[c] !== undefined) out[c] = s[c];
  return out;
}

/**
 * Hash do CONJUNTO de cenários (JCS, RFC 8785): cada cenário vira o
 * `contentHash` do seu conteúdo e o conjunto é a lista ORDENADA e sem
 * repetição desses hashes — a ordem de execução, a formatação e campos de
 * execução (`maxTokens`, `origin`) não mudam o hash.
 */
export function datasetHashOf(specs: readonly unknown[]): { hash: string | null; n: number } {
  const itens = [...new Set(specs.map((s) => contentHash(conteudoDoCenario(s))))].sort();
  if (itens.length === 0) return { hash: null, n: 0 };
  return { hash: contentHash({ format: 'prompt-builder-dataset@1', items: itens }), n: itens.length };
}

/** Runs de uma sessão: iterações + re-avaliações limpas (sem repetir). */
export function sessionRunIds(s: SessionRecord): string[] {
  const ids = new Set<string>(s.runIds ?? []);
  for (const it of s.bestPromptByIteration ?? []) {
    const rid = it.gate?.reeval?.runId;
    if (rid) ids.add(rid);
  }
  for (const rid of (s as { reevalRunIds?: string[] }).reevalRunIds ?? []) ids.add(rid);
  return [...ids];
}

/** O conjunto de cenários da sessão, na melhor fonte disponível. */
export function sessionDataset(
  s: SessionRecord,
  firstRun: Pick<RunRecord, 'stages'> | null,
): { specs: unknown[]; source: PromptApproval['datasetSource'] } {
  const custom = s.config?.customStages;
  if (Array.isArray(custom) && custom.length > 0) return { specs: custom, source: 'customStages' };
  const daIteracao0 = (firstRun?.stages ?? []).map((st) => st.spec).filter((x): x is StageSpec => Boolean(x));
  if (daIteracao0.length > 0) return { specs: daIteracao0, source: 'iteration-0' };
  if (s.pinnedStages?.length) return { specs: s.pinnedStages, source: 'pinnedStages' };
  return { specs: [], source: 'none' };
}

/** `sha256:<hex>` dos bytes exatos. */
export function bytesHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf-8').digest('hex')}`;
}

function gitOut(dir: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

/** Raiz do repo git que contém `dir`, ou `null` fora de um repo. */
export function gitTopLevel(dir: string): string | null {
  return gitOut(dir, ['rev-parse', '--show-toplevel']);
}

/** Caractere de controle (inclui `\n`/`\r`/`\t`, NUL e DEL). */
const CONTROLE = /[\u0000-\u001f\u007f]/u;

/**
 * Revisão w2: `--approver` vai VERBATIM para o trailer `Approved-by:` do commit,
 * para o `.prompt-approvals/<id>.json` e para o `handoffs.jsonl` — trilha de
 * auditoria. Um `\n` embutido (`--approver $'Ana\nOverride-Reason: x'`, ou uma
 * variável de script) forjava linhas que `git interpret-trailers --parse` lê
 * como trailers reais. Recusa (exit 2) em vez de "consertar" em silêncio.
 */
export function assertCleanApprover(raw: string | undefined): void {
  if (raw === undefined || !CONTROLE.test(raw)) return;
  throw new CliError('--approver não pode conter quebra de linha nem outro caractere de controle.', EXIT.USAGE, { flag: '--approver' }, {
    code: 'usage.invalid_flag_value',
    hint: 'Use uma linha só, no formato `--approver "Nome <email>"` (o valor vira o trailer `Approved-by:` do commit).',
  });
}

/**
 * Quem aprova: `--approver` explícito, senão a identidade que o `git commit`
 * usaria AQUI (`git var GIT_AUTHOR_IDENT` respeita config e env), no formato
 * `Nome <email>`. `null` = ninguém identificável.
 */
export function resolveApprover(explicit: string | undefined, dir: string): string | null {
  assertCleanApprover(explicit);
  const e = explicit?.trim();
  if (e) return e;
  const ident = gitOut(dir, ['var', 'GIT_AUTHOR_IDENT']);
  const m = ident ? /^(.*?<[^>]*>)/u.exec(ident) : null;
  return m ? m[1].trim() : null;
}

function gitRef(dir: string): PromptApproval['git'] {
  if (!gitTopLevel(dir)) return null;
  const branch = gitOut(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const head = gitOut(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return { branch: branch || null, head: head || null };
}

/** O texto que vai para o destino (o mesmo `\n` final do `applyPromptFile`). */
export function appliedText(prompt: string): string {
  return prompt.endsWith('\n') ? prompt : `${prompt}\n`;
}

/**
 * Monta o registro (puro, fora o `git` de leitura). `approvalId` deriva do
 * conteúdo + instante: `pa-<AAAAMMDD>-<12 hex>`.
 */
export function buildPromptApproval(input: {
  record: SessionRecord;
  firstRun: Pick<RunRecord, 'stages'> | null;
  prompt: string;
  destino: string;
  approver: string | null;
  override: HandoffOverride | null;
  now?: Date;
}): PromptApproval {
  const { record } = input;
  const agora = input.now ?? new Date();
  const dir = path.dirname(input.destino);
  const top = gitTopLevel(dir);
  const dataset = sessionDataset(record, input.firstRun);
  const ds = datasetHashOf(dataset.specs);
  const campeao = record.bestPromptByIteration.at(-1);
  const sig = record.significance ?? null;
  const origem = sig ? (sig as { pOrigin?: unknown }).pOrigin : undefined;
  const decl = record.championDeclaration;
  const base: Omit<PromptApproval, 'approvalId'> = {
    format: PROMPT_APPROVAL_FORMAT,
    promptHash: bytesHash(appliedText(input.prompt)),
    datasetHash: ds.hash,
    datasetSize: ds.n,
    datasetSource: dataset.source,
    configHash: `sha256:${configHash(record.config)}`,
    sessionId: record.id,
    runIds: sessionRunIds(record),
    approver: input.approver,
    approvedAt: agora.toISOString(),
    file: top ? path.relative(top, input.destino).split(path.sep).join('/') : input.destino,
    evidence: {
      iterations: record.bestPromptByIteration.length,
      champion: campeao ? { iteration: campeao.iteration, contestantId: campeao.winnerContestantId } : null,
      holdoutN: record.holdout?.n ?? null,
      controlScore: record.holdout?.controlScore ?? null,
      championScore: record.holdout?.championScore ?? null,
      gain: record.holdout?.gain ?? null,
      regressed: record.holdout ? record.holdout.regressed : null,
      holdoutSkipped: Boolean(record.holdoutSkipped),
      ci95Pp: sig && Array.isArray(sig.ci95Pp) ? [sig.ci95Pp[0], sig.ci95Pp[1]] : null,
      pValue: sig ? sig.pValue : null,
      pOrigin: typeof origem === 'string' ? origem : null,
      costUsd: record.totalCostUsd,
      curatedKofN: decl ? { curated: decl.curatedItems, total: ds.n } : null,
      judgeDrift: Boolean(record.judgeDrift),
    },
    override: input.override,
    git: gitRef(dir),
  };
  const dia = base.approvedAt.slice(0, 10).replace(/-/g, '');
  const approvalId = `pa-${dia}-${contentHash(base).slice('sha256:'.length, 'sha256:'.length + 12)}`;
  const { format, ...resto } = base;
  return { format, approvalId, ...resto };
}

/** Onde o registro versionado mora: `<raiz do repo | dir do destino>/.prompt-approvals/<id>.json`. */
export function approvalFilePath(destino: string, approvalId: string): string {
  const dir = path.dirname(destino);
  const raiz = gitTopLevel(dir) ?? dir;
  return path.join(raiz, PROMPT_APPROVALS_DIR, `${approvalId}.json`);
}

/** Grava o registro (JSON com 2 espaços + `\n`). Devolve o caminho absoluto. */
export async function writePromptApproval(destino: string, approval: PromptApproval): Promise<string> {
  const file = approvalFilePath(destino, approval.approvalId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(approval, null, 2)}\n`, 'utf-8');
  return file;
}

/**
 * Trailers do commit do handoff (`git interpret-trailers --parse` os lê):
 * `Approved-by`, `Prompt-Approval` e os hashes — antes dos de override.
 */
export function approvalTrailers(a: PromptApproval): string[] {
  return [
    ...(a.approver ? [`Approved-by: ${a.approver}`] : []),
    `Prompt-Approval: ${a.approvalId}`,
    `Prompt-Hash: ${a.promptHash}`,
    ...(a.datasetHash ? [`Dataset-Hash: ${a.datasetHash}`] : []),
  ];
}
