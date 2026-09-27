// ----------------------------------------------------------------------------
// `agent-task@2` (IMPL-098) — schema Zod do `AgentTaskSpec` estendido.
//
// O formato do arquivo continua o `arena-agent-config` (o parser completo vive em
// `configFile.ts`, fora do escopo deste módulo): aqui validamos o NÓ `agentTask`
// com os campos novos da v2 — `solution` (obrigatório em modo validate),
// `regression[]` (PASS_TO_PASS), `testsDir` (copiado DEPOIS do agente),
// `env.digest` (imagem/lockfile fixado; `path` relativo é REJEITADO) e
// `metadata{origin,commit,difficulty,tags,canary}`.
//
// Compatibilidade: o `arena-agent-config@1` continua legível — os campos novos
// são opcionais em modo `run`. Em modo `validate` (`agents task validate`,
// IMPL-097) `solution` é OBRIGATÓRIO: sem solução de referência não há
// pass-after, flakiness, trivialidade nem oráculo fraco para validar.
// ----------------------------------------------------------------------------
import path from 'node:path';
import { z } from 'zod';
import type { AgentTaskSpec } from './types.js';

/** Marcador da versão do formato que este schema valida. */
export const AGENT_TASK_FORMAT_V2 = 'arena-agent-config@2';

/** Um check do oráculo/regressão (`verify[]` / `regression[]`). */
export const agentTaskCheckSchema = z.object(
  {
    cmd: z.string('cmd obrigatório').min(1, 'cmd obrigatório'),
    expectExit: z.number('expectExit deve ser número').int('expectExit deve ser inteiro').optional(),
    timeoutMs: z.number('timeoutMs deve ser número').int('timeoutMs deve ser inteiro').positive('timeoutMs deve ser positivo').optional(),
    weight: z.number('weight deve ser número').positive('weight deve ser positivo').optional(),
    label: z.string('label deve ser texto').optional(),
    kind: z.enum(['fail_to_pass', 'pass_to_pass']).optional(),
    critical: z.boolean('critical deve ser boolean').optional(),
  },
  'cada check deve ser { cmd, expectExit?, timeoutMs?, weight?, label?, kind?, critical? }',
);

/** Solução de referência: script shell OU diff unificado. */
export const agentTaskSolutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('script'), script: z.string('script deve ser texto').min(1, 'script não pode ser vazio') }),
  z.object({ kind: z.literal('diff'), diff: z.string('diff deve ser texto').min(1, 'diff não pode ser vazio') }),
], 'solution deve ser { kind: "script", script } ou { kind: "diff", diff }');

/** Digest de imagem/lockfile: `sha256:<hex>` OU `<ref>@sha256:<hex>`. */
const DIGEST_RE = /^(?:[a-z0-9._/-]+@)?sha256:[a-f0-9]{64}$/i;

/**
 * Ambiente fixado (IMPL-098). `path` relativo é REJEITADO: um caminho relativo
 * muda de significado com o cwd e quebra a reprodutibilidade da tarefa.
 */
export const agentTaskEnvSchema = z
  .object({
    digest: z.string('env.digest obrigatório').min(1, 'env.digest obrigatório'),
    path: z.string('env.path deve ser texto').optional(),
  })
  .superRefine((v, ctx) => {
    if (!DIGEST_RE.test(v.digest)) {
      ctx.addIssue({
        code: 'custom',
        message: `env.digest deve ser sha256:<hex> ou <ref>@sha256:<hex> (recebido "${v.digest}")`,
        path: ['digest'],
      });
    }
    if (v.path !== undefined && !path.posix.isAbsolute(v.path) && !path.win32.isAbsolute(v.path)) {
      ctx.addIssue({
        code: 'custom',
        message: `env.path deve ser absoluto — path relativo é rejeitado (recebido "${v.path}")`,
        path: ['path'],
      });
    }
  });

/** Metadados de proveniência/curadoria (IMPL-098). */
export const agentTaskMetadataSchema = z.object(
  {
    origin: z.string('origin deve ser texto').optional(),
    commit: z.string('commit deve ser texto').optional(),
    difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    tags: z.array(z.string('tags devem ser texto')).optional(),
    canary: z.boolean('canary deve ser boolean').optional(),
  },
  'metadata deve ser { origin?, commit?, difficulty?, tags?, canary? }',
);

/** O nó `agentTask` na versão 2 (a v1 continua legível: só os campos novos mudam). */
export const agentTaskSpecSchema = z.object({
  repo: z
    .object({
      kind: z.literal('git'),
      url: z.string('url deve ser texto').min(1, 'url não pode ser vazia').optional(),
      path: z.string('path deve ser texto').min(1, 'path não pode ser vazio').optional(),
      ref: z.string('ref obrigatório').min(1, 'ref obrigatório'),
      shallow: z.boolean('shallow deve ser boolean').optional(),
    })
    .optional(),
  setup: z
    .array(
      z.object({
        cmd: z.string('cmd obrigatório').min(1, 'cmd obrigatório'),
        timeoutMs: z.number().int().positive().optional(),
      }),
    )
    .optional(),
  files: z
    .array(
      z.object({
        path: z.string('path obrigatório').min(1, 'path obrigatório'),
        content: z.string('content deve ser texto'),
      }),
    )
    .optional(),
  verify: z.array(agentTaskCheckSchema).optional(),
  // --- IMPL-098 (agent-task@2) -----------------------------------------------
  regression: z.array(agentTaskCheckSchema).optional(),
  solution: agentTaskSolutionSchema.optional(),
  testsDir: z.string('testsDir deve ser texto').min(1, 'testsDir não pode ser vazio').optional(),
  env: agentTaskEnvSchema.optional(),
  metadata: agentTaskMetadataSchema.optional(),
  // --- campos @1 que acompanham ----------------------------------------------
  forbiddenPaths: z.array(z.string('forbiddenPaths devem ser texto')).optional(),
  rebuild: z
    .object({
      cmd: z.string().optional(),
      lockfiles: z.array(z.string()).optional(),
      protect: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  detectors: z.enum(['off', 'warn', 'fail']).optional(),
  contextFiles: z.boolean().optional(),
  limits: z
    .object({
      maxTurns: z.number().int().positive().optional(),
      maxCostUsd: z.number().positive().optional(),
      timeoutMs: z.number().int().positive().optional(),
      maxOutputBytes: z.number().int().positive().optional(),
      maxDiffBytes: z.number().int().positive().optional(),
    })
    .optional(),
});

/** Modo de validação: `validate` exige solução de referência (IMPL-097/098). */
export type AgentTaskParseMode = 'validate' | 'run';

export type AgentTaskParseResult =
  | { ok: true; task: AgentTaskSpec; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Valida um nó `agentTask` (v1 ou v2) e devolve o `AgentTaskSpec` tipado.
 *
 * - modo `'run'` (default): a v1 continua válida — `solution`/`regression`/…
 *   são opcionais (uma run pode testar sem solução de referência);
 * - modo `'validate'` (`agents task validate`): `solution` é OBRIGATÓRIO — sem
 *   ela as 6 checagens do IMPL-097 são impossíveis e a tarefa é REJEITADA.
 */
export function parseAgentTaskSpec(input: unknown, opts: { mode?: AgentTaskParseMode } = {}): AgentTaskParseResult {
  const mode = opts.mode ?? 'run';
  const result = agentTaskSpecSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : 'agentTask'}: ${i.message}`),
    };
  }
  const task = result.data as AgentTaskSpec;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (mode === 'validate' && !task.solution) {
    errors.push('solution: obrigatório em modo validate (script ou diff de referência)');
  }
  if (mode === 'validate' && !task.verify?.length && !task.regression?.length) {
    errors.push('verify/regression: modo validate exige pelo menos um check');
  }
  if (task.solution?.kind === 'diff' && !task.solution.diff.includes('\n') && !task.solution.diff.startsWith('diff ')) {
    warnings.push('solution.diff parece curto demais para um patch unificado');
  }
  if (task.testsDir && (path.posix.isAbsolute(task.testsDir) || path.win32.isAbsolute(task.testsDir))) {
    errors.push(`testsDir: deve ser relativo à configuração (recebido "${task.testsDir}")`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, task, warnings };
}
