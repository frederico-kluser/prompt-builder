import { Router } from 'express';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { listModels, validateKey } from './openrouter.js';
import { startRun } from './orchestrator.js';
import { startTraining } from './trainer.js';
import { listTechniques } from './techniques.js';
import { getLgpdData } from './lgpd.js';
import { listRuns, loadRun, listSessions, loadSession } from './storage.js';
import { subscribe, subscribeSession } from './events.js';
import { runConfigSchema } from './runConfigSchema.js';
import { prepareOptsFor } from './prepareRun.js';
import { isTerminalRunStatus } from './types.js';
import { isValidRecordId, publicErrorMessage } from './pathSafety.js';
import type { CompareConfig, CompetitorResponse, RunRecord } from './types.js';

const router = Router();

// ---------------------------------------------------------------------------
// Linha de base de segurança (IMPL-024, R-09:REC-10)
// ---------------------------------------------------------------------------

/**
 * O Express DECODIFICA `:id` (`..%2Fpackage` → `../package`, `%2e%2e` → `..`,
 * `..%5C` → `..\`): validar o id é a única correção. `router.param` roda antes
 * de TODA rota com `:id` deste router — rota nova herda a guarda sozinha.
 * A resposta não ecoa o valor recebido (seria devolver um caminho).
 */
router.param('id', (_req, res, next, id: unknown) => {
  if (!isValidRecordId(id)) {
    res.status(400).json({ error: 'id inválido: use o id (UUID) devolvido ao criar a run/sessão.' });
    return;
  }
  next();
});

/**
 * Express 4 não captura rejeição de handler async: um `await loadRun` que
 * lança (EISDIR, EACCES, JSON corrompido) virava unhandledRejection e DERRUBAVA
 * o processo. O wrapper manda o erro ao error handler do app (500 tratado).
 */
function ah(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/** 500 com mensagem pública (sem caminho absoluto). */
function fail500(res: Response, err: unknown): void {
  res.status(500).json({ error: publicErrorMessage(err) });
}

const HEADER_NAME = 'x-openrouter-key';

function extractKey(req: Request): string | null {
  const headerVal = req.headers[HEADER_NAME];
  if (typeof headerVal === 'string' && headerVal.trim().length > 0) {
    return headerVal.trim();
  }
  return null;
}

function requireKey(req: Request, res: Response, next: NextFunction) {
  const key = extractKey(req);
  if (!key) {
    res.status(401).json({ error: 'OpenRouter key ausente. Envie no header x-openrouter-key.' });
    return;
  }
  (req as Request & { apiKey: string }).apiKey = key;
  next();
}

router.post('/validate-key', ah(async (req, res) => {
  const key = extractKey(req) ?? (req.body?.apiKey as string | undefined);
  if (!key) {
    res.status(400).json({ ok: false, error: 'Key ausente.' });
    return;
  }
  const result = await validateKey(key);
  res.status(result.ok ? 200 : 401).json(result);
}));

router.get('/models', requireKey, ah(async (req, res) => {
  try {
    const models = await listModels((req as Request & { apiKey: string }).apiKey);
    res.json({ data: models });
  } catch (err) {
    fail500(res, err);
  }
}));

router.post('/runs', requireKey, ah(async (req, res) => {
  const parsed = runConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Config invalida', details: parsed.error.flatten() });
    return;
  }
  const apiKey = (req as Request & { apiKey: string }).apiKey;

  // Pre-flight: valida a key ANTES de iniciar a run, pra falhar rapido com
  // mensagem clara em vez de quebrar la na etapa 1 do datagen.
  const keyCheck = await validateKey(apiKey);
  if (!keyCheck.ok) {
    res.status(401).json({ error: `Key OpenRouter invalida: ${keyCheck.error}` });
    return;
  }

  try {
    const cfg = parsed.data;

    if (cfg.mode === 'training') {
      res.status(400).json({ error: 'Modo treino usa POST /v1/benchmark/sessions.' });
      return;
    }

    if (cfg.mode === 'variation') {
      // A geracao das variantes mora em prepareRun.ts — servidor e CLI passam
      // pelo mesmo lugar. Sem ela, a run sai com ZERO contestants e sem erro.
      const { runId } = startRun(cfg, apiKey, prepareOptsFor(cfg, apiKey));
      res.status(202).json({ runId });
      return;
    }

    // compare — o superRefine garantiu competitorModelIds OU competitorConfigs
    // (>= 2 competidores efetivos); esse XOR nao e expressavel no tipo estatico
    // (CompareConfig exige competitorModelIds), dai o cast pontual.
    const { runId } = startRun(cfg as CompareConfig, apiKey);
    res.status(202).json({ runId });
  } catch (err) {
    fail500(res, err);
  }
}));

// Biblioteca curada de tecnicas de variacao (sem o meta-prompt). Nao exige key.
router.get('/techniques', (_req, res) => {
  res.json({ data: listTechniques() });
});

// Base de conhecimento LGPD (familias, areas, origem de providers/criadores)
// que alimenta o filtro consultivo de proposito/area. Publica, nao exige key.
router.get('/lgpd', (_req, res) => {
  res.json({ data: getLgpdData() });
});

router.get('/runs', ah(async (_req, res) => {
  try {
    const data = await listRuns();
    res.json({ data });
  } catch (err) {
    fail500(res, err);
  }
}));

router.get('/runs/:id', ah(async (req, res) => {
  try {
    const record = await loadRun(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Run nao encontrada' });
      return;
    }
    res.json(record);
  } catch (err) {
    fail500(res, err);
  }
}));

// SSE: nao exige key (a key so e necessaria para INICIAR a run, nao para acompanhar)
router.get('/runs/:id/events', ah(async (req, res) => {
  const runId = req.params.id;
  // Lança (EISDIR…) ANTES dos headers de SSE: o `ah` responde 500 em JSON.
  const record = await loadRun(runId);
  if (!record) {
    res.status(404).json({ error: 'Run nao encontrada' });
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

  send({ type: 'snapshot', record });

  // Helper único (IMPL-004): lista solta esquecia 'inconclusive' e o cliente
  // ficava pendurado num stream que nunca mais emitiria nada.
  const isTerminal = isTerminalRunStatus(record.status);
  if (isTerminal) {
    // evento terminal correto: 'error' vira run.error (UI mostra o motivo),
    // o resto vira run.finished. Em ambos o cliente fecha o EventSource.
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
}));

function csvEscape(value: unknown): string {
  const s = value === undefined || value === null ? '' : String(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

router.get('/runs/:id/export.csv', ah(async (req, res) => {
  const record = await loadRun(req.params.id);
  if (!record) {
    res.status(404).json({ error: 'Run nao encontrada' });
    return;
  }
  const byId = new Map(record.contestants.map((c) => [c.id, c]));
  const rows: string[] = [];
  rows.push(
    [
      'runId',
      'sessionId',
      'iteration',
      'stageIndex',
      'question',
      'contestantId',
      'label',
      'technique',
      'modelId',
      'status',
      'latencyMs',
      'tokensIn',
      'tokensOut',
      'costUsd',
      'rankPosition',
      'verdict',
      'errorMsg',
      'text',
    ]
      .map(csvEscape)
      .join(','),
  );
  for (const stage of record.stages) {
    const ranking = stage.judge?.rankedContestantIds ?? [];
    for (const r of stage.responses) {
      const rankPosition = ranking.indexOf(r.contestantId);
      const c = byId.get(r.contestantId);
      const verdict =
        stage.judge?.verdictByContestant?.[r.contestantId] ??
        (stage.judge?.acceptableByContestant?.[r.contestantId] === undefined
          ? ''
          : stage.judge.acceptableByContestant[r.contestantId]
            ? 'resolve'
            : 'nao');
      rows.push(
        [
          record.id,
          record.sessionId ?? '',
          record.iteration ?? '',
          stage.index,
          stage.spec?.question ?? '',
          r.contestantId,
          c?.label ?? '',
          c?.techniqueId ?? '',
          r.modelId,
          r.status,
          r.latencyMs,
          r.tokensIn,
          r.tokensOut,
          r.costUsd,
          rankPosition >= 0 ? rankPosition + 1 : '',
          verdict,
          r.errorMsg ?? '',
          r.text,
        ]
          .map(csvEscape)
          .join(','),
      );
    }
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="run-${record.id}.csv"`,
  });
  res.send(rows.join('\n'));
}));

// ---------------------------------------------------------------------------
// Sessoes de treino (modo training = N iteracoes encadeadas)
// ---------------------------------------------------------------------------

router.post('/sessions', requireKey, ah(async (req, res) => {
  const parsed = runConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Config invalida', details: parsed.error.flatten() });
    return;
  }
  if (parsed.data.mode !== 'training') {
    res.status(400).json({ error: 'POST /sessions exige mode "training".' });
    return;
  }
  const apiKey = (req as Request & { apiKey: string }).apiKey;

  const keyCheck = await validateKey(apiKey);
  if (!keyCheck.ok) {
    res.status(401).json({ error: `Key OpenRouter invalida: ${keyCheck.error}` });
    return;
  }

  try {
    const { sessionId } = await startTraining(parsed.data, apiKey);
    res.status(202).json({ sessionId });
  } catch (err) {
    fail500(res, err);
  }
}));

router.get('/sessions', ah(async (_req, res) => {
  try {
    res.json({ data: await listSessions() });
  } catch (err) {
    fail500(res, err);
  }
}));

router.get('/sessions/:id', ah(async (req, res) => {
  try {
    const record = await loadSession(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'Sessao nao encontrada' });
      return;
    }
    res.json(record);
  } catch (err) {
    fail500(res, err);
  }
}));

router.get('/sessions/:id/events', ah(async (req, res) => {
  const sessionId = req.params.id;
  const record = await loadSession(sessionId);
  if (!record) {
    res.status(404).json({ error: 'Sessao nao encontrada' });
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

  send({ type: 'snapshot', record });

  // Helper único (IMPL-004): lista solta esquecia 'inconclusive' e o cliente
  // ficava pendurado num stream que nunca mais emitiria nada.
  const isTerminal = isTerminalRunStatus(record.status);
  if (isTerminal) {
    if (record.status === 'error') {
      send({ type: 'session.error', sessionId, error: record.error ?? 'Sessao terminou com erro.' });
    } else {
      send({ type: 'session.finished', sessionId, record });
    }
    res.end();
    return;
  }

  const unsubscribe = subscribeSession(sessionId, (event) => {
    send(event);
    if (event.type === 'session.finished' || event.type === 'session.error') {
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
}));

export type { RunRecord, CompetitorResponse };

export default router;
