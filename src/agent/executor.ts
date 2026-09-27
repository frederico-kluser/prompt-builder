// ----------------------------------------------------------------------------
// O contrato do adaptador — a ÚNICA coisa que o motor sabe sobre o executor.
//
// ⚠️ O orquestrador (e todo o resto de `src/`) NÃO conhece o `pi`. Ele conhece
// SOMENTE esta interface. É isso que permite (1) avaliar outro executor (Claude
// Code, `codex exec`…) amanhã como um arquivo novo, não uma refatoração, e
// (2) impede que particularidades de um executor vazem para `orchestrator.ts`,
// onde seriam impossíveis de remover. Nenhum `if (executor === 'pi')` no motor.
//
// Mesma nota do §7.3 do plano: o motor client-side (`web/src/engine/`) NÃO
// espelha este módulo. O navegador não tem `child_process`, não tem filesystem,
// não tem git — o modo agente é impossível ali (não é caro, é impossível). Uma
// SPA só pode LER runs de agente (campos aditivos); criar é impossível. Não
// "consertar" essa assimetria.
// ----------------------------------------------------------------------------
import type { AgentTaskSpec, AgentRunnerConfig, AgentStopReason, AgentTrajectory } from './types.js';

/** De onde vem o binário e a versão que o pré-voo precisa casar. */
export interface PrepareOpts {
  /** 'isolated' instala a versão pinada num prefixo do run; 'system' usa o PATH. */
  install: 'system' | 'isolated';
  /** Versão EXIGIDA — divergência = falha de preparação (pré-voo). */
  executorVersion: string;
  /** Raiz das pastas por-run (pi-bin/, pi-home/…). */
  runDir: string;
  /**
   * OPÇÕES DE ISOLAMENTO. O `prepare()` hoje não enxerga a config da run — este
   * campo ADITIVO e opcional é a ÚNICA mudança necessária para permitir o
   * branch `isolation.kind === 'container'` na preparação (garantir a imagem do
   * pi, bin='docker', sem `npm install` isolado). Ausente = comportamento atual
   * (host/instalação local). Não altera nenhum outro membro do contrato.
   */
  isolation?: {
    kind?: 'worktree' | 'clone' | 'container';
    /** Imagem Docker explícita — sobrescreve `prompt-builder-pi:<version>` (tag ou digest). */
    image?: string;
    /** Runtime OCI opt-in (ex.: `runsc`/gVisor) — validado no daemon ANTES da run. */
    runtime?: string;
  };
}

/**
 * Por onde o agente fala com o modelo (IMPL-037 / R-15 DEC-2). O produto sobe um
 * proxy de inferência LOCAL que detém a key real (`inferenceProxy.ts`) e entrega
 * ao executor só isto: uma base URL local + um token FICTÍCIO desta execução. É
 * a "base URL configurável" do executor — o upstream do agente deixa de ser o
 * provedor e passa a ser o proxy. A key real NUNCA vem por aqui.
 */
export interface InferenceRoute {
  /** Token fictício (vai no `Authorization: Bearer` do agente); revogado no fim da execução. */
  token: string;
  /** Base OpenAI-compatível no HOST (`http://127.0.0.1:<porta>/api/v1`) — modo host. */
  baseUrl?: string;
  /**
   * Diretório do HOST com o socket Unix do proxy e o relay — modo container:
   * montado read-only em `/exec/proxy`; o sandbox (`--network none`) o alcança
   * pelo loopback do próprio container, via relay.
   */
  socketDir?: string;
  /** Log redigido do proxy (dicas de erro; nunca montado no sandbox). */
  logFile?: string;
}

/** A execução de UMA tarefa num workspace já preparado. */
export interface AgentRunOpts {
  /** Id da execução (uuid) — também é o nome do diretório em disco. */
  execId: string;
  /** A tarefa: o MUNDO em que o agente acorda (repo, setup, verify, limites). */
  task: AgentTaskSpec;
  /** A config DA RUN: executor/modelo/isolamento/limites default. */
  config: AgentRunnerConfig;
  /** Workspace git já montado e no commit seed — o cwd do agente. */
  workspaceDir: string;
  /** Diretório de trabalho da execução (session/, logs/, artifact). */
  workDir: string;
  /** Binário preparado por `prepare()`. */
  bin: string;
  /** env do executor (sala limpa) — já redigido/saneado por `prepare()`. */
  env: Record<string, string>;
  /**
   * Rota de inferência pelo proxy local (IMPL-037). Presente = o executor aponta o
   * agente para ela. Em NENHUM caso o executor repassa `OPENROUTER_API_KEY` ao
   * ambiente do agente: sem rota mas com a key no `env`, ele sobe um proxy
   * PRÓPRIO desta execução (a key fica no processo do produto); sem rota e sem
   * key, o modo container recusa e o modo host roda sem credencial (fakes).
   */
  inference?: InferenceRoute;
}

/**
 * O que você ganha de volta de uma execução. Só o agente rodando + limites
 * respeitados: git, oráculo e julgamento são do orquestrador.
 */
export interface AgentRunOutcome {
  stopReason: AgentStopReason;
  turns: number;
  toolCalls: number;
  durationMs: number;
  usage: { tokensIn: number; tokensOut: number; costUsd: number };
  /** A trajetória NORMALIZADA (formato canônico, independente do executor). */
  trajectory: AgentTrajectory;
  /**
   * Presente quando a execução terminou por falha de INFRAESTRUTURA — o
   * provedor/rede falhou na última chamada ao modelo (retentativas do executor
   * esgotadas) — e não por decisão do agente. Vem com `stopReason: 'error'`, mas
   * NÃO é o "processo morreu" do §18.3: quem julga deixa a execução SEM veredito
   * (fora do placar, nunca `nao`), salvo oráculo conclusivo — ver `infraError.ts`.
   * O texto é a mensagem do provedor (ex.: "Connection error.").
   */
  infraError?: string;
}

/** Configuração do auto-teste de sala limpa (`agents doctor --deep`). */
export interface SelfTestOpts {
  /** Binário preparado. */
  bin: string;
  /**
   * env limpo a testar (o mesmo que a execução usaria). No modo container,
   * `PI_CONTAINER_IMAGE` (digest) e `PI_CONTAINER_RUNTIME` (runtime OCI opt-in)
   * estampados pelo `prepare()` definem o sandbox que o auto-teste sobe.
   */
  env: Record<string, string>;
  /** Diretório do run (pi-home/ vazio etc.). */
  runDir: string;
  /** Provider a usar no teste, quando houver chave disponível. */
  provider?: string;
}

/**
 * Resultado do auto-teste: PROVA (não promete) que a sala limpa está isolando.
 * `leaks` lista cada variável/caminho do ambiente do host que vazou para o test
 * — não-vazio com `ok` = o teste falhou e a run não deveria seguir.
 */
export interface CleanRoomReport {
  ok: boolean;
  /** Cada variável de ambiente / configuração do host que vazou para o sandbox. */
  leaks: string[];
  /** Versão do executor detectada (`--version`). */
  piVersion?: string;
  /** Flags de isolamento/sanitização que o executor confirmou ter aplicado. */
  flagsUsed: string[];
}

/**
 * O adaptador de um executor de agente.
 *
 * `prepare` roda UMA vez por run (não por execução): instala o binário certo e
 * devolve um ambiente sanificado e pronto. `run` roda por (contestant × cenário ×
 * repetição). `selfTest` é o canário de sala limpa.
 */
export interface AgentExecutor {
  /** Identidade, para o manifesto e o pré-voo. */
  readonly id: string; // 'pi'
  /** Versão detectada (`--version`), para casar com `executorVersion`. */
  version(): Promise<string>;

  /**
   * Prepara o binário conforme `install`. Em 'isolated', instala a versão
   * pinada num prefixo do run e devolve o caminho absoluto do executável.
   * Roda UMA vez por run (não por execução).
   */
  prepare(opts: PrepareOpts): Promise<{ bin: string; env: Record<string, string> }>;

  /**
   * Executa UMA tarefa num workspace já preparado. Não faz git, não faz oráculo,
   * não julga: só roda o agente, respeita os limites e devolve a trajetória crua
   * + a normalizada. Tudo o mais é do orquestrador.
   */
  run(opts: AgentRunOpts): Promise<AgentRunOutcome>;

  /**
   * Auto-teste de sala limpa: prova (não promete) que a configuração de
   * isolamento está funcionando.
   */
  selfTest(opts: SelfTestOpts): Promise<CleanRoomReport>;
}