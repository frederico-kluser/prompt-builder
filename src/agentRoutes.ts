// ----------------------------------------------------------------------------
// ⚠️⚠️⚠️ §21.1 — ESTE ROUTER É EXECUÇÃO REMOTA DE CÓDIGO (/v1/agents, §21.6).
// ⚠️⚠️⚠️ `setup[]`/`verify[]`/`repo` DO CORPO DA REQUISIÇÃO SÃO COMANDOS
// ⚠️⚠️⚠️ ARBITRÁRIOS: `POST /v1/agents/runs` recebe um JSON e, como consequência,
// ⚠️⚠️⚠️ um processo roda `bash` num diretório desta máquina. Trate TODO o corpo
// ⚠️⚠️⚠️ como CÓDIGO, nunca como dados. Por isso este router SÓ é montado quando
// ⚠️⚠️⚠️ `PROMPT_BUILDER_AGENTS === '1'`, exige o token compartilhado
// ⚠️⚠️⚠️ `x-agents-token`, e (junto com o `server.ts`) recusa subir para um host
// ⚠️⚠️⚠️ não-localhost. Sem o env, a rota SIMPLESMENTE NÃO EXISTE (404), nunca 403.
// ----------------------------------------------------------------------------
//
// §21.5 — Portão de segurança (não negociável):
//   * Só montado com PROMPT_BUILDER_AGENTS=1 (em server.ts, ANTES do listen).
//   * Token compartilhado em <dataDir>/agents-token (0600), exigido no header
//     `x-agents-token`, comparado em tempo constante (timing-safe).
//   * A key do OpenRouter NÃO autoriza executar código — ela só autoriza GASTAR.
//     Para INICIAR uma run de agente ainda é necessária (`x-openrouter-key`).
//   * `isolation.kind === 'worktree'` de origem não-localhost => 400 (v1 exige
//     container para origem remota).
//   * Path traversal: nenhum segmento do cliente vira caminho. `stage`/`rep`
//     são Ints estritos, `contestant` é casado contra `record.contestants` e
//     `:file` é uma allowlist FECHADA. Todo caminho é montado com path.join +
//     path.resolve e verificado por prefixo sob agentRunsRoot() (store.ts).
// ----------------------------------------------------------------------------
import { promises as fs } from 'node:fs';
import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { ensurePrivateDataDir, getDataDir, listRuns, loadRun } from './storage.js';
import { isValidRecordId } from './pathSafety.js';
import { normalizeRunRecord } from './normalize.js';
import { subscribe } from './events.js';
import { startRun } from './orchestrator.js';
import { parseRunConfig } from './runConfigSchema.js';
import { isArenaAgentConfigFormat, parseArenaAgentConfig } from './configFile.js';
import { arenaAgentConfigToRunConfig } from './arenaConfig.js';
import { runPreflight } from './agent/doctor.js';
import {
  agentRunsRoot,
  execDir,
  readExecutionRef,
  readArtifact,
  ensureAgentsTokenFile,
} from './agent/store.js';
import type { ExecutionRef } from './agent/types.js';
import { isTerminalRunStatus } from './types.js';
import type { RunRecord } from './types.js';

const router = Router();

// ---------------------------------------------------------------------------
// Middleware: token compartilhado (timing-safe)
// ---------------------------------------------------------------------------

const TOKEN_HEADER = 'x-agents-token';

/**
 * Lê o token real do arquivo por chamada (nunca fica em memória de processo) e
 * compara com o header em TEMPO CONSTANTE. 401 quando ausente ou divergente.
 */
function requireAgentsToken(req: Request, res: Response, next: () => void): void {
  void (async () => {
    const supplied = req.headers[TOKEN_HEADER];
    if (typeof supplied !== 'string' || supplied.length === 0) {
      res.status(401).json({ error: 'Token de agentes ausente. Envie no header x-agents-token.' });
      return;
    }
    const file = await ensureAgentsTokenFile();
    const expected = (await fs.readFile(file, 'utf-8')).replace(/\s+$/u, '');
    const a = Buffer.from(supplied, 'utf-8');
    const b = Buffer.from(expected, 'utf-8');
    // timingSafeEqual exige buffers de tamanhos iguais; hash neutra o comprimento
    // sem abrir janela de timing por tamanho diferente.
    const aHash = createHash('sha256').update(a).digest();
    const bHash = createHash('sha256').update(b).digest();
    const ok = a.length === b.length && timingSafeEqual(aHash, bHash);
    if (!ok) {
      res.status(401).json({ error: 'Token de agentes inválido.' });
      return;
    }
    next();
  })().catch((err) => {
    res
      .status(500)
      .json({ error: `Falha ao verificar token de agentes: ${(err as Error).message}` });
  });
}

// ---------------------------------------------------------------------------
// Helpers de validação e origem do pedido
// ---------------------------------------------------------------------------

/** Parse de inteiro ESTRITO (não aceita sinais, decimais, hex, floats). */
function parseStrictInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  if (!/^\d+$/u.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

/** Origem da conexão (proxy de confiança mínimo => req.ip já é o socket real). */
function originIsLocalhost(req: Request): boolean {
  // `req.ip` respeita trust proxy; como o default é false, cai no remoteAddress.
  const ip = req.ip ?? req.socket.remoteAddress ?? '';
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) também é localhost
  const norm = ip.toLowerCase().replace(/^::ffff:/u, '');
  return norm === '127.0.0.1' || norm === '::1' || norm === 'localhost';
}

function contestantExists(record: RunRecord, id: string): boolean {
  return record.contestants.some((c) => c.id === id);
}

/**
 * Valida stage(strict Int)/contestant(∈record)/rep(strict Int) e devolve um
 * ExecutionRef cujo `dir` RELATIVO aponta para o dir pedido sob agent-runs.
 * A VERIFICAÇÃO DE PREFIXO sob agentRunsRoot() é feita aqui E no store ao ler —
 * defesa em profundidade contra path traversal (§21.6).
 */
function buildExecRef(
  record: RunRecord,
  stage: string,
  contestant: string,
  rep: string,
): { ok: true; ref: ExecutionRef } | { ok: false; error: string; status: number } {
  const stageIndex = parseStrictInt(stage);
  if (stageIndex === null) {
    return { ok: false, error: 'stage deve ser um inteiro.', status: 400 };
  }
  const repetition = parseStrictInt(rep);
  if (repetition === null) {
    return { ok: false, error: 'rep deve ser um inteiro.', status: 400 };
  }
  if (!contestantExists(record, contestant)) {
    return { ok: false, error: `contestant não encontrado: ${contestant}`, status: 400 };
  }
  // `dir` é RELATIVO (contrato do ExecutionRecord). Aqui verificamos o prefixo
  // do absoluto sob agentRunsRoot() para nunca deixar um dir escapar da raiz.
  const dir = execDir(record.id, stageIndex, contestant, repetition);
  const abs = path.resolve(getDataDir(), dir);
  const root = path.resolve(agentRunsRoot());
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: 'Caminho de execução inválido.', status: 400 };
  }
  return {
    ok: true,
    ref: { execId: '', repetition, dir, turns: 0, toolCalls: 0, durationMs: 0, stopReason: 'completed' },
  };
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

// TODAS as rotas de /v1/agents exigem o token compartilhado (§21.5). Sem ele,
// qualquer pessoa com acesso à rede executaria código na máquina — portão
// aplicado ANTES de qualquer handler.
router.use(requireAgentsToken);

// IMPL-024: `:id` decodificado pelo Express (`..%2F`, `%2e%2e`, `..%5C`) nunca
// chega ao disco — mesma guarda de /v1/benchmark, sem ecoar o valor.
router.param('id', (_req, res, next, id: unknown) => {
  if (!isValidRecordId(id)) {
    res.status(400).json({ error: 'id inválido: use o runId (UUID) devolvido ao criar a run.' });
    return;
  }
  next();
});

/**
 * GET /doctor — pré-voo do executor (§21.4). Executor presente? versão certa?
 * git? disco? `?deep=1` roda o canário de sala limpa (gasta a key do
 * `x-openrouter-key`); sem deep não chama LLM.
 */
router.get('/doctor', async (req, res) => {
  try {
    const deep = req.query.deep === '1' || req.query.deep === 'true';
    const runDir = path.join(getDataDir(), 'tmp', 'doctor-' + randomUUID());
    // IMPL-024: a sala envenenada do canário nasce dentro de tmp/ 0700.
    await ensurePrivateDataDir(runDir);
    const apiKeyHeader = req.headers['x-openrouter-key'];
    const apiKey =
      typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0
        ? apiKeyHeader.trim()
        : '';
    const model =
      typeof req.query.model === 'string' && req.query.model.trim()
        ? (req.query.model as string).trim()
        : 'xiaomi/mimo-v2.6-pro'; // default do dono (2026-09-27)
    const result = await runPreflight({
      expectedVersion: '0.84.2',
      cacheKey: deep ? 'pi-0.84.2-cleanroom' : undefined,
      runDir,
      apiKey: deep ? apiKey : '',
      model,
      bin: undefined,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Início e listagem de runs
// ---------------------------------------------------------------------------

// Controllers de abort por runId (§21.3 cancelamento).
const abortControllers = new Map<string, AbortController>();

/**
 * POST /runs — inicia uma run de agente. Aceita OU `arena-agent-config@1`
 * (traduzido via arenaAgentConfigToRunConfig) OU um RunConfig com `config.agent`
 * (validado por parseRunConfig). Exige `x-openrouter-key` (a key autoriza gastar;
 * quem autoriza executar código é o `x-agents-token`). Responde 202 {runId}.
 */
router.post('/runs', async (req, res) => {
  const apiKeyHeader = req.headers['x-openrouter-key'];
  const apiKey =
    typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0
      ? apiKeyHeader.trim()
      : '';
  if (!apiKey) {
    res
      .status(400)
      .json({ error: 'OpenRouter key ausente. Envie no header x-openrouter-key.' });
    return;
  }

  let config;
  try {
    const agentFile = parseArenaAgentConfig(req.body);
    if (agentFile.ok) {
      const translated = arenaAgentConfigToRunConfig(agentFile.config);
      if (!translated.ok) {
        res.status(400).json({ error: `Config invalida (${translated.error})` });
        return;
      }
      config = translated.config;
    } else if (isArenaAgentConfigFormat((req.body as Record<string, unknown> | null)?.format)) {
      // O formato bateu mas o parse falhou — devolve o erro real do schema.
      res.status(400).json({ error: agentFile.error });
      return;
    } else {
      // Caso: um RunConfig com config.agent (o schema valida cfg.agent também).
      const parsed = parseRunConfig(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: `Config invalida (${parsed.error})` });
        return;
      }
      config = parsed.config;
      if (!config.agent) {
        res.status(400).json({ error: 'Config sem config.agent — não é uma run de agente.' });
        return;
      }
    }
  } catch (err) {
    res.status(400).json({ error: `Config invalida: ${(err as Error).message}` });
    return;
  }

  // Portão de isolamento (§21.5): worktree de fora de localhost é proibido na v1.
  const isolationKind = config.agent?.isolation?.kind;
  if (isolationKind === 'worktree' && !originIsLocalhost(req)) {
    res.status(400).json({
      error:
        'isolation.kind="worktree" só é aceito de localhost na v1 — de origem remota use isolation.kind="container".',
    });
    return;
  }

  try {
    const controller = new AbortController();
    const { runId } = startRun(config, apiKey, { signal: controller.signal });
    abortControllers.set(runId, controller);
    // Limpa o controller quando a run fecha em evento terminal (sem listener órfão).
    const off = subscribe(runId, (event) => {
      if (event.type === 'run.finished' || event.type === 'run.error') {
        off();
        abortControllers.delete(runId);
      }
    });
    res.status(202).json({ runId });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /runs — resumos das runs. Estende de listRuns: inclui a contagem de
 * execuções quando o record a tem (etapas × contestants × repetições).
 */
router.get('/runs', async (_req, res) => {
  try {
    const summaries = await listRuns();
    const enriched = await Promise.all(
      summaries.map(async (s) => {
        let executions = 0;
        try {
          const record = await loadRun(s.id);
          if (record && record.config.agent) {
            const reps = record.config.agent.repetitions ?? 1;
            for (const stage of record.stages) {
              executions += stage.responses.length * reps;
            }
          }
        } catch {
          // melhor esforço — o resumo segue sem a contagem
        }
        return { ...s, executions };
      }),
    );
    res.json({ data: enriched });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** GET /runs/:id — o RunRecord completo (normalizado; campos novos aditivos). */
router.get('/runs/:id', async (req, res) => {
  try {
    const record = await loadRun(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Run não encontrada' });
      return;
    }
    res.json(normalizeRunRecord(record));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * GET /runs/:id/events — SSE (§21.7). Snapshot leve + subscribe(getBus(runId));
 * keepalive 15s; FECHA o stream (res.end) em run.finished / run.error.
 */
router.get('/runs/:id/events', async (req, res) => {
  const runId = req.params.id;
  let record;
  try {
    record = await loadRun(runId);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }
  if (!record) {
    res.status(404).json({ error: 'Run não encontrada' });
    return;
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  // Snapshot leve: o record já carrega ExecutionRefs, não trajetórias (§21.7).
  send({ type: 'snapshot', record: normalizeRunRecord(record) });

  const isTerminal = isTerminalRunStatus(record.status); // inclui 'inconclusive' (IMPL-004)
  if (isTerminal) {
    if (record.status === 'error') {
      send({ type: 'run.error', runId, error: record.error ?? 'Run terminou com erro.' });
    } else {
      send({ type: 'run.finished', runId, record });
    }
    res.end();
    return;
  }

  const unsubscribe = subscribe(runId, (event) => {
    send(event);
    if (event.type === 'run.finished' || event.type === 'run.error') {
      unsubscribe();
      res.end();
    }
  });

  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15_000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

/** POST /runs/:id/cancel — aborta a run via AbortController (sinal de controle). */
router.post('/runs/:id/cancel', async (req, res) => {
  const runId = req.params.id;
  try {
    const record = await loadRun(runId);
    if (!record) {
      res.status(404).json({ error: 'Run não encontrada' });
      return;
    }
    const terminal = isTerminalRunStatus(record.status); // inclui 'inconclusive' (IMPL-004)
    if (terminal) {
      res.status(409).json({ error: 'Run já terminou — nada a cancelar.' });
      return;
    }
    const controller = abortControllers.get(runId);
    if (!controller) {
      // Sem controller, a run pode ter sido iniciada por outro processo (CLI):
      // não conseguimos sinalizá-la aqui — não finge que abortou.
      res.status(409).json({
        error: 'Sem controle de abort para esta run (iniciada fora deste processo).',
      });
      return;
    }
    controller.abort();
    abortControllers.delete(runId);
    res.status(202).json({ runId, aborted: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Export CSV (§21.6) — uma linha por (etapa × contestant × repetição)
// ---------------------------------------------------------------------------

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/u.test(s)) return `"${s.replace(/"/gu, '""')}"`;
  return s;
}

/** Veredito do referenceJudge para um contestant, quando houver. */
function verdictFor(record: RunRecord, stageIndex: number, contestantId: string): string {
  const stage = record.stages.find((s) => s.index === stageIndex);
  return stage?.referenceJudge?.verdictByContestant?.[contestantId] ?? '';
}

/**
 * GET /runs/:id/export.csv — colunas:
 * runId,stageIndex,contestantId,repetition,stopReason,turns,toolCalls,durationMs,
 * costUsd,oracleScore,verdict. Fim de linha CRLF; por repetição, lendo cada
 * exec.json em disco (a ref no record cobre só a rep 0).
 */
router.get('/runs/:id/export.csv', async (req, res) => {
  const runId = req.params.id;
  try {
    const record = await loadRun(runId);
    if (!record) {
      res.status(404).json({ error: 'Run não encontrada' });
      return;
    }
    const rows: string[] = [];
    rows.push(
      [
        'runId',
        'stageIndex',
        'contestantId',
        'repetition',
        'stopReason',
        'turns',
        'toolCalls',
        'durationMs',
        'costUsd',
        'oracleScore',
        'verdict',
      ]
        .map(csvEscape)
        .join(','),
    );

    const repsDefault = record.config.agent?.repetitions ?? 1;
    for (const stage of record.stages) {
      for (const r of stage.responses) {
        // reps: para agentes usa repetition+1 da ref (se houver) ou o default.
        const reps =
          record.config.agent && r.execution
            ? Math.max(repsDefault, r.execution.repetition + 1)
            : record.config.agent
              ? repsDefault
              : 0;
        for (let rep = 0; rep < reps; rep++) {
          const ref: ExecutionRef = {
            execId: '',
            repetition: rep,
            dir: execDir(runId, stage.index, r.contestantId, rep),
            turns: 0,
            toolCalls: 0,
            durationMs: 0,
            stopReason: 'completed',
          };
          const exec = await readExecutionRef(ref);
          let stopReason = exec?.trajectorySummary.stopReason ?? '';
          let turns = exec?.trajectorySummary.turns ?? 0;
          let toolCalls = exec?.trajectorySummary.toolCalls ?? 0;
          let durationMs = 0;
          let costUsd = exec?.usage.costUsd ?? 0;
          let oracleScore = exec?.oracle?.score ?? '';
          if (exec?.invocation?.startedAt && exec.invocation.finishedAt) {
            durationMs = Math.max(
              0,
              Date.parse(exec.invocation.finishedAt) - Date.parse(exec.invocation.startedAt),
            );
          }
          if (!exec && rep === 0 && r.execution) {
            // exec.json ausente (ex.: coleta interrompida): usa o resumo da ref.
            stopReason = r.execution.stopReason;
            turns = r.execution.turns;
            toolCalls = r.execution.toolCalls;
            durationMs = r.execution.durationMs;
            oracleScore = r.execution.oracle?.score ?? '';
          }
          rows.push(
            [
              record.id,
              stage.index,
              r.contestantId,
              rep,
              stopReason,
              turns,
              toolCalls,
              durationMs,
              costUsd,
              oracleScore,
              verdictFor(record, stage.index, r.contestantId),
            ]
              .map(csvEscape)
              .join(','),
          );
        }
      }
    }

    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="run-${record.id}.csv"`,
    });
    res.send(rows.join('\r\n'));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// Artefatos de execução (§21.6)
// ---------------------------------------------------------------------------

/** Allowlist FECHADA de `:file` do raw. 'session' abre só o subdir `session/*`. */
function allowedRawFile(file: string): boolean {
  const norm = file.replaceAll('\\', '/');
  if (norm.includes('/')) {
    if (!norm.startsWith('session/')) return false;
    const parts = norm.split('/');
    return parts.every((p) => p.length > 0 && p !== '.' && p !== '..');
  }
  return new Set([
    'events.jsonl',
    'session',
    'workspace.diff',
    'workspace.stat',
    'files.json',
    'oracle.json',
    'trajectory.json',
    'dossier.md',
    'task.txt',
    'argv.json',
    'stderr.log',
    'stdout.log',
    'digests.json',
  ]).has(norm);
}

/**
 * GET /runs/:id/exec/:stage/:contestant/:rep — o exec.json (=404 se não existe).
 */
router.get('/runs/:id/exec/:stage/:contestant/:rep', async (req, res) => {
  try {
    const record = await loadRun(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Run não encontrada' });
      return;
    }
    const built = buildExecRef(record, req.params.stage, req.params.contestant, req.params.rep);
    if (!built.ok) {
      res.status(built.status).json({ error: built.error });
      return;
    }
    const exec = await readExecutionRef(built.ref);
    if (!exec) {
      res.status(404).json({ error: 'Execução não encontrada' });
      return;
    }
    res.json(exec);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** Lê um artefato textual da execução (dossier/diff/trajectory/raw). */
async function serveArtifact(
  req: Request,
  res: Response,
  artifact: string,
  contentType: string,
): Promise<void> {
  try {
    const record = await loadRun(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Run não encontrada' });
      return;
    }
    const built = buildExecRef(record, req.params.stage, req.params.contestant, req.params.rep);
    if (!built.ok) {
      res.status(built.status).json({ error: built.error });
      return;
    }
    if (!allowedRawFile(artifact)) {
      res.status(400).json({ error: `Artefato não permitido: ${artifact}` });
      return;
    }
    const content = await readArtifact(built.ref, artifact);
    if (content === null) {
      res.status(404).json({ error: `Artefato não encontrado: ${artifact}` });
      return;
    }
    res.set({ 'Content-Type': contentType });
    res.send(content);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

router.get('/runs/:id/exec/:stage/:contestant/:rep/dossier', (req, res) => {
  void serveArtifact(req, res, 'dossier.md', 'text/markdown; charset=utf-8');
});
router.get('/runs/:id/exec/:stage/:contestant/:rep/diff', (req, res) => {
  void serveArtifact(req, res, 'workspace.diff', 'text/plain; charset=utf-8');
});
router.get('/runs/:id/exec/:stage/:contestant/:rep/trajectory', (req, res) => {
  void serveArtifact(req, res, 'trajectory.json', 'application/json; charset=utf-8');
});
router.get('/runs/:id/exec/:stage/:contestant/:rep/raw/:file', (req, res) => {
  void serveArtifact(req, res, req.params.file, 'application/octet-stream; charset=utf-8');
});

export default router;