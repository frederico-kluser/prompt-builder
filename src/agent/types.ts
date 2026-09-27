// ----------------------------------------------------------------------------
// Modo agente (Agent Arena) — TIPOS DE DOMÍNIO.
//
// Este diretório abriga todo o domínio NOVO do modo agente: a tarefa executável
// (`AgentTaskSpec`), a config do executor (`AgentRunnerConfig`), o registro de
// auditoria em disco (`ExecutionRecord`) e a trajetória normalizada.
//
// ⚠️ IMPORTANTE — o motor client-side (`web/src/engine/`) NÃO espelha o modo
// agente. Não é que seja *caro* portar para lá: é IMPOSSÍVEL. O navegador não
// tem `child_process`, não tem filesystem, não tem git e não pode spawnar um
// processo — e o modo agente é, na essência, "spawnar um executável num
// workspace isolado". A SPA estática da Vercel continua fazendo exatamente o
// que faz hoje: compare/variation/training de chat.
//
// NÃO "consertar" essa assimetria com um espelho em `web/src/engine/`: o
// módulo resultante não poderia funcionar. (Ler uma run de agente quando
// apontada para um backend local, isso sim, é seguro — os campos são aditivos.)
//
// Todos os imports daqui vêm de `../types.js` e são `import type` — só tipos,
// sem runtime. A troca é bidirecional com `src/types.ts` (que importa daqui via
// `import type`), formando um ciclo de TIPOS. Isso é esperado e aceitável:
// `import type` é apagado na compilação, então não existe ciclo de runtime.
// ----------------------------------------------------------------------------
import type { ReasoningLevel } from '../types.js';

/**
 * O que transforma uma etapa em tarefa executável. Tudo aqui descreve o MUNDO
 * em que o agente acorda — nunca o agente em si (isso é `AgentRunnerConfig`).
 * Separar os dois é o que permite rodar a MESMA tarefa com agentes diferentes.
 */
export interface AgentTaskSpec {
  /**
   * Repositório-semente. O agente sempre acorda dentro de um repositório git,
   * mesmo quando a tarefa é "escreva do zero" (aí é um `git init` com um commit
   * vazio). Motivo: o git é o que torna o ARTEFATO calculável — `diff seed..HEAD`
   * é uma definição exata de "o que este agente fez", sem heurística, sem
   * comparar árvores de arquivos na mão, e com um sha para citar no record.
   * Ausente => workspace vazio inicializado (`git init` + commit vazio).
   */
  repo?: {
    kind: 'git';
    /** Clonável (https/ssh) OU caminho local. Um dos dois. */
    url?: string;
    path?: string;
    /** Commit/tag/branch. EXIGIDO quando há repo: sem ref pinada não há reprodutibilidade. */
    ref: string;
    /** Clone raso — barato e suficiente; `false` quando a tarefa envolve histórico. */
    shallow?: boolean;
  };

  /**
   * Comandos rodados ANTES do agente acordar (npm ci, pip install, build).
   * NÃO contam como trabalho do agente e NÃO entram na trajetória julgada; se
   * contassem, "o agente que gastou 4 minutos instalando dependência" pareceria
   * mais laborioso que o que recebeu o ambiente pronto. Falha aqui = etapa
   * `error` para TODOS os contestants (é problema da tarefa, não de ninguém).
   */
  setup?: { cmd: string; timeoutMs?: number }[];

  /** Fixtures escritos no workspace depois do setup (entrada, casos de teste, mocks). */
  files?: { path: string; content: string }[];

  /**
   * ORÁCULO DETERMINÍSTICO. Comandos cujo exit code decide o veredito, rodados
   * DEPOIS do agente, sempre no mesmo workspace, sempre com a mesma ordem.
   * `expectExit` default 0. `weight` pondera quando há vários (default 1).
   *
   * Quando existe oráculo, ele MANDA. É a única parte do julgamento que não
   * depende de um LLM ter um bom dia.
   */
  verify?: {
    cmd: string;
    expectExit?: number;
    timeoutMs?: number;
    weight?: number;
    /** Rótulo curto p/ o dossiê e o CSV ("testes unitários", "typecheck", "lint"). */
    label?: string;
  }[];

  /**
   * Caminhos que o agente NÃO pode tocar. Violação => veredito 'nao' automático,
   * sem gastar juiz. Existe porque a forma mais barata de "passar no teste" é
   * editar o teste — é o reward hacking clássico deste domínio, e ele precisa de
   * uma barreira determinística, não de um pedido educado no prompt.
   * Globs simples (prefixo de caminho + `*`).
   */
  forbiddenPaths?: string[];

  /**
   * default false — ver o aviso em §12.2 do plano. `--no-context-files` (default)
   * também apaga o `AGENTS.md`/`CLAUDE.md` do repo-alvo, o que é certo por
   * padrão (o experimento controla o que o agente lê). `true` sinaliza que o
   * `AGENTS.md` faz parte do enunciado (ex.: "conserta o bug DESTE repo".
   * O dossiê registra qual foi o valor — leitor sem isso compara maçã com laranja.
   */
  contextFiles?: boolean;

  /**
   * Limites POR EXECUÇÃO. Este objeto é o CONTRATO DE CUSTO da tarefa: é dele
   * que a estimativa deriva o teto e é ele que o executor impõe matando o
   * processo. Sem isso, um agente em laço infinito gasta o orçamento inteiro
   * numa etapa e a run "termina" sem ter medido nada.
   */
  limits?: AgentLimits;
}

export interface AgentLimits {
  /** Turnos do agente (contados por evento `turn_start`). Default 30. */
  maxTurns?: number;
  /** Teto de gasto DESTA execução, em USD. Default: obrigatório em modo agente. */
  maxCostUsd?: number;
  /** Parede de tempo da execução inteira, ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Teto de bytes de stdout+stderr gravados. Default 8 MiB. Acima disso, mata. */
  maxOutputBytes?: number;
  /** Teto de bytes do diff considerado. Acima, o dossiê trunca com marca. Default 512 KiB. */
  maxDiffBytes?: number;
}

/**
 * Quem executa, com que modelo, sob que isolamento. Vive em RunConfigBase
 * (`config.agent`), porque é config DA RUN, não da etapa: a mesma tarefa
 * precisa rodar sob o mesmo executor para todos os contestants, senão o
 * experimento compara duas coisas ao mesmo tempo.
 */
export interface AgentRunnerConfig {
  /**
   * Qual adaptador. v1 implementa só 'pi'. O enum existe desde já para que o
   * ponto de extensão seja visível — e para que ninguém escreva `if (pi)` no
   * meio do orquestrador.
   */
  executor: 'pi';

  /** Versão EXIGIDA do executor. Divergência = run falha no pré-voo. */
  executorVersion: string;

  /**
   * Como o binário é obtido. 'system' usa o `pi` do PATH (rápido, mas o
   * ambiente do dev vaza para o experimento); 'isolated' instala a versão
   * pinada num prefixo temporário do run (reprodutível). Default 'isolated'.
   */
  install?: 'system' | 'isolated';

  /** Provider do agente. Default 'openrouter'. */
  provider?: string;

  /**
   * Como o prompt sob teste chega ao agente.
   * 'replace' => substitui o prompt de coding do executor INTEIRO.
   * 'append'  => soma ao prompt de coding.
   * 'none'    => não passa nada (usado no compare de MODELOS como agentes).
   *
   * Isto não é detalhe: em 'replace' você está testando "este texto é um bom
   * system prompt de agente?"; em 'append' você testa "esta instrução melhora
   * um agente que já sabe ser agente?". São perguntas diferentes e a run precisa
   * declarar qual está fazendo. Default: 'append'.
   */
  promptMode?: 'replace' | 'append' | 'none';

  /** Ferramentas liberadas (allowlist). Ausente = built-ins do executor. */
  tools?: string[];

  /**
   * Repetições por (contestant × cenário). Agente é ESTOCÁSTICO: a mesma tarefa
   * com o mesmo prompt dá resultados diferentes. Com 1 repetição, o veredito de
   * uma etapa é uma amostra de tamanho 1 — e a diferença entre dois contestants
   * pode ser inteiramente ruído. Default 1 (barato) com AVISO explícito no
   * relatório; recomendado 3 quando a decisão importa.
   */
  repetitions?: number;

  /**
   * Máximo de execuções de agente SIMULTÂNEAS neste processo.
   * ⚠️ Isto NÃO viola a regra "não ponha cap de concorrência local" do AGENTS.md.
   * Aquela regra fala do limitador global de `openrouter.ts`, que existe para
   * respeitar o RATE LIMIT DO PROVEDOR. Aqui o recurso escasso é a MÁQUINA
   * (cada execução é um processo Node + shells filhos + I/O de disco), e o
   * limitador global não enxerga essas chamadas, porque elas saem de dentro do
   * executor. São dois problemas distintos com duas soluções distintas.
   * Default: `min(4, os.cpus().length - 1)`.
   */
  maxParallel?: number;

  /** Limites default, herdados por toda `AgentTaskSpec` que não os declare. */
  limits?: AgentLimits;

  /** Isolamento do workspace. */
  isolation?: {
    /** 'worktree' (default) | 'clone' | 'container'. */
    kind?: 'worktree' | 'clone' | 'container';
    /** Guarda o workspace ao fim (debug). Default false — ocupa disco rápido. */
    keepWorkspace?: boolean;
    /**
     * Imagem, quando kind==='container': tag (resolvida para o digest sha256 na
     * preparação) ou referência por digest (`repo@sha256:…`/`sha256:…`). O
     * `docker run` usa SEMPRE o digest — nunca a tag (IMPL-036).
     */
    image?: string;
    /**
     * Runtime OCI alternativo do Docker (ex.: `runsc` = gVisor), opt-in de ALTO
     * RISCO operacional, fora do default (R-15 DEC-1: ~2× em syscalls, ~11× em
     * I/O de arquivos pequenos). Ausente = runc do daemon + perfil endurecido.
     */
    runtime?: string;
  };

  /** Nível de esforço do agente. MESMA escada do repo (7 degraus). */
  thinking?: ReasoningLevel;

  /** Orçamento de tokens do dossiê entregue ao juiz. default 12_000 */
  dossierTokens?: number;
}

/** Por que a execução de um agente terminou. */
export type AgentStopReason =
  | 'completed' // o agente terminou por conta própria
  | 'maxTurns' // bateu o teto de turnos
  | 'maxCost' // bateu o teto de custo DA EXECUÇÃO
  | 'timeout' // bateu a parede de tempo
  | 'maxOutput' // vomitou mais bytes que o permitido
  | 'error' // o processo morreu / o executor falhou
  | 'cancelled'; // sinal de controle (Ctrl-C, orçamento da RUN)

/** O que fica DENTRO do RunRecord: pequeno, estável, suficiente para navegar. */
export interface ExecutionRef {
  /** Id da execução (uuid). Nome do diretório em disco. */
  execId: string;
  /** 0-based; > 0 só quando `repetitions` > 1. */
  repetition: number;
  /** Caminho RELATIVO à raiz de dados — nunca absoluto (o record viaja entre máquinas). */
  dir: string;
  /** Resumo que a UI/CLI mostram sem abrir arquivo nenhum. */
  turns: number;
  toolCalls: number;
  durationMs: number;
  /** Por que a execução terminou. */
  stopReason: AgentStopReason;
  /** Linhas +/- e nº de arquivos, do diff seed..HEAD. */
  diffStat?: { files: number; added: number; removed: number };
  /** Resultado do oráculo, quando houve. */
  oracle?: { passed: number; failed: number; score: number };
  /** sha256 do dossiê que o juiz leu — prova de auditoria. */
  dossierSha256?: string;
  /** true = o dossiê foi truncado; o veredito foi dado com evidência parcial. */
  dossierTruncated?: boolean;
  /** > 0 ⇒ o stream teve linhas ilegíveis; a trajetória é parcial. */
  parseErrors?: number;
}

/**
 * O `exec.json` em disco — o REGISTRO DE AUDITORIA da execução. É grande de
 * propósito: sem ele, o log não é evidência de nada.
 */
export interface ExecutionRecord {
  format: 'agent-execution@1';
  execId: string;
  runId: string;
  stageIndex: number;
  contestantId: string;
  repetition: number;

  /** Reprodutibilidade: sem isto, o log não é evidência. */
  invocation: {
    executor: { id: string; version: string; bin: string };
    argv: string[];
    /** env com segredos redigidos NA ESCRITA. */
    env: Record<string, string>;
    cwd: string;
    /** bytes exatos enviados ao stdin */
    stdinSha256: string;
    startedAt: string;
    finishedAt: string;
  };

  workspace: {
    kind: 'worktree' | 'clone' | 'empty' | 'container';
    repo?: { url?: string; path?: string; ref: string };
    seedCommit: string;
    afterCommit?: string;
    files: { path: string; status: 'A' | 'M' | 'D' | 'R'; added: number; removed: number }[];
    diffStat: { files: number; added: number; removed: number };
    diffTruncated: boolean;
  };

  process: {
    exitCode: number | null;
    signal: string | null;
    stdoutBytes: number;
    stderrBytes: number;
  };

  trajectorySummary: {
    turns: number;
    toolCalls: number;
    toolErrors: number;
    stopReason: AgentStopReason;
    parseErrors: number;
    compactions: number;
    byTool: Record<string, number>;
  };

  usage: {
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    costSource: 'agent-derived' | 'reconciled';
  };

  oracle?: OracleResult;

  dossier: {
    sha256: string;
    tokensApprox: number;
    truncatedSections: string[];
    complete: boolean;
    redactions: number;
    mode: 'full' | 'compact' | 'summarized';
  };

  digests: Record<string, string>; // arquivo → sha256
}

/**
 * Trajetória NORMALIZADA. `dossier.ts`, `agentJudge.ts` e a UI leem SÓ aqui (e
 * nunca o formato do executor), senão trocar de executor vira reescrita. É uma
 * função pura que roda uma vez e grava `trajectory.json`; o bruto continua em
 * disco — normalizar não é descartar.
 */
export interface AgentTrajectory {
  format: 'agent-trajectory@1';
  executor: { id: string; version: string };
  model: { provider: string; id: string; thinking?: ReasoningLevel };
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopReason: AgentStopReason;
  turns: AgentTurn[];
  usage: {
    tokensIn: number;
    tokensOut: number;
    tokensReasoning: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    costSource: 'agent-derived' | 'reconciled';
  };
  /** Linhas do stream que não deram parse. > 0 ⇒ trajetória incompleta. */
  parseErrors: number;
  /** Compactação de contexto ocorrida durante a execução (o executor faz isso sozinho). */
  compactions: { at: string; tokensBefore: number }[];
}

export interface AgentTurn {
  index: number;
  /** Texto visível do assistente neste turno. */
  text?: string;
  /** Raciocínio, quando o executor expõe. Vai para o disco; ao juiz só com flag. */
  thinking?: string;
  steps: AgentStep[];
  usage?: { tokensIn: number; tokensOut: number; costUsd: number };
  stopReason?: string;
}

export interface AgentStep {
  /** Correlação com o executor (`toolCallId`). */
  id: string;
  tool: string; // 'bash' | 'edit' | 'write' | 'read' | ...
  /** Argumentos, com valores longos truncados e MARCADOS. */
  args: Record<string, unknown>;
  ok: boolean;
  /** Saída, truncada com marca; o completo está em events.jsonl. */
  output?: string;
  outputTruncated?: boolean;
  /** Só para bash: exit code, quando o executor reporta. */
  exitCode?: number;
  durationMs?: number;
}

/** Resultado do ORÁCULO (a régua: `verify[]`), rodado no workspace depois do commit. */
export interface OracleResult {
  checks: {
    label: string;
    cmd: string;
    exitCode: number;
    expected: number;
    ok: boolean;
    weight: number;
    durationMs: number;
    /** Últimas N linhas, guardadas inteiras em oracle.json. */
    tail: string;
  }[];
  /** Soma ponderada dos ok / soma dos pesos, em [0,1]. */
  score: number;
  /** Caminhos proibidos que foram modificados. Não-vazio ⇒ veredito 'nao'. */
  violations: string[];
  /** true = algum check não pôde rodar (comando ausente, timeout do próprio check). */
  inconclusive: boolean;
}