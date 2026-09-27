// ----------------------------------------------------------------------------
// O ORÁCULO DETERMINÍSTICO do modo agente — `runOracle`.
//
// Este é o módulo que roda `AgentTaskSpec.verify[]` e monta o `OracleResult`.
// Ele marca a FRONTEIRA entre os dois mundos do julgamento: o que pode ser
// MEDIDO (exit code de um comando, arquivo proibido tocado) e o que só um LLM
// consegue graduar. À luz do plano §17.1, quando o oráculo existe ele é a ÚNICA
// parte do julgamento que NÃO depende de um LLM ter um bom dia — e por isso ele
// MANDA onde decide.
//
// O porquê de cada decisão aqui (não é decoração, é o desejo de design):
//
// 1. **spawn com `shell:false` SEMPRE.** O `cmd` de `verify[]` é CONFIG DO
//    USUÁRIO (vem da tarefa). Com `shell:true`, aspas, `$(...)` e `;` no texto
//    do comando virariam INJEÇÃO DE COMANDO — o oráculo executaria um script
//    arbitrário no cwd do experimento. `spawn` sem shell passa o argv como lista
//    literal e deixa a "vitória suja" fora. Por isso a string `cmd` é tokenizada
//    AQUI, na fronteira de confiança, respeitando aspas — nunca delegada a um
//    shell (§11.2 do plano).
//
// 2. **Exit code como régua, na ordem da lista.** `ok = exitCode === expected`;
//    `score` é a soma ponderada dos `ok` sobre a soma dos pesos. Ordem SEMPRE a
//    da lista — o oráculo precisa ser reproduzível entre execuções, e a ordem
//    dos checks faz parte do contrato.
//
// 3. **`inconclusive` = o oráculo NÃO decidiu.** Comando ausente (spawn error)
//    ou timeout do próprio check significam "o critério de sucesso não pôde ser
//    aferido" — e o plano §17.1 é explícito: nesse caso o veredito cai para o
//    caminho SEM oráculo, com o dossiê marcando isso. Fingir `ok:false` aqui
//    seria punir a tarefa (não o agente) por um oráculo mal escrito.
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe. O navegador não tem `child_process` —
// rodar oráculo na SPA é impossível por construção (ver nota em `types.ts`).
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import type { AgentTaskSpec, OracleResult } from './types.js';
import {
  detectSuspicious,
  diffProtected,
  diffViolations,
  restoreFiles,
  scoreChecks,
  snapshotProtected,
  type ProtectedSnapshot,
  type ScoredCheck,
  type VerifyKind,
} from './guard.js';

// Timeout default dos checks quando a tarefa não informa (§contrato no JSDoc).
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
// Teto de bytes do tail capturado POR CHECK (stdout+stderr combinados).
const MAX_TAIL_BYTES = 64 * 1024;
// Linhas de tail: ~40 para quem falhou (precisa de evidência), ~10 para quem
// passou (só confirmação). Menos bytes salvos em disco/oracle.json.
const TAIL_LINES_FAIL = 40;
const TAIL_LINES_PASS = 10;

/**
 * Exit code sintético para os casos em que NÃO houve exit normal do processo:
 * spawn error (comando ausente, permissão negada) ou timeout do próprio check.
 * `OracleResult.checks[].exitCode` é `number` não-nulo; este sentinela negativo
 * (chegou ao processo filho como `null` no `close`) sinaliza "não rodou".
 * `ok` nunca é `true` nesses casos e `inconclusive` já agrega o motivo.
 */
const NO_EXIT = -1;

/** Um check não roda => `onCheck` recebe `exitCode: NO_EXIT`. */
interface CheckOutcome {
  exitCode: number;
  ok: boolean;
  inconclusive: boolean;
  durationMs: number;
  tail: string;
}

/**
 * Tokeniza uma linha de comando em argv, SEM passar por shell. Necessário
 * porque `verify[].cmd` é config de usuário e `spawn` exige `shell:false`.
 * Regras (subconjunto POSIX suficiente para `node -e "..."`, `npm test`,
 * `npx tsc ...` etc.): espaços separam argumentos; `"..."` agrupa com `\"`
 * e `\\` como escape interno; `'...'` agrupa literal (sem escape); `\x` fora
 * de aspas escapa o próximo caractere. Qualquer outra coisa é literal.
 */
function tokenize(cmd: string): string[] {
  const args: string[] = [];
  let cur = '';
  let inArg = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (inArg) {
        args.push(cur);
        cur = '';
        inArg = false;
      }
      i += 1;
      continue;
    }
    inArg = true;
    if (ch === "'") {
      i += 1;
      while (i < cmd.length && cmd[i] !== "'") {
        cur += cmd[i];
        i += 1;
      }
      i += 1; // fecha a aspa
    } else if (ch === '"') {
      i += 1;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === '\\' && i + 1 < cmd.length && (cmd[i + 1] === '"' || cmd[i + 1] === '\\')) {
          cur += cmd[i + 1];
          i += 2;
        } else {
          cur += cmd[i];
          i += 1;
        }
      }
      i += 1; // fecha a aspa
    } else if (ch === '\\') {
      if (i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i += 2;
      } else {
        i += 1;
      }
    } else {
      cur += ch;
      i += 1;
    }
  }
  if (inArg) args.push(cur);
  return args;
}

/**
 * Coletor de output com janela deslizante: guarda apenas os ULTIMOS `cap`
 * bytes do fluxo (stdout+stderr combinados). É o que materializa o teto de
 * 64 KiB por check sem acumular o processo inteiro na heap (um `npm test`
 * verboso gera MB).
 */
class TailCollector {
  private segs: string[] = [];
  private bytes = 0;
  private readonly cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  push(buf: Buffer): void {
    let seg = buf.toString('utf8');
    // Segmento sozinho maior que o cap: guarda só o rabo dele.
    if (Buffer.byteLength(seg, 'utf8') > this.cap) {
      seg = seg.slice(-this.cap);
    }
    this.segs.push(seg);
    this.bytes += Buffer.byteLength(seg, 'utf8');
    while (this.bytes > this.cap && this.segs.length > 0) {
      const first = this.segs.shift();
      if (first === undefined) break;
      this.bytes -= Buffer.byteLength(first, 'utf8');
    }
  }

  text(): string {
    return this.segs.join('');
  }
}

/** Últimas `n` linhas de um texto (split por `\n`). */
function lastLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

/**
 * Roda UM `verify[].cmd` no workspace, com `spawn` + `shell:false`, matando o
 * GRUPO de processos no timeout. Nunca lança: bastou o comando não ter exit
 * normal para virar `inconclusive` com `NO_EXIT` (§17.1 — o oráculo não decidiu).
 */
async function runCheck(opts: {
  cmd: string;
  cwd: string;
  expected: number;
  timeoutMs: number;
}): Promise<CheckOutcome> {
  const argv = tokenize(opts.cmd);
  const started = Date.now();

  return await new Promise<CheckOutcome>((resolve) => {
    const child = spawn(argv[0] ?? '', argv.slice(1), {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // grupo próprio => `kill(-pid)` derruba a árvore inteira
      // shell:false (default) — NUNCA true: o cmd vem de config do usuário.
    });

    const tail = new TailCollector(MAX_TAIL_BYTES);
    let timedOut = false;
    let spawnFailed = false;

    // Ambos os pipes drenados desde o primeiro byte (regra 2 do spawn.ts):
    // um pipe de 64 KiB cheio bloqueia o filho para sempre.
    child.stdout?.on('data', (buf: Buffer) => tail.push(buf));
    child.stderr?.on('data', (buf: Buffer) => tail.push(buf));

    // Parede de tempo do CHECK — NÃO unref(): precisa disparar mesmo com o
    // filho mudo (um verificação pendurada não pode segurar a run para sempre).
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid as number), 'SIGTERM'); // grupo inteiro
      } catch {
        /* o grupo já morreu */
      }
    }, opts.timeoutMs);

    // `error` para spawn que falha (binário ausente, permissão negada). Um
    // comando que não existe é um oráculo que não rodou, não um "não passou".
    child.on('error', () => {
      spawnFailed = true;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        try {
          process.kill(-(child.pid as number), 'SIGKILL'); // graça esgotada
        } catch {
          /* ok */
        }
      }
      const durationMs = Date.now() - started;
      const inconclusive = timedOut || spawnFailed || code === null;
      const exitCode = code ?? NO_EXIT;
      const ok = !inconclusive && exitCode === opts.expected;
      const text = tail.text();
      const tailText = lastLines(text, ok ? TAIL_LINES_PASS : TAIL_LINES_FAIL);
      resolve({ exitCode, ok, inconclusive, durationMs, tail: tailText });
    });
  });
}

// ---------------------------------------------------------------------------
// VERIFICADOR v2 (IMPL-039). A lógica de checagem/pontuação/hash é PURA e mora
// em `guard.ts`; aqui só se orquestra: snapshot do seed → (agente) → snapshot
// pós → rebuild → checks → nota. O glob v1 (`*` só no fim, `*.test.ts`
// literal) foi trocado pela semântica gitignore de `guard.ts`.
// ---------------------------------------------------------------------------

/** Lockfile restaurado ao seed antes do rebuild, quando a tarefa não diz. */
const DEFAULT_REBUILD_LOCKFILES = ['package-lock.json'];
/** O que o rebuild reconstrói (e por isso entra no hash de protegidos). */
const DEFAULT_REBUILD_PROTECT = ['node_modules/'];
const DEFAULT_REBUILD_CMD = 'npm ci';
const DEFAULT_REBUILD_TIMEOUT_MS = 600_000;

type GuardTask = Pick<AgentTaskSpec, 'forbiddenPaths' | 'rebuild'>;

/** Padrões cujo SHA-256 é comparado com o seed: `forbiddenPaths` + o que o rebuild cobre. */
export function protectedPatternsFor(task: GuardTask): string[] {
  const out = [...(task.forbiddenPaths ?? [])];
  if (task.rebuild) {
    out.push(...(task.rebuild.lockfiles ?? DEFAULT_REBUILD_LOCKFILES));
    out.push(...(task.rebuild.protect ?? DEFAULT_REBUILD_PROTECT));
  }
  return out;
}

/**
 * Snapshot dos protegidos NO SEED — chame depois do `prepare()` e ANTES do
 * agente acordar. `undefined` quando a tarefa não protege nada. Guarda os bytes
 * dos lockfiles para o rebuild restaurá-los ("npm ci do lockfile do seed").
 */
export function captureSeedGuard(workspaceDir: string, task: GuardTask): ProtectedSnapshot | undefined {
  const patterns = protectedPatternsFor(task);
  if (patterns.length === 0) return undefined;
  const keepContent = task.rebuild ? task.rebuild.lockfiles ?? DEFAULT_REBUILD_LOCKFILES : [];
  return snapshotProtected(workspaceDir, patterns, { keepContent });
}

/**
 * Roda todo o oráculo: monta `OracleResult` a partir de `verify[]`,
 * `forbiddenPaths`, `diffFiles` e (v2) do snapshot do seed.
 *
 * Qualquer ausência de AÇÚCAR ou de invariante aqui vira veredito errado nas
 * duas pontas: "agente ruim disfarçado de bom" (cheque que não rodou contado
 * como falha, ou score maior) e "agente bom reprovado" (violação fantasma).
 *
 * Contrato das regras (ver JSDoc do arquivo):
 *  - ordem dos checks SEMPRE a da lista; `label` default `verify #<i>`.
 *  - `expectExit` default 0; `weight` default 1; `timeoutMs` por check, senão
 *    `defaultTimeoutMs` (60_000); `kind` default `fail_to_pass`.
 *  - `score` = `scoreChecks` (F2P×P2P): Σ(ok·weight)/Σ(weight) dos F2P; P2P
 *    quebrado ⇒ 0; sem checks, `0`. Violação ⇒ `score` 0 (reward 0).
 *  - `violations` = caminhos do diff (novo OU origem de rename) que casam
 *    `forbiddenPaths` + protegidos cujo SHA-256 mudou vs o seed (inclui
 *    arquivos ignorados pelo git) + achados dos detectores em modo `fail`.
 *  - o snapshot pós é tirado ANTES do rebuild e dos checks (os checks podem
 *    escrever arquivos; o que conta é o estado que o AGENTE deixou).
 *  - `rebuild`: lockfiles voltam ao seed, `cmd` roda; falhou ⇒ checks NÃO
 *    rodam (nunca contra dependências sujas) e o oráculo é `inconclusive`.
 *  - `inconclusive` = algum check não rodou (timeout, spawn error, rebuild).
 *  - `onCheck` é chamado ao fim de cada check, na ordem, com o exit code real.
 */
export async function runOracle(opts: {
  workspaceDir: string;
  verify: {
    label?: string;
    cmd: string;
    expectExit?: number;
    timeoutMs?: number;
    weight?: number;
    kind?: VerifyKind;
  }[];
  forbiddenPaths?: string[];
  diffFiles?: { path: string; oldPath?: string; status?: string }[];
  /** Snapshot dos protegidos no seed (`captureSeedGuard`). Sem ele, só o diff é checado. */
  seedSnapshot?: ProtectedSnapshot;
  rebuild?: AgentTaskSpec['rebuild'];
  /** Default `'warn'`. */
  detectors?: AgentTaskSpec['detectors'];
  /** Diff unificado do agente (para os detectores estáticos). */
  diff?: string;
  defaultTimeoutMs?: number;
  onCheck?: (c: { label: string; ok: boolean; exitCode: number }) => void;
}): Promise<OracleResult> {
  const defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const diffFiles = opts.diffFiles ?? [];

  // --- 1. Barreiras determinísticas, sobre o estado que o AGENTE deixou.
  const violations = new Set(diffViolations(diffFiles, opts.forbiddenPaths ?? []));
  let protectedChanges: OracleResult['protectedChanges'];
  if (opts.seedSnapshot) {
    const post = snapshotProtected(opts.workspaceDir, opts.seedSnapshot.patterns);
    protectedChanges = diffProtected(opts.seedSnapshot, post, diffFiles);
    for (const c of protectedChanges) violations.add(c.path);
  }
  const detectorMode = opts.detectors ?? 'warn';
  const findings = detectorMode === 'off' ? [] : detectSuspicious({ diff: opts.diff, nameStatus: diffFiles });
  if (detectorMode === 'fail') for (const f of findings) violations.add(f.path);

  // --- 2. Rebuild de dependências a partir do lockfile do seed.
  let rebuild: OracleResult['rebuild'];
  if (opts.rebuild) {
    const restored = opts.seedSnapshot
      ? restoreFiles(opts.workspaceDir, opts.seedSnapshot, opts.rebuild.lockfiles ?? DEFAULT_REBUILD_LOCKFILES)
      : [];
    const cmd = opts.rebuild.cmd ?? DEFAULT_REBUILD_CMD;
    const out = await runCheck({
      cmd,
      cwd: opts.workspaceDir,
      expected: 0,
      timeoutMs: opts.rebuild.timeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS,
    });
    rebuild = { cmd, exitCode: out.exitCode, ok: out.ok, durationMs: out.durationMs, tail: out.tail, restored };
  }
  const rebuildFailed = rebuild !== undefined && !rebuild.ok;

  // --- 3. Checks, na ordem da lista.
  const checks: OracleResult['checks'] = [];
  const scored: ScoredCheck[] = [];
  let inconclusive = rebuildFailed;

  for (let i = 0; i < opts.verify.length; i += 1) {
    const v = opts.verify[i];
    const label = v.label ?? `verify #${i + 1}`;
    const expected = v.expectExit ?? 0;
    const weight = v.weight ?? 1;
    const timeoutMs = v.timeoutMs ?? defaultTimeout;
    const kind = v.kind;

    const out: CheckOutcome = rebuildFailed
      ? { exitCode: NO_EXIT, ok: false, inconclusive: true, durationMs: 0, tail: '' }
      : await runCheck({ cmd: v.cmd, cwd: opts.workspaceDir, expected, timeoutMs });

    if (out.inconclusive) inconclusive = true;
    scored.push({ ok: out.ok, weight, kind, inconclusive: out.inconclusive });

    checks.push({
      label,
      cmd: v.cmd,
      exitCode: out.exitCode,
      expected,
      ok: out.ok,
      weight,
      durationMs: out.durationMs,
      tail: out.tail,
      ...(kind ? { kind } : {}),
      ...(rebuildFailed ? { skipped: true } : {}),
    });

    if (!rebuildFailed) opts.onCheck?.({ label, ok: out.ok, exitCode: out.exitCode });
  }

  // --- 4. Nota: F2P×P2P; tocar protegido = reward 0.
  const s = scoreChecks(scored);
  const violationList = [...violations];
  const score = violationList.length > 0 ? 0 : s.score;

  return {
    checks,
    score,
    violations: violationList,
    inconclusive,
    rawScore: s.rawScore,
    f2p: s.f2p,
    p2p: s.p2p,
    ...(protectedChanges ? { protectedChanges } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...(rebuild ? { rebuild } : {}),
  };
}
