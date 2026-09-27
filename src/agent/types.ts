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
 * Um check do oráculo/regressão da tarefa (IMPL-039 + IMPL-098).
 * `fail_to_pass` (default) = o que a tarefa pede (falha no seed, tem de passar);
 * `pass_to_pass` = REGRESSÃO (passava no seed e tem de continuar passando).
 */
export interface AgentTaskCheck {
  cmd: string;
  expectExit?: number;
  timeoutMs?: number;
  weight?: number;
  /** Rótulo curto p/ o dossiê e o CSV ("testes unitários", "typecheck", "lint"). */
  label?: string;
  kind?: 'fail_to_pass' | 'pass_to_pass';
  /**
   * IMPL-098 — check CRÍTICO: o veredito dele decide sozinho (falhou ⇒ score 0
   * mesmo com os pesos; passou no seed ⇒ barreira de `fail-before`). Os pesos
   * não o substituem: `weight` é para os checks comuns.
   */
  critical?: boolean;
}

/**
 * IMPL-098 (agentTask@2) — SOLUÇÃO DE REFERÊNCIA ("golden"). Obrigatória em
 * modo validate: sem ela não há `pass-after` validável nem `flakiness` medível.
 * `script` = comando shell que implementa a solução; `diff` = patch unificado
 * aplicado com `git apply` sobre o seed.
 */
export type AgentTaskSolution = { kind: 'script'; script: string } | { kind: 'diff'; diff: string };

/**
 * IMPL-098 — ambiente FIXADO por digest (imagem OCI ou lockfile). `path`, quando
 * existe, tem de ser ABSOLUTO (path relativo é rejeitado pelo schema: um
 * caminho relativo muda de significado com o cwd e quebra a reprodutibilidade).
 */
export interface AgentTaskEnv {
  /** `sha256:<hex>` ou `<ref>@sha256:<hex>`. */
  digest: string;
  /** Caminho absoluto do lockfile/imagem local, quando houver. */
  path?: string;
}

/** IMPL-098 — metadados da tarefa (proveniência e curadoria). */
export interface AgentTaskMetadata {
  /** De onde veio (dataset, repo, mineração --from-commit…). */
  origin?: string;
  /** Commit de origem, quando minerada de um repo. */
  commit?: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  tags?: string[];
  /** Canário de sala limpa/sanidade: roda sempre, não entra no placar. */
  canary?: boolean;
}

/**
 * O que transforma uma etapa em tarefa executável. Tudo aqui descreve o MUNDO
 * em que o agente acorda — nunca o agente em si (isso é `AgentRunnerConfig`).
 * Separar os dois é o que permite rodar a MESMA tarefa com agentes diferentes.
 *
 * Formato `arena-agent-config@2` (IMPL-098): os campos novos (`solution`,
 * `regression[]`, `testsDir`, `env`, `metadata`) são ADITIVOS — o @1 continua
 * legível (schema em `taskSchema.ts`).
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
  verify?: AgentTaskCheck[];

  /**
   * IMPL-098 (agentTask@2) — REGRESSÃO (PASS_TO_PASS): checks que já passavam
   * no seed e têm de continuar passando depois da solução. Na prática entram no
   * oráculo como `kind: 'pass_to_pass'` (quebrar um zera a nota).
   */
  regression?: AgentTaskCheck[];

  /**
   * IMPL-098 (agentTask@2) — SOLUÇÃO DE REFERÊNCIA. Obrigatória em modo
   * validate (`taskSchema.ts`): é o que valida `pass-after`, `flakiness`,
   * `trivialidade` e `oráculo fraco` (IMPL-097).
   */
  solution?: AgentTaskSolution;

  /**
   * IMPL-098 (agentTask@2) — `tests/` copiado para o verificador DEPOIS do
   * agente, NUNCA no workspace durante a execução (o agente não entrega o
   * próprio teste adulterado — padrão Harbor/SWE-bench). Caminho relativo ao
   * diretório da configuração; o conteúdo é colhido na compilação/execução.
   */
  testsDir?: string;

  /**
   * IMPL-098 (agentTask@2) — ambiente fixado por digest (imagem/lockfile).
   */
  env?: AgentTaskEnv;

  /** IMPL-098 (agentTask@2) — metadados (proveniência, dificuldade, canário). */
  metadata?: AgentTaskMetadata;

  /**
   * Caminhos que o agente NÃO pode tocar. Violação => veredito 'nao' automático,
   * sem gastar juiz. Existe porque a forma mais barata de "passar no teste" é
   * editar o teste — é o reward hacking clássico deste domínio, e ele precisa de
   * uma barreira determinística, não de um pedido educado no prompt.
   * Semântica GITIGNORE (IMPL-039, `guard.ts`): `*.test.ts` casa em qualquer
   * nível, `/test/` ancora na raiz, `dir/` casa tudo dentro, `**`, `!` reinclui.
   * Checado pelo diff (inclusive a ORIGEM de renames) E por SHA-256 do arquivo
   * contra o seed no filesystem (pega arquivo ignorado pelo `.gitignore`).
   */
  forbiddenPaths?: string[];

  /**
   * IMPL-039 — rebuild de dependências ANTES do `verify[]`: os `lockfiles` voltam
   * aos bytes do seed e `cmd` reconstrói (default `npm ci --ignore-scripts
   * --no-audit --no-fund`). Com rebuild ligado,
   * `lockfiles` e `protect` (default `node_modules/`) entram no hash de
   * protegidos: dependência adulterada pelo agente é VIOLAÇÃO — e o rebuild a
   * neutraliza para os checks rodarem contra dependências limpas. Falha do
   * rebuild = oráculo inconclusivo, checks não rodam (nunca contra deps sujas)
   * e a repetição fica SEM veredito (infra, nunca `nao`) — salvo violação.
   * O default `npm ci --ignore-scripts` não roda `postinstall`/`prepare` do
   * pacote raiz: um script de instalação plantado pelo agente adulteraria
   * `node_modules` DEPOIS do snapshot pós.
   */
  rebuild?: {
    cmd?: string;
    /** Default `['package-lock.json']`. */
    lockfiles?: string[];
    /** Padrões (gitignore) do que o rebuild reconstrói. Default `['node_modules/']`. */
    protect?: string[];
    timeoutMs?: number;
  };

  /**
   * IMPL-039 — detectores estáticos sobre o diff (skip/only/todo, xfail,
   * exit(0)/`|| true`, teste apagado, config de runner editada). Heurística:
   * `'warn'` (default) só registra em `oracle.json`; `'fail'` vira violação
   * (veredito `nao` sem LLM); `'off'` desliga.
   */
  detectors?: 'off' | 'warn' | 'fail';

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
  /**
   * Teto de gasto DESTA execução, em USD. Default: obrigatório em modo agente.
   * Imposto ANTES da chamada (IMPL-035): o proxy de custo recusa (429
   * `budget_exhausted`) a chamada cujo custo projetado não cabe mais; o kill
   * pelo custo derivado do executor fica como segunda barreira.
   */
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

/**
 * De onde veio o custo de uma execução (R-14b DEC-4). `usage` = medido pelo
 * proxy de custo (`usage.cost` que o OpenRouter cobrou, em TODAS as chamadas);
 * `catalog` = medido pelo proxy, mas alguma chamada sem `usage.cost` (catálogo ou
 * desconhecido); `agent-derived` = o que o executor calculou por tabela própria
 * (sem chamadas pelo proxy); `reconciled` = conferido com `/generation`.
 */
export type AgentCostSource = 'usage' | 'catalog' | 'agent-derived' | 'reconciled';

/** Por que a execução de um agente terminou. */
export type AgentStopReason =
  | 'completed' // o agente terminou por conta própria
  | 'maxTurns' // bateu o teto de turnos
  | 'maxCost' // teto de custo: o proxy recusou a chamada seguinte (execução OU run) / kill pelo derivado
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
  /**
   * Mensagem do provedor quando a execução terminou por erro de INFRA
   * (`stopReason: 'error'` sem culpa do agente) — a repetição fica sem veredito,
   * salvo oráculo conclusivo (IMPL-036, `infraError.ts`). Ausente em records antigos.
   */
  infraError?: string;
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
    /** Ver `AgentCostSource`. Records antigos: 'agent-derived'. */
    costSource: AgentCostSource;
    /** O custo que o EXECUTOR reportou (tabela própria) — auditoria contra o medido. */
    agentDerivedCostUsd?: number;
    /**
     * O que o proxy de custo MEDIU desta execução (IMPL-035): chamadas, quantas com
     * `usage.cost`, recusadas pelo freio e os ids de geração (ponte com a fatura).
     */
    proxy?: {
      calls: number;
      exact: number;
      estimated: number;
      unknown: number;
      refused: number;
      generationIds: string[];
      /** A recusa por orçamento que parou a execução, se houve. */
      budgetStop?: { scope: 'execution' | 'run'; committedUsd: number; projectedUsd: number; limitUsd: number };
    };
  };

  oracle?: OracleResult;

  dossier: {
    sha256: string;
    tokensApprox: number;
    truncatedSections: string[];
    complete: boolean;
    redactions: number;
    mode: 'full' | 'compact' | 'summarized';
    /** Marca dos blocos DADOS-DO-AGENTE (IMPL-034) — ausente em execuções antigas. */
    marker?: string;
    /** Tokens estruturais neutralizados no conteúdo do agente (tentativa de forjar bloco). */
    neutralized?: number;
  };

  digests: Record<string, string>; // arquivo → sha256

  /**
   * ONDE rodou cada fase de código não confiável (IMPL-038). `mode: 'host'` =
   * SEM ISOLAMENTO (sem Docker): setup/verify rodaram com o uid do operador,
   * só com env mínimo. Ausente em records antigos.
   */
  sandbox?: {
    mode: 'host' | 'container';
    isolated: boolean;
    setup: 'host' | 'sandbox';
    verify: 'host' | 'sandbox';
    /** Como o artefato foi colhido: cópia de árvore + git do produto num --git-dir próprio. */
    collect: 'tree-copy';
    /** Rede do sandbox de setup (container): pré-agente, sem segredo no env. */
    setupNetwork?: 'none' | 'bridge';
    /** Digest da imagem do sandbox verificador (container). */
    verifierImage?: string;
    note?: string;
  };
}

/**
 * Trajetória NORMALIZADA. `dossier.ts`, `agentJudge.ts` e a UI leem SÓ aqui (e
 * nunca o formato do executor), senão trocar de executor vira reescrita. É uma
 * função pura que roda uma vez e grava `trajectory.json`; o bruto continua em
 * disco — normalizar não é descartar.
 *
 * Duas versões em circulação (IMPL-095):
 * - `agent-trajectory@1` — o que `fromPi` produz hoje (turnos só do agente);
 * - `agent-trajectory@2` — formato de INTERCÂMBIO (R-14b:REC-3 / R-14c:REC-8):
 *   cada turno ganha `source` (system/user/agent) e `timestamp`, o que torna o
 *   round-trip ATIF↔próprio sem perda possível. Os leitores aceitam as duas —
 *   os campos novos são aditivos e opcionais.
 */
export interface AgentTrajectory {
  format: 'agent-trajectory@1' | 'agent-trajectory@2';
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
    costSource: AgentCostSource;
    /** O custo que o executor reportou, quando `costUsd` passou a ser o MEDIDO. */
    agentDerivedCostUsd?: number;
  };
  /** Linhas do stream que não deram parse. > 0 ⇒ trajetória incompleta. */
  parseErrors: number;
  /** Compactação de contexto ocorrida durante a execução (o executor faz isso sozinho). */
  compactions: { at: string; tokensBefore: number }[];
}

export interface AgentTurn {
  index: number;
  /**
   * Quem falou (IMPL-095, `agent-trajectory@2`): `agent` (default — o agente)
   * ou as mensagens de CONTEXTO que rodeiam os turnos (`user` = enunciado,
   * `system` = instrução de sistema) — sem elas o intercâmbio ATIF perderia
   * mensagens no round-trip.
   */
  source?: 'system' | 'user' | 'agent';
  /** ISO do instante do turno (IMPL-095, `agent-trajectory@2`). */
  timestamp?: string;
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
    /**
     * Por que o check NÃO terminou com exit normal (ausente = terminou). Em
     * todos os casos `ok` é false e o peso fica no denominador do `score`:
     * - `spawn`   — o comando nem começou (ausente, sem permissão): o único caso
     *               que pode ser defeito do AMBIENTE da tarefa; quem decide é a
     *               célula (`oracleCellDefect`, IMPL-033);
     * - `timeout` — passou do `timeoutMs` do check (código que pendura);
     * - `signal`  — morto por sinal que não foi o nosso timeout (OOM, segfault);
     * - `rebuild` — não rodou porque o rebuild de dependências falhou (IMPL-039:
     *               infra — a rep fica sem veredito, ver runAgentStage).
     * `timeout`/`signal` são desfecho do código sob teste: contam como check falho
     * (num P2P, regressão — IMPL-039).
     */
    notRun?: OracleNotRun;
    /** IMPL-039: papel do check (ausente = `fail_to_pass`). */
    kind?: 'fail_to_pass' | 'pass_to_pass';
    /** IMPL-039: não rodou por falha do rebuild de dependências. */
    skipped?: boolean;
  }[];
  /** Soma ponderada dos ok / soma dos pesos, em [0,1]. */
  score: number;
  /** Caminhos proibidos que foram modificados. Não-vazio ⇒ veredito 'nao' (e `score` 0). */
  violations: string[];
  /**
   * true = algum check não terminou com exit normal (ver `checks[].notRun`) ou
   * o hash dos protegidos foi truncado (IMPL-039).
   */
  inconclusive: boolean;
  // --- IMPL-039 (opcionais: `oracle.json` antigos não têm) ---------------------
  /** Nota antes das penalidades (violação / P2P quebrado). */
  rawScore?: number;
  f2p?: { passed: number; total: number };
  /**
   * `broken` ⇒ regressão: a execução falhou (score 0) — inclui P2P que travou
   * (timeout) ou morreu por sinal. `unverified` = P2P que não pôde ser aferido
   * (spawn error/rebuild): com ele > 0 a nota cheia NÃO basta para `resolve`.
   */
  p2p?: { passed: number; total: number; broken: boolean; unverified?: number };
  /** Mudanças nos arquivos protegidos por SHA-256 vs o seed (filesystem). */
  protectedChanges?: { path: string; change: 'modified' | 'deleted' | 'added' | 'renamed'; to?: string }[];
  /**
   * true = o percurso dos protegidos bateu no teto de entradas (seed ou pós):
   * o hash NÃO foi comparado (evita `added`/`deleted` fantasma pelo corte) e só
   * o diff do git vigiou `forbiddenPaths`. O oráculo fica `inconclusive`.
   */
  guardTruncated?: boolean;
  /** Violações que vieram SÓ dos detectores em modo `fail` (não de caminho protegido). */
  detectorViolations?: string[];
  /** Caches de ferramenta apagados antes do rebuild/checks (`__pycache__`, `node_modules/.vite`…). */
  purged?: string[];
  /** Achados dos detectores estáticos (`detectors`). */
  findings?: { kind: 'skip' | 'xfail' | 'exit0' | 'test-deleted' | 'runner-config'; path: string; detail: string }[];
  /** Rebuild de dependências rodado antes dos checks. */
  rebuild?: { cmd: string; exitCode: number; ok: boolean; durationMs: number; tail: string; restored: string[] };
}

/** Motivo de um check do oráculo não ter terminado com exit normal (IMPL-033 + `rebuild` do IMPL-039). */
export type OracleNotRun = 'spawn' | 'timeout' | 'signal' | 'rebuild';
