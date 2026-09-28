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
import type { ReasoningLevel } from '../types.js';
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

/**
 * Por que o proxy de CUSTO recusou uma chamada desta execução (IMPL-035 / R-14b
 * DEC-5): o orçamento acabou ANTES da chamada seguinte. `execution` = o teto
 * `maxCostUsd` desta execução; `run` = o orçamento da RUN (ledger).
 */
export interface CostBrakeStop {
  scope: 'execution' | 'run';
  /** Gasto que o freio considerou (medido + em voo + chamadas sem custo conhecido), USD. */
  committedUsd: number;
  /** Custo projetado da chamada recusada, USD. */
  projectedUsd: number;
  /** O teto (execução) ou o saldo (run) contra o qual a chamada foi medida, USD. */
  limitUsd: number;
  /** ISO do instante da 1ª recusa. */
  at: string;
}

/** O que o proxy de custo MEDIU desta execução (`usage.cost` do último chunk SSE). */
export interface MeasuredCost {
  /** Soma do custo das chamadas encerradas (medido > catálogo; `unknown` soma 0). */
  usd: number;
  /** Chamadas encaminhadas ao provedor e encerradas (2xx). */
  calls: number;
  /** Com `usage.cost` (valor cobrado). */
  exact: number;
  /** Sem `usage.cost`, precificadas pelo catálogo. */
  estimated: number;
  /** Sem custo conhecido (stream abortado/ilegível) — NÃO é "custou zero". */
  unknown: number;
  /** Recusadas pelo freio de orçamento (nunca chegaram ao provedor). */
  refused: number;
  tokensIn: number;
  tokensOut: number;
  /** Ids de geração do OpenRouter (`gen-…`), na ordem — a ponte com a fatura. */
  generationIds: string[];
}

/**
 * O freio de custo de UMA execução, visto pelo executor (IMPL-035). Quem conta o
 * dinheiro é o proxy de custo do produto (`costProxy.ts`): ele recusa a chamada
 * que estouraria o orçamento com 429 `budget_exhausted` ANTES de ir ao provedor.
 * O executor só precisa TRADUZIR essa recusa (sinal de CONTROLE, não erro do
 * provedor) em `stopReason: 'maxCost'` e encerrar o agente — o kill por custo
 * DERIVADO do executor continua como segunda barreira.
 *
 * Este é o `costSink` do contrato v2 (IMPL-095): o dreno de custo da execução,
 * dono do produto. Não criar um segundo campo com o mesmo papel.
 */
export interface CostBrake {
  /** A recusa por orçamento, se já houve (a 1ª; é pegajosa). */
  stopped(): CostBrakeStop | null;
  /** Avisa na 1ª recusa (dispara na hora se já houve). Devolve o "desinscrever". */
  onStop(cb: (stop: CostBrakeStop) => void): () => void;
  /** O custo MEDIDO até agora. */
  measured(): MeasuredCost;
}

/**
 * Alça do sandbox já preparado (IMPL-095, `sandboxHandle`). Antes este dado
 * viajava por env (`PI_CONTAINER_IMAGE`) estampado no `prepare()` e lido por
 * fora do contrato — o contrato v2 o carrega explicitamente.
 */
export interface SandboxHandle {
  kind: 'worktree' | 'clone' | 'container';
  /** Digest sha256 da imagem (container) — o `docker run` usa SEMPRE o digest. */
  imageDigest?: string;
  /** Referência pedida (tag/`repo@sha256:…`) — só auditoria. */
  imageRef?: string;
  /** Runtime OCI opt-in (`runsc`/gVisor). Ausente = runc do daemon. */
  runtime?: string;
}

/**
 * Evento enxuto do stream da execução, exposto no contrato v2 (IMPL-095).
 * O `turn` leva o custo REAL do turno (medido — `usage.cost` quando existe,
 * catálogo como fallback), nunca o placeholder 0 de antes.
 */
export type AgentStreamEvent =
  | { type: 'turn'; index: number; total: number; costUsd: number }
  | { type: 'cost'; costUsd: number; tokensIn: number; tokensOut: number; responseId?: string }
  | { type: 'tool'; name: string; ok: boolean; total: number }
  | { type: 'settled'; sessionFile?: string };

/**
 * Ordem de adaptadores prevista (IMPL-095): cada entrada é um `AgentExecutor`
 * futuro, testado contra o MESMO canário de sala limpa (`selfTest`) antes de
 * entrar na corrida. O `pi` é o único implementado; a lista existe para que a
 * troca seja um arquivo novo, nunca uma refatoração — e para que ninguém
 * invente uma 7ª ordem sem passar pelo canário.
 */
export const AGENT_ADAPTER_ORDER = ['pi', 'claude-code', 'codex', 'gemini-cli', 'openhands', 'aider'] as const;
export type AgentAdapterId = (typeof AGENT_ADAPTER_ORDER)[number];

/**
 * A execução de UMA tarefa num workspace já preparado — CONTRATO v2 (IMPL-095).
 *
 * Tudo o que a execução precisa entra AQUI: modelo, tarefa, system prompt,
 * esforço, cancelamento, observador de eventos, credenciais de inferência,
 * sandbox e o dreno de custo. Nada viaja por variáveis `PI_*` do env e nada
 * viaja num 2º parâmetro fora do contrato (o `PiRunOptions` antigo foi fundido
 * aqui; o que sobra no adaptador do pi é só tolerância LEGADA, marcada).
 */
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
   * Modelo do contestant (IMPL-095). Antes: env `PI_MODEL_ID` — canal de env
   * eliminado; o adaptador lê daqui.
   */
  modelId?: string;
  /**
   * Enunciado da tarefa — o que o agente recebe (stdin/prompt). Antes: env
   * `PI_TASK` OU `<workDir>/task.txt`.
   */
  instruction?: string;
  /** System prompt sob teste. Antes: env `PI_SYSTEM_PROMPT` OU `<workDir>/system-prompt.txt`. */
  systemPrompt?: string;
  /**
   * Como o prompt sob teste chega ao agente ('replace' | 'append' | 'none').
   * Valor RESOLVIDO (task/run/orquestrador) — o adaptador não adivinha default.
   * Ausente = `config.promptMode` (e o default 'append' do adaptador).
   */
  promptMode?: 'replace' | 'append' | 'none';
  /** Nível de esforço por contestant (MESMA escada de 7 degraus). Ausente = `config.thinking`. */
  thinking?: ReasoningLevel;
  /** contextFiles: o que o agente pode ler do repo (tarefa/contexto do experimento). */
  contextFiles?: boolean;
  /**
   * Cancelamento (IMPL-095): o aborto interrompe `run()` e devolve
   * `stopReason: 'cancelled'` — sinal de CONTROLE, nunca erro.
   */
  signal?: AbortSignal;
  /** Observador do stream enxuto — o `turn` leva o custo REAL do turno. */
  onEvent?: (e: AgentStreamEvent) => void;
  /** Fallback de preço por token (catálogo) quando a chamada não reporta custo. */
  priceTokensIn?: (tokens: number) => number;
  priceTokensOut?: (tokens: number) => number;
  /** Diretório da sessão/transcript. Default `<workDir>/session`. */
  sessionDir?: string;
  /**
   * Rota de inferência pelo proxy local (IMPL-037) — o `credentialRef`/`baseUrl`
   * do contrato v2. Presente = o executor aponta o agente para ela. Em NENHUM
   * caso o executor repassa `OPENROUTER_API_KEY` ao ambiente do agente: sem rota
   * mas com a key no `env`, ele sobe um proxy PRÓPRIO desta execução (a key fica
   * no processo do produto); sem rota e sem key, o modo container recusa e o
   * modo host roda sem credencial (fakes).
   */
  inference?: InferenceRoute;
  /**
   * Freio/dreno de custo desta execução (IMPL-035), dono = o produto (proxy da
   * run). É o `costSink` do contrato v2. Presente = o executor traduz a recusa
   * do proxy em `stopReason: 'maxCost'` e mata o agente. Ausente (rota própria
   * do executor) = o executor monta o dele.
   */
  costBrake?: CostBrake;
  /**
   * Alça do sandbox preparado (IMPL-095, `sandboxHandle`): imagem pinada por
   * digest + runtime. Antes viajava por env (`PI_CONTAINER_IMAGE`). Ausente em
   * modo host.
   */
  sandbox?: SandboxHandle;
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
   *
   * UM parâmetro só (IMPL-095): `AgentRunOpts` carrega TODO o contrato — não há
   * 2º parâmetro fora dele nem canal por variáveis `PI_*` do env.
   */
  run(opts: AgentRunOpts): Promise<AgentRunOutcome>;

  /**
   * Auto-teste de sala limpa: prova (não promete) que a configuração de
   * isolamento está funcionando.
   */
  selfTest(opts: SelfTestOpts): Promise<CleanRoomReport>;
}