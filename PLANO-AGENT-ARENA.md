# Agent Arena — plano para julgar AGENTES com o mesmo motor que julga prompts

> Documento de PLANEJAMENTO. Nada aqui foi implementado. O objetivo é que uma
> pessoa (ou um agente de programação) consiga executar isto sem precisar
> redescobrir nenhuma das decisões — por isso cada escolha vem com o **porquê** e,
> quando existe, com a **evidência** que a sustenta.
>
> Data: 2026-08-23 · Versão do repo: `prompt-builder-cli@0.1.1` · `pi` verificado: **0.84.2**

---

## 0. Sumário executivo

### 0.1 O que se quer

Hoje o motor mede **uma resposta de chat**: o competidor recebe `system` +
`user`, devolve texto, o juiz compara esse texto com um gabarito e sai um
veredito ternário (`resolve`/`parcial`/`nao`). Isso está em `competitor.ts`
(uma chamada), `gabarito.ts` (a régua), `refJudge.ts` (o veredito) e
`duels.ts` (as finais).

O que se quer agora é que **as mesmas etapas** (`StageSpec`) sirvam para medir
um **agente**: um processo que recebe uma tarefa, roda por vários turnos, usa
ferramentas (bash, edit, write, read), mexe em arquivos de verdade e termina
deixando um **artefato** (um diff) e um **rastro** (a trajetória). E que o juiz
consiga dizer quem foi melhor lendo esse rastro.

### 0.2 A tese em uma frase

> **Um agente é um competidor cuja resposta não é um texto, e sim um par
> (artefato, trajetória) — e quase todo o resto do motor continua valendo.**

Se essa frase for verdadeira na implementação, ganhamos de graça: placar
aditivo, judge-score, medalhas, finais Copeland, holdout, significância
bootstrap, ledger de orçamento, portas de fase, NDJSON, CSV, retrocompat de
records. Se ela for falsa em algum ponto, esse ponto é onde mora o trabalho.
Este documento existe para tornar a frase verdadeira com o mínimo de cirurgia.

### 0.3 As sete decisões que carregam o plano

| # | Decisão | Por quê (resumo — o longo está no corpo) |
|---|---|---|
| 1 | **Novo eixo `runner: 'chat' \| 'agent'` no `Contestant`, não um novo `RunMode`** | `compare`/`variation`/`training` são perguntas ("qual modelo?", "qual prompt?"); `runner` é *como se colhe a resposta*. São ortogonais. Um novo modo duplicaria os três. |
| 2 | **`StageSpec` ganha `agentTask?`; todo o resto do `StageSpec` é reusado verbatim** | É literalmente o pedido: "as etapas dos desafios servirem também para prompts que rodam em agentes". `question`, `productContext`, `rubric` e `reference` já são a espinha certa. |
| 3 | **Executor = `pi` (pi.dev) rodando em **sala limpa**, por `child_process.spawn`** | É o único CLI verificado que junta: 3 modos headless sem prompt de confiança, trajetória completa em JSONL estruturado, redirecionamento de transcript por flag/env, OpenRouter nativo e **a mesma escada de 7 degraus de esforço** que este repo já modela. |
| 4 | **O log completo vai para DISCO; o juiz lê um DOSSIÊ determinístico e versionado** | O rastro bruto de um agente tem megabytes. Enfiá-lo no juiz é impossível e enfiá-lo no `RunRecord` destruiria o `saveRun` throttled. O dossiê é montado por código (não por LLM) e é **salvo** — dá para auditar exatamente o que o juiz viu. |
| 5 | **Oráculo determinístico VENCE o juiz LLM; teste que falha é `nao` sem apelação** | Se a tarefa tem teste, o teste é a verdade. O LLM entra para graduar qualidade e desempatar, nunca para absolver um `exit 1`. |
| 6 | **API separada `/v1/agents`, desligada por padrão, só em localhost, nunca no serverless e nunca no motor do browser** | Um endpoint HTTP que roda um agente com bash num workspace **é execução remota de código**. E `web/src/engine/` não tem filesystem, git nem processo: duplicar isto lá é impossível, não caro. |
| 7 | **Custo do agente entra no ledger como `source: 'catalog'`, não `'usage'`** | O `pi` calcula custo por **tabela de preços embarcada**, não pelo valor cobrado (achado verificado da pesquisa). Sob a doutrina "dinheiro é medido, nunca inferido", isso é o caminho de *fallback* — chamá-lo de medido reintroduziria exatamente o bug de subcontagem que este repo já pagou para consertar. |

### 0.4 Mapa do documento

- **Parte I** — Por que o motor atual não serve como está, e o que NÃO pode mudar.
- **Parte II** — O modelo de dados: os cinco tipos novos e as quatro linhas alteradas.
- **Parte III** — O executor: `pi` em sala limpa, `spawn`, timeouts, kill de árvore.
- **Parte IV** — A captura: o que é "log completo", e o dossiê que o juiz lê.
- **Parte V** — O julgamento: gabarito de agente, oráculo, pointwise, duelos, vieses.
- **Parte VI** — Dinheiro: por que a estimativa vira contrato e como o ledger fecha.
- **Parte VII** — As superfícies: HTTP, CLI, MCP, NDJSON, docs para agentes.
- **Parte VIII** — Roadmap em 6 fases com critérios de aceite.
- **Parte IX** — Armadilhas específicas DESTE repositório (checklist de merge).
- **Parte X** — Alternativas descartadas, com o motivo de cada descarte.
- **Parte XI** — Riscos, lacunas de evidência e o que fica fora da v1.
- **Apêndices** — Schemas completos, comandos exatos, exemplo de dossiê, splitter JSONL.

### 0.5 Status da evidência (leia antes de confiar em qualquer número)

Este plano tem **três** classes de afirmação e elas estão marcadas ao longo do texto:

- **[VERIFICADO LOCAL]** — eu executei/li na máquina: `pi 0.84.2` instalado em
  `~/.nvm/.../@earendil-works/pi-coding-agent`, seus `docs/` embarcados no
  tarball, um arquivo real de sessão JSONL em `~/.pi/agent/sessions/`, e um
  teste de isolamento com `PI_CODING_AGENT_DIR`.
- **[VERIFICADO PESQUISA]** — achado da pesquisa profunda que sobreviveu a
  verificação adversarial 3-voto contra a fonte primária (docs oficiais + código
  publicado). Vem com a fonte.
- **[JULGAMENTO]** — decisão de engenharia minha, derivada da doutrina deste
  repositório (AGENTS.md) e do código existente. **Não** é achado de pesquisa.

A pesquisa cobriu bem o eixo "executar um CLI de agente headless e capturar a
trajetória". Ela **não** produziu evidência sobre: julgamento de trajetórias
(Agent-as-a-Judge, rubricas de processo, vieses nesse regime), como
SWE-bench/Terminal-Bench/τ-bench de fato executam e pontuam, quantas repetições
dão significância, nem sobre o plumbing Node (deadlock de pipes, kill de árvore).
Tudo nesses assuntos aqui é **[JULGAMENTO]** ancorado no que o repo já faz —
e a Parte XI lista isso como lacuna a fechar antes de a Fase 4 valer alguma coisa.

---

# PARTE I — O problema e as invariantes

## 1. Por que o motor atual não serve como está

O pipeline de hoje (`orchestrator.ts`) assume cinco coisas que deixam de valer
quando o competidor é um agente:

**1.1 — A resposta é um texto e cabe na memória.**
`CompetitorResponse.text` é uma string que vai inteira para dentro do
`RunRecord`, que é serializado a cada `saveRun`. Com agente, o "texto" vira uma
trajetória de dezenas de mensagens com saídas de comando — megabytes. O
`createSaver` já existe justamente porque as escritas se atropelam
(`SAVE_INTERVAL_MS = 800`); colocar trajetórias dentro do record faria cada
escrita custar O(tamanho de tudo o que já rodou). Isso não é uma otimização
prematura: é a diferença entre uma run de 20 cenários salvar 200 KB ou 400 MB.

**1.2 — O custo é estimável antes de gastar.**
`estimate.ts` consegue projetar a run porque sabe quantas chamadas serão feitas
(cenários × contestants × juízes) e qual o teto de tokens de cada uma. Um agente
decide sozinho quantos turnos vai dar. A estimativa deixa de ser *previsão* e
precisa virar **contrato**: um teto por execução que o executor **impõe**.

**1.3 — A chamada de LLM passa por `chatCompletion`.**
A regra do AGENTS.md ("toda chamada de LLM passa por `chatCompletion`, que tem o
limitador global adaptativo") é o que segura 429 e é onde o ledger é alimentado.
As chamadas do agente saem de dentro do `pi`, para o provedor dele. Elas são
**invisíveis** para o nosso limitador e para o nosso `CostSink`. Isso tem duas
consequências que precisam de resposta explícita (Partes III e VI): o controle de
concorrência muda de natureza, e o dinheiro precisa ser reconciliado, não medido
no ponto de chamada.

**1.4 — O gabarito é uma resposta ideal em texto.**
`gabarito.ts` roda o modelo de referência com o *mesmo* contexto e guarda o texto.
Para uma tarefa de agente, a "resposta ideal" é um diff — ou, melhor ainda, um
conjunto de testes que passam. O conceito de referência sobrevive, mas ganha
três encarnações (Parte V).

**1.5 — Não existe efeito colateral.**
Duas execuções de `runCompetitor` no mesmo cenário não interferem uma na outra.
Duas execuções de agente no mesmo diretório destroem uma à outra. Todo o desenho
de isolamento (workspace efêmero por execução) existe por causa disto.

O que **não** muda: a etapa continua sendo uma pergunta com contexto e rubrica; o
veredito continua ternário; o placar continua aditivo; as finais continuam
Copeland. É por isso que a cirurgia é pequena.

## 2. Invariantes — o que este plano se compromete a NÃO quebrar

Estas são regras que o repositório já pagou caro para aprender (estão em
`AGENTS.md` e nos comentários do código). Elas valem igual no modo agente, e
cada uma delas tem um lugar concreto no desenho abaixo.

| Invariante | Onde vive hoje | Como o modo agente a respeita |
|---|---|---|
| **stdout é payload, stderr é narração** | `cli/output.ts` | O executor escreve a narração do `pi` em `stderr` do nosso processo apenas com `--verbose`; o stream do agente vai para arquivo, nunca para o nosso stdout. |
| **`console.log` do motor vai para stderr** | `orchestrator.ts`, `trainer.ts` | O runner de agente usa a mesma função `log()` (stderr). Uma linha de log no stdout corromperia o NDJSON de quem consome. |
| **Dinheiro é medido, nunca inferido; `unknown` ≠ zero** | `budget.ts`, `types.ts` | Custo vindo do `pi` é marcado `source: 'catalog'` (derivado). Há um passo de reconciliação opcional contra o OpenRouter para promover a `'usage'`. Nunca se assume zero. |
| **`BudgetExceeded`/`RunCancelled` são CONTROLE, não erro** | `budget.ts`, todo catch do pipeline | O runner de agente degrada erro de execução para `status: 'error'` — mas todo catch começa com `if (isControlSignal(err)) throw err`. |
| **Use `isControlSignal`, nunca `instanceof`** | `budget.ts` | Idem no código novo. ESM com instância dupla do módulo daria `false` em silêncio. |
| **Portas de orçamento agem em GRUPOS de fase atômicos** | `orchestrator.ts` `gate()` | `execuções + julgamento` é um grupo indivisível, exatamente como `competidores + julgamento` hoje. Autorizar execuções sem poder pagar o julgamento produz etapas com diff e sem nota. |
| **Etapa cortada é `incomplete` e fica FORA do placar** | `StageRecord.incomplete` | Execução cortada por teto (turnos/custo/tempo) marca a resposta como `incomplete`. Ela **não** vira veredito `nao`: "acabou o dinheiro" não é "o agente errou". |
| **Degrada, nunca derruba** | `gabarito.ts`, `refJudge.ts`, `duels.ts` | Falha de um agente = 1 resposta com erro; falha do oráculo = veredito só por LLM; falha do juiz = `parcial` com o motivo. A run segue. |
| **Ranking sempre por veredito** | `orchestrator.ts` (fase 3) | Inalterado. O veredito agora pode vir do oráculo, mas continua sendo `resolve`/`parcial`/`nao`. |
| **Desempate por shuffle cego semeado, nunca ordem de entrada** | `duels.ts` `blindRankMap` | Inalterado, e agora também usado para ordenar dossiês no prompt do juiz. |
| **Imports relativos terminam em `.js`** | ESM NodeNext | Todo arquivo novo. |
| **Nada de `process.cwd()` para dados do pacote** | `paths.ts` | O binário do `pi` e os templates de tarefa são resolvidos por `PKG_ROOT`/config, nunca por cwd. |
| **O motor client-side (`web/src/engine/`) espelha o backend** | AGENTS.md | **Exceção deliberada e documentada**: o modo agente **não** é espelhado. Ver §7.3 — não é preguiça, é impossibilidade. |

## 3. Os dois consumidores (e por que o contrato é o mesmo)

O pedido tem dois clientes distintos, e ambos precisam do mesmo contrato:

**3.1 — Um agente de programação (Claude Code, Codex, o próprio `pi`) rodando
`prompt-builder agents ...`.** Aqui o valor é o de sempre: custo ~0 de contexto,
`--json`/`--output-format ndjson`, códigos de saída distintos, docs embarcadas.
O agente-cliente **dirige** o benchmark.

**3.2 — A própria ferramenta rodando `pi` via `node:child_process`.** Aqui a
ferramenta **é** o cliente do agente. É o executor descrito na Parte III.

O ponto não-óbvio: **os dois compartilham o formato de trajetória**. Se o
agente-cliente (3.1) quiser inspecionar o que o agente-executado (3.2) fez, ele
lê o mesmo `exec.json`/`dossier.md`. Não há dois vocabulários. Isso também
significa que, no dia em que quisermos avaliar o *próprio Claude Code* em vez do
`pi`, só o adaptador muda — o resto do sistema não sabe qual binário rodou.

---

# PARTE II — O modelo de dados

## 4. Princípio: cinco tipos novos, quatro campos opcionais

A regra de ouro desta parte: **nenhum campo existente muda de tipo ou de
significado**. Tudo é aditivo e opcional. Records antigos continuam abrindo;
`normalizeRunRecord` continua funcionando; a UI existente continua renderizando
(ela simplesmente não sabe dos campos novos, e ignorá-los é o comportamento
correto).

## 5. Os quatro campos aditivos em tipos existentes

```ts
// src/types.ts

export interface Contestant {
  // ...tudo como está hoje...

  /**
   * COMO a resposta deste competidor é colhida.
   * 'chat'  (default, ausente) = uma chamada de chatCompletion — o que existe hoje.
   * 'agent' = uma execução de agente num workspace isolado (Agent Arena).
   *
   * Eixo ORTOGONAL ao `mode`: um compare pode ter 3 modelos como agentes; um
   * training pode evoluir o system prompt DE um agente. Foi por isso que este
   * campo não virou um quarto RunMode — viraria a duplicação dos três.
   */
  runner?: 'chat' | 'agent';
}

export interface StageSpec {
  // ...question, productContext, maxTokens, rubric, reference, origin...

  /**
   * A etapa, quando executada por um agente. AUSENTE => a etapa só serve ao
   * runner 'chat' (comportamento de hoje, intacto).
   *
   * `question` continua sendo A TAREFA e `productContext` continua sendo o
   * contexto/política — para o agente eles viram, respectivamente, o prompt
   * inicial e o system prompt. `rubric` continua sendo a âncora do juiz e
   * `reference` continua sendo o gabarito. É literalmente a mesma etapa
   * servindo aos dois runners; só o transporte muda.
   */
  agentTask?: AgentTaskSpec;
}

export interface CompetitorResponse {
  // ...contestantId, modelId, text, latencyMs, tokensIn, tokensOut, costUsd, status...

  /**
   * Ponteiro para os artefatos da execução de agente em disco. NUNCA o conteúdo:
   * o RunRecord é reserializado inteiro a cada saveRun (throttled em 800ms) e
   * embutir trajetórias tornaria cada escrita O(tudo que já rodou).
   */
  execution?: ExecutionRef;
}

export type CostRole =
  | 'datagen' | 'gabarito' | 'competitor' | 'judge' | 'duel' | 'rewriter'
  /** NOVO: gasto de LLM feito DENTRO de uma execução de agente. */
  | 'agent';
```

> ⚠️ **Ao adicionar `'agent'` a `CostRole`, atualize `COST_ROLES`** (a const em
> `types.ts`), `ROLE_LABEL` e `PHASE_LABEL` (`budget.ts`), `ROLE_LABEL_PT`
> (`cli/output.ts`) e `emptyByRole()` — este último deriva de `COST_ROLES`, então
> vem de graça, mas os três primeiros são mapas literais e o TypeScript vai
> reclamar (bom: é o compilador fazendo o checklist por você).

## 6. Os cinco tipos novos

### 6.1 `AgentTaskSpec` — o desafio, do ponto de vista do agente

```ts
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
   * Quando existe oráculo, ele MANDA (ver §17.3). É a única parte do julgamento
   * que não depende de um LLM ter um bom dia.
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
   * Limites POR EXECUÇÃO. Este objeto é o CONTRATO DE CUSTO da tarefa: é dele
   * que a estimativa deriva o teto (§20) e é ele que o executor impõe matando o
   * processo. Sem isso, um agente em laço infinito gasta o orçamento inteiro
   * numa etapa e a run "termina" sem ter medido nada.
   */
  limits?: AgentLimits;
}

export interface AgentLimits {
  /** Turnos do agente (contados por evento `turn_start`). Default 30. */
  maxTurns?: number;
  /** Teto de gasto DESTA execução, em USD. Default: obrigatório (ver §20.2). */
  maxCostUsd?: number;
  /** Parede de tempo da execução inteira, ms. Default 600_000 (10 min). */
  timeoutMs?: number;
  /** Teto de bytes de stdout+stderr gravados. Default 8 MiB. Acima disso, mata. */
  maxOutputBytes?: number;
  /** Teto de bytes do diff considerado. Acima, o dossiê trunca com marca. Default 512 KiB. */
  maxDiffBytes?: number;
}
```

**Por que `verify` é uma lista de comandos e não um "script de teste":** porque
o veredito precisa ser *decomponível*. Com uma lista, o dossiê mostra
"typecheck ✓ · testes ✗ (3 falhas) · lint ✓" e o juiz LLM recebe um sinal
estruturado em vez de 4000 linhas de saída de test runner. Com um script único,
tudo colapsa num exit code e a explicação some.

### 6.2 `AgentRunnerConfig` — o agente, do ponto de vista da run

```ts
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

  /** Versão EXIGIDA do executor. Divergência = run falha no pré-voo (§21.4). */
  executorVersion: string; // ex.: "0.84.2"

  /**
   * Como o binário é obtido. 'system' usa o `pi` do PATH (rápido, mas o
   * ambiente do dev vaza para o experimento); 'isolated' instala a versão
   * pinada num prefixo temporário do run (reprodutível). Default 'isolated'.
   */
  install?: 'system' | 'isolated';

  /** Provider do agente. Default 'openrouter' — ver §12.3 para o porquê. */
  provider?: string;

  /**
   * Como o prompt sob teste chega ao agente.
   * 'replace' => `--system-prompt` (substitui o prompt de coding do pi INTEIRO).
   * 'append'  => `--append-system-prompt` (soma ao prompt de coding).
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
   * relatório; recomendado 3 quando a decisão importa. Ver §18.4.
   */
  repetitions?: number;

  /**
   * Máximo de execuções de agente SIMULTÂNEAS neste processo.
   * ⚠️ Isto NÃO viola a regra "não ponha cap de concorrência local" do AGENTS.md.
   * Aquela regra fala do limitador global de `openrouter.ts`, que existe para
   * respeitar o RATE LIMIT DO PROVEDOR. Aqui o recurso escasso é a MÁQUINA
   * (cada execução é um processo Node + shells filhos + I/O de disco), e o
   * limitador global não enxerga essas chamadas, porque elas saem de dentro do
   * `pi`. São dois problemas distintos com duas soluções distintas.
   * Default: `min(4, os.cpus().length - 1)`.
   */
  maxParallel?: number;

  /** Limites default, herdados por toda `AgentTaskSpec` que não os declare. */
  limits?: AgentLimits;

  /** Isolamento do workspace. Ver §13. */
  isolation?: {
    /** 'worktree' (default) | 'clone' | 'container'. */
    kind?: 'worktree' | 'clone' | 'container';
    /** Guarda o workspace ao fim (debug). Default false — ocupa disco rápido. */
    keepWorkspace?: boolean;
    /** Imagem, quando kind==='container'. */
    image?: string;
  };

  /** Nível de esforço do agente. MESMA escada do repo (7 degraus). Ver §12.4. */
  thinking?: ReasoningLevel;
}
```

### 6.3 `ExecutionRef` e `ExecutionRecord` — o ponteiro e o registro

```ts
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
  /** Por que a execução terminou. Ver §15.2. */
  stopReason: AgentStopReason;
  /** Linhas +/- e nº de arquivos, do diff seed..HEAD. */
  diffStat?: { files: number; added: number; removed: number };
  /** Resultado do oráculo, quando houve. */
  oracle?: { passed: number; failed: number; score: number };
  /** sha256 do dossiê que o juiz leu — prova de auditoria. */
  dossierSha256?: string;
  /** true = o dossiê foi truncado; o veredito foi dado com evidência parcial. */
  dossierTruncated?: boolean;
}

export type AgentStopReason =
  | 'completed'       // o agente terminou por conta própria
  | 'maxTurns'        // bateu o teto de turnos
  | 'maxCost'         // bateu o teto de custo DA EXECUÇÃO
  | 'timeout'         // bateu a parede de tempo
  | 'maxOutput'       // vomitou mais bytes que o permitido
  | 'error'           // o processo morreu / o executor falhou
  | 'cancelled';      // sinal de controle (Ctrl-C, orçamento da RUN)
```

O `ExecutionRecord` completo (que vive em `exec.json`, no disco) está no
Apêndice A.2 — ele é grande de propósito, porque é o registro de auditoria.

### 6.4 `AgentEvent` — os eventos novos

```ts
/**
 * Eventos ADITIVOS ao RunEvent existente. Vão pelo MESMO barramento
 * (`events.ts`), porque uma run de agente é uma run — quem já assina
 * `subscribe(runId, ...)` continua recebendo `stage.judged`, `run.spend`, etc.
 *
 * ⚠️ Consumidores existentes precisam IGNORAR tipos desconhecidos em silêncio.
 * O reducer da UI e o `emitRunEvent` do CLI já têm `switch` com casos
 * enumerados; sem `default`, o TypeScript acusa (bom) e, em runtime, um evento
 * novo simplesmente não faz nada (correto). Verificar isso é item de checklist
 * na Fase 3.
 */
export type RunEvent =
  | /* ...todos os de hoje... */
  | { type: 'agent.started'; runId: string; stageIndex: number; contestantId: string;
      execId: string; repetition: number }
  | { type: 'agent.turn'; runId: string; stageIndex: number; contestantId: string;
      execId: string; turn: number; costUsd: number }
  | { type: 'agent.tool'; runId: string; stageIndex: number; contestantId: string;
      execId: string; toolName: string; ok: boolean;
      /** Só para bash: o comando, truncado em 200 chars. NUNCA a saída. */
      summary?: string }
  | { type: 'agent.finished'; runId: string; stageIndex: number; contestantId: string;
      execId: string; stopReason: AgentStopReason; turns: number; costUsd: number;
      diffStat?: { files: number; added: number; removed: number } }
  | { type: 'agent.verified'; runId: string; stageIndex: number; contestantId: string;
      execId: string; results: { label: string; ok: boolean; exitCode: number }[] };
```

**Por que `agent.tool` não carrega a saída da ferramenta:** pela mesma razão que
`ndjson.ts` já documenta em maiúsculas — `competitor.finished` carregaria o
texto completo e estouraria a janela de contexto de quem faz `tail` no stream.
Um agente emite dezenas de tool calls por etapa; carregar saídas transformaria o
NDJSON num despejo de log. Quem quer a saída abre o arquivo.

## 7. Onde cada coisa mora

### 7.1 Arquivos novos em `src/`

```
src/agent/
  types.ts          AgentTaskSpec, AgentRunnerConfig, ExecutionRecord, AgentStopReason
  executor.ts       a interface `AgentExecutor` (contrato do adaptador)
  pi.ts             o adaptador do pi: argv, env, parse do stream, normalização
  spawn.ts          spawn seguro: pipes, timeout, kill de árvore, limites de bytes
  jsonl.ts          o splitter LF-estrito (NÃO use readline — §14.5)
  workspace.ts      preparar/derrubar workspace (worktree|clone|container), diff, files
  oracle.ts         rodar `verify[]`, montar OracleResult, detectar forbiddenPaths
  trajectory.ts     normalizar a trajetória do executor para o formato canônico
  dossier.ts        montar o dossiê determinístico (com truncamento marcado e redação)
  store.ts          layout em disco, escrita atômica, sha256, leitura por ref
  agentJudge.ts     os prompts do juiz pointwise e do duelo, para dossiês
  runAgentStage.ts  o "runCompetitor" do modo agente
  doctor.ts         diagnóstico + o auto-teste de sala limpa (§12.6)
src/cli/commands/agents.ts   os subcomandos `agents ...`
src/agentRoutes.ts           o router /v1/agents (montado condicionalmente)
```

### 7.2 Arquivos existentes tocados (e o quanto)

| Arquivo | Mudança | Tamanho |
|---|---|---|
| `src/types.ts` | 4 campos aditivos + `'agent'` em `CostRole` + eventos | ~40 linhas |
| `src/orchestrator.ts` | despacho `runner==='agent'` na fase 2; grupo de orçamento | ~60 linhas |
| `src/estimate.ts` | ramo de agente (teto por contrato, não por tokens) | ~50 linhas |
| `src/budget.ts` | `'agent'` nos mapas de rótulo | ~4 linhas |
| `src/runConfigSchema.ts` | schemas Zod de `agentTask`/`agent` | ~90 linhas |
| `src/refJudge.ts` | aceitar dossiê em vez de `response.text` | ~30 linhas |
| `src/duels.ts` | idem para o par | ~25 linhas |
| `src/cli/ndjson.ts` | mapear os 5 eventos novos (enxutos) | ~35 linhas |
| `src/cli/output.ts` | rótulo do papel `agent` | ~2 linhas |
| `src/cli/index.ts` | despacho de `agents` + help | ~10 linhas |
| `src/server.ts` | montagem condicional do router de agentes | ~8 linhas |
| `src/cli/commands/mcp.ts` | 2 ferramentas novas | ~60 linhas |
| `agent-docs/` | 2 tópicos + `index.json` | novo |
| `skills/prompt-builder/SKILL.md` | 1 seção | ~20 linhas |
| `package.json` | `files` inclui os docs novos | 1 linha |

### 7.3 O que **não** é tocado: `web/src/engine/`

O AGENTS.md manda sincronizar os dois lados do pipeline. **Aqui essa regra é
suspensa, e o motivo precisa ficar escrito no próprio código** (um comentário no
topo de `src/agent/executor.ts`), senão o próximo agente de programação vai
"consertar" a assimetria e criar um módulo que não pode funcionar:

> O motor client-side roda **no navegador**. Ele não tem `child_process`, não
> tem filesystem, não tem git e não pode spawnar processo. O modo agente não é
> *caro* de portar para lá — é **impossível**. A SPA estática da Vercel continua
> fazendo exatamente o que faz hoje: compare/variation/training de chat.

O que a SPA **pode** ganhar (opcional, Fase 5): **ler** runs de agente quando
apontada para um backend local, porque `GET /v1/benchmark/runs/:id` já devolve o
`RunRecord` e os campos novos são aditivos. Ler é seguro; criar não é.

---

# PARTE III — O executor: `pi` em sala limpa

## 8. O contrato do adaptador (o que o motor sabe do executor)

O orquestrador **não** pode saber o que é `pi`. Ele conhece só isto:

```ts
// src/agent/executor.ts

export interface AgentExecutor {
  /** Identidade, para o manifesto e o pré-voo. */
  readonly id: string;                       // 'pi'
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
   * isolamento está funcionando. Ver §12.6.
   */
  selfTest(opts: SelfTestOpts): Promise<CleanRoomReport>;
}
```

Ter esta interface desde a primeira linha custa quase nada e compra duas coisas:
(1) o dia em que quisermos avaliar Claude Code ou `codex exec` como competidores,
é um arquivo novo, não uma refatoração; (2) impede que particularidades do `pi`
vazem para `orchestrator.ts`, que é onde elas seriam impossíveis de remover.

## 9. Por que `pi` — a evidência, não a preferência

**[VERIFICADO LOCAL]** `pi` está instalado nesta máquina em
`~/.nvm/versions/node/v24.19.0/lib/node_modules/@earendil-works/pi-coding-agent`,
versão **0.84.2**, pacote npm `@earendil-works/pi-coding-agent`, licença MIT,
domínio `pi.dev`. Os `docs/` viajam **dentro do tarball** (33 arquivos), o que é
relevante: dá para casar a documentação com a versão exata do binário, do mesmo
jeito que este repositório faz com `agent-docs/`.

Os cinco motivos, cada um com a evidência:

**9.1 — Três modos headless, nenhum deles com prompt de confiança.**
**[VERIFICADO PESQUISA, 3-0]** `-p/--print`, `--mode json` e `--mode rpc`; a
doc afirma verbatim, em quatro lugares distintos (`usage.md`, `settings.md`,
`README`, `security.md`): *"Non-interactive modes (`-p`, `--mode json`, and
`--mode rpc`) do not show a trust prompt."* Confirmado no código publicado
(`src/cli/args.ts` define `Mode = "text" | "json" | "rpc"`; `resolveAppMode()`
cai em print quando não há TTY). Fonte:
<https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/usage.md>.
Para um harness isso é o requisito zero: qualquer diálogo interativo trava a
execução para sempre num processo sem terminal.

**9.2 — A trajetória inteira sai estruturada, sem raspar TUI.**
**[VERIFICADO PESQUISA, 3-0]** O ciclo de tool call vem em três fases
(`tool_execution_start{toolCallId,toolName,args}` → `tool_execution_update{partialResult}`
→ `tool_execution_end{result,isError}`), correlacionadas por `toolCallId`, mais
blocos tipados `text`/`thinking`/`toolCall{id,name,arguments}`. Fonte:
`docs/json.md` e `docs/rpc.md`.
E **[VERIFICADO PESQUISA, 3-0]**: dá para reconstruir tudo **sem** remontar
deltas — `message_end` é declarado autoritativo, `turn_end` traz
`{message, toolResults}` e `agent_end` traz `messages: AgentMessage[]`. Ou seja,
o consumidor filtra por `message_end`/`turn_end` e já tem transcript completo,
inclusive `usage`. Isso simplifica muito o nosso parser: **ignoramos
`message_update` inteiro**.

**9.3 — Transcript persistente, em árvore, com caminho redirecionável.**
**[VERIFICADO LOCAL]** Li um arquivo real de sessão em
`~/.pi/agent/sessions/--<cwd-slug>--/<ts>_<uuid>.jsonl` e extraí o schema:
tipos de linha `session`, `message`, `model_change`, `thinking_level_change`,
`custom`; roles `user`/`assistant`/`toolResult`; blocos `text`/`thinking`/`toolCall`;
e — o mais importante — **cada `AssistantMessage` carrega**
`usage.{input,output,cacheRead,cacheWrite,reasoning,totalTokens}` **e**
`usage.cost.{input,output,cacheRead,cacheWrite,total}`, além de `stopReason`,
`responseId` e `rawStopReason`. Também vi entradas `custom` de
`customType: "pi-checkpoint"` com `beforeCommit`, `afterCommit`, `prompt`,
`fileCount` e `fileChanges[{path,added,removed}]` — ou seja, o próprio `pi` já
pensa em git como substrato de checkpoint.
**[VERIFICADO PESQUISA, 3-0]** A precedência do diretório de sessão é
`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` do settings, e
`--no-session` desliga a gravação.

**9.4 — OpenRouter é provider embutido.**
**[VERIFICADO PESQUISA, 3-0 em duas claims, 2-1 em duas]** OpenRouter está na
lista de providers embutidos (OAuth PKCE por `/login openrouter` **ou**
`OPENROUTER_API_KEY`), e a precedência de credencial é `--api-key` > `auth.json`
> variável de ambiente. Fonte: `docs/providers.md`. Isso importa **muito** aqui:
é a mesma key que o resto da ferramenta já usa, o mesmo catálogo que
`modelsCache.ts` já baixa e a mesma unidade de dinheiro — sem isso, o benchmark
teria uma conta em dólares nossa e outra "conta do agente" impossível de
comparar.

**9.5 — A mesma escada de 7 degraus de esforço.**
**[VERIFICADO LOCAL + PESQUISA, 3-0]** `pi --help` lista
`--thinking <level>` com exatamente `off, minimal, low, medium, high, xhigh, max`
— **os mesmos sete degraus** de `ReasoningLevel` em `src/types.ts`. E para
OpenRouter o `pi` envia `reasoning: { effort }`, que é literalmente o que
`src/reasoning.ts` já monta. Consequência prática: `modelCaps`/`effortOptions`/
`thinkLevelsFor` (`src/modelCaps.ts`) transportam quase 1:1 para escolher o
esforço do agente, e a regra do AGENTS.md sobre `fitEffort` e o degrau `off`
continua valendo sem tradução. É uma coincidência feliz que economiza uma
camada inteira de mapeamento — e mais uma razão para não trocar de executor sem
motivo forte.

**9.6 — E os outros?** **[VERIFICADO PESQUISA]**
- *Claude Code headless* entrega `--output-format stream-json` (NDJSON, última
  linha é um `result` com custo) e multi-turn por `session_id` + `--resume`. Mas
  a reprodutibilidade **exige `--bare`**: sem ele, `claude -p` carrega hooks de
  `.claude/settings.json` e conecta servidores de `.mcp.json` mesmo em pasta
  nunca confiada. É um ótimo executor — mas o isolamento é uma flag tudo-ou-nada
  e não há rota nativa para OpenRouter. Fica como **segundo adaptador**, não como
  o primeiro.
- *mini-swe-agent* grava a run inteira em **um** `.traj.json`
  (`trajectory_format: "mini-swe-agent-1.1"`) com ações de shell parseadas,
  custo por chamada, `info.model_stats.instance_cost` e um `exit_status` que
  distingue `Submitted` de truncamento por limite. É o modelo de captura mais
  simples que existe e **é o único dos três cuja evidência inclui integração com
  benchmark** (`run/benchmarks/swebench.py`). Vale como inspiração de formato
  (o `exit_status` explícito é exatamente o nosso `AgentStopReason`), não como
  executor: é Python e o alvo aqui é Node.

**9.7 — O que o `pi` NÃO é: um sandbox.** **[VERIFICADO LOCAL]** `docs/security.md`
diz sem rodeios: *"Pi does not include a built-in sandbox"*, *"Project trust ... is
not a sandbox"*, e recomenda container/VM para automação desatendida. Ou seja: as
flags de §12 dão **sala limpa** (isolam *configuração*), não **contenção** (não
isolam *capacidade*). Confundir as duas coisas seria o erro de segurança mais
provável deste projeto. Ver §13.4.

## 10. O ciclo de vida de UMA execução

```
        ┌─ orquestrador (fase 2, por contestant × cenário × repetição) ─┐
        │                                                              │
  1. workspace.prepare()      git worktree/clone a partir do seed      │
  2. setup[]                  npm ci, build … (não é trabalho do agente)│
  3. files[]                  fixtures                                  │
  4. seedCommit = commit -am  "seed" (a régua do diff)                  │
  5. executor.run()           spawn do pi, stream JSONL, limites        │
  6. commit -A "agent-result" (workspace descartável ⇒ commitar é grátis)│
  7. workspace.collect()      diff, diffstat, lista de arquivos         │
  8. oracle.run()             verify[] + forbiddenPaths                 │
  9. trajectory.normalize()   pi → formato canônico                     │
 10. dossier.build()          o que o juiz vai ler (determinístico)     │
 11. store.write()            exec.json + artefatos + sha256            │
 12. workspace.dispose()      salvo se keepWorkspace                    │
        └──────────────────────────────────────────────────────────────┘
```

Três detalhes que não são óbvios:

**10.1 — O `seedCommit` é feito DEPOIS do setup e dos fixtures.** Se fosse antes,
o `node_modules` do `npm ci` apareceria no diff do agente e o dossiê teria 200 mil
linhas de dependência. O diff precisa medir *o que o agente fez*, não *o que o
ambiente trouxe*. (Mesmo com `.gitignore`, `git add -A` respeita o ignore — mas
tarefas sem `.gitignore` decente existem, e o commit pós-setup resolve isso sem
depender da higiene do repo-semente.)

**10.2 — Commitar o resultado é de graça e resolve os arquivos novos.** A
alternativa (`git add -A -N` + `git diff`) é mais "limpa" mas tem casos-limite com
renomeação e submódulo. Como o workspace é descartável, `git add -A && git commit`
é mais simples, gera um sha citável (`afterCommit`) e faz `git diff seed..HEAD`
capturar criações, remoções e renomeações sem exceção.

**10.3 — O oráculo roda DEPOIS do commit.** Assim, se um teste escrever arquivo
(cache, snapshot, `.pytest_cache`), esse lixo não polui o artefato julgado.

## 11. `spawn`, não `exec` — e as cinco armadilhas

**[JULGAMENTO]** — a pesquisa não cobriu o plumbing Node; isto é engenharia
padrão e cada regra vem com o modo de falha que ela evita.

**11.1 — `exec`/`execFile` têm `maxBuffer` (1 MiB default).** Estourar significa
matar o processo e receber um erro **em vez** da saída. Um agente que roda
`npm test` verboso passa disso em segundos. → **Sempre `spawn`**, com os pipes
consumidos e escritos direto em arquivo.

**11.2 — Nunca `shell: true`.** O prompt da tarefa vem de configuração do usuário
e pode conter aspas, `$(...)`, `;`. Com `shell: true` isso vira injeção de
comando na nossa própria linha. → argv como array, sempre.

**11.3 — Consumir os DOIS pipes, sempre.** Se lermos `stdout` e ignorarmos
`stderr`, o buffer do pipe (~64 KiB) enche e o filho **bloqueia para sempre**
escrevendo em stderr. O sintoma é "o agente travou" e ele não travou: nós
travamos ele. → ambos os streams são consumidos e drenados desde o primeiro byte,
mesmo quando não interessam.

**11.4 — Matar o processo não mata os filhos.** O agente roda `npm test`, que roda
`vitest`, que roda workers. Matar só o `pi` deixa uma árvore órfã consumindo CPU e
segurando o workspace (que não pode ser apagado). → `spawn(..., { detached: true })`
e, no timeout, `process.kill(-child.pid, 'SIGTERM')` (o `-` mata o **grupo**),
graça de 5s, depois `SIGKILL` no grupo. E `unref()` nunca — precisamos do `close`.

**11.5 — Fechar o stdin.** O prompt vai por stdin (§12.5). Se não chamarmos
`child.stdin.end()`, o `pi` pode ficar esperando mais entrada. → escrever e fechar.

Esqueleto (o completo está no Apêndice C.1):

```ts
const child = spawn(bin, argv, {
  cwd: workspaceDir,
  env,                 // ENV EXPLÍCITO, não `...process.env` — ver §12.2
  detached: true,      // grupo próprio ⇒ dá para matar a árvore
  stdio: ['pipe', 'pipe', 'pipe'],
});
child.stdin.end(taskPrompt);              // 11.5
child.stdout.pipe(eventsFile);            // stream JSONL cru, sempre em disco
child.stdout.on('data', feedSplitter);    // 11.3 + parser incremental
child.stderr.pipe(stderrFile);            // 11.3 — drenado mesmo se ignorado
```

## 12. A sala limpa — a receita, e como ela é *provada*

### 12.1 O que "instalação limpa" precisa neutralizar

O pedido diz "numa instalação limpa porque tem o mínimo de interferência
possível". Traduzindo para o que o `pi` de fato carrega, há **duas camadas** de
contaminação e elas exigem mecanismos diferentes:

| Camada | O que vaza | Neutralizador |
|---|---|---|
| **Global (`~/.pi/agent/`)** | `settings.json` (modelo/thinking default, extensões, pacotes), `auth.json`, `SYSTEM.md`/`APPEND_SYSTEM.md`, skills, temas, prompt templates, `AGENTS.md` global | `PI_CODING_AGENT_DIR=<dir vazio do run>` |
| **Projeto (cwd e ancestrais)** | `.pi/settings.json`, `.pi/SYSTEM.md`, `.pi/extensions|skills|prompts|themes`, `.agents/skills`, `AGENTS.md`/`CLAUDE.md`/`AGENTS.override.md` | `--no-approve` + `--no-context-files` + os `--no-*` de recurso |

**[VERIFICADO PESQUISA, 3-0]** — e este é o achado mais importante da pesquisa
para esta parte: as flags `--no-context-files`/`-nc` e `-na/--no-approve`
**NÃO produzem sala limpa completa**; extensões, skills, temas e `SYSTEM.md`
**globais continuam carregando**. Ou seja, quem só passar `-nc -na` está com a
sala suja e não sabe. Fonte: `docs/usage.md`, `docs/settings.md`, `docs/security.md`.

**[VERIFICADO LOCAL]** `docs/environment-variables.md` documenta
`PI_CODING_AGENT_DIR` como *"Override the config directory; default is
`~/.pi/agent`"* — e como settings, auth, extensões, skills, temas e `SYSTEM.md`
todos moram embaixo desse diretório, apontá-lo para um diretório vazio derruba a
camada global inteira de uma vez. Eu testei: rodar `pi --version` com
`PI_CODING_AGENT_DIR` apontado para um diretório temporário **não criou nada** lá
nem tocou no home real.

> ⚠️ **Consequência que morde:** com `PI_CODING_AGENT_DIR` vazio não há
> `auth.json`. A credencial **tem** que vir por `--api-key` ou variável de
> ambiente. Isso é bom (explícito) e é o comportamento que queremos, mas quem
> esquecer vai ver "sem credencial" e culpar a flag errada.

### 12.2 A receita exata

```bash
# Diretórios por RUN (não por execução — o binário e a config são os mesmos):
#   $RUN/pi-home/      PI_CODING_AGENT_DIR  (vazio: mata a camada global)
#   $RUN/pi-bin/       prefixo do npm quando install='isolated'
# Diretórios por EXECUÇÃO:
#   $EXEC/session/     PI_CODING_AGENT_SESSION_DIR / --session-dir
#   $EXEC/workspace/   cwd do agente

env -i \
  HOME="$RUN/pi-home" \
  PATH="/usr/bin:/bin:/usr/local/bin" \
  LANG=C.UTF-8 TZ=UTC \
  PI_CODING_AGENT_DIR="$RUN/pi-home" \
  PI_CODING_AGENT_SESSION_DIR="$EXEC/session" \
  PI_OFFLINE=1 \
  PI_SKIP_VERSION_CHECK=1 \
  PI_TELEMETRY=0 \
  OPENROUTER_API_KEY="$KEY" \
  GIT_TERMINAL_PROMPT=0 \
  GIT_AUTHOR_NAME=agent GIT_AUTHOR_EMAIL=agent@local \
  GIT_COMMITTER_NAME=agent GIT_COMMITTER_EMAIL=agent@local \
  "$PI_BIN" \
    --mode json \
    --provider openrouter \
    --model "$MODEL" \
    --thinking "$THINKING" \
    --session-dir "$EXEC/session" \
    --no-context-files \
    --no-extensions \
    --no-skills \
    --no-prompt-templates \
    --no-themes \
    --no-approve \
    --tools read,write,edit,bash,grep,find,ls \
    --append-system-prompt "$PROMPT_SOB_TESTE" \
  < "$EXEC/task.txt" \
  > "$EXEC/events.jsonl" \
  2> "$EXEC/stderr.log"
```

Linha a linha, o que cada uma compra:

| Item | Neutraliza | Se faltar |
|---|---|---|
| `env -i` + env explícito | variáveis do shell do dev (`ANTHROPIC_API_KEY`, `NODE_OPTIONS`, proxies, `EDITOR`) | o resultado depende de quem rodou |
| `HOME=$RUN/pi-home` | qualquer coisa que resolva `~` | ferramentas auxiliares acham config do dev |
| `PI_CODING_AGENT_DIR` | **toda a camada global do pi** | settings/skills/extensões/SYSTEM.md do dev entram no experimento |
| `PI_CODING_AGENT_SESSION_DIR` + `--session-dir` | transcript indo para o home real | o log fica fora do run e some na próxima limpeza |
| `PI_OFFLINE=1` | update check, telemetria, update de pacotes | a versão pode mudar **no meio do benchmark** |
| `PI_SKIP_VERSION_CHECK=1` | request a `pi.dev` | latência e um ponto de falha de rede |
| `PI_TELEMETRY=0` | ping de instalação + headers de atribuição | ruído externo e um vazamento de metadado |
| `--no-context-files` | `AGENTS.md`/`CLAUDE.md` (inclusive do repo-alvo!) | o repo-semente instrui o agente e o experimento vira outro |
| `--no-extensions/-skills/-prompt-templates/-themes` | recursos globais e de projeto | ver o achado 3-0 acima: `-nc -na` sozinhos não bastam |
| `--no-approve` | confiança em `.pi/` do projeto | um repo-semente hostil altera as settings do agente |
| `--tools <lista>` | superfície de ferramenta variando entre execuções | dois contestants com poderes diferentes |
| `GIT_TERMINAL_PROMPT=0` | git parando para pedir senha num processo sem TTY | trava até o timeout |
| `GIT_*_NAME/EMAIL` | commit falhando por identidade ausente | o `seedCommit` falha e não há régua de diff |
| `< task.txt` | prompt gigante em `argv` (ARG_MAX, quoting, aspas) | falha aleatória em tarefas longas |
| `--mode json` | ter de raspar TUI | nada de trajetória estruturada |

> ⚠️ **`--no-context-files` também apaga o `AGENTS.md` do repositório-alvo.**
> Isso é o certo por padrão (o experimento controla o que o agente lê), mas é uma
> decisão de produto: se a tarefa é "consertar um bug **neste** repo, respeitando
> as convenções dele", o `AGENTS.md` faz parte do enunciado. Por isso
> `AgentTaskSpec` deveria ganhar, na Fase 2, um `contextFiles?: boolean`
> (default `false`) — e o dossiê **registra** qual foi o valor, porque um leitor
> que não sabe disso compara maçã com laranja.

### 12.3 Por que forçar `--provider openrouter`

Quatro razões, em ordem de peso:

1. **Uma key só.** A ferramenta já exige `OPENROUTER_API_KEY` e já a valida
   (`validateKey`, `/key`). Um segundo provedor significa um segundo segredo, um
   segundo lugar para faltar crédito e um segundo modo de falha no pré-voo.
2. **Um catálogo só.** `modelsCache.ts` já baixa `/models` com
   `supported_parameters` e `reasoning.supported_efforts`. O mesmo id de modelo
   vale nos dois lados; `estimate.ts` já sabe precificar; `fitEffort` já sabe
   encaixar o degrau. Com outro provedor, todo esse conhecimento vira chute.
3. **Uma unidade de dinheiro.** Custo do juiz e custo do agente na mesma moeda,
   no mesmo ledger, com o mesmo teto. É o que torna `--budget` honesto.
4. **Uma rota de reconciliação.** O OpenRouter devolve o custo cobrado em
   `usage.cost`; o `pi` guarda `responseId` em cada mensagem. Isso abre o caminho
   de promover o custo de derivado a medido (§20.4).

Não é uma trava: `AgentRunnerConfig.provider` existe. Mas o default é
`openrouter` e sair dele deveria emitir aviso, porque três das quatro garantias
acima caem juntas.

### 12.4 Esforço de raciocínio: reusar o que já existe

`src/modelCaps.ts` já expõe `thinkLevelsFor(modelId)` a partir do catálogo real —
e o AGENTS.md avisa que ele **não** roda `fitEffort` no degrau `off`, de propósito
("desligar raciocínio usa `{ enabled: false }`, não um degrau"). Como o `pi` usa
**a mesma escada de sete degraus** e envia `reasoning: { effort }` para OpenRouter,
a regra transporta inteira:

- `config.agent.thinking` é validado contra `thinkLevelsFor(modelo do agente)`
  no **pré-voo**, não em runtime. Um degrau não suportado vira HTTP 400 lá dentro
  do `pi`, e um 400 dentro do agente aparece como "o agente falhou" — o erro mais
  caro de diagnosticar que existe neste sistema.
- Se o modelo tem `reasoning.mandatory`, o degrau `off` **não** é passado (a flag
  simplesmente não vai), exatamente como o backend já faz.

### 12.5 O prompt: o que é system e o que é a tarefa

| Peça da etapa | Para onde vai no `pi` | Por quê |
|---|---|---|
| `stage.productContext` | `--append-system-prompt` (ou `--system-prompt` em `promptMode: 'replace'`) | É o contexto/política — o análogo exato do `role: 'system'` de `runCompetitor`. |
| `contestant.systemPrompt` (variation/training) | idem, concatenado depois | É **o que está sob teste**. |
| `stage.question` | **stdin** (o prompt inicial) | É a tarefa. Vai por stdin para não passar por `argv`. |
| `stage.agentTask.limits` | flags/limites impostos pelo runner | Contrato de custo. |
| `stage.rubric` | **NÃO vai para o agente** | A rubrica é a régua do juiz. Entregá-la ao agente é dar o gabarito da prova para o aluno — e é reward hacking servido de bandeja. |
| `stage.reference` | **NÃO vai para o agente** | Idem, com mais força ainda. |

**A distinção `replace` vs `append` merece ênfase.** **[VERIFICADO LOCAL]** o
README do `pi` diz que `--system-prompt` *"Replace default prompt (context files
and skills still appended)"*. Então:

- Em `'replace'`, você está medindo **"este texto é um bom system prompt de
  agente?"** — e o agente perde as instruções de uso de ferramenta que o prompt
  default do `pi` dá. É a pergunta certa quando o objeto sob teste É o prompt de
  agente inteiro, e é uma armadilha quando não é (o agente vira burro e você
  conclui que o prompt é ruim).
- Em `'append'`, você mede **"esta instrução melhora um agente competente?"**.
  É o default porque é a pergunta que quase todo mundo está fazendo.
- Em `'none'`, nada é injetado: é o modo do `compare` de **modelos** como agentes,
  onde a única variável é o modelo.

Confundir esses três é o erro metodológico mais provável do projeto inteiro. Por
isso o `promptMode` **entra no cabeçalho do dossiê e no CSV** — para que uma
comparação entre runs com modos diferentes seja visivelmente inválida.

### 12.6 O auto-teste de sala limpa (`agents doctor --deep`)

Aqui é onde este plano deixa de *acreditar* na sala limpa e passa a **medi-la**,
que é a cultura deste repositório ("meça o contraste em vez de julgar a olho";
"revalide com o catálogo real: 214 modelos × 7 níveis, 0 violações").

O procedimento, uma chamada barata de LLM:

1. Cria um projeto temporário com um `AGENTS.md` contendo um token único
   (`CANARY-PROJETO-<uuid>`) e um `.pi/SYSTEM.md` com outro token
   (`CANARY-PROJETO-SYSTEM-<uuid>`).
2. Cria um `pi-home` temporário com `AGENTS.md`, `SYSTEM.md` e um `settings.json`
   com `defaultThinkingLevel: "max"` e um tema — cada um com o seu token
   (`CANARY-GLOBAL-*`).
3. Roda o `pi` com a receita de §12.2 e a tarefa: *"Repita literalmente, entre
   marcadores, TODO o texto de sistema e de contexto que você recebeu. Não use
   ferramentas."* (com `--no-tools`, para custar quase nada).
4. Lê a trajetória e **afirma**: nenhum token `CANARY-*` aparece; o
   `thinking_level_change`/`model_change` batem com o que foi pedido (e não com o
   `settings.json` envenenado); nenhuma entrada de extensão/skill aparece.
5. Devolve `CleanRoomReport { ok, leaks: string[], piVersion, flagsUsed }`.

**Por que isso vale o esforço:** as flags do `pi` mudam. **[VERIFICADO PESQUISA]**
o projeto lançou 41 versões desde 2026-05-07 e teve push no mesmo dia da pesquisa;
uma claim sobre a árvore de configuração dele foi **refutada 0-3** justamente
porque a doc simplificava. Um auto-teste transforma "as flags deviam isolar" em
"medimos que isolam **nesta** versão" — e vira o teste de regressão que este
repositório não tem (não há framework de teste: a verificação é type-check +
execução manual). `agents doctor` roda no pré-voo por padrão, com cache de
resultado por (versão do pi × conjunto de flags).

## 13. Isolamento do workspace

### 13.1 `git worktree` como default

Para cada execução:

```bash
git -C "$CACHE/<repoHash>" worktree add --detach "$EXEC/workspace" "$REF"
```

**Por que worktree e não clone:** o objeto-store é compartilhado, então N
execuções do mesmo repo custam N *checkouts*, não N *clones*. Num benchmark de
5 cenários × 4 contestants × 3 repetições = 60 checkouts, a diferença entre
worktree e clone é a diferença entre segundos e minutos (e entre centenas de MB
e dezenas de GB). O repo-semente é clonado **uma vez** por run, num cache
endereçado por hash de `(url|path, ref)`.

**Cuidados:**
- `--detach` sempre: worktrees não podem compartilhar branch, e um agente que
  faz `git commit` numa branch compartilhada corromperia a execução vizinha.
- `git worktree remove --force` no dispose, e `git worktree prune` no fim da run
  (um processo morto deixa registro órfão em `.git/worktrees/`).
- Se o repo-semente for um **caminho local** (o caso comum: "teste um agente
  neste projeto aqui"), **nunca** aponte o worktree para o repositório de
  trabalho do usuário. Clone-o para o cache primeiro. Um agente com bash rodando
  dentro de um worktree do repo real pode `git checkout` outra coisa, mexer no
  index ou rodar `git clean -xdf` na raiz. O cache é a barreira.

### 13.2 `clone` quando worktree não serve

Tarefas que mexem em `.git` (rebase, bisect, hooks, submódulo) precisam de um
repositório de verdade. `isolation.kind: 'clone'` faz `git clone --local` do
cache — ainda barato (hardlinks), mas independente.

### 13.3 Workspace vazio

Sem `repo`, o workspace é `git init` + commit vazio (`--allow-empty`). Serve para
tarefas do tipo "escreva um script que faz X" e mantém a definição de artefato
idêntica (diff contra o commit vazio = tudo o que o agente criou).

### 13.4 Contenção (container) — opcional, e por que não é o default

**[VERIFICADO LOCAL]** o `pi` documenta três padrões (`docs/containerization.md`):
processo inteiro em Docker, micro-VM Gondolin roteando as ferramentas, e OpenShell.
E é explícito: bind-mount read/write deixa o container escrever no host.

`isolation.kind: 'container'` fica **previsto e não implementado na v1**, com o
raciocínio escrito:

- **Contra o default:** exige Docker instalado, torna o `agents doctor` bem mais
  complexo, aumenta muito a latência de cada execução (pull + start), complica o
  cache de `npm ci` e — o mais importante — **não é o gargalo de correção**. O que
  ameaça a validade do experimento hoje é contaminação de *configuração* (sala
  suja), não fuga de *capacidade*.
- **A favor, e por que vai ser preciso:** o `pi` roda com as permissões do usuário
  e não tem popup de permissão. Rodar um agente desconhecido, com prompt
  desconhecido, sobre um repo desconhecido, sem contenção, é aceitar RCE. No
  minuto em que este harness rodar **prompts que não são nossos** ou **repos que
  não são nossos**, container deixa de ser opcional.
- **A regra prática para a v1:** worktree para código nosso em máquina nossa;
  container obrigatório para qualquer coisa vinda de fora. E `POST /v1/agents/runs`
  (§23) **recusa** `isolation.kind: 'worktree'` quando a requisição não vem de
  localhost.

### 13.5 Rede

Não há como cortar a rede do agente sem container: ele **precisa** de rede para
falar com o modelo. Duas mitigações realistas na v1:

- **`PI_OFFLINE=1`** já corta as chamadas de *startup* do próprio `pi`.
- **Declarar**, não impedir: o dossiê registra todo comando bash executado, então
  um `curl` para fora fica visível para o juiz e para a auditoria. É observação,
  não prevenção — e o documento precisa dizer isso com todas as letras, para
  ninguém confundir "está no log" com "está contido".

Com container (Fase 5), `--network=none` para tarefas cujo `setup` já baixou tudo
é a mitigação de verdade — só que aí o agente não fala com o modelo, o que exige
um proxy de inferência. Isso é escopo de outra fase, e o `docs/containerization.md`
do `pi` descreve o padrão OpenShell exatamente para isso.

---

# PARTE IV — A captura: o que é "log completo"

> O pedido é explícito: *"tenhamos todo o histórico do que foi feito capturado"*
> e *"esses logs devem ser completos"*. Esta parte define **completo** de um jeito
> verificável, e resolve a tensão entre "completo" e "cabe no juiz".

## 14. As sete fontes de verdade

Nenhuma delas sozinha é o log. **Completo** = todas as sete, guardadas juntas,
com o `sha256` de cada uma:

| # | Fonte | O que só ela tem | Arquivo |
|---|---|---|---|
| 1 | **Transcript do executor** (session JSONL do `pi`) | o diálogo inteiro: `user`/`assistant`/`toolResult`, blocos `thinking`, `usage`+`cost` por mensagem, `stopReason`, `responseId`, mudanças de modelo/esforço | `session/<ts>_<uuid>.jsonl` |
| 2 | **Stream de eventos** (`--mode json`) | a ordem temporal real, `tool_execution_*` com `args`/`result`/`isError`, e o que aconteceu **antes** de um crash (o transcript pode não ter sido gravado) | `events.jsonl` |
| 3 | **stderr do processo** | erros do executor que nunca viram evento (crash de parse, falha de credencial, stack trace) | `stderr.log` |
| 4 | **Código de saída + sinal** | a diferença entre "terminou", "estourou o limite" e "nós matamos" | `exec.json` |
| 5 | **Artefato** (`git diff seed..HEAD` + `--stat` + lista de arquivos) | **o que mudou no mundo** — a única fonte que mede resultado em vez de intenção | `workspace.diff`, `workspace.stat`, `files.json` |
| 6 | **Oráculo** (`verify[]`: comando, exit code, saída) | o veredito que não depende de LLM | `oracle.json` |
| 7 | **Manifesto de execução** | argv exato, env (com segredos redigidos), versão do executor, sha do seed, limites, hashes | `exec.json` |

**Por que 1 e 2 juntos, se parecem redundantes?** Não são.
**[VERIFICADO PESQUISA]** o `--mode json` emite eventos em tempo real e `--no-session`
existe — ou seja, os dois canais são independentes por construção. Na prática:
o stream (2) é o que chega **ao vivo** (vira `agent.turn`/`agent.tool` no SSE e
no NDJSON) e é o que sobra quando o processo morre no meio; o transcript (1) é
canônico, tem a árvore `id`/`parentId` e é o que o `pi` sabe reabrir (`--session`,
`--fork`) para **replay**. Guardar os dois custa disco e compra as duas
propriedades. Guardar só um perde uma delas — e qual delas você perde só se
descobre no dia do incidente.

**Por que o manifesto (7) é uma fonte e não metadado:** sem `argv` + `env` + versão
do executor + sha do seed, o log **não é reproduzível**, e um log irreproduzível
não é evidência, é anedota. Este é o mesmo raciocínio que fez o repo guardar
`config` inteiro dentro do `RunRecord`.

### 14.1 Layout em disco

```
<dataDir>/agent-runs/<runId>/
  manifest.json                      # run: executor, versão, isolamento, key redigida
  repo-cache/<repoHash>/             # clone bare/espelho do seed (compartilhado)
  stages/<stageIndex>/
    task.json                        # o AgentTaskSpec resolvido (defaults aplicados)
    <contestantId>/<repetition>/
      exec.json                      # ExecutionRecord (§Apêndice A.2)
      task.txt                       # o prompt inicial, byte a byte, como foi para stdin
      argv.json                      # argv exato + env redigido
      events.jsonl                   # stream --mode json, cru
      session/<...>.jsonl            # transcript do pi, cru
      stdout.log stderr.log
      workspace.diff workspace.stat files.json
      oracle.json
      trajectory.json                # normalizado (§15)
      dossier.md                     # EXATAMENTE o que o juiz leu
      digests.json                   # sha256 de cada arquivo acima
```

Regras do store:

- **Escrita atômica** (tmp único + rename), reusando o padrão de `storage.ts` —
  inclusive o motivo: `${target}.${randomUUID()}.tmp`, porque duas escritas
  concorrentes brigando pelo mesmo `.tmp` já derrubaram uma run neste repo.
- **Nada disso entra no `RunRecord`.** Só o `ExecutionRef`.
- **`digests.json` é escrito por último** e cobre todos os outros. Se ele não
  existe, a execução foi interrompida durante a coleta e o `ExecutionRef` é
  marcado incompleto.
- **Caminhos relativos** dentro do record; o absoluto é montado com `getDataDir()`.
  Um record com caminho absoluto não sobrevive a `--data-dir` diferente.

### 14.2 Redação de segredos — obrigatória, na escrita

`argv.json` e `manifest.json` **nunca** guardam a key. A redação acontece **no
momento da escrita** (não na leitura), com uma lista de padrões: o valor de
`OPENROUTER_API_KEY`, `--api-key`, `sk-or-*`, `sk-ant-*`, e qualquer env cujo nome
case `/(KEY|TOKEN|SECRET|PASSWORD)/i`. Marcado como `"<redigido>"`.

Motivo de ser na escrita: um arquivo em disco vaza por backup, por `scp`, por
anexo em issue. Redigir na leitura protege a UI e deixa o disco pelado.

### 14.3 O transcript pode conter segredo do *usuário*

O agente lê arquivos do workspace. Se o repo-semente tem `.env`, o conteúdo pode
entrar no transcript. Duas defesas na v1:

1. `setup` roda `git rm --cached` de padrões de segredo? Não — invasivo demais.
   Em vez disso: **`AgentTaskSpec.forbiddenPaths` aceita padrões de leitura
   proibida** e o dossiê marca leitura de arquivo casando `.env*`, `*.pem`,
   `id_rsa*`, `credentials*` como **evento de risco**, visível ao juiz e ao humano.
2. O `agents doctor` avisa quando o repo-semente contém arquivos que casam esses
   padrões, antes de gastar.

Isto é observabilidade, não prevenção — e o documento diz isso porque a alternativa
(fingir que previne) é pior.

### 14.4 Volume esperado

Ordem de grandeza, para dimensionar disco e decisões:

| Item | Típico | Ruim |
|---|---|---|
| `events.jsonl` (20 turnos, bash verboso) | 0,5–3 MB | 50 MB+ |
| `session/*.jsonl` | 0,2–1 MB | 20 MB |
| `workspace.diff` | 2–50 KB | 5 MB (lockfile, snapshot) |
| **Total por execução** | ~1–5 MB | ~80 MB |
| Run 5 cenários × 4 contestants × 3 reps = 60 execuções | **60–300 MB** | **~5 GB** |

Daí `maxOutputBytes` (default 8 MiB por execução) e `maxDiffBytes` (512 KiB) não
serem paranoia: são o que impede uma run de encher o disco do usuário. E daí, de
novo, trajetória **não** poder morar dentro do `RunRecord`.

### 14.5 ⚠️ O parser: **não use `readline`**

**[VERIFICADO PESQUISA, 3-0]** — este é o achado mais fácil de ignorar e mais
caro de descobrir em produção. A doc do `pi` avisa que o protocolo é *"strict
LF-delimited JSONL"* e que **o `readline` do Node é não-conforme**, porque também
quebra linha em U+2028/U+2029 — que são **caracteres válidos dentro de uma string
JSON**. Um agente que leia um arquivo contendo um separador de linha Unicode
(muito comum em JS minificado e em texto colado de web) faz o `readline` partir o
JSON no meio, e o parse falha **de forma intermitente e dependente de conteúdo**.
Fonte: `docs/rpc.md`.

O splitter correto (código completo no Apêndice C.2): `spawn` + `StringDecoder`
+ buffer manual com `indexOf('\n')`, tolerando `\r` final, com flush no `end`, e
uma **linha inválida nunca derruba a execução** — ela é contada em
`exec.json.parseErrors` e a execução segue (degradar, nunca derrubar). Se
`parseErrors > 0`, o `ExecutionRef` é marcado e o dossiê diz quantas linhas se
perderam, porque um dossiê montado a partir de um stream parcialmente ilegível
não pode se apresentar como completo.

## 15. A trajetória normalizada

### 15.1 Por que normalizar

Se `dossier.ts`, `agentJudge.ts` e a UI lerem o formato do `pi` direto, trocar de
executor vira reescrita. A normalização é uma função pura
(`trajectory.ts: fromPi(events, session) → AgentTrajectory`) que roda uma vez e
grava `trajectory.json`. O bruto continua em disco — normalizar não é descartar.

```ts
export interface AgentTrajectory {
  format: 'agent-trajectory@1';
  executor: { id: string; version: string };
  model: { provider: string; id: string; thinking?: ReasoningLevel };
  startedAt: string; finishedAt: string; durationMs: number;
  stopReason: AgentStopReason;
  turns: AgentTurn[];
  usage: { tokensIn: number; tokensOut: number; tokensReasoning: number;
           cacheRead: number; cacheWrite: number;
           costUsd: number; costSource: 'agent-derived' | 'reconciled' };
  /** Linhas do stream que não deram parse (§14.5). > 0 ⇒ trajetória incompleta. */
  parseErrors: number;
  /** Compactação de contexto ocorrida durante a execução (o pi faz isso sozinho). */
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
  tool: string;                       // 'bash' | 'edit' | 'write' | 'read' | ...
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
```

### 15.2 `stopReason`: a lição do mini-swe-agent

**[VERIFICADO PESQUISA]** o `.traj.json` do mini-swe-agent tem um `exit_status`
que **distingue `Submitted` de truncamento por limite**. Isso é exatamente a
distinção que este repositório já defende em outro contexto:
`StageRecord.incomplete` existe para separar *"parou cedo, honesto"* de
*"terminou, mentindo"*.

A regra derivada, e ela é dura:

> **`stopReason !== 'completed'` ⇒ a resposta é `incomplete` e a etapa não entra
> no placar daquele contestant.** Um agente cortado no turno 30 não "resolveu
> parcialmente": ele não terminou. Contá-lo como `parcial` inventaria um resultado;
> contá-lo como `nao` puniria o contestant pelo nosso teto.

Exceção deliberada: quando **existe oráculo e ele passa**, `stopReason: 'maxTurns'`
ainda pode valer `resolve` — porque o mundo mudou de forma verificável, e o
critério de sucesso é o teste, não a educação do agente ao se despedir. Essa
exceção precisa estar no código com comentário, senão alguém a remove por parecer
inconsistente.

## 16. O DOSSIÊ — o que o juiz realmente lê

### 16.1 O problema, em números

Um cenário com 4 contestants × 3 repetições = 12 trajetórias de ~2 MB = ~24 MB.
Nenhum juiz lê isso. Mesmo um contexto de 1M tokens não resolve: o juiz teria de
processar ~500 mil tokens por veredito, o custo por etapa explodiria, e a atenção
sobre o que importa (o diff) afundaria num mar de saída de `npm install`.

### 16.2 A escolha: dossiê determinístico, não resumo por LLM

**[JULGAMENTO]** — a pesquisa não trouxe evidência sobre sumarização hierárquica
de trajetória, e este é justamente um ponto onde eu prefiro a opção auditável.

Duas saídas eram possíveis:

- **(A) Sumarizar a trajetória com um LLM antes do juiz.** Barato de escrever,
  caro de confiar: insere um modelo **não auditado** entre a evidência e o
  veredito. Se o sumarizador omitir que o agente editou o teste, o juiz aprova e
  ninguém nunca descobre — o erro fica invisível **por construção**, porque o
  resumo não é comparável com nada. Além disso, adiciona um papel de custo e um
  ponto de falha em cima de um pipeline que já degrada exceção por design.
- **(B) Montar o dossiê por código, com regras fixas e truncamento marcado.**
  Determinístico (mesma execução ⇒ mesmo dossiê ⇒ mesmo `sha256`), auditável
  (o dossiê é salvo), barato (zero LLM), e o que ele **não** mostra está
  explicitamente marcado como não mostrado.

**Escolha: (B).** Sumarização por LLM fica como *fallback de última instância*
(§16.6), ligada por flag, **sempre marcada no record** — porque um veredito
apoiado em resumo de LLM não tem a mesma força que um apoiado em evidência
direta, e o record precisa dizer qual dos dois foi.

O paralelo com o repositório é direto: `JudgeResult.rawJudgeText` já existe para
que se possa ver o que o juiz respondeu. `dossier.md` é o outro lado: o que o juiz
**leu**. Com os dois, um veredito estranho é diagnosticável em dois minutos.

### 16.3 Estrutura do dossiê (ordem fixa, orçamento fixo)

A ordem importa: o que é mais decisivo vem primeiro, porque é o que sobrevive a
qualquer truncamento e é onde a atenção do modelo é melhor.

```
### 1. CABEÇALHO                                    (~200 tokens, nunca truncado)
    tarefa, candidato (LETRA CEGA), promptMode, limites, stopReason,
    turnos, duração, nº de tool calls, custo, e o AVISO de truncamento se houver.

### 2. VERIFICAÇÃO AUTOMÁTICA                        (~600 tokens, nunca truncado)
    por comando: rótulo, exit code, esperado, PASSOU/FALHOU
    + as últimas ~40 linhas da saída de cada comando que FALHOU
    + violações de forbiddenPaths (lista de caminhos)

### 3. RESUMO DAS MUDANÇAS                           (~200 tokens, nunca truncado)
    git diff --stat  (arquivos, +linhas, -linhas)
    + lista completa de arquivos criados/modificados/apagados/renomeados

### 4. DIFF                                          (orçamento ~55% do total)
    o patch unificado, arquivo a arquivo, na ordem: código > config > teste > doc
    (a ordem é por RELEVÂNCIA, não alfabética: o que decide o veredito vem antes
     do que provavelmente será cortado)
    cada arquivo truncado individualmente, com marca:
      [... 214 linhas omitidas neste arquivo ...]

### 5. O QUE O AGENTE FEZ                            (orçamento ~25% do total)
    lista NUMERADA de passos: turno, ferramenta, argumento essencial
    (para bash: o comando; para edit/write: o caminho), ok/erro, exitCode
    + para os passos que FALHARAM: as últimas ~15 linhas da saída
    (a saída dos passos que deram certo NÃO entra — é o maior volume e o menor
     sinal; quando importa, ela está em events.jsonl)

### 6. MENSAGEM FINAL DO AGENTE                       (~500 tokens)
    o último texto do assistente, truncado no fim se preciso

### 7. RODAPÉ DE INTEGRIDADE                          (~80 tokens, nunca truncado)
    dossierComplete: true|false
    seções truncadas: [...]
    parseErrors: N
    sha256 do dossiê
```

### 16.4 As sete regras do montador

1. **Orçamento em tokens, declarado.** `judgeDossierTokens` (default 12.000)
   entra na config. O montador estima por caracteres/4 e corta por seção segundo
   os percentuais acima. Um cenário grande não pode fazer o juiz custar 10× o
   previsto — a estimativa de custo (§20) depende deste teto ser real.
2. **Truncar é sempre visível.** Nunca cortar em silêncio. Cada corte deixa
   `[... N linhas omitidas ...]`, e o rodapé lista as seções afetadas.
3. **Seções 1, 2, 3 e 7 nunca são truncadas.** Se o orçamento não couber nelas, o
   orçamento está configurado errado — erro de config (exit 3), não corte.
4. **Truncar no MEIO, não no fim** (para diff e saídas): o começo (contexto) e o
   fim (resultado) carregam mais sinal que o miolo.
5. **Redação de identidade quando o julgamento é cego.** A trajetória do `pi`
   carrega `provider` e `model` em **toda** mensagem. Se isso vazar para o juiz,
   ele sabe quem é o candidato — e viés de auto-preferência é um risco conhecido
   e gratuito de eliminar aqui. O montador remove `provider`/`model`/`responseId`
   e substitui labels de contestant pela letra cega, contando as substituições em
   `redactions`. **Se `redactions` for 0 num julgamento cego, é bug**, não sorte.
6. **Determinismo total.** Sem timestamps relativos ("há 3 min"), sem ordem de
   `Object.keys`, sem caminho absoluto. Mesmo `exec.json` ⇒ mesmo byte.
   Consequência boa: dá para *cachear* o veredito por `sha256(dossiê)+juiz+rubrica`
   e não pagar de novo ao reprocessar.
7. **Ruído fora.** Filtro de caminhos que nunca entram no diff julgado:
   `node_modules/`, `dist/`, `build/`, `.next/`, `coverage/`, `*.lock`,
   `package-lock.json`, `*.min.js`, `*.map`, binários. Eles entram no
   **`--stat`** (o juiz vê que existiram) mas não no patch. Sem esse filtro, um
   `package-lock.json` de 15 mil linhas come o orçamento inteiro e o juiz não vê
   a mudança de 3 linhas que decide a etapa.

### 16.5 Duas variantes do dossiê

- **`full`** — para o juiz pointwise (orçamento cheio).
- **`compact`** — para os duelos, onde **dois** dossiês entram no mesmo prompt.
  Metade do orçamento, seções 4 e 5 mais agressivamente cortadas, seção 6 fora.
  Os dois lados de um duelo usam **exatamente** o mesmo orçamento e as mesmas
  regras: um dossiê maior que o outro é viés de verbosidade servido de graça.

### 16.6 O fallback de sumarização (previsto, desligado)

Se, mesmo com `compact`, um diff legítimo não couber (refatoração enorme), a
saída é `dossierMode: 'summarized'`: um passe de LLM **por arquivo** produzindo
"o que mudou neste arquivo", com o resultado **salvo** ao lado do dossiê. O
veredito resultante recebe `evidence: 'summarized'` no record, e o relatório
final avisa. Não é o default; é a alternativa honesta a truncar uma evidência
decisiva.

---

# PARTE V — O julgamento

## 17. A régua: três fontes, uma hierarquia

**[JULGAMENTO]** — a pesquisa **não** cobriu Agent-as-a-Judge, rubricas de
processo, nem vieses nesse regime (ver Parte XI). O que segue é a extensão
disciplinada do que este repositório já faz para chat, com a hierarquia desenhada
para que a parte não verificada (o LLM) tenha o menor poder possível.

```
        ┌──────────────────────────────────────────────────────────┐
        │  1. ORÁCULO         determinístico   → decide, quando existe
        │  2. GABARITO        referência       → ancora o juiz LLM
        │  3. RUBRICA         critério escrito → ancora quando não há gabarito
        └──────────────────────────────────────────────────────────┘
```

### 17.1 O oráculo (`verify[]`)

Roda no workspace **depois** do commit do agente. Produz:

```ts
export interface OracleResult {
  checks: { label: string; cmd: string; exitCode: number; expected: number;
            ok: boolean; weight: number; durationMs: number;
            /** Últimas N linhas, guardadas inteiras em oracle.json. */
            tail: string }[];
  /** Soma ponderada dos ok / soma dos pesos, em [0,1]. */
  score: number;
  /** Caminhos proibidos que foram modificados. Não-vazio ⇒ veredito 'nao'. */
  violations: string[];
  /** true = algum check não pôde rodar (comando ausente, timeout do próprio check). */
  inconclusive: boolean;
}
```

Mapeamento para veredito:

| Situação | Veredito | Juiz LLM |
|---|---|---|
| `violations.length > 0` | **`nao`** | não roda (economiza e é indiscutível) |
| `score === 1` | **`resolve`** (candidato) | roda só para **graduar qualidade** e escrever o motivo; **não pode rebaixar para `nao`**, só para `parcial` com justificativa |
| `0 < score < 1` | **`parcial`** (candidato) | roda; pode confirmar ou rebaixar para `nao` |
| `score === 0` | **`nao`** | não roda |
| `inconclusive` | — | cai para o caminho sem oráculo, e o dossiê marca isso |

**Por que o LLM não pode reprovar um oráculo que passou inteiro:** porque o
critério de sucesso da tarefa foi declarado pelo autor da tarefa em `verify[]`.
Se o LLM discorda, o problema é a `verify[]` (subespecificada), e a resposta certa
é consertar a tarefa, não deixar o modelo legislar. Deixar o LLM rebaixar para
`parcial` (com motivo) preserva a capacidade de sinalizar "passou, mas fez uma
gambiarra" sem transformar o juiz em veto.

**Por que ele pode rebaixar quando `0 < score < 1`:** aí o oráculo já disse que
está incompleto, e distinguir "incompleto mas no caminho certo" de "incompleto e
errado" é exatamente o julgamento qualitativo que um LLM faz bem.

### 17.2 O gabarito de agente

`gabarito.ts` hoje roda o modelo de referência **uma vez por cenário**,
temperatura 0, com o mesmo `productContext`. Para agentes, a referência tem três
encarnações e a ordem de preferência é esta:

**(a) `verify[]` como referência (preferida).** Se a tarefa traz oráculo, ela já
tem gabarito: o gabarito é *"os testes passam"*. **Não gere gabarito por agente
neste caso** — seria pagar uma execução inteira de agente por cenário para
produzir uma régua pior que a que já existe. Economia real e considerável.

**(b) Gabarito importado.** `StageSpec.reference` recebe um texto descrevendo a
solução esperada (ou o próprio diff esperado), vindo do `ScenarioPack`. É o
caminho para tarefas curadas por humano.

**(c) Execução de referência.** Um agente de referência (modelo forte, esforço
alto, mesmos limites) roda a tarefa **uma vez por cenário** e o **dossiê** dessa
execução vira `reference`. Custo: uma execução extra por cenário — significativo,
mas amortizado por todos os contestants e todas as repetições, exatamente como o
gabarito de chat já é hoje.

E a regra de degradação de `gabarito.ts` é preservada: **falha ao gerar a
referência nunca derruba a run**; a etapa segue sem `reference` e o juiz cai para
o modo rubrica. Com uma diferença importante em relação ao chat: se **há oráculo**,
a ausência de gabarito **não** degrada o veredito para `parcial` — o oráculo
decide sozinho. Sem oráculo e sem gabarito, aí sim, `parcial` com o motivo
`(sem referência e sem verificação para este cenário)`.

### 17.3 A rubrica

Inalterada em espírito: `StageSpec.rubric` é injetada como **critério ancorado**,
com prioridade sobre a impressão do juiz — é o que `refJudge.ts` já faz
(`"CRITÉRIO DE CORRETUDE DESTA ETAPA (tem prioridade)"`). Para agentes ela ganha
uma seção sugerida, porque tarefa de agente tem dimensões que texto não tem:

```
CRITÉRIO DE CORRETUDE
- Resultado: <o que precisa estar verdadeiro no código ao final>
- Escopo: <o que NÃO deveria ser tocado>
- Processo (opcional): <padrão de trabalho exigido, ex.: "não editar testes">
```

## 18. O juiz pointwise de agente

### 18.1 Reuso de `refJudge.ts`

O contrato de saída **não muda**: `{"verdict": "resolve"|"parcial"|"nao",
"explanation": "<uma frase>"}`, com o mesmo parse tolerante (JSON, fallback
regex, lixo ⇒ `parcial`), a mesma agregação multi-juiz por **média ordinal**, o
mesmo `judgeScoreFromVerdicts`. O que muda é o `buildUserPrompt`: em vez de
`CANDIDATO: <texto>`, ele recebe `CANDIDATO (dossiê): <dossier.md>`.

O system prompt ganha três parágrafos (versão completa no Apêndice B.1), cujas
razões são:

1. **"Julgue o RESULTADO, não o estilo de trabalho"** — sem isso o juiz premia
   trajetórias bonitas (o agente que "explicou bem o que ia fazer") sobre diffs
   corretos. É o análogo agentic do `"Ignore redação/estilo"` que o prompt de
   chat já tem.
2. **"A VERIFICAÇÃO AUTOMÁTICA tem precedência sobre a sua impressão"** — reforça
   a hierarquia de §17.1 dentro do próprio prompt, além de no código.
3. **"Trajetória mais longa não é melhor"** — mitigação explícita de viés de
   verbosidade, que aqui aparece numa forma nova e perversa: o agente que deu 40
   turnos gera um dossiê com mais evidência de esforço que o que resolveu em 3.

### 18.2 Vieses novos deste regime, e a mitigação de cada um

**[JULGAMENTO]** — sem evidência externa nesta rodada; cada mitigação é
estrutural (código), não retórica (prompt), porque prompt é o que menos se pode
verificar.

| Viés | Como aparece aqui | Mitigação estrutural |
|---|---|---|
| **Auto-preferência** | `provider`/`model` estão em toda mensagem do transcript | redação obrigatória (§16.4-5), com contador; `redactions === 0` em modo cego é bug |
| **Verbosidade** | mais turnos ⇒ dossiê maior ⇒ "trabalhou mais" | orçamento **igual** por candidato; seção 5 lista passos, não despeja saída; nº de turnos aparece no cabeçalho como **dado neutro**, ao lado do custo |
| **Tamanho do diff** | diff grande parece solução "mais completa" | `--stat` sempre visível; a rubrica pede escopo; e o oráculo é indiferente a tamanho |
| **Posição** | ordem dos candidatos no duelo | duas ordens + desacordo = empate (já existe em `duels.ts`) |
| **Ordem dos arquivos** | primeiro arquivo do diff pesa mais | ordem por relevância **determinística** (código > config > teste > doc), igual para todos |
| **Reward hacking** | editar o teste, `chmod`, `skip`, `--force` | `forbiddenPaths` ⇒ `nao` automático; o dossiê lista **todo** comando bash executado |

### 18.3 Respostas com erro: o que é `nao` e o que é `incomplete`

`refJudge.ts` já dá `nao` automático (sem gastar LLM) para resposta ausente,
com erro ou vazia. A tradução para agentes precisa de cuidado, porque as
categorias são diferentes:

| `stopReason` | Trata como | Por quê |
|---|---|---|
| `completed`, diff vazio | **`nao`** (sem LLM) | terminou e não mudou nada — é uma resposta, e é errada |
| `error` (processo morreu) | **`nao`**, `status: 'error'` | falhou em executar; é do contestant |
| `maxTurns`/`maxCost`/`timeout`/`maxOutput` **sem** oráculo passando | **`incomplete`** | o teto é nosso, a culpa não é dele — fora do placar |
| `maxTurns`/... **com** oráculo passando | julgado normalmente | o mundo mudou de forma verificável (§15.2) |
| `cancelled` | **`incomplete`** + sinal de controle sobe | orçamento/Ctrl-C são controle |

### 18.4 Repetições e o que elas significam

**[JULGAMENTO]** — a pesquisa não trouxe nada sobre variância entre execuções nem
sobre pass@k; isto é desenho conservador.

- Cada repetição é **uma observação independente** no denominador do judge-score.
  `judgeScoreFromVerdicts` recebe `stages × repetitions` vereditos por contestant
  e **não muda uma linha**.
- `pairedSignificance` (`stats.ts`) exige pareamento posicional: o par vira
  `(cenário, repetição)`, o que aumenta o `n` e é exatamente o que ele pede
  (piso `n ≥ 5`).
- **`repetitions: 1` é o default e precisa de aviso**, não de silêncio. Uma
  diferença de judge-score entre dois agentes medida com 1 execução por cenário
  pode ser inteiramente ruído. O relatório final imprime, sempre:
  `Repetições  1 — a diferença entre contestants pode ser ruído; use 3+ para decidir.`
  Este aviso é irmão do `holdoutSkipped` que o treino já imprime pelo mesmo motivo:
  **omitir a fragilidade de um resultado transforma a feature em regressão de
  qualidade**.
- Um campo derivado novo, barato e útil: `resolveRate` por (contestant, cenário)
  = fração das repetições com `resolve`. É o que separa "resolve sempre" de
  "resolve às vezes", e é o número que decide na vida real.

## 19. As finais (duelos) entre agentes

`duels.ts` continua valendo inteiro — `pickFinalists` por judge-score médio,
duelo nas duas ordens, desacordo = empate, Copeland agregado cross-etapa. Três
ajustes:

**19.1 — Duelo decidido pelo oráculo, sem LLM.** Se os dois lados têm oráculo e
os `score` diferem, o vencedor é o de maior `score`. Só empate de oráculo vai
para o LLM. Isso corta a maior parte do custo das finais e é mais correto.

**19.2 — `finalists` default menor em modo agente: 2.** Um duelo de agentes é
`2 × dossiê compact` no modelo mais caro do pipeline; com 3 finalistas são 3 pares
× 2 ordens × N cenários. O default de 3 (que faz sentido para chat) fica caro
demais aqui. O `arena-agent-config@1` deixa isso explícito, e o pré-voo mostra o
número de duelos projetado.

**19.3 — Duelo compara o par no MESMO cenário e na MESMA repetição.** Comparar a
repetição 0 de A com a 2 de B introduz variância no lugar do sinal. Quando
`repetitions > 1`, o duelo usa a **repetição mediana por judge-score** de cada
lado (determinístico, com desempate pelo shuffle cego semeado).

---

# PARTE VI — Dinheiro

> Esta é a parte onde o plano mais briga com a realidade, e onde o repositório
> tem a doutrina mais forte: *"Dinheiro é medido, nunca inferido"*, *"`unknown`
> não é o mesmo que custou zero"*, *"a contabilidade é feita em UM ponto".*
> Nenhuma das três sobrevive intacta ao modo agente. Ignorar isso reintroduziria
> exatamente a subcontagem de 80× que este repositório já pagou para consertar.

## 20. O problema em três frases

1. **As chamadas do agente não passam por `chatCompletion`.** Elas saem de dentro
   do `pi`, direto para o OpenRouter. Nosso `CostSink` nunca as vê, e o limitador
   global adaptativo (semáforo + backoff em 429) também não.
2. **O custo reportado pelo `pi` é derivado, não cobrado.** **[VERIFICADO
   PESQUISA, 3-0, com a ressalva levantada pelo próprio verificador]** o `pi`
   calcula custo por **tabela de preços embarcada** (`calculateCost` em `pi-ai`),
   não pelo valor que o provedor cobrou. Sob a doutrina deste repo, isso é
   exatamente o que `CostSource: 'catalog'` significa.
3. **Não dá para estimar antes.** O agente decide quantos turnos dá.

## 20.1 A resposta: a estimativa vira CONTRATO

Em vez de tentar prever o imprevisível, **declaramos o teto e o impomos**:

```
custoProjetadoDeAgente =
    contestants × cenários × repetições × limits.maxCostUsd
  + (referência de agente ? cenários × limits.maxCostUsd : 0)
```

Isso entra em `estimate.ts` como `byRole.agent`. Três propriedades boas:

- **É um limite superior por construção**, não um chute. O `low` da faixa pode
  usar um fator empírico (~0,35 do teto), mas o `high` é o teto e é **exato**.
- **O pré-voo passa a ter dente.** Se `budgetUsd < est.low`, recusa (exit 2), do
  jeito que já faz. E a mensagem pode ser acionável de verdade: *"reduza
  `--repetitions`, `--stages`, ou `limits.maxCostUsd`"*.
- **`maxCostUsd` deixa de ser opcional em modo agente.** Sem ele não há
  estimativa, e sem estimativa não há orçamento — a run seria aceita e depois
  gastaria o que quisesse. `runConfigSchema` **exige** `limits.maxCostUsd` quando
  há contestant com `runner: 'agent'`; ausência é erro de config (exit 3), não
  default silencioso.

## 20.2 Como o teto é imposto (o executor mata)

O runner acumula custo lendo o stream `--mode json` — cada `message_end` de
assistente traz `usage.cost.total`. Quando o acumulado passa de `maxCostUsd`:

1. `kill(-pid, 'SIGTERM')` no **grupo**, graça 5s, `SIGKILL`.
2. `stopReason: 'maxCost'`, resposta `incomplete`.
3. Evento `agent.finished` com o custo real.
4. O custo **acumulado até ali** é lançado no ledger — gastar e não contar seria
   pior que gastar.

Idem para `maxTurns` (conta `turn_start`), `timeoutMs` (parede) e
`maxOutputBytes` (contador nos dois pipes).

> ⚠️ **O teto é aproximado por baixo, sempre.** A última chamada em voo quando o
> `SIGTERM` chega já foi cobrada. Overshoot típico: uma chamada. Isso precisa
> estar documentado em `agent-docs/`, porque um usuário que configura
> `maxCostUsd: 0.05` e vê `0.061` no relatório vai achar que o teto não funciona —
> quando na verdade ele funcionou exatamente como um teto pode funcionar sem um
> proxy que intercepte a chamada antes de sair.

## 20.3 Como o custo entra no ledger

```ts
// Ao fim de CADA execução de agente, uma única nota no ledger:
const reservation = ctx.sink.reserve('agent', modelId, 0, 0); // reserva nula
ctx.sink.note(reservation, {
  role: 'agent',
  modelId,
  cost: { usd: trajectory.usage.costUsd, source: 'catalog' },  // ⚠️ derivado
  tokensIn: trajectory.usage.tokensIn,
  tokensOut: trajectory.usage.tokensOut,
});
```

Três observações que não são detalhe:

- **`source: 'catalog'` e não `'usage'`.** É a tradução honesta de "derivado de
  tabela de preços". Consequência visível: `costAccuracy.estimated` sobe, e o
  relatório final imprime `Precisão N exatas · M estimadas`. Um usuário que vê
  "estimadas" numa run de agente está vendo a verdade.
- **Nunca `'unknown'`** — o número existe e é razoável; marcá-lo como desconhecido
  seria pior (o AGENTS.md avisa que `unknown` ≠ zero, mas também não é "temos um
  número derivado e confiável o bastante para o orçamento").
- **A reserva é nula** porque a porta dura já foi aplicada na fronteira de fase
  (o grupo `execuções+julgamento`) e o teto por execução é imposto pelo processo.
  Reservar `maxCostUsd` no início de cada execução seria mais rigoroso, e é uma
  melhoria natural da Fase 4: transformaria o ledger no controlador do paralelismo
  (só inicia uma execução se couber a reserva) — que é o desenho mais correto,
  mas exige mexer no `reserve` para aceitar reserva por execução, não por chamada.

## 20.4 Reconciliação: como promover `catalog` → `usage`

**[JULGAMENTO com base VERIFICADA LOCAL]** — no arquivo real de sessão que li,
cada `AssistantMessage` tem **`responseId`**. Para OpenRouter, o id da geração é a
chave de `GET /api/v1/generation?id=<id>`, que devolve o custo **cobrado**. Ou
seja, existe um caminho concreto para fechar a conta de verdade:

1. Ao normalizar a trajetória, colher todos os `responseId`.
2. Um passo opcional `agents reconcile <runId>` (ou automático quando
   `provider === 'openrouter'`) consulta o endpoint por id, soma, e grava
   `trajectory.usage.costSource = 'reconciled'` + o delta.
3. O `RunRecord` ganha `agentCostReconciled?: { derivedUsd, billedUsd, deltaPct }`.

**Não é v1**, e o motivo de não ser é honesto: eu **não verifiquei** que o
`responseId` do `pi` é o id de geração do OpenRouter (é o que a estrutura sugere,
não o que eu medi). Vira o **primeiro item de verificação da Fase 4**, com um
teste barato: rodar uma execução, pegar um `responseId`, consultar o endpoint, e
comparar. Se não bater, a alternativa é um **proxy local** entre o `pi` e o
OpenRouter (o `pi` aceita provider customizado com `baseUrl` via `models.json` —
**[VERIFICADO PESQUISA]**), o que devolveria a contabilidade para o nosso lado e
recuperaria a doutrina inteira, ao custo de mais uma peça móvel.

## 20.5 O paralelismo e o limitador global

Consequência que precisa estar escrita, porque contradiz uma regra do AGENTS.md
se lida sem contexto:

> *"Não chame o OpenRouter por fora nem ponha cap de concorrência local — confie
> no limitador."*

Em modo agente, **as chamadas do agente são "por fora" por definição** — não há
como não serem, a menos que se implemente o proxy de §20.4. Portanto:

- O limitador global continua governando **as nossas** chamadas (datagen,
  gabarito, juiz, duelo, otimizador). Nada muda ali.
- O `agent.maxParallel` governa **processos**, que é um recurso local (CPU, disco,
  descritores), e não tem nada a ver com o rate limit do provedor.
- **Risco assumido:** 4 agentes em paralelo, cada um disparando chamadas, podem
  tomar 429 do OpenRouter sem passar pelo nosso backoff. Mitigação da v1: o `pi`
  tem retry automático próprio (**[VERIFICADO PESQUISA]** o RPC expõe
  `set_auto_retry` e eventos `auto_retry_start/end`), e `maxParallel` default
  baixo (4). Mitigação real (Fase 5): o proxy.
- **O comentário sobre isto vai no código**, em `src/agent/executor.ts`, senão
  alguém "corrige" o cap achando que está violando a doutrina.

## 20.6 A porta de fase em modo agente

Um grupo novo, com a mesma lógica de `gate()`:

```
G0  variantes           (inalterado)
G1  datagen + gabarito   ← se a referência é 'execução de agente', o custo dela
                           entra AQUI, não em G2. É descartável inteira, antes de
                           gastar com os contestants.
G2  execuções + julgamento  ← ATÔMICO. Idêntico em espírito ao
                              `competidores + julgamento` de hoje: autorizar
                              execuções sem poder pagar o julgamento produz
                              etapas com diff e sem nota — resultado incompleto
                              com cara de completo.
G3  finais               (inalterado, com o custo de duelo de dossiê)
```

E a regra que já existe se aplica igual: **etapa cortada em G2 vira `incomplete`
para todos os contestants**, fora do placar e fora das médias.

---

# PARTE VII — As superfícies

## 21. Por que uma API separada (`/v1/agents`)

O pedido diz: *"isso vai ser uma outra api dessa nossa ferramenta só destinada
para fora da WEB"*. Concordo, e as razões são mais fortes que a preferência:

**21.1 — É execução remota de código.** `POST /v1/agents/runs` recebe um JSON e,
como consequência, um processo roda `bash` num diretório da máquina. Misturar isso
com `/v1/benchmark` (que hoje é seguro por construção: só fala com o OpenRouter)
apagaria a fronteira mental entre "endpoint que gasta dinheiro" e "endpoint que
executa código".

**21.2 — Os requisitos de runtime são incompatíveis com o deploy atual.** O
AGENTS.md já diz: *"Não rode o backend `src/` em serverless"*. O modo agente
piora isso de "grava no filesystem efêmero" para "precisa de git, de processos
filhos e de minutos de execução". Um router separado é o que permite **não
montá-lo** por padrão.

**21.3 — O ciclo de vida é diferente.** Uma run de chat termina em minutos e o
SSE é suficiente. Uma run de agente pode durar uma hora; precisa de cancelamento
(`POST /:id/cancel`), de retomada de stream por cursor e de acesso a artefatos
por caminho.

**21.4 — O pré-voo é diferente.** Além de key + catálogo + estimativa, precisa
verificar `pi` presente e na versão certa, `git` presente, disco livre e a sala
limpa (`doctor`).

### 21.5 O portão de segurança (não negociável)

```ts
// src/server.ts
if (process.env.PROMPT_BUILDER_AGENTS === '1') {
  app.use('/v1/agents', agentRouter);
} // ausente => a rota simplesmente não existe (404), não "403"
```

Regras que acompanham:

- **Bind em `127.0.0.1`** quando o router de agentes está montado. Se
  `HOST`/`--host` pedir `0.0.0.0`, o processo **recusa subir** com mensagem
  explicando. Expor isto na rede é entregar a máquina.
- **Token compartilhado obrigatório**, gerado na primeira subida em
  `<dataDir>/agents-token` (modo `0600`), exigido no header `x-agents-token`. A
  key do OpenRouter **não** serve como autenticação: ela autoriza gastar, não
  executar código.
- **`isolation.kind: 'worktree'` só é aceito de `127.0.0.1`.** De qualquer outra
  origem, exige `container`.
- **`setup[]` e `verify[]` são comandos arbitrários.** O corpo da requisição
  precisa ser tratado como código, não como dados. Documentado no topo do router,
  em maiúsculas.
- **Sem isso, nada disso vai para a Vercel.** `vercel.json` continua exatamente
  como está; o `web:build` continua sendo SPA estática.

### 21.6 Endpoints

| Método | Rota | Nota |
|---|---|---|
| `GET` | `/v1/agents/doctor` | executor, versão, git, disco, sala limpa (cacheado) |
| `POST` | `/v1/agents/runs` | 202 `{runId}`; valida `arena-agent-config@1` ou `RunConfig` |
| `GET` | `/v1/agents/runs` | listagem (resumos) |
| `GET` | `/v1/agents/runs/:id` | o `RunRecord` (com `ExecutionRef`s) |
| `GET` | `/v1/agents/runs/:id/events` | SSE — snapshot + eventos, fecha em terminal |
| `POST` | `/v1/agents/runs/:id/cancel` | aborta (sinal de controle ⇒ `aborted`, parcial salvo) |
| `GET` | `/v1/agents/runs/:id/exec/:stage/:contestant/:rep` | `exec.json` |
| `GET` | `/v1/agents/runs/:id/exec/.../dossier` | `dossier.md` (`text/markdown`) |
| `GET` | `/v1/agents/runs/:id/exec/.../diff` | `workspace.diff` (`text/plain`) |
| `GET` | `/v1/agents/runs/:id/exec/.../trajectory` | `trajectory.json` |
| `GET` | `/v1/agents/runs/:id/exec/.../raw/:file` | `events.jsonl`/`session`/`stderr.log` — **allowlist de nomes**, nunca caminho do cliente |
| `GET` | `/v1/agents/runs/:id/export.csv` | uma linha por (etapa × contestant × repetição) |

> ⚠️ **Path traversal** é o bug óbvio aqui. Nenhum segmento do cliente vira
> caminho: `stage`/`rep` são inteiros validados, `contestant` é casado contra
> `record.contestants`, `:file` é allowlist fechada. E tudo é resolvido sob
> `getDataDir()` com `path.resolve` + verificação de prefixo.

### 21.7 SSE: a regra que já existe

`AGENTS.md`: *"Em SSE, feche o `EventSource` em eventos terminais (senão o
browser reconecta infinitamente)"*. Vale igual. Como uma run de agente é longa, o
keepalive de 15s de `routes.ts` é ainda mais necessário, e o snapshot inicial
precisa ser leve — ele já é (`ExecutionRef`, não trajetória).

## 22. CLI: `prompt-builder agents ...`

```
prompt-builder agents doctor [--deep] [--json]
    Verifica: pi presente e na versão pinada, git, disco livre, e (--deep) roda o
    auto-teste de sala limpa com canários. Exit 3 se a sala estiver suja.

prompt-builder agents run --config <arquivo> --budget <usd|none> [--dry-run]
                          [--repetitions N] [--max-parallel N] [--keep-workspace]
    Roda a arena de agentes até o fim. Mesmas regras globais: sem --budget e sem
    TTY, recusa (exit 2). --dry-run valida, estima e não gasta nada.

prompt-builder agents show <runId> [--json]
prompt-builder agents list [--json]
prompt-builder agents logs <runId> --stage N --contestant <id> [--rep N]
        [--what dossier|diff|trajectory|events|session|stderr|oracle]
    Imprime no STDOUT o artefato pedido. Default: dossier.
prompt-builder agents replay <runId> --stage N --contestant <id> [--rep N]
    NÃO reexecuta: imprime o comando EXATO (argv + env redigido + cwd + seed sha)
    para reproduzir à mão. É o que transforma o log em evidência.
prompt-builder agents reconcile <runId>        (Fase 4 — ver §20.4)
prompt-builder agents gc [--older-than 30d] [--dry-run]
    Apaga artefatos de runs antigas. Necessário: isto enche disco.
```

**Códigos de saída: os mesmos.** `0` ok · `2` uso · `3` config (inclui executor
ausente/versão errada/sala suja) · `4` auth · `5` sem crédito · `7` parcial por
orçamento · `8` rede · `130` SIGINT. Não inventar código novo é uma feature:
o agente-cliente já sabe tratar essa tabela, e ela está nas `agent-docs`.

**Um caso novo que merece atenção:** *todas* as execuções falharam (por exemplo,
credencial errada dentro do `pi`). Isso **não** é exit 0 com placar vazio — é
`EXIT.ERROR` (1) com a mensagem do primeiro erro. Uma run que "terminou" com
todos os contestants em `nao` por falha de infra é o resultado-lixo-com-cara-de-
sucesso que este repositório inteiro é desenhado para evitar.

## 23. NDJSON: o que entra e o que fica de fora

Seguindo à risca a regra de `cli/ndjson.ts` (*"nunca transmita `RunEvent`
verbatim"*):

| Evento interno | Linha NDJSON | O que **não** vai |
|---|---|---|
| `agent.started` | `{type:'agent.started', stageIndex, contestantId, execId, repetition}` | — |
| `agent.turn` | `{type:'agent.turn', ..., turn, costUsd}` | texto do turno, thinking |
| `agent.tool` | `{type:'agent.tool', ..., toolName, ok, summary?}` | **a saída da ferramenta** |
| `agent.finished` | `{type:'agent.finished', ..., stopReason, turns, costUsd, diffStat}` | trajetória, diff |
| `agent.verified` | `{type:'agent.verified', ..., results:[{label,ok,exitCode}]}` | saída dos comandos |

E com `--verbose`, uma concessão: `agent.tool` passa a incluir `summary` também
para `edit`/`write` (o caminho do arquivo). Nunca conteúdo.

**Nova linha de `result`:** o `result` final de `agents run` ganha
`agentSummary: { executions, failed, incomplete, avgTurns, avgCostUsd, oracleRate }`.
É o que um agente-cliente precisa para decidir o próximo passo sem abrir arquivo.

## 24. MCP: exatamente duas ferramentas a mais

`src/cli/commands/mcp.ts` já diz por que: *"a superfície é deliberadamente PEQUENA
(6 ferramentas): o schema de cada uma entra no contexto do agente a cada turno,
então cada ferramenta a mais é um imposto permanente de tokens"*.

- **`run_agent_benchmark`** — `{config, budgetUsd}` (ambos obrigatórios, como o
  `run_benchmark` de hoje) → resumo + `runId`.
- **`get_agent_dossier`** — `{runId, stageIndex, contestantId, repetition?}` →
  o `dossier.md`. É a ferramenta de *diagnóstico*: quando o agente-cliente quer
  entender **por que** um contestant perdeu, é isso que ele lê — e é exatamente o
  mesmo texto que o juiz leu.

Nada de `get_agent_trajectory` no MCP: quem quer o bruto usa o CLI ou o HTTP. Uma
trajetória inteira num tool result é a receita para estourar o contexto do cliente.

## 25. `arena-agent-config@1`

Um **formato novo**, não um campo a mais no `arena-config@1`. Motivo: o parser
despacha por `format` (`configFile.ts`), e o `arena-config@1` é lido também pelo
**motor do browser** (`web/src/engine/configFile.ts`). Aceitar campos de agente lá
significaria a UI validar com sucesso uma configuração que ela **nunca** poderá
executar — o pior tipo de erro, porque só aparece depois.

```jsonc
{
  "format": "arena-agent-config@1",
  "mode": "compare",                    // compare | variation | training
  "theme": "Correção de bugs em TypeScript",
  "scenarioBrief": "…",

  "agent": {
    "executor": "pi",
    "executorVersion": "0.84.2",
    "install": "isolated",
    "provider": "openrouter",
    "promptMode": "append",
    "thinking": "medium",
    "tools": ["read", "write", "edit", "bash", "grep", "find", "ls"],
    "repetitions": 3,
    "maxParallel": 4,
    "isolation": { "kind": "worktree", "keepWorkspace": false },
    "limits": {
      "maxTurns": 30,
      "maxCostUsd": 0.40,               // OBRIGATÓRIO
      "timeoutMs": 600000,
      "maxOutputBytes": 8388608,
      "maxDiffBytes": 524288
    }
  },

  "models": {
    "datagen": "…", "judges": ["…"], "reference": "…",
    "competitors": ["anthropic/claude-…", "openai/gpt-…", "google/gemini-…"]
  },

  "scenarios": [
    {
      "question": "O parser de datas quebra com fuso negativo. Conserte e prove.",
      "productContext": "Você é um agente de manutenção deste repositório…",
      "rubric": "Resultado: date.test.ts passa inteiro. Escopo: não altere testes.",
      "agentTask": {
        "repo": { "kind": "git", "path": "./fixtures/date-lib", "ref": "a1b2c3d", "shallow": true },
        "setup": [{ "cmd": "npm ci --ignore-scripts", "timeoutMs": 180000 }],
        "verify": [
          { "label": "typecheck", "cmd": "npx tsc --noEmit", "weight": 1 },
          { "label": "testes",    "cmd": "npm test -- --run", "weight": 3 }
        ],
        "forbiddenPaths": ["test/", "*.test.ts", "package.json"]
      }
    }
  ],

  "judging": { "reference": true, "passes": 1, "dossierTokens": 12000 },
  "duels": true,
  "finalists": 2
}
```

Notas de tradução (`arenaAgentConfigToRunConfig`), com o motivo de cada uma:

- `agent.limits` é o **default** de todo `scenario.agentTask.limits` ausente —
  senão cada cenário repetiria o mesmo bloco e uma divergência acidental viraria
  um experimento inválido silencioso.
- `scenarios[].agentTask` ausente com `runner: 'agent'` ⇒ **erro de config**, não
  fallback para chat. Cair para chat em silêncio produziria uma run que mede
  outra coisa.
- `stages` é forçado ao tamanho de `scenarios` (mesma regra do `arena-config@1`),
  porque **datagen de tarefa de agente não existe na v1** (§Parte XI): um LLM não
  consegue gerar `repo`+`setup`+`verify` que de fato rodem sem executá-los.
- `judging.dossierTokens` é config, não constante, porque é ele que liga o custo
  do juiz ao tamanho da evidência.

## 26. Documentação embarcada

`agent-docs/` ganha dois tópicos (e `index.json` ganha duas entradas — ele é lido
por `docs --list` com custo aproximado em tokens):

- **`agents`** (~1200 tokens): o que é o modo agente, o caminho feliz em 5
  comandos, os limites obrigatórios, a tabela de `stopReason`, e as três frases
  que evitam 80% dos erros: *"`--budget` é obrigatório"*, *"`maxCostUsd` é
  obrigatório"*, *"rode `agents doctor` antes"*.
- **`agent-task`** (~4000 tokens): o contrato `arena-agent-config@1` inteiro,
  campo a campo, com os erros comuns.

`skills/prompt-builder/SKILL.md` ganha uma linha na tabela "Quando usar":
`| "qual agente/prompt de agente resolve melhor?" | agents run |`. E o
`package.json` já publica `agent-docs` inteiro em `files`, então não há mudança lá
— mas **confirme com `npm pack --dry-run`**, como o AGENTS.md manda.

---

# PARTE VIII — Roadmap

## 27. Como as fases foram cortadas

O corte não é por camada (dados → lógica → UI) e sim por **risco decrescente**.
Cada fase existe para matar a incerteza mais cara que ainda estiver de pé, e cada
uma termina em algo que roda:

1. **Fase 0** mata a incerteza sobre o `pi` — que é a única dependência externa e
   a que mais pode mudar. Ela é um spike descartável de propósito: descobrir que
   `--append-system-prompt` estoura o `ARG_MAX` custa uma hora num script solto e
   custa uma refatoração se descoberto na Fase 2.
2. **Fase 1** mata a incerteza sobre **capturar** — sem log completo e confiável,
   nada do resto tem sobre o que operar.
3. **Fase 2** mata a incerteza sobre **julgar** — é onde a tese ("o motor
   existente serve") é confirmada ou refutada. Se o `refJudge` não engolir um
   dossiê, é aqui que se descobre, com tudo o mais já funcionando.
4. **Fase 3** é integração: nenhuma incerteza técnica nova, só superfície.
5. **Fase 4** é onde o resultado passa a **significar** alguma coisa (repetições,
   significância, custo fechado).
6. **Fase 5 e 6** são o que só faz sentido depois que o núcleo prova valor.

A regra que amarra tudo: **nenhuma fase pode deixar o modo chat diferente**.
Se ao fim de qualquer fase uma run de `compare` produzir um resultado, um custo ou
um formato de record diferente do que produzia antes, a fase não está pronta.

## 28. O que "verificar" significa aqui

Não há `test` nem `lint` configurados neste repositório (`AGENTS.md`). A
verificação é sempre a mesma tríade, e ela vale como critério de aceite de todas
as fases abaixo, somada ao smoke específico de cada uma:

| Passo | Comando | O que ele pega |
|---|---|---|
| Type-check do backend | `npx tsc -p tsconfig.json --noEmit` | quase todo erro de contrato — inclusive os mapas literais de `CostRole` que o compilador obriga a atualizar |
| Type-check do frontend | `cd web && npx tsc -b` | regressão acidental na SPA (exige `MOTION_TOKEN`, ver §29.13) |
| Empacotamento | `npm pack --dry-run` | docs novas de fato viajando no tarball (`files` do `package.json`) |
| Smoke | o descrito em cada fase | tudo o que tipo não pega: processo, git, disco, rede |

Duas verificações extras que este plano introduz e que valem como teste de
regressão permanente, na falta de um framework:

- **`agents doctor --deep`** — o canário de sala limpa (§12.6). Roda no pré-voo e
  falha a run se a máquina do usuário estiver vazando para dentro do experimento.
- **Determinismo do dossiê** — montar duas vezes o mesmo `exec.json` e comparar o
  `sha256`. É barato, roda offline e protege a propriedade da qual dependem o
  cache de veredito e a auditoria.

## Fase 0 — Spike de descoberta (1 dia) — **não commitar em `src/`**

**Objetivo:** provar o loop inteiro com um script solto no scratchpad, com 1
cenário, 1 contestant, 1 repetição.

**Entregas:** um `.ts` que (1) cria worktree, (2) spawna `pi` com a receita de
§12.2, (3) parseia o stream com o splitter correto, (4) commita, (5) tira o diff,
(6) roda um `verify`, (7) imprime custo e turnos.

**Perguntas que ele responde** (todas são risco real se ficarem em aberto):
1. O `--mode json` sai mesmo linha a linha, sem buffer, com pipe (não-TTY)?
2. O `--append-system-prompt` aceita texto grande sem estourar `ARG_MAX`? (Se não:
   escrever em arquivo e usar `@file`, ou `.pi/APPEND_SYSTEM.md` dentro do
   `pi-home` isolado.)
3. O `usage.cost` aparece nos eventos ao vivo ou só no transcript final? (Decide se
   o teto de custo é imposto em tempo real ou só no fim.)
4. Com `PI_CODING_AGENT_DIR` vazio e `OPENROUTER_API_KEY` no ambiente, o `pi`
   autentica sem `auth.json`?
5. `--tools` aceita a lista exata dos built-ins?
6. Quanto tempo custa o startup do `pi` por execução? (Se for > 3s, `install:
   'isolated'` precisa reusar o mesmo `node_modules` entre execuções.)

**Aceite:** as 6 respostas escritas no próprio arquivo do spike, e um diff real
produzido por um agente real. Custo: < US$ 1.

## Fase 1 — Executor e captura (o coração)

`src/agent/`: `types`, `executor`, `pi`, `spawn`, `jsonl`, `workspace`,
`trajectory`, `store`, `doctor`. Mais `agents doctor` no CLI.

**Aceite:**
- `prompt-builder agents doctor --deep --json` → `ok: true`, `leaks: []`.
- Um comando de dev roda **uma** execução e escreve o diretório completo de
  artefatos com `digests.json` fechando.
- Matar o processo no meio (Ctrl-C) deixa artefatos coerentes e nenhum worktree
  órfão (`git worktree list` limpo).
- `parseErrors === 0` numa execução com saída contendo U+2028 (teste proposital).

## Fase 2 — Etapas, oráculo, dossiê e julgamento

`oracle.ts`, `dossier.ts`, `agentJudge.ts`, `runAgentStage.ts`; despacho no
orquestrador; `refJudge`/`duels` aceitando dossiê; schema Zod.

**Aceite:**
- Uma run `compare` com 2 modelos como agentes, 2 cenários com `verify`, termina
  com `judgeScoreByContestant` preenchido e `standings` (se `duels`).
- `dossier.md` existe, é determinístico (rodar o montador 2× dá o mesmo `sha256`)
  e em modo cego tem `redactions > 0`.
- Um cenário com `forbiddenPaths` violado dá `nao` **sem** chamada de juiz
  (verificável em `costByRole.judge`).
- Uma execução cortada por `maxTurns` sem oráculo aparece como `incomplete` e
  **não** entra no judge-score.

## Fase 3 — Superfícies

`agents run/show/list/logs/replay/gc`, NDJSON, `/v1/agents` com o portão de
segurança, `arena-agent-config@1`, 2 ferramentas MCP, `agent-docs`.

**Aceite:**
- `agents run --config x.json --budget 3 --dry-run` imprime config + faixa e não
  chama nada.
- Sem `--budget` e sem TTY: exit 2, nada gasto.
- `--output-format ndjson` produz stream consumível, `agent.tool` **sem** saída.
- Servidor sem `PROMPT_BUILDER_AGENTS=1`: `/v1/agents/*` → 404.
- Com a variável e `HOST=0.0.0.0`: **recusa subir**.
- `web/`: `npx tsc -b` limpo; a UI abre um `RunRecord` de agente sem quebrar.

## Fase 4 — Estatística, custo e treino

Repetições > 1 no placar e no `pairedSignificance`; `resolveRate`; reconciliação
de custo (§20.4, começando por **verificar** o `responseId`); e o modo
`training` com agente (evoluir o system prompt de um agente).

**Atenção máxima:** `variationConfigFrom` (`trainer.ts`) é um **whitelist campo a
campo**. `agent` e `agentTask` **têm** que ser copiados, ou o treino roda todas as
iterações em modo chat sem erro nenhum. Ver §29.2.

**Aceite:**
- `repetitions: 3` produz `n = cenários × 3` no bootstrap e um `resolveRate` por
  contestant/cenário.
- Uma sessão de treino de 2 iterações com agente promove (ou converge) usando o
  mesmo `minGain`, com holdout.
- `agents reconcile` fecha a conta (ou o relatório explica por que não fecha).

## Fase 5 — Contenção e escala

`isolation.kind: 'container'`; proxy de inferência opcional (recupera o limitador
global e o custo medido); `agents gc` automático; segundo adaptador
(`claude-code`, com `--bare`) para validar que a interface `AgentExecutor` de fato
abstrai.

## Fase 6 — UI (opcional, só leitura)

Uma aba na tela de run que renderiza `ExecutionRef` (turnos, custo, stopReason,
diffstat, oráculo) e busca `dossier.md`/`workspace.diff` **sob demanda** do
backend local. Zero criação pela UI. Se o backend não expõe `/v1/agents`, a aba
some.

---

# PARTE IX — Armadilhas deste repositório (checklist de merge)

> Esta parte existe porque quase todo item abaixo já causou um bug real neste
> código, e está documentado no `AGENTS.md` ou num comentário. Repetir qualquer
> um deles seria pagar duas vezes pela mesma lição.

## 29.1 `normalizeRunRecord` — o whitelist que engolia campo

`normalize.ts` **hoje espalha `...raw` de propósito**, e o comentário conta o
porquê: a lista explícita era um whitelist e engolia em silêncio todo campo novo
— foi assim que `judgeScoreByContestant`, `standings` e `finalists` sumiam ao
reler a run do disco (o painel de finais vinha vazio depois de um F5).

**Ação:** `CompetitorResponse.execution` sobrevive porque `normalizeStage` faz
`{...r, contestantId: ...}` nas respostas. ✅ Mas **verifique** — um `map` que
enumere campos ali mataria `execution` do mesmo jeito.

## 29.2 `variationConfigFrom` — o whitelist que ainda engole

`trainer.ts` enumera campo a campo, de propósito para `budgetUsd` e por descuido
para todo o resto. **Adicione `agent` à lista.** Se esquecer: o treino roda
iterações inteiras em **modo chat**, com o mesmo `theme` e os mesmos cenários,
sem erro nenhum — e você vai comparar prompts de agente medindo respostas de chat.
Este é o bug mais caro e mais silencioso possível neste plano.

E **não** copie `budgetUsd` (o comentário existente explica: daria a cada
iteração o teto inteiro da sessão).

## 29.3 `isControlSignal`, nunca `instanceof`

Todo catch novo (`spawn`, `oracle`, `dossier`, `pi.run`) começa com
`if (isControlSignal(err)) throw err`. Sob ESM, `instanceof` pode dar `false` em
silêncio com instância dupla do módulo — e o sinal voltaria a ser engolido como
erro comum, de forma intermitente.

**Onde isso morde no modo agente:** o `AbortSignal` da run chega ao executor. Se o
`spawn` degradar `RunCancelled` para `status: 'error'`, uma run cancelada sai como
"concluída com todos os agentes falhando".

## 29.4 ESM NodeNext: imports terminam em `.js`

`import { spawnAgent } from './spawn.js'` — mesmo o arquivo sendo `.ts`.

## 29.5 `PKG_DATA_DIR`, nunca `process.cwd()`

O `pi` instalado em modo `isolated` vai para `<dataDir>/…`, resolvido por
`getDataDir()`. Templates e dados versionados, se houver, saem de `PKG_ROOT`.
Instalado como pacote npm, o cwd é o projeto do usuário — e a leitura falha com
ENOENT.

**Novo caso específico:** `AgentTaskSpec.repo.path` é **relativo ao arquivo de
config**, não ao cwd. Resolver relativo ao cwd faz o mesmo config funcionar de um
diretório e falhar de outro. Documente e implemente assim.

## 29.6 `console.log` do motor vai para stderr

`src/agent/*` usa a mesma função `log()` do orquestrador (stderr). No CLI o stdout
é payload; uma linha de log corrompe o NDJSON de quem consome.

**Caso novo e fácil de errar:** o `stdout` do `pi` **nunca** pode vazar para o
nosso `stdout`. Ele vai para arquivo e para o parser, ponto.

## 29.7 Tipos duplicados em três lugares — e por que aqui é um

`src/types.ts`, `web/src/engine/types.ts` e `web/src/api.ts` são cópias que devem
ser mantidas em sincronia. Para o modo agente:

- `src/types.ts` — fonte, completa.
- `web/src/api.ts` — **só os campos que a UI lê** (`ExecutionRef`, os campos
  aditivos). Ler é seguro.
- `web/src/engine/types.ts` — **nada**. O motor do browser não executa agente.

Comente essa assimetria nos três arquivos, senão a próxima passada de sincronia a
"conserta".

## 29.8 SSE: fechar o `EventSource` em evento terminal

Já é regra. Runs de agente são longas: verifique que `run.finished`/`run.error`
continuam chegando e fechando, e que os eventos `agent.*` **não** confundem o
reducer da UI (eles não são terminais).

## 29.9 Eventos agregados e índices sentinela

`stage.gabarito` usa `stageIndex: -1` e `duel.progress` não tem índice; o AGENTS.md
avisa que eles **não** entram no reducer de etapas. Os eventos `agent.*` **sempre**
têm `stageIndex` real — não invente sentinela nova. Se precisar de progresso
agregado, reuse o `progress` já normalizado do `ndjson.ts`.

## 29.10 `judgeModelIds` não competem

O `superRefine` do `runConfigSchema` já garante que juiz não é competidor. Vale
igual: o modelo do agente não pode ser o juiz da própria trajetória.

## 29.11 `maxTokens` sanitizado

`orchestrator.ts` tem `saneMaxTokens` porque `Math.min(maxOutputTokens,
stage.maxTokens)` com valor ausente vira `NaN`. Em modo agente, `stage.maxTokens`
**não se aplica** ao agente (ele controla os próprios tokens). Não passe adiante,
mas mantenha o campo preenchido — ele ainda é usado se a mesma etapa rodar em
modo chat.

## 29.12 Retrocompat na leitura

Um `RunRecord` de hoje aberto por um binário com modo agente: `runner` ausente ⇒
`'chat'`. E um record **de agente** aberto por um binário antigo: os campos extras
são ignorados e a run aparece como uma run normal com respostas de texto vazio.
Aceitável — mas o `text` de uma resposta de agente deve receber um **resumo de uma
linha** (`"agente: 12 turnos, 3 arquivos, testes ✓"`) em vez de string vazia,
justamente para que binários e telas antigas mostrem algo sensato em vez de nada.
Custa uma linha e evita a impressão de dados perdidos.

## 29.13 `web/` exige `MOTION_TOKEN`

Qualquer comando dentro de `web/` (inclusive `npx tsc -b`) falha sem
`MOTION_TOKEN` no ambiente. Isso não é problema deste plano, mas é o primeiro
obstáculo de quem for verificar a Fase 3 — deixe registrado no critério de aceite.

---

# PARTE X — Alternativas descartadas

## 30.1 Um quarto `RunMode` (`'agent'`) em vez do eixo `runner`

**Descartado.** `mode` responde *"qual é a pergunta?"* (qual modelo / qual prompt /
evoluir prompt). Agente responde *"como colho a resposta?"*. Se virasse modo,
precisaríamos de `agent-compare`, `agent-variation` e `agent-training` — três
modos novos, três ramos no `runConfigSchema`, três no `estimate`, três no
`trainer`. Como eixo ortogonal, é **um** campo e um `if` no despacho.

## 30.2 Embutir o `pi` in-process (SDK) em vez de `spawn`

O `pi` exporta um SDK (`createAgentSession`, `ModelRuntime`, `SessionManager`) e a
própria doc sugere isso para Node/TS. **Descartado para a v1**, por quatro razões:

1. **Dependência pesada e volátil.** Viraria dependência de runtime do
   `prompt-builder-cli`, que hoje tem **uma** dependência (`zod`). O AGENTS.md
   defende o cold start rápido e o custo zero de contexto como a vantagem do CLI
   sobre MCP; arrastar um agente inteiro para dentro joga isso fora — inclusive
   para quem nunca vai usar o modo agente.
2. **Isolamento vira ficção.** In-process, o agente compartilha o `process.env`, o
   cwd, os handles e o event loop com o motor. A sala limpa de §12 depende de
   controlar o ambiente do processo filho — não dá para fazer isso consigo mesmo.
3. **Não dá para matar.** O teto de custo/turnos/tempo é imposto com `SIGKILL` no
   grupo. In-process, um laço travado leva o benchmark inteiro junto.
4. **Versão pinada.** `executorVersion` é verificável com `--version` de um
   binário; com SDK, seria o que o `npm` resolveu, e um `^` num range mudaria o
   experimento sem ninguém notar.

**Quando reconsiderar:** se o startup do `pi` por execução se mostrar dominante
(Fase 0, pergunta 6) *e* o isolamento puder vir de container. Aí o SDK vira uma
otimização legítima — dentro do container.

## 30.3 MCP como transporte do executor

**Descartado.** O `pi` não fala MCP por decisão de projeto (*"No MCP"* no README).
E mesmo que falasse, MCP é um protocolo para **um agente chamar ferramentas**, não
para **um harness dirigir um agente**. O que precisamos é: iniciar, observar,
limitar, matar e ler o rastro. Isso é gestão de processo, não RPC de ferramenta.

## 30.4 `--mode rpc` em vez de `--mode json`

**Descartado para a v1, previsto para depois.** O RPC dá controle bidirecional
(`abort`, `get_session_stats`, `steer`) que seria elegante para impor limites sem
`SIGKILL`. Mas: exige um cliente stateful com correlação de `id`, mantém o processo
vivo esperando comandos (mais coisa para dar errado num benchmark desatendido) e
tem uma superfície muito maior para mudar entre versões. `--mode json` + stdin +
`SIGKILL` é o mínimo que resolve, e o mínimo é o que sobrevive a 41 releases.

`get_session_stats` (que devolve `tokens`, `cost` e `contextUsage`) é atraente
para a reconciliação de custo — mas o mesmo dado está no transcript, que já
lemos.

## 30.5 Docker por padrão

**Descartado como default, obrigatório fora de localhost.** O raciocínio completo
está em §13.4: contaminação de *configuração* é o risco que ameaça a validade do
experimento hoje; fuga de *capacidade* é o risco que ameaça a máquina amanhã. A
v1 resolve o primeiro (que é o pedido: "instalação limpa") e **fecha a porta** do
segundo (o portão de §21.5), em vez de fingir que o resolveu.

## 30.6 Resumir a trajetória com LLM antes do juiz

**Descartado como caminho principal** (§16.2). Um sumarizador não auditado entre
a evidência e o veredito cria erros **invisíveis por construção**. Fica como
fallback marcado.

## 30.7 Enfiar a trajetória dentro do `RunRecord`

**Descartado.** `saveRun` é throttled em 800 ms e reserializa o record inteiro.
Com trajetórias, cada escrita seria O(tudo que já rodou) e uma run média
produziria centenas de MB de JSON reescrito dezenas de vezes. O `ExecutionRef` é
a resposta, e ela é a mesma que o repositório já usou para separar "resumo no
record" de "detalhe em arquivo".

## 30.8 Medir sucesso só pelo teste (sem juiz LLM)

**Descartado**, mas por pouco — e a razão importa. O oráculo é melhor que o LLM
para *correção*. Mas ele não mede: escopo (mudou 40 arquivos para consertar 1
linha), qualidade (gambiarra que passa), aderência à rubrica, nem tarefas que
**não têm** teste automatizável ("escreva a documentação deste módulo"). O desenho
final — oráculo manda, LLM gradua — pega o melhor dos dois sem deixar o LLM
legislar sobre correção.

## 30.9 Reusar `runCompetitor` com um "modo agente" dentro

**Descartado.** `competitor.ts` tem 122 linhas e uma responsabilidade: uma chamada
de chat com retry. Enfiar spawn, workspace, git, oráculo e limites lá dentro
transformaria o arquivo mais simples do pipeline no mais complexo, e o `retries: 1`
que faz sentido para uma chamada de chat é **perigoso** para um agente (repetir
uma execução que já mexeu em arquivos, gastou dinheiro e talvez tenha falhado no
meio de um `git commit`). `runAgentStage.ts` é um irmão, não uma extensão.

## 30.10 Gerar tarefas de agente por LLM (datagen)

**Descartado para a v1.** O datagen atual gera `{question, productContext, rubric}`
— texto que não precisa *funcionar*. Uma `AgentTaskSpec` precisa de um repo que
clone, um `setup` que instale e um `verify` que rode e que **falhe antes e passe
depois**. Um LLM gerando isso sem executar produz tarefas quebradas com aparência
de tarefas boas, e a run inteira vira ruído. O caminho certo (Fase futura) é
**geração com verificação**: gerar, executar o `verify` no repo-semente e
**exigir que ele falhe** (senão a tarefa já está resolvida), depois exigir que
uma execução de referência o faça passar. Isso é caro e é um projeto próprio.

Na v1, tarefas são **importadas** (`scenarios` no config) — e é por isso que
`stages` é forçado ao tamanho da lista.

---

# PARTE XI — Riscos, lacunas e escopo

## 31. Lacunas de evidência (o que este plano NÃO sabe)

Honestidade sobre a pesquisa: ela cobriu com força o eixo "executar CLI de agente
headless e capturar trajetória" e **não** cobriu quatro coisas. Cada uma está
marcada **[JULGAMENTO]** no corpo. Antes de a Fase 4 valer alguma coisa, elas
precisam de uma rodada própria:

1. **Julgamento de trajetória.** Nada foi verificado sobre Agent-as-a-Judge,
   rubricas de processo, pointwise vs pairwise nesse regime, concordância com
   humanos, nem sobre os vieses específicos. Todo o desenho da Parte V é extensão
   do que este repo faz para chat. **Risco:** o dossiê pode estar otimizando a
   coisa errada (por exemplo, o juiz pode ser muito mais sensível ao texto final
   do agente do que ao diff — e nós não sabemos).
   **Mitigação barata e imediata:** um estudo de concordância com 20 execuções
   rotuladas à mão, comparando (a) só oráculo, (b) só LLM, (c) híbrido. É o único
   jeito de calibrar o peso do juiz, e custa pouco.
2. **Quantas repetições.** Nada sobre variância entre execuções nem sobre pass@k.
   O default 1 com aviso é uma escolha conservadora, não informada. **Mitigação:**
   medir a própria variância — rodar o mesmo contestant 10× no mesmo cenário e
   olhar o desvio do judge-score. Isso pode e deve ser feito na Fase 2, e o
   número resultante vira o default.
3. **Como os harnesses de referência fazem.** Nada verificado sobre SWE-bench
   Verified, Terminal-Bench, τ-bench ou AgentBench: container por instância, rede,
   timeout, limite de turnos, pontuação. **Risco:** estar reinventando pior. O
   único sinal foi o `.traj.json` do mini-swe-agent, que já influenciou o
   `stopReason` daqui.
4. **Plumbing Node.** Só um achado (o splitter LF-estrito, que aliás é dos mais
   valiosos). Deadlock de pipes, kill de árvore e backpressure aqui são
   engenharia padrão bem estabelecida, mas não foram confirmados contra fonte
   nesta rodada.

## 32. Riscos técnicos, com o gatilho e a resposta

| Risco | Gatilho observável | Resposta |
|---|---|---|
| **`pi` muda flags/eventos** — 41 versões em ~3 meses, push no mesmo dia da pesquisa | `agents doctor` falha após atualizar | Versão **pinada** obrigatória (`executorVersion`) + `install: 'isolated'` + `doctor` no pré-voo. Nunca `latest`. |
| **Custo derivado diverge do cobrado** | fatura do OpenRouter ≠ soma do record | `source: 'catalog'` já sinaliza; `agents reconcile` (Fase 4) fecha; proxy (Fase 5) elimina |
| **429 sem passar pelo limitador** | execuções falhando em lote sob `maxParallel` alto | `maxParallel` baixo, retry do `pi`, e o proxy como solução real |
| **Disco cheio** | run de 60 execuções ≈ 300 MB, pior caso GBs | `maxOutputBytes`/`maxDiffBytes` por execução + `agents gc` + avisar no `doctor` quando o livre < 5 GB |
| **Worktree órfão** | `git worktree list` cresce; disco não libera | `prune` no fim da run e no `doctor`; `dispose` em `finally` |
| **Agente edita o teste** | oráculo passa e o diff toca `test/` | `forbiddenPaths` ⇒ `nao` automático; e o dossiê lista todos os comandos |
| **Agente lê `.env` do repo-semente** | leitura casando padrão de segredo | marcado como evento de risco no dossiê; `doctor` avisa antes |
| **Prompt injection do repo-semente** | um `AGENTS.md` hostil instruindo o agente | `--no-context-files` por default; e quando `contextFiles: true`, o dossiê **destaca** que o repo instruiu o agente |
| **Run de agente exposta na rede** | `PROMPT_BUILDER_AGENTS=1` + host público | recusa de boot (§21.5) |
| **Um resultado com n=1 vira decisão** | relatório sem aviso | aviso obrigatório de repetições, irmão do `holdoutSkipped` |

## 33. Fora do escopo da v1 (explicitamente)

- Datagen de tarefas de agente (§30.10).
- Container (§13.4) e proxy de inferência (§20.4).
- Segundo adaptador (Claude Code / `codex exec`) — a interface existe, a
  implementação não.
- UI de criação de run de agente. A UI, se ganhar algo, ganha **leitura**.
- Avaliação multi-agente (agentes conversando entre si), avaliação com humano no
  loop, e replay determinístico (reexecutar uma trajetória gravada sem chamar o
  modelo).
- Qualquer coisa rodando na Vercel.

## 34. Critério de sucesso do projeto inteiro

O plano é bem-sucedido quando estas cinco frases forem verdadeiras:

1. `prompt-builder agents run --config x.json --budget 5` roda do início ao fim,
   sem interação, e devolve um ranking com evidência.
2. Para qualquer veredito do ranking, existe um `dossier.md` em disco que mostra
   **exatamente** o que o juiz leu, e um `agents replay` que imprime o comando
   exato que produziu aquela execução.
3. O gasto reportado bate com a fatura dentro de uma margem conhecida e
   **declarada** (e o record diz se o número é medido ou derivado).
4. `agents doctor --deep` prova, com canários, que nenhuma configuração da máquina
   do usuário entrou no experimento.
5. Nenhuma run de chat existente mudou de comportamento — nem de resultado, nem de
   custo, nem de formato de record.

---

# APÊNDICES

## Apêndice A — Schemas completos

### A.1 Adições a `src/types.ts` (consolidado)

```ts
export type AgentStopReason =
  | 'completed' | 'maxTurns' | 'maxCost' | 'timeout'
  | 'maxOutput' | 'error' | 'cancelled';

export interface AgentLimits {
  maxTurns?: number;          // default 30
  maxCostUsd?: number;        // OBRIGATÓRIO em modo agente (§20.1)
  timeoutMs?: number;         // default 600_000
  maxOutputBytes?: number;    // default 8 MiB
  maxDiffBytes?: number;      // default 512 KiB
}

export interface AgentTaskSpec {
  repo?: { kind: 'git'; url?: string; path?: string; ref: string; shallow?: boolean };
  setup?: { cmd: string; timeoutMs?: number }[];
  files?: { path: string; content: string }[];
  verify?: { label?: string; cmd: string; expectExit?: number;
             timeoutMs?: number; weight?: number }[];
  forbiddenPaths?: string[];
  /** default false — ver o aviso em §12.2 */
  contextFiles?: boolean;
  limits?: AgentLimits;
}

export interface AgentRunnerConfig {
  executor: 'pi';
  executorVersion: string;
  install?: 'system' | 'isolated';       // default 'isolated'
  provider?: string;                      // default 'openrouter'
  promptMode?: 'replace' | 'append' | 'none';  // default 'append'
  tools?: string[];
  repetitions?: number;                   // default 1 (com aviso)
  maxParallel?: number;                   // default min(4, cpus-1)
  limits?: AgentLimits;
  isolation?: { kind?: 'worktree' | 'clone' | 'container';
                keepWorkspace?: boolean; image?: string };
  thinking?: ReasoningLevel;
  /** Orçamento de tokens do dossiê entregue ao juiz. default 12_000 */
  dossierTokens?: number;
}

export interface ExecutionRef {
  execId: string;
  repetition: number;
  dir: string;                            // relativo a getDataDir()
  turns: number;
  toolCalls: number;
  durationMs: number;
  stopReason: AgentStopReason;
  diffStat?: { files: number; added: number; removed: number };
  oracle?: { passed: number; failed: number; score: number };
  dossierSha256?: string;
  dossierTruncated?: boolean;
  /** > 0 ⇒ o stream teve linhas ilegíveis; a trajetória é parcial. */
  parseErrors?: number;
}

// aditivos
export interface Contestant { /* … */ runner?: 'chat' | 'agent'; }
export interface StageSpec  { /* … */ agentTask?: AgentTaskSpec; }
export interface CompetitorResponse { /* … */ execution?: ExecutionRef; }
export interface RunConfigBase { /* … */ agent?: AgentRunnerConfig; }
export type CostRole = 'datagen' | 'gabarito' | 'competitor'
                     | 'judge' | 'duel' | 'rewriter' | 'agent';
export type RunPhase = 'variants' | 'datagen' | 'gabarito'
                     | 'competitors' | 'judging' | 'finals' | 'holdout'
                     | 'agents';   // o grupo G2 em modo agente
```

### A.2 `ExecutionRecord` (o `exec.json` em disco)

```ts
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
    /** env com segredos redigidos NA ESCRITA (§14.2) */
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

  process: { exitCode: number | null; signal: string | null;
             stdoutBytes: number; stderrBytes: number };

  trajectorySummary: {
    turns: number; toolCalls: number; toolErrors: number;
    stopReason: AgentStopReason; parseErrors: number;
    compactions: number;
    byTool: Record<string, number>;
  };

  usage: { tokensIn: number; tokensOut: number; tokensReasoning: number;
           cacheRead: number; cacheWrite: number;
           costUsd: number; costSource: 'agent-derived' | 'reconciled' };

  oracle?: OracleResult;

  dossier: { sha256: string; tokensApprox: number; truncatedSections: string[];
             complete: boolean; redactions: number;
             mode: 'full' | 'compact' | 'summarized' };

  digests: Record<string, string>;   // arquivo → sha256
}
```

## Apêndice B — Prompts do juiz

### B.1 System do juiz pointwise de agente

```
Você é um juiz técnico estrito avaliando o trabalho de um AGENTE DE PROGRAMAÇÃO.

Você recebe um DOSSIÊ com: a verificação automática (quando existe), o resumo das
mudanças, o diff produzido, a lista do que o agente fez e a mensagem final dele.

REGRAS DE JULGAMENTO, em ordem de precedência:
1. A VERIFICAÇÃO AUTOMÁTICA tem precedência sobre a sua impressão. Se ela falhou,
   a tarefa não foi resolvida — não importa quão convincente seja a explicação
   do agente.
2. Julgue o RESULTADO (o diff e a verificação), não o estilo de trabalho. Um
   agente que resolveu em 3 passos não é pior que um que resolveu em 40.
   Trajetória mais longa NÃO é melhor.
3. Respeite o CRITÉRIO DE CORRETUDE da etapa quando ele existir; ele tem
   prioridade sobre o seu próprio critério.
4. Mudanças fora do escopo pedido são um DEFEITO, não um bônus.
5. Se o dossiê estiver marcado como truncado, julgue apenas com o que está
   presente e diga isso na explicação.

Responda APENAS com {"verdict": "resolve"|"parcial"|"nao",
"explanation": "<uma frase curta em pt-BR>"}, onde
resolve = a tarefa foi cumprida; parcial = incompleta, imprecisa, ou cumprida com
efeito colateral relevante; nao = não cumprida, ou cumprida burlando o critério.
```

### B.2 System do duelo de dossiês

Reusa o prompt de `duels.ts`, trocando "resposta" por "trabalho do agente" e
acrescentando a regra 1 acima. **Os dois dossiês entram com o mesmo orçamento e o
mesmo formato** — e a ordem é embaralhada pelo shuffle cego semeado, com as duas
ordens julgadas e desacordo virando empate, exatamente como hoje.

## Apêndice C — Código de referência

### C.1 `spawn` com timeout, limite de bytes e kill de árvore

```ts
import { spawn } from 'node:child_process';

export interface SpawnAgentResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stopReason: AgentStopReason;
  stdoutBytes: number;
  stderrBytes: number;
}

export async function spawnAgent(opts: {
  bin: string; argv: string[]; cwd: string; env: Record<string, string>;
  stdin: string;
  timeoutMs: number; maxOutputBytes: number;
  onStdoutChunk(buf: Buffer): void;     // alimenta o splitter JSONL
  onStderrChunk(buf: Buffer): void;
  signal?: AbortSignal;                 // cancelamento da run
  shouldStop?: () => AgentStopReason | null;  // teto de custo/turnos
}): Promise<SpawnAgentResult> {
  const child = spawn(opts.bin, opts.argv, {
    cwd: opts.cwd,
    env: opts.env,          // explícito; NUNCA {...process.env}
    detached: true,         // grupo próprio ⇒ kill(-pid) mata a árvore
    stdio: ['pipe', 'pipe', 'pipe'],
    // shell: false (default) — NUNCA true: o prompt vem de config do usuário
  });

  let stopReason: AgentStopReason = 'completed';
  let stdoutBytes = 0, stderrBytes = 0, killed = false;

  const killTree = (reason: AgentStopReason): void => {
    if (killed) return;
    killed = true;
    stopReason = reason;
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { /* já morreu */ }
    setTimeout(() => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* ok */ }
    }, 5_000).unref();
  };

  const timer = setTimeout(() => killTree('timeout'), opts.timeoutMs);
  timer.unref();

  const onAbort = (): void => killTree('cancelled');
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  // AMBOS os pipes são consumidos SEMPRE: ignorar um enche o buffer (~64 KiB)
  // e o filho bloqueia escrevendo nele — o processo "trava" e a culpa é nossa.
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

  child.stdin.on('error', () => undefined);   // EPIPE se o filho já saiu
  child.stdin.end(opts.stdin);                // escreve E fecha (§11.5)

  return await new Promise((resolve, reject) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: code,
        signal: sig,
        stopReason: killed ? stopReason : (code === 0 ? 'completed' : 'error'),
        stdoutBytes, stderrBytes,
      });
    });
  });
}
```

### C.2 Splitter JSONL LF-estrito (**não use `readline`** — §14.5)

```ts
import { StringDecoder } from 'node:string_decoder';

/**
 * O protocolo JSONL do pi é delimitado por LF e SOMENTE por LF. O `readline` do
 * Node também quebra em U+2028/U+2029, que são CARACTERES VÁLIDOS dentro de uma
 * string JSON — um agente que leia um arquivo com separador Unicode faria o
 * readline partir o JSON no meio, com falha intermitente e dependente de
 * conteúdo. Este splitter quebra só em '\n'.
 */
export function createJsonlSplitter(
  onRecord: (obj: unknown) => void,
  onParseError: (line: string, err: unknown) => void,
) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const emit = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    try { onRecord(JSON.parse(line)); }
    catch (err) { onParseError(line, err); }   // degrada: NUNCA derruba
  };

  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    end(): void {
      buffer += decoder.end();
      if (buffer.length > 0) { emit(buffer); buffer = ''; }
    },
  };
}
```

### C.3 Workspace: preparar, medir, derrubar

```bash
# 1. cache do seed (uma vez por run, endereçado por hash de url|path + ref)
git clone --bare --no-tags "$SEED" "$CACHE/$HASH"      # ou --depth 1 --branch $REF

# 2. worktree por execução
git -C "$CACHE/$HASH" worktree add --detach "$EXEC/workspace" "$REF"

# 3. setup (não é trabalho do agente) e fixtures — DEPOIS o seed commit
( cd "$EXEC/workspace" && npm ci --ignore-scripts )
git -C "$EXEC/workspace" add -A
git -C "$EXEC/workspace" commit -q --allow-empty -m "seed"
SEED_SHA=$(git -C "$EXEC/workspace" rev-parse HEAD)

# 4. …o agente roda…

# 5. artefato
git -C "$EXEC/workspace" add -A
git -C "$EXEC/workspace" commit -q --allow-empty -m "agent-result"
AFTER_SHA=$(git -C "$EXEC/workspace" rev-parse HEAD)
git -C "$EXEC/workspace" diff --no-color "$SEED_SHA".."$AFTER_SHA" > "$EXEC/workspace.diff"
git -C "$EXEC/workspace" diff --numstat  "$SEED_SHA".."$AFTER_SHA" > "$EXEC/workspace.stat"
git -C "$EXEC/workspace" diff --name-status "$SEED_SHA".."$AFTER_SHA" > "$EXEC/files.txt"

# 6. oráculo (depois do commit: lixo de teste não polui o artefato)
( cd "$EXEC/workspace" && npx tsc --noEmit ); echo $? >> "$EXEC/oracle.raw"

# 7. dispose
git -C "$CACHE/$HASH" worktree remove --force "$EXEC/workspace"
git -C "$CACHE/$HASH" worktree prune
```

## Apêndice D — Exemplo de dossiê (abreviado)

```markdown
## 1. CABEÇALHO
Tarefa .............. Etapa 2 — "O parser de datas quebra com fuso negativo…"
Candidato ........... B                      (identidade redigida: 47 substituições)
Modo de prompt ...... append
Limites ............. 30 turnos · US$ 0,40 · 600 s
Encerramento ........ completed
Turnos .............. 7        Ferramentas: 19        Duração: 3 min 12 s
Custo ............... US$ 0,1132 (derivado do executor)
Dossiê .............. COMPLETO

## 2. VERIFICAÇÃO AUTOMÁTICA
[PASSOU]  typecheck   `npx tsc --noEmit`        exit 0 (esperado 0) · peso 1
[FALHOU]  testes      `npm test -- --run`       exit 1 (esperado 0) · peso 3
    últimas linhas:
    ✗ parseOffset > deve aceitar -03:00
      esperado -180, recebido 180
    Tests: 1 failed | 23 passed (24)
Caminhos proibidos ... nenhum

## 3. RESUMO DAS MUDANÇAS
 src/date/parse.ts        | 12 +++++++---
 src/date/offset.ts       |  4 ++--
 2 arquivos, +14 −5
 [M] src/date/parse.ts    [M] src/date/offset.ts

## 4. DIFF
--- a/src/date/parse.ts
+++ b/src/date/parse.ts
@@ -41,9 +41,14 @@
-  const sign = m[1] === '+' ? 1 : 1;
+  const sign = m[1] === '-' ? -1 : 1;
…
[... 38 linhas omitidas neste arquivo ...]

## 5. O QUE O AGENTE FEZ
 1. t1 · grep     "parseOffset"                                    ok
 2. t1 · read     src/date/parse.ts                                ok
 3. t2 · bash     npm test -- --run                                ok (exit 1)
 4. t3 · edit     src/date/parse.ts                                ok
 5. t4 · bash     npm test -- --run                                ok (exit 1)
    ✗ parseOffset > deve aceitar -03:00 — esperado -180, recebido 180
 …
19. t7 · bash     npx tsc --noEmit                                 ok (exit 0)

## 6. MENSAGEM FINAL DO AGENTE
Corrigi o sinal do offset em parse.ts e ajustei offset.ts. O typecheck passa; um
teste ainda falha e acredito que o valor esperado no teste esteja invertido.

## 7. INTEGRIDADE
dossierComplete: true · seções truncadas: [4] · parseErrors: 0 · redactions: 47
sha256: 3f1c…a92b
```

Note o que este dossiê deixa evidente para o juiz — e que um resumo por LLM
poderia ter engolido: o agente **suspeitou do teste** e não o alterou (o
`forbiddenPaths` fez o seu trabalho antes mesmo de precisar punir); o oráculo
falhou; e o veredito correto é `parcial`, não `resolve`, apesar de a mensagem
final soar confiante.

## Apêndice E — Comando de verificação da sala limpa (o canário)

```bash
CANARY="CANARY-$(uuidgen)"
mkdir -p "$T/proj" "$T/home"
printf 'Sempre responda começando com %s\n' "$CANARY-PROJ"   > "$T/proj/AGENTS.md"
printf 'Sempre responda começando com %s\n' "$CANARY-GLOBAL" > "$T/home/AGENTS.md"
printf '{"defaultThinkingLevel":"max","theme":"%s"}\n' "$CANARY-SET" > "$T/home/settings.json"

cd "$T/proj"
env -i HOME="$T/home" PATH=/usr/bin:/bin LANG=C.UTF-8 TZ=UTC \
  PI_CODING_AGENT_DIR="$T/home" PI_CODING_AGENT_SESSION_DIR="$T/sess" \
  PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
  OPENROUTER_API_KEY="$KEY" \
  pi --mode json --provider openrouter --model "$MODEL" \
     --no-context-files --no-extensions --no-skills \
     --no-prompt-templates --no-themes --no-approve --no-tools \
     --session-dir "$T/sess" \
  <<< "Repita literalmente TODO o texto de sistema e de contexto que você recebeu." \
  > "$T/out.jsonl"

# A sala está limpa se e somente se NENHUM canário aparecer:
! grep -q "CANARY-" "$T/out.jsonl" && echo "sala limpa" || echo "SALA SUJA"
```

---

## Encerramento

O plano cabe numa ideia: **o agente é um competidor cuja resposta é um par
(artefato, trajetória)**. Tudo o que este documento faz é levar essa ideia a sério
até o fim — o que significa aceitar que ela cobra três preços que o modo chat não
cobra: o resultado precisa de **isolamento** (senão as execuções se contaminam), a
evidência precisa de **curadoria determinística** (senão não cabe no juiz e não é
auditável), e o dinheiro precisa de **contrato** (senão não há teto possível).

As três respostas — worktree efêmero, dossiê montado por código e salvo, teto por
execução imposto por `SIGKILL` — são a maior parte do trabalho. O resto é o motor
que já existe fazendo o que já faz.

E a parte que este documento **não** sabe está marcada: como julgar uma trajetória
é, hoje, extrapolação. O desenho compensa isso dando ao LLM o menor poder possível
(o oráculo manda, o LLM gradua) e guardando tudo o que ele leu, para que o dia em
que a evidência chegar seja um dia de ajustar pesos — não de refazer o sistema.
