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
//    shell (§11.2 do plano). ONDE o argv roda é do `CommandRunner` (IMPL-038):
//    sandbox verificador em modo container, host explícito com env mínimo no
//    modo host. Este módulo decide QUAIS checks e a pontuação, não o lugar.
//
// 2. **Exit code como régua, na ordem da lista.** `ok = exitCode === expected`;
//    `score` é a soma ponderada dos `ok` sobre a soma dos pesos. Ordem SEMPRE a
//    da lista — o oráculo precisa ser reproduzível entre execuções, e a ordem
//    dos checks faz parte do contrato.
//
// 3. **Check que não terminou = `ok:false` + o MOTIVO (`notRun`).** O check
//    fica no denominador do `score` e o motivo segue junto, porque ele decide
//    de quem é a culpa (IMPL-033, R-14a DEC-1/DEC-2):
//    - `timeout`/`signal` — o comando RODOU e o código sob teste pendurou ou
//      morreu. Isso é desfecho do agente sob um teto da tarefa, igual para
//      todos (mesma lógica do corte por limite): conta como check falho.
//      Tirar a execução do denominador aqui premiaria quem quebra a suíte.
//    - `spawn` — o comando nem começou (ausente, sem permissão). Pode ser
//      defeito do AMBIENTE (igual para todos) ou obra do agente (apagou o
//      script). Quem separa é a CÉLULA, não este módulo: se o check rodou em
//      alguma execução da etapa, o ambiente serve e a falha é do agente; se
//      não rodou em nenhuma, a etapa é inválida para TODOS (`oracleCellDefect`).
//    `inconclusive` continua sendo o resumo "algum check não terminou".
//
// ⚠️ ESPELHO CLIENT-SIDE: NÃO existe. O navegador não tem `child_process` —
// rodar oráculo na SPA é impossível por construção (ver nota em `types.ts`).
// ----------------------------------------------------------------------------
import type { AgentTaskSpec, OracleNotRun, OracleResult } from './types.js';
import { hostCommandRunner, type CommandRunner } from './sandboxExec.js';
import {
  detectSuspicious,
  diffProtected,
  diffViolations,
  purgeToolCaches,
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
  /** Por que não houve exit normal (ausente = houve): spawn, timeout, sinal ou rebuild falho. */
  notRun?: OracleNotRun;
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
 * Roda UM `verify[].cmd` pelo `runner` (IMPL-038: ONDE roda é do runner — o
 * sandbox verificador em modo container, o host EXPLÍCITO com env mínimo no
 * modo host). Nunca lança: bastou o comando não ter exit normal para virar
 * `inconclusive` com `NO_EXIT` (§17.1 — o oráculo não decidiu).
 */
async function runCheck(opts: {
  cmd: string;
  cwd: string;
  expected: number;
  timeoutMs: number;
  runner: CommandRunner;
}): Promise<CheckOutcome> {
  const argv = tokenize(opts.cmd);
  const started = Date.now();
  const tail = new TailCollector(MAX_TAIL_BYTES);
  // Ambos os pipes drenados desde o primeiro byte (regra 2 do spawn.ts); a
  // parede de tempo do CHECK é do runner (kill do grupo / do container).
  const r = await opts.runner.exec({
    argv,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    onOutput: (buf) => tail.push(buf),
  });
  const durationMs = Date.now() - started;
  // Um comando que não existe é um oráculo que não rodou, não um "não passou".
  // Ordem importa (IMPL-033): spawn que falha não chega a pendurar; o nosso
  // timeout mata por sinal, então `timeout` vem antes de `signal`.
  const notRun: OracleNotRun | undefined = r.spawnFailed
    ? 'spawn'
    : r.timedOut
      ? 'timeout'
      : r.code === null
        ? 'signal'
        : undefined;
  const inconclusive = notRun !== undefined;
  // Spawn que falha fecha com o errno negativo (ex.: -2); normaliza.
  const exitCode = inconclusive ? NO_EXIT : (r.code ?? NO_EXIT);
  const ok = !inconclusive && exitCode === opts.expected;
  const text = tail.text();
  const tailText = lastLines(text, ok ? TAIL_LINES_PASS : TAIL_LINES_FAIL);
  return { exitCode, ok, inconclusive, ...(notRun ? { notRun } : {}), durationMs, tail: tailText };
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
/**
 * `--ignore-scripts`: o `npm ci` default roda `preinstall`/`postinstall`/
 * `prepare` do pacote RAIZ — e o `package.json` é do agente. Um `postinstall`
 * plantado rodaria DEPOIS do snapshot pós e adulteraria `node_modules` antes dos
 * checks, sem violação nenhuma (confirmado com npm real). `--no-audit
 * --no-fund`: o rebuild não precisa ir ao registry por nada além dos pacotes.
 * Tarefa cujas deps exigem install script declara `rebuild.cmd` e protege o
 * `package.json` em `forbiddenPaths`.
 */
export const DEFAULT_REBUILD_CMD = 'npm ci --ignore-scripts --no-audit --no-fund';
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
export async function captureSeedGuard(workspaceDir: string, task: GuardTask): Promise<ProtectedSnapshot | undefined> {
  const patterns = protectedPatternsFor(task);
  if (patterns.length === 0) return undefined;
  const keepContent = task.rebuild ? task.rebuild.lockfiles ?? DEFAULT_REBUILD_LOCKFILES : [];
  return await snapshotProtected(workspaceDir, patterns, { keepContent });
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
 *  - snapshot truncado (teto de entradas) no seed OU no pós ⇒ o hash NÃO é
 *    comparado (`guardTruncated`, oráculo `inconclusive`); o diff segue valendo.
 *  - caches de ferramenta (`__pycache__`, `*.pyc`, `node_modules/.vite`…) são
 *    APAGADOS antes do rebuild/checks: o hash os ignora, então não podem
 *    sobreviver até o runner carregá-los.
 *  - `rebuild`: lockfiles voltam ao seed, `cmd` roda; falhou (ou a restauração
 *    falhou) ⇒ checks NÃO rodam (nunca contra dependências sujas, `notRun:
 *    'rebuild'`) e o oráculo é `inconclusive` — quem decide o veredito trata
 *    como infra (sem veredito, IMPL-036), salvo violação.
 *  - check que não terminou (`checks[].notRun`: spawn, timeout, sinal) conta
 *    como `ok:false` no `score` (IMPL-033).
 *  - P2P que trava (timeout) ou morre por sinal = QUEBRADO (`scoreChecks`).
 *  - `inconclusive` = algum check não rodou (timeout, spawn error, rebuild) ou
 *    o hash dos protegidos foi truncado.
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
  /**
   * ONDE os checks rodam (IMPL-038). Default: host EXPLÍCITO, sem isolamento,
   * com env mínimo. O `runAgentStage` em modo container passa o sandbox
   * verificador montado numa cópia do estado final do agente.
   */
  runner?: CommandRunner;
  /**
   * Onde roda o `rebuild` (precisa de rede para o registry). Default: `runner`.
   * Em modo container o `runAgentStage` passa um sandbox COM rede montado na
   * mesma cópia (nunca o host).
   */
  rebuildRunner?: CommandRunner;
  /**
   * Diretório com o estado que o AGENTE deixou, para o hash dos protegidos.
   * Default `workspaceDir`. Com o verificador numa cópia com os `files[]`
   * PRÍSTINOS reescritos (IMPL-038), o hash tem de olhar o workspace do agente
   * — na cópia a adulteração já foi desfeita e passaria despercebida.
   */
  guardDir?: string;
}): Promise<OracleResult> {
  const defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const runner = opts.runner ?? hostCommandRunner();
  const rebuildRunner = opts.rebuildRunner ?? runner;
  const diffFiles = opts.diffFiles ?? [];

  // --- 1. Barreiras determinísticas, sobre o estado que o AGENTE deixou.
  const violations = new Set(diffViolations(diffFiles, opts.forbiddenPaths ?? []));
  let protectedChanges: OracleResult['protectedChanges'];
  let guardTruncated = false;
  if (opts.seedSnapshot) {
    const post = await snapshotProtected(opts.guardDir ?? opts.workspaceDir, opts.seedSnapshot.patterns);
    if (opts.seedSnapshot.truncated || post.truncated) {
      // Percurso cortado pelo teto: o ponto de corte se DESLOCA com qualquer
      // arquivo que o agente cria/apaga — comparar daria `added`/`deleted`
      // fantasma a um agente honesto (e cegaria o que ficou além do corte).
      guardTruncated = true;
    } else {
      protectedChanges = diffProtected(opts.seedSnapshot, post, diffFiles);
      for (const c of protectedChanges) violations.add(c.path);
    }
  }
  const detectorMode = opts.detectors ?? 'warn';
  const findings = detectorMode === 'off' ? [] : detectSuspicious({ diff: opts.diff, nameStatus: diffFiles });
  const detectorViolations: string[] = [];
  if (detectorMode === 'fail') {
    for (const f of findings) {
      if (!violations.has(f.path) && !detectorViolations.includes(f.path)) detectorViolations.push(f.path);
    }
    for (const p of detectorViolations) violations.add(p);
  }

  // --- 1b. Caches que o hash ignora não chegam aos checks (código sem hash).
  const purged = await purgeToolCaches(opts.workspaceDir);

  // --- 2. Rebuild de dependências a partir do lockfile do seed.
  let rebuild: OracleResult['rebuild'];
  if (opts.rebuild) {
    const cmd = opts.rebuild.cmd ?? DEFAULT_REBUILD_CMD;
    let restored: string[] = [];
    let restoreError: string | undefined;
    try {
      restored = opts.seedSnapshot
        ? restoreFiles(opts.workspaceDir, opts.seedSnapshot, opts.rebuild.lockfiles ?? DEFAULT_REBUILD_LOCKFILES)
        : [];
    } catch (err) {
      // Restauração falhou: rodar o rebuild sobre o lockfile do AGENTE seria
      // instalar deps sujas. Vira rebuild falho — as violações já detectadas
      // continuam valendo (a rep não cai no catch genérico e perde oracle.json).
      restoreError = err instanceof Error ? err.message : String(err);
    }
    if (restoreError !== undefined) {
      rebuild = { cmd, exitCode: NO_EXIT, ok: false, durationMs: 0, tail: `restauração do lockfile falhou: ${restoreError}`, restored };
    } else {
      const out = await runCheck({
        cmd,
        cwd: opts.workspaceDir,
        expected: 0,
        timeoutMs: opts.rebuild.timeoutMs ?? DEFAULT_REBUILD_TIMEOUT_MS,
        runner: rebuildRunner,
      });
      rebuild = { cmd, exitCode: out.exitCode, ok: out.ok, durationMs: out.durationMs, tail: out.tail, restored };
    }
  }
  const rebuildFailed = rebuild !== undefined && !rebuild.ok;

  // --- 3. Checks, na ordem da lista.
  const checks: OracleResult['checks'] = [];
  const scored: ScoredCheck[] = [];
  let inconclusive = rebuildFailed || guardTruncated;

  for (let i = 0; i < opts.verify.length; i += 1) {
    const v = opts.verify[i];
    const label = v.label ?? `verify #${i + 1}`;
    const expected = v.expectExit ?? 0;
    const weight = v.weight ?? 1;
    const timeoutMs = v.timeoutMs ?? defaultTimeout;
    const kind = v.kind;

    const out: CheckOutcome = rebuildFailed
      ? { exitCode: NO_EXIT, ok: false, inconclusive: true, notRun: 'rebuild', durationMs: 0, tail: '' }
      : await runCheck({ cmd: v.cmd, cwd: opts.workspaceDir, expected, timeoutMs, runner });

    if (out.inconclusive) inconclusive = true;
    scored.push({ ok: out.ok, weight, kind, inconclusive: out.inconclusive, ...(out.notRun ? { reason: out.notRun } : {}) });

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
      ...(out.notRun ? { notRun: out.notRun } : {}),
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
    ...(guardTruncated ? { guardTruncated: true } : {}),
    ...(detectorViolations.length > 0 ? { detectorViolations } : {}),
    ...(purged.length > 0 ? { purged } : {}),
    ...(findings.length > 0 ? { findings } : {}),
    ...(rebuild ? { rebuild } : {}),
  };
}
