// ----------------------------------------------------------------------------
// `spawnAgent` — o plumbing de PROCESSO do modo agente.
//
// Este módulo é a ÚNICA ponte entre o motor e o executável real do executor.
// Ele cuida de tudo o que é "vitória-suja": spawn SEMPRE (nunca exec/execFile),
// `shell` SEMPRE desligado, AMBOS os pipes drenados desde o primeiro byte, stdin
// fechado depois de escrito, kill de ÁRVORE de processos e os três telhados de
// contenção (parede de tempo, teto de bytes e `shouldStop`).
//
// Nada aqui decide SEMÂNTICA de controle: se `opts.signal` abortar, matamos a
// árvore com razão 'cancelled' e resolvemos o promise — NÃO lançamos
// RunCancelled. Quem traduz cancelamento em exceção de domínio é o chamador
// (o runner), via `opts.signal`. Este é plumbing de baixo nível e é o chamador
// que carrega a semântica de controle.
// ----------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import type { AgentStopReason } from './types.js';

/** Resultado agregado de UMA execução de processo. O chamador junta isso ao
 * `ExecutionRecord.process` (§C.1) — bytes contados aqui e NÃO no splitter, para
 * que o teto de `maxOutputBytes` seja medido na fonte, antes de o splitter
 * normalizar/descartar. */
export interface SpawnAgentResult {
  /** Exit code do processo (null quando foi morto por sinal/representante). */
  exitCode: number | null;
  /** Sinal que encerrou o processo (null no exit normal). */
  signal: NodeJS.Signals | null;
  /** Por que a execução terminou — ver `AgentStopReason`. */
  stopReason: AgentStopReason;
  /** Bytes brutos lidos de stdout (independente do que o splitter fez). */
  stdoutBytes: number;
  /** Bytes brutos lidos de stderr (independente do que o splitter fez). */
  stderrBytes: number;
}

export interface SpawnAgentOpts {
  /** Caminho absoluto do binário executável. */
  bin: string;
  /** Args do processo, sem o próprio bin. */
  argv: string[];
  /** cwd do processo filho. */
  cwd: string;
  /** env EXPLÍCITO (sala limpa). NUNCA `...process.env` — §11.5. */
  env: Record<string, string>;
  /** Bytes escritos no stdin, seguidos de fechamento (EOF). */
  stdin: string;
  /** Parede de tempo. Estourado → kill de árvore com razão 'timeout'. */
  timeoutMs: number;
  /** Teto de stdout+stderr. Estourado → kill com razão 'maxOutput'. */
  maxOutputBytes: number;
  /** Alimenta o splitter JSONL. Chamado com cada chunk bruto de stdout. */
  onStdoutChunk(buf: Buffer): void;
  /** Alimenta o narrador de narração. Chamado com cada chunk bruto de stderr. */
  onStderrChunk(buf: Buffer): void;
  /** Cancelamento da run. Ao abortar → kill de árvore com razão 'cancelled'. */
  signal?: AbortSignal;
  /** Consultada a cada chunk de stdout. Retorna ≠ null → kill com essa razão
   * (teto de custo/turnos). `stderr` NÃO dispara isto: é narração, não trabalho. */
  shouldStop?: () => AgentStopReason | null;
  /**
   * Opcional — gancho disparado UMA vez dentro do guard `killTree` (junto do
   * kill do grupo), na razão do kill. Pensado para limpeza EXTERNA do recurso
   * do processo: em modo container, aponta para `killContainer(<nome>)`.
   * FIRE-AND-FORGET: não deve ser `await`ado dentro do callback, e erros não
   * devem derrubar o kill.
   * Aditivo/genérico — não altera a semântica existente de `spawnAgent`.
   */
  onKill?: (reason: AgentStopReason) => void;
  /**
   * Opcional — gatilho EXTERNO de parada, empurrado (não consultado): recebe a
   * função que mata a árvore com uma razão e pode devolver o "desinscrever",
   * chamado quando o processo encerra. Pensado para o freio do proxy de custo
   * (IMPL-035): a recusa `budget_exhausted` mata o agente NA HORA com 'maxCost',
   * sem esperar o próximo chunk de stdout (o `shouldStop` só é consultado neles,
   * e um agente em backoff de retry fica mudo).
   */
  onExternalStop?: (stop: (reason: AgentStopReason) => void) => (() => void) | void;
}

/**
 * Spawn de processo com kill de árvore e contenção de recursos.
 *
 * CADA regra abaixo protege um modo de falha específico — o porquê importa:
 *
 * 1. **`spawn` + `shell: false` (implícito) + env explícito.** O prompt testado
 *    é config do usuário. Com `shell: true`, aspas/`$(...)`/`;` no argv virariam
 *    INJEÇÃO DE COMANDO. `exec`/`execFile` também passam por shell. `spawn` sem
 *    shell passa o argv como lista literal, e o env é dado íntegro por nós —
 *    nunca `...process.env`, senão o ambiente do dev vaza para o experimento
 *    (e segredos do host entram na sala limpa).
 *
 * 2. **AMBOS os pipes são consumidos desde o primeiro byte.** O pipe do OS tem
 *    ~64 KiB de buffer. Se um dos lados (stdout OU stderr) não for drenado, o
 *    filho eventualmente bloqueia em `write(2)` e o processo "trava" para
 *    sempre — sem sinal, sem timeout que o alcance, só um wait infinito. Por
 *    isso os `'data'` handlers existem ANTES de qualquer coisa que possa demorar.
 *
 * 3. **`stdin.on('error')` + `stdin.end(stdin)`.** O `end` escreve E fecha
 *    (EOF). Se o filho já saiu, o `end` dispara EPIPE — que VIROU um `'error'`
 *    não tratado no stream, derrubaria este promise. Se não escrevêssemos/fechássemos,
 *    o filho que espera stdin ficaria esperando entrada para sempre.
 *
 * 4. **Kill de ÁRVORE + graça de 5 s.** O filho nasce `detached: true`, ou seja,
 *    num novo GRUPO de processos — `process.kill(-child.pid, SIGTERM)` atinge o
 *    grupo inteiro (`-` = o grupo), não só o pid. Matar só o pid deixaria netos
 *    órfãos rodando (shells `&&`, pipelines…), a custo de quem paga a run.
 *    Depois de 5 s de graça o `SIGKILL` (imparável) fecha a conta; esse timer de
 *    graça é `unref()` — se o processo já morreu e nada mais segura o loop,
 *    não queremos que o processo Node fique vivo 5 s à toa. A flag `killed`
 *    garante que `killTree` dispara UMA vez apenas (várias razões podem
 *    concorrer: timeout + bytes + abort no mesmo instante).
 *
 *    ⚠️ O timer de TIMEOUT, ao contrário, NÃO é `unref()`. Precisamos que ele
 *    dispare mesmo quando o filho está mudo e nenhum I/O mantém o loop vivo:
 *    se fosse `unref()`, uma execução pendurada (nada escreve, nada fecha)
 *    poderia simplesmente nunca ser interrompida. O promise resolve no `close`;
 *    o timer não-unref é o que garante que um filho travado não segure a run.
 *
 * 5. **Concorrência de razões de kill.** `timeoutMs` → 'timeout'; abort de
 *    `opts.signal` → 'cancelled'; `shouldStop()` (teto de custo/turnos) →
 *    a razão retornada; `stdoutBytes + stderrBytes > maxOutputBytes` →
 *    'maxOutput'. Quem chegar primeiro vence (flag `killed`); `stopReason` é
 *    a razão DO VENCEDOR, jogando fora as perdedoras.
 *
 * 6. **`stopReason` final.** Se matamos, é a razão do kill. Senão, `exitCode === 0`
 *    → 'completed'; qualquer outro exit (exit code não-zero morto por sinal
 *    próprio) → 'error'. Um processo que cai sozinho por bug é 'error', não
 *    'completed' — o veredito não pode fingir sucesso.
 *
 * 7. **Resolve em `close`, rejeita em `error`.** `'close'` é o ÚNICO evento que
 *    garante stdio completamente fechado (drenado). `'error'` (spawn que falhou —
 *    binário ausente, permissão negada) rejeita o promise e limpa timers +
 *    listener de abort antes, para não vazar handles.
 *
 * CONTROLE: este módulo NUNCA lança `RunCancelled`. Abort de `opts.signal` vira
 * `killTree('cancelled')` e o promise RESOLVE — o licitante decide se isso é
 * exceção ou resultado. Matar com razão própria é diferente de "lançar por
 * dentro": garante que o processo foi de fato encerrado antes de o controle
 * voltar ao chamador.
 */
export async function spawnAgent(opts: SpawnAgentOpts): Promise<SpawnAgentResult> {
  const child = spawn(opts.bin, opts.argv, {
    cwd: opts.cwd,
    env: opts.env, // explícito; NUNCA {...process.env} (sala limpa)
    detached: true, // grupo próprio ⇒ kill(-pid) mata a árvore inteira
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell: false (default) — NUNCA true: o prompt vem de config do usuário
  });

  let stopReason: AgentStopReason = 'completed';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let killed = false;

  /** Mata o GRUPO de processos do filho. Dispara uma única vez (flag `killed`):
   * SIGTERM imediato, graça de 5 s, SIGKILL. Razões concorrentes: quem chegar
   * primeiro fixa `stopReason` e dá como feita. */
  const killTree = (reason: AgentStopReason): void => {
    if (killed) return;
    killed = true;
    stopReason = reason;
    try {
      process.kill(-child.pid!, 'SIGTERM'); // `-` = o grupo (detached: true)
    } catch {
      /* o grupo já morreu (exit espontâneo entre o check e o kill) */
    }
    // Gancho de limpeza EXTERNA do recurso (ex.: killContainer em modo
    // container). Dispara UMA vez, junto do killTree, sem bloquear: o chamador
    // cuida de não fazer await e de engolir erros. `void` descarta a promessa.
    const onKill = opts.onKill;
    if (onKill) {
      try {
        void Promise.resolve(onKill(reason));
      } catch {
        /* nunca derruba o kill por um gancho externo */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL'); // imparável, fecha a conta
      } catch {
        /* ok — o processo encerrou na graça */
      }
    }, 5_000).unref(); // graça: se nada segura o loop, não segurem o Node 5 s
  };

  // Parede de tempo — NÃO unref() (ver regra 4 no JSDoc): precisa disparar mesmo
  // com o filho mudo, senão uma execução pendurada segura a run para sempre.
  const timer = setTimeout(() => killTree('timeout'), opts.timeoutMs);

  const onAbort = (): void => killTree('cancelled');
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // Gatilho externo (freio de custo): pode disparar já na inscrição (recusa
  // anterior ao spawn) — o killTree é idempotente e o close resolve normalmente.
  let offExternal: (() => void) | void = undefined;
  try {
    offExternal = opts.onExternalStop?.((reason) => killTree(reason));
  } catch {
    /* um gatilho externo quebrado nunca derruba a execução */
  }
  const unsubscribeExternal = (): void => {
    try {
      if (typeof offExternal === 'function') offExternal();
    } catch {
      /* idem */
    }
  };

  // Regra 2: AMBOS os pipes consumidos SEMPRE e desde o primeiro byte. Ignorar
  // um (~64 KiB de buffer de OS) bloqueia o filho escrevendo nele.
  child.stdout.on('data', (buf: Buffer) => {
    stdoutBytes += buf.length;
    opts.onStdoutChunk(buf);
    if (stdoutBytes + stderrBytes > opts.maxOutputBytes) killTree('maxOutput');
    const stop = opts.shouldStop?.();
    if (stop) killTree(stop);
  });
  child.stderr.on('data', (buf: Buffer) => {
    stderrBytes += buf.length;
    opts.onStderrChunk(buf);
    if (stdoutBytes + stderrBytes > opts.maxOutputBytes) killTree('maxOutput');
  });

  // Regra 3: EPIPE se o filho já saiu é esperado — não derruba. Depois, end()
  // escreve E fecha (EOF).
  child.stdin.on('error', () => undefined);
  child.stdin.end(opts.stdin);

  return await new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      unsubscribeExternal();
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      unsubscribeExternal();
      resolve({
        exitCode: code,
        signal: sig,
        stopReason: killed ? stopReason : code === 0 ? 'completed' : 'error',
        stdoutBytes,
        stderrBytes,
      });
    });
  });
}