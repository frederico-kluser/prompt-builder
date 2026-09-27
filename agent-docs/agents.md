# Modo agente (Agent Arena)

Nos modos de chat, um competidor entrega um **texto** e o juiz compara textos.
No modo agente, o competidor é um **processo**: ele recebe uma tarefa, roda por
vários turnos, usa ferramentas (`read`, `write`, `edit`, `bash`, `grep`, ...),
mexe em arquivos de verdade dentro de um workspace isolado e termina deixando um
**artefato** (um diff) e um **rastro** (a trajetória).

> **Um agente é um competidor cuja resposta não é um texto, e sim um par
> (artefato, trajetória).** Quase todo o resto do motor continua valendo:
> placar aditivo, judge-score, finais por taxa de vitória, orçamento, NDJSON, CSV.

O runner é `'agent'` (contra `'chat'`); o executor é o **`pi`** (pi.dev) rodando
em **sala limpa**: versão pinada (`executorVersion`), instalado isolado da máquina
no modo `isolated`, sem as skills/temas/`SYSTEM.md` do ambiente. A configuração
da máquina não pode vazar para o experimento — e o `agents doctor` é quem **prova**
(com canários) que a sala está limpa antes de rodar.

O isolamento de execução tem **três `isolation.kind`**: **`worktree`** (default —
`git worktree` da raiz-de-mundo), **`clone`** (clone descartável por execução) e
**`container`**. Em `container`, **cada execução do `pi` roda num container Docker
efêmero e endurecido** (imagem `prompt-builder-pi:<ver>` pinada por digest sha256,
`--cap-drop ALL`, `no-new-privileges`, rootfs read-only, `--network none`, roda como o
usuário do host — nunca root). A key do OpenRouter **nunca entra no sandbox**: fica num
proxy de inferência local do host, e o agente fala com ele por um socket Unix montado
read-only, com um token fictício por execução. A imagem é criada/cacheada na **primeira preparação** de run em
container. Exige Docker **CLI/daemon** acessível (sem sudo); valide com
`agents doctor --container`.

O contrato completo da configuração está na próxima doc: `docs agent-task`.

## O caminho feliz em 5 comandos

```bash
# 1. PROVE a sala limpa antes de qualquer coisa (canários, versão pinada, git, disco).
#    Em modo container, use `--container --config x.json` (Docker CLI, imagem/runtime da run e
#    rota até o provedor pelo proxy de inferência, medida no sandbox — exit 3 se faltarem).
prompt-builder agents doctor          # --deep roda o auto-teste de sala limpa

# 2. Rode. --config declara a arena; --budget é o teto da run inteira.
prompt-builder agents run --config x.json --budget 5

# 3. Veja as runs existentes.
prompt-builder agents list --json

# 4. Veja o resultado de um contestant (dossier é o que o juiz leu).
prompt-builder agents show <runId> --json

# 5. Imprima o artefato de uma execução (dossier default; diff/trajectory/session).
prompt-builder agents logs <runId> --stage 0 --contestant <id> --what diff
```

## Limites obrigatórios (não improvise em cima deles)

- **`--budget` é obrigatório.** Sem ele, e sem terminal interativo, o comando
  recusa (exit `2`) e não gasta nada.
- **`agent.limits.maxCostUsd` é obrigatório.** Sem ele não há estimativa e sem
  estimativa não há orçamento — o agente gastaria o que quisesse. Ausência é
  erro de config (exit `3`), não default silencioso.
- **Rode `agents doctor` antes.** Ele falha (exit `3`) se a sala estiver suja —
  uma configuração da máquina vazando para o experimento invalida a comparação.

O teto é imposto **matando** a execução (`SIGTERM` → graça → `SIGKILL`) e é
**aproximado por baixo**: a última chamada em voo quando o sinal chega já foi
cobrada. Configurar `maxCostUsd: 0.05` e ver `0.061` **é o teto funcionando**.

## `stopReason` — por que a execução terminou (e o que isso significa)

**Erro de infraestrutura não é `error` do agente.** Quando a execução termina porque o
**provedor/rede** falhou na última chamada ao modelo (retentativas esgotadas — ex.:
proxy de inferência sem alcançar o provedor, 502/`Connection error.`), o `stopReason` é `error`,
mas a execução leva `infraError` e a repetição fica **sem veredito — fora do placar e das
médias, nunca `nao`**. Exceção: oráculo conclusivo (passou 100% ou violou
`forbiddenPaths`) decide como numa execução concluída. O `error` → `nao` da tabela é o
processo que **morreu** sem erro do provedor.

| `stopReason` | O que acontece | Efeito na nota |
|---|---|---|
| `completed` | o agente terminou sozinho | julgado normalmente (oráculo → juiz) |
| `maxTurns` | bateu o teto de turnos | `nao` — **conta no denominador** |
| `maxCost` | bateu o teto de custo da execução | `nao` — **conta no denominador** |
| `timeout` | bateu a parede de tempo | `nao` — **conta no denominador** |
| `maxOutput` | emitiu bytes demais | `nao` — **conta no denominador** |
| `error` | o processo morreu / executor falhou | `nao`, falha de execução |
| `cancelled` | sinal de controle (Ctrl-C) | etapa `incomplete` — **fora do placar** |

A regra é dura: **corte por limite é falha.** O limite faz parte da tarefa e é
igual para todos os contestants; um agente cortado no turno 30 não terminou, e
isso conta `nao` no judge-score, no `resolveRateByContestant` e no vetor da
significância. Tirar o corte do denominador (a regra antiga, árvore v1) dava a
quem entra em laço nas tarefas difíceis uma nota perfeita nas fáceis — viés de
sobrevivência. Nenhum harness de referência (SWE-bench, Inspect AI,
Terminal-Bench) exclui por limite.

`incomplete` fica reservado aos **sinais de controle** — cancelamento e
orçamento da run —, que não dependem do comportamento do agente: a etapa sai
inteira do placar, para todos.

**Exceção única:** quando **existe oráculo e ele passa 100%, sem violar
`forbiddenPaths`**, o corte por teto ainda pode valer `resolve` — o mundo mudou
de forma verificável, e o critério de sucesso é o teste, não a educação do
agente ao se despedir. Oráculo parcial, zerado ou violado + corte = `nao`.

## Oráculo × juiz — o juiz só age DENTRO da faixa do oráculo

Teste passando não prova correção (e o juiz LLM erra), então o juiz **audita**
— só rebaixa —, **nunca promove** acima do que o oráculo mediu:

| Oráculo (`verify[]`) | Faixa do juiz | Se o juiz falhar |
|---|---|---|
| score 1, sem violação | `resolve` ou rebaixa a `parcial` | fica `resolve` (do oráculo) + `judgeError` |
| score entre 0 e 1 | confirma `parcial` ou rebaixa a `nao` — **nunca `resolve`** | fica `parcial` (do oráculo) + `judgeError` |
| score 0 / `forbiddenPaths` violado | `nao` direto, sem juiz | — |
| check que não terminou (timeout/sinal do check; comando ausente que rodou em outra execução) | conta como check **falho** no score — a execução nunca sai do denominador por isso | — |
| comando do check ausente em **todas** as execuções da etapa | etapa **inválida para TODOS** (`stage.error`) — defeito da tarefa, não desempenho | — |
| sem oráculo | juiz pleno pelo dossiê | **sem nota** (nunca um `parcial` inventado) + `judgeError` |

"Falhar" = exceção, timeout ou resposta fora do schema estrito
`{"rubrica": {resultado, escopo, burla, manipulacao}, "verdict", "explanation"}`
(JSON puro, sem campo extra, veredito nunca mais favorável que a própria rubrica)
— recusa, texto livre e JSON no meio de prosa incluídos, nunca lidos "por
palavra" — **mesmo após 2 retentativas** (3 chamadas). Orçamento/cancelamento não
são falha do juiz: sobem como controle.

**Anti-injeção.** No `dossier.md`, tudo o que o agente escreveu (diff, nomes de
arquivo, comandos, saídas, mensagem final, saída dos checks) fica dentro de blocos
`<<<DADOS-DO-AGENTE secao="…" marca="M">>>` … `<<<FIM-DADOS-DO-AGENTE marca="M">>>`
com toda linha prefixada por `│ `; a marca `M` sai do hash do conteúdo (linha
`marca-dos-dados` do rodapé) e marcadores forjados são neutralizados
(`neutralizacoes` no rodapé e em `exec.json`). Fora dos blocos só há texto de
código: cabeçalho, checks, score e os **Fatos** (JSON de campos fechados). O
system prompt do juiz é fixo e manda tratar o conteúdo dos blocos como evidência,
nunca como instrução; a rubrica do juiz (inclusive `manipulacao: "detectada"`)
fica no `verdict.json`.

## Modo container (`agent.isolation.kind: "container"`)

Quando `isolation.kind` é `'container'`, a **execução** do agente (e só ela — `setup[]`
e `verify[]`/oráculo continuam no host) roda num container Docker **efêmero** por
repetição:

- **Imagem default:** `prompt-builder-pi:<executorVersion>` (ex. `prompt-builder-pi:0.84.2`),
  derivada da versão pinada do executor. Ela é **criada na primeira preparação de run
  em container** (via `ensurePiImage`, com o Dockerfile embutido em `src/agent/container.ts`)
  e **cacheada por tag** — o `doctor` **não** builda; `isolation.image` sobrescreve a tag.
  Dockerfile em produção: `node:22-bookworm-slim` + `git`/`ca-certificates`/`bash` +
  `npm i -g @earendil-works/pi-coding-agent@<versão>`.
- **Execução efêmera por rep:** `docker run -i --rm` com o container nomeado
  `pb-agent-<execId>`, binds `<workspace>` → `/ws` (cwd), `<execDir>/session` →
  `/exec/session` e `<execDir>/pi-home` → `/exec/pi-home`. Os artefatos que o agente
  grava **aparecem no host** sem `docker cp`; o resto do `<execDir>` (argv.json, logs
  crus) **não** é montado — o agente não alcança a própria auditoria.
- **Perfil endurecido FIXO (sem knob no arquivo):** `--cap-drop ALL --security-opt
  no-new-privileges --read-only` + `--tmpfs /tmp` e `--tmpfs /exec`, `--network none`,
  `--pids-limit 512`, `--cpus` ≤ 2, `--memory 2g --memory-swap 2g`, `--pull never` e imagem por
  **digest**. O `argv.json` da execução registra o digest e o perfil efetivo
  (`hardening`) para conferir contra o `docker inspect`. Graváveis dentro do container:
  só `/ws`, `/tmp`, `/exec/session` e `/exec/pi-home` (= `$HOME`).
- **Usuário:** `--user <uid>:<gid>` = o **usuário do host**, **nunca root** — os
  artefatos criados no container são legíveis pelo host **sem sudo**. Rodar o
  prompt-builder como root com `kind: "container"` é recusado (use um usuário comum ou
  Docker rootless).
- **Key do OpenRouter: NUNCA entra no sandbox.** Ela fica num **proxy de inferência
  local** do host (um por run), que a injeta só na perna HTTPS até o provedor. O agente
  recebe uma base URL local + um **token fictício por execução** (no `models.json` do
  `pi`, não no env — `printenv OPENROUTER_API_KEY` dentro do container é vazio), revogado
  quando a execução termina. O `--env-file` tmp 0600 do host leva só as `PI_*`; o
  `argv.json` registra os NOMES das variáveis (`inference.envKeys`) e o sha256 do relay.
  O log **redigido** do proxy fica em `<dataDir>/agent-runs/<runId>/inference-proxy.jsonl`
  (método, rota, status, bytes, tempos, `upstreamAuth: "injected"` e o `keyFingerprint`
  — nunca a key, o token, headers ou corpos). Rotas de gerência da conta (`/keys`,
  `/credits`, `/key`) são recusadas pelo proxy.
- **Timeout/cancelamento:** mata o container **por nome** → `docker kill <nome>` +
  `docker rm -f <nome>` (fire-and-forget, idempotente). Nenhum órfão no host.
- **Rede:** `--network none` por default — o agente **não** tem rota para fora (DNS, IP
  direto e os serviços do host falham). A ÚNICA saída é o proxy de inferência: o socket
  Unix dele é montado **read-only** em `/exec/proxy` e um relay (PID 1 do container)
  o expõe numa base URL HTTP no loopback do próprio container (porta fixa do relay). O
  `agents doctor --container` **mede** essa rota no sandbox da run (relay → proxy, key
  ausente, egress bloqueado) e **falha (exit `3`)** se ela não fechar — ex.: Docker
  Desktop (macOS/Windows) ou gVisor sem `--host-uds=open`, onde o socket do host não
  atravessa. Se o modelo não responder numa execução (proxy/upstream fora), ela termina
  como **erro de infraestrutura**: `stopReason: "error"` com `execution.infraError` e a
  dica no `stderr.log` — **sem veredito, fora do placar e das médias; nunca `nao`**.
  Válvula **do operador** (variável de ambiente, nunca campo do arquivo):
  `PROMPT_BUILDER_UNSAFE_CONTAINER_NETWORK=bridge` devolve a rede padrão para tarefas
  cujas tools precisam de rede — a key continua só no proxy, mas o agente ganha egress
  (pode exfiltrar o workspace); o uso é avisado no stderr, no `agents doctor` e
  registrado em `hardening.unsafe` do `argv.json`.
- **`--cpus`** é encaixado nas CPUs do **daemon** (`docker info` → `NCPU`), não nas da
  máquina que roda o CLI — `DOCKER_HOST` remoto e a VM do Docker Desktop têm menos.
- **Pré-requisito:** Docker **CLI** no PATH **e** daemon acessível (sem sudo). Confira
  com `agents doctor --container --config x.json` (mostra a tag → digest que a run
  usaria; com `--config`, mede a `image`/`runtime` do arquivo — sem ele, a imagem
  default em runc).

**Nota de escopo (TODO de fase futura):** hoje só a **execução** do agente é isolada
pelo container. `setup[]` e `verify[]` (oráculo) rodam no HOST. Isolar esses também via
`dockerExec` está no roadmap de uma fase futura.

### Métricas de agente no `RunRecord`

| Campo | O que é |
|---|---|
| `resolveRateByContestant` | **métrica principal**: fração de `resolve` sobre TODAS as execuções (etapas × repetições), cortes incluídos como `nao` |
| `censoredResolveRateByContestant` | **só diagnóstico** ("sucesso até o limite"): a mesma fração sem os cortes no denominador. Nunca entra em placar, finais ou gate |
| `limitCutsByContestant` | quantas execuções foram cortadas por limite (já contadas como `nao`) |
| `agentVerdictTreeVersion` | versão da árvore de veredito que produziu as notas. **Ausente numa run com agente = v1 (legado)**, em que o corte saía do denominador; **v3** = juiz confinado ao oráculo e falha do juiz sem `parcial` inventado — notas de versões diferentes não se comparam |
| `agentJudgeErrorCount` / `agentJudgeErrorsByContestant` | execuções em que o juiz falhou após as retentativas (`judgeError`) — a nota ficou com o oráculo, ou sem nota se não havia oráculo. Presente (0) em toda run com agente |
| `agentUnscoredRepsByContestant` | execuções **sem nota** por motivo que não é controle nem comportamento do agente (sem oráculo: juiz falhou ou não foi chamado; ou erro de infraestrutura do provedor/rede sem oráculo conclusivo) — fora de judge-score/resolveRate |

O `agentSummary` (NDJSON `run.finished`, `result` do `agents run`, MCP) separa
`limitCut` (cortes, contam `nao`) de `incomplete` (só cancelamento) e traz
`verdictTreeVersion`, `judgeErrors` e `unscoredReps`. Taxa de `judgeErrors`
alta = o juiz está instável (modelo, timeout curto, dossiê grande): as notas
ainda são do oráculo, mas a auditoria do juiz não aconteceu.

Detalhes do contrato: `prompt-builder docs agent-task`.