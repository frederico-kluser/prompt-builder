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
| `completed` | o agente terminou sozinho | julgado normalmente |
| `maxTurns` | bateu o teto de turnos | `incomplete` — **fora do placar** |
| `maxCost` | bateu o teto de custo da execução | `incomplete` — **fora do placar** |
| `timeout` | bateu a parede de tempo | `incomplete` — **fora do placar** |
| `maxOutput` | emitiu bytes demais | `incomplete` — **fora do placar** |
| `error` | o processo morreu / executor falhou | `nao`, falha de execução |
| `cancelled` | sinal de controle (Ctrl-C, orçamento da run) | `incomplete` — **fora do placar** |

A regra é dura: **`stopReason !== 'completed'` ⇒ a resposta é `incomplete` e a
etapa não entra no placar daquele contestant.** Um agente cortado no turno 30
não "resolveu parcialmente" — ele não terminou. Contá-lo como `parcial`
inventaria um resultado; contá-lo como `nao` puniria o contestant pelo **nosso**
teto.

**Exceção única:** quando **existe oráculo e ele passa**, `stopReason` de teto
(`maxTurns`/`maxCost`/`timeout`/`maxOutput`) ainda pode valer `resolve` — porque
o mundo mudou de forma verificável, e o critério de sucesso é o teste, não a
educação do agente ao se despedir. Sem oráculo, todo corte é `incomplete`.

Detalhes do contrato: `prompt-builder docs agent-task`.