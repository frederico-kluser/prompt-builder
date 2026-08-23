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
}

/** Configuração do auto-teste de sala limpa (`agents doctor --deep`). */
export interface SelfTestOpts {
  /** Binário preparado. */
  bin: string;
  /** env limpo a testar (o mesmo que a execução usaria). */
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