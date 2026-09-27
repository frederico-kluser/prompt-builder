# Problemas comuns

## `Faltou definir orçamento` (código 2)

Você está fora de um terminal interativo. Passe `--budget 5` ou `--budget none`.
Nada foi gasto.

## HTTP 400 ao mandar esforço de raciocínio

O nível pedido não existe naquele modelo. Confira antes:

```bash
prompt-builder models show <id> --json | jq .model.thinkLevels
```

`accepted` lista o que pode ser pedido; `fit` mostra o que vai no fio para cada
pedido. Modelos com `canDisable: false` **ignoram** `off` — raciocínio é
obrigatório neles.

## `OpenRouter sem crédito (HTTP 402)` (código 5)

`prompt-builder key check` mostra uso, limite e saldo. O pré-voo recusa antes de
gastar quando o saldo não cobre nem o piso da estimativa.

## Todos os vereditos vieram `parcial`

Significa que o juiz não teve gabarito para comparar. Causas, em ordem de
frequência:

1. o modelo de referência falhou (sem crédito, id errado, timeout) — os cenários
   ficam sem `reference` e o juiz pointwise degrada;
2. `referenceJudging` está desligado (padrão do `compare` clássico);
3. os cenários vieram de um pacote sem gabarito.

Rode com `--output-format ndjson` e procure `progress` com `phase: "gabarito"`.

## `modelos fora do catálogo (custo contado como zero)`

O id não existe no catálogo carregado — provavelmente um erro de digitação ou um
modelo retirado. Com `--budget` ligado isso vira **erro**, porque um orçamento
sobre um custo desconhecido não seria orçamento nenhum.

```bash
prompt-builder models list --search <parte-do-nome>
```

## Run travada em `running`

O processo morreu sem finalizar (SIGKILL, queda de energia). O próximo comando
que lista runs marca as órfãs como `aborted`. Os dados parciais continuam lá.

## `Run "..." não encontrada`

Você está apontando para outro diretório de dados. Confira com
`prompt-builder doctor` — runs vivem em `~/.prompt-builder/runs/` por padrão,
e `--data-dir` / `$PROMPT_BUILDER_HOME` mudam isso.

## O comando parece travar no fim

Não deveria: os temporizadores internos são `unref`ados. Se acontecer, reporte
com `--verbose`.

## Catálogo offline

Se o OpenRouter estiver fora do ar, o CLI usa o cache em disco (até 24 h) e
avisa no stderr. `models list` funciona offline; runs, não.

## Modo container — `docker: comando não encontrado` / daemon indisponível

Quando `isolation.kind` é `"container"`, o run precisa do Docker **CLI** no PATH e de um
**daemon acessível sem sudo**. Se o CLI
falta ou o daemon está inacessível, a preparação/execução falha. Instale/ative o Docker e
garanta acesso sem sudo. Confirme com `agents doctor --container`: o pré-voo ecoa o estado
do Docker (`· docker ok (prompt-builder-pi:<ver>)` ou `docker CLI AUSENTE` / `imagem ausente`)
e **falha com exit `3`** quando o CLI/imagem faltam.

## Modo container — execução em `error` com `Connection error.` / doctor: `o agente não alcança o provedor`

O container roda com `--network none` (perfil endurecido): sem o proxy de inferência
local, o `pi` não alcança o OpenRouter. O `agents doctor --container` já **falha com exit
`3`** por isso (é o aviso cedo, sem gastar). Se a run seguir, o `pi` esgota as
retentativas e sai 0 — o prompt-builder marca a execução como **erro de infraestrutura**
(`stopReason: "error"` + `execution.infraError`) e põe no `stderr.log` a mensagem do
provedor e a dica. A repetição fica **sem veredito — fora do placar e das médias, nunca
`nao`** (exceto se o oráculo já for conclusivo: passou 100% ou violou `forbiddenPaths`).
Um processo que **morre** sem erro do provedor continua `error` → `nao`. Se você aceita o
risco (a key fica ao alcance do agente), rode com
`PROMPT_BUILDER_UNSAFE_CONTAINER_NETWORK=bridge` no ambiente do operador; o doctor avisa e
o `argv.json` registra o desvio em `hardening.unsafe`.

## Modo container — `range of CPUs is from 0.01 to N`

O `--cpus` do sandbox é encaixado no `NCPU` do **daemon** (`docker info`). Se o erro
aparecer, o daemon não respondeu ao `docker info` no preparo (o fallback usa as CPUs da
máquina do CLI) — confira `docker info --format '{{.NCPU}}'` com o mesmo `DOCKER_HOST`.

## Modo container — `não roda o agente como root`

O container herda o uid do host e **nunca** roda como root. Execute o prompt-builder com
um usuário comum (ou Docker rootless).

## Modo container — imagem docker `prompt-builder-pi:<ver>` ausente

A imagem default `prompt-builder-pi:<executorVersion>` (ex. `prompt-builder-pi:0.84.2`) é
**criada e cacheada na primeira preparação de run em container** (`ensurePiImage` — o
`doctor` não builda). Se o pré-voo acusar a imagem ausente, rode uma run em container para
buildá-la automaticamente; ou adiante com `docker build` seguindo o Dockerfile (em produção,
embutido em `src/agent/container.ts`).
