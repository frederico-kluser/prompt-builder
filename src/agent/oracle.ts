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
import type { OracleResult } from './types.js';

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

/**
 * `forbiddenPath` casa com um caminho normalizado.
 *
 * A regra de match é um "glob simples", deliberadamente pequeno (§6.1 do plano;
 * os padrões vêm do autor da tarefa e precisam ser previsíveis para quem lê o
 * diff):
 *  - padrão que termina em `*` => casa por PREFIXO (o `*` é removido e testamos
 *    `path.startsWith(prefix)`) — ex.: `test/*` casa `test/a.ts`;
 *  - padrão que termina em `/` => também casa por PREFIXO (é um diretório) —
 *    ex.: `test/` casa `test/a.ts`;
 *  - caso contrário => igualdade EXATA, com `*` no meio tratado como LITERAL.
 * Separadores são normalizados para `/` dos dois lados antes de comparar.
 *
 * ⚠️ Note a consequência da regra "`*` no meio = literal": um padrão como
 * `*.test.ts` (estrela no INÍCIO) NÃO faz wildcard — só casaria um arquivo
 * literalmente chamado `*.test.ts`. Padrões assim devem ser escritos com o
 * prefixo explícito (`test/`, `src/` etc.), não como glob de sufixo.
 */
function matchesForbidden(filePath: string, pattern: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');
  if (pat.endsWith('*')) {
    return p.startsWith(pat.slice(0, -1));
  }
  if (pat.endsWith('/')) {
    return p.startsWith(pat);
  }
  return p === pat;
}

/**
 * Roda todo o oráculo: monta `OracleResult` a partir de `verify[]`,
 * `forbiddenPaths` e `diffFiles`.
 *
 * Qualquer ausência de AÇÚCAR ou de invariante aqui vira veredito errado nas
 * duas pontas: "agente ruim disfarçado de bom" (cheque que não rodou contado
 * como falha, ou score maior) e "agente bom reprovado" (violação fantasma).
 *
 * Contrato das regras (ver JSDoc do arquivo):
 *  - ordem dos checks SEMPRE a da lista; `label` default `verify #<i>`.
 *  - `expectExit` default 0; `weight` default 1; `timeoutMs` por check, senão
 *    `defaultTimeoutMs` (60_000).
 *  - `score = Σ(ok·weight) / Σ(weight)`; sem checks, `0`.
 *  - `violations` = caminhos de `diffFiles` que casam algum `forbiddenPath`.
 *  - `inconclusive` = algum check não rodou (timeout ou spawn error).
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
  }[];
  forbiddenPaths?: string[];
  diffFiles?: { path: string }[];
  defaultTimeoutMs?: number;
  onCheck?: (c: { label: string; ok: boolean; exitCode: number }) => void;
}): Promise<OracleResult> {
  const defaultTimeout = opts.defaultTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const checks: OracleResult['checks'] = [];
  let sumOk = 0;
  let sumWeight = 0;
  let inconclusive = false;

  for (let i = 0; i < opts.verify.length; i += 1) {
    const v = opts.verify[i];
    const label = v.label ?? `verify #${i + 1}`;
    const expected = v.expectExit ?? 0;
    const weight = v.weight ?? 1;
    const timeoutMs = v.timeoutMs ?? defaultTimeout;

    const out = await runCheck({
      cmd: v.cmd,
      cwd: opts.workspaceDir,
      expected,
      timeoutMs,
    });

    if (out.inconclusive) inconclusive = true;
    if (out.ok) sumOk += weight;
    sumWeight += weight;

    checks.push({
      label,
      cmd: v.cmd,
      exitCode: out.exitCode,
      expected,
      ok: out.ok,
      weight,
      durationMs: out.durationMs,
      tail: out.tail,
    });

    opts.onCheck?.({ label, ok: out.ok, exitCode: out.exitCode });
  }

  const score = sumWeight > 0 ? sumOk / sumWeight : 0;

  const forbidden = opts.forbiddenPaths ?? [];
  const violations = (opts.diffFiles ?? [])
    .map((f) => f.path)
    .filter((p) => forbidden.some((pat) => matchesForbidden(p, pat)));

  return { checks, score, violations, inconclusive };
}