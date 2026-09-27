# Modo agente (Agent Arena)

Nos modos de chat, um competidor entrega um **texto** e o juiz compara textos.
No modo agente, o competidor é um **processo**: ele recebe uma tarefa, roda por
vários turnos, usa ferramentas (`read`, `write`, `edit`, `bash`, `grep`, ...),
mexe em arquivos de verdade dentro de um workspace isolado e termina deixando um
**artefato** (um diff) e um **rastro** (a trajetória).

> **Um agente é um competidor cuja resposta não é um texto, e sim um par
> (artefato, trajetória).** Quase todo o resto do motor continua valendo:
> placar aditivo, judge-score, finais Copeland, orçamento, NDJSON, CSV.

O runner é `'agent'` (contra `'chat'`); o executor é o **`pi`** (pi.dev) rodando
em **sala limpa**: versão pinada (`executorVersion`), instalado isolado da máquina
no modo `isolated`, sem as skills/temas/`SYSTEM.md` do ambiente. A configuração
da máquina não pode vazar para o experimento — e o `agents doctor` é quem **prova**
(com canários) que a sala está limpa antes de rodar.

O isolamento de execução tem **três `isolation.kind`**: **`worktree`** (default —
`git worktree` da raiz-de-mundo), **`clone`** (clone descartável por execução) e
**`container`**. Em `container`, **cada execução do `pi` roda num container Docker
efêmero** (`prompt-builder-pi:<ver>`, monta `/ws` + `/exec`, roda como o usuário do
host), com a key do OpenRouter chegando por um **`--env-file` 0600 do host** (nunca
em arquivo/volume) e a imagem criada/cacheada na **primeira preparação** de run em
container. Exige Docker **CLI/daemon** acessível (sem sudo); valide com
`agents doctor --container`.

O contrato completo da configuração está na próxima doc: `docs agent-task`.

## O caminho feliz em 5 comandos

```bash
# 1. PROVE a sala limpa antes de qualquer coisa (canários, versão pinada, git, disco).
#    Em modo container, use `--container` (vê se o Docker CLI/imagem existem — exit 3 se faltarem).
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
| inconclusivo (check não rodou) | **sem juiz**: re-verifica 2×; persistindo, execução **inválida** — sem nota, fora do denominador | — |
| sem oráculo | juiz pleno pelo dossiê | **sem nota** (nunca um `parcial` inventado) + `judgeError` |

"Falhar" = exceção, timeout ou resposta sem veredito reconhecível **mesmo após 2
retentativas** (3 chamadas). Orçamento/cancelamento não são falha do juiz: sobem
como controle.

### Métricas de agente no `RunRecord`

| Campo | O que é |
|---|---|
| `resolveRateByContestant` | **métrica principal**: fração de `resolve` sobre TODAS as execuções (etapas × repetições), cortes incluídos como `nao` |
| `censoredResolveRateByContestant` | **só diagnóstico** ("sucesso até o limite"): a mesma fração sem os cortes no denominador. Nunca entra em placar, finais ou gate |
| `limitCutsByContestant` | quantas execuções foram cortadas por limite (já contadas como `nao`) |
| `agentVerdictTreeVersion` | versão da árvore de veredito que produziu as notas. **Ausente numa run com agente = v1 (legado)**, em que o corte saía do denominador; **v3** = juiz confinado ao oráculo e falha do juiz sem `parcial` inventado — notas de versões diferentes não se comparam |
| `agentJudgeErrorCount` / `agentJudgeErrorsByContestant` | execuções em que o juiz falhou após as retentativas (`judgeError`) — a nota ficou com o oráculo, ou sem nota se não havia oráculo. Presente (0) em toda run com agente |
| `agentUnscoredRepsByContestant` | execuções **sem nota** por motivo que não é controle (verificador inconclusivo; juiz falho sem oráculo) — fora de judge-score/resolveRate/significância |

O `agentSummary` (NDJSON `run.finished`, `result` do `agents run`, MCP) separa
`limitCut` (cortes, contam `nao`) de `incomplete` (só cancelamento) e traz
`verdictTreeVersion`, `judgeErrors` e `unscoredReps`. Taxa de `judgeErrors`
alta = o juiz está instável (modelo, timeout curto, dossiê grande): as notas
ainda são do oráculo, mas a auditoria do juiz não aconteceu.

Detalhes do contrato: `prompt-builder docs agent-task`.