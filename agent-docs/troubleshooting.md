# Problemas comuns

Com `--json` (ou `--output-format ndjson`), todo erro chega no stdout como
`{ok:false, command, error:{code, kind, message, hint, details}}`. Procure
aqui pelo `error.code`; o `error.hint` já traz o comando que resolve o caso
comum, e `error.details` o dado exato (flag culpada, arquivo, saldo, estimativa).

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

## `config.unknown_model` — modelo fora do catálogo (código 3)

O id não existe no catálogo carregado — provavelmente um erro de digitação ou um
modelo retirado. A run real e o `--dry-run` recusam igual, antes de gastar:
chamar um id inexistente daria HTTP 400 depois de já ter pago datagen e
gabaritos. `error.details.unknownModelIds` traz os ids culpados.

```bash
prompt-builder models list --search <parte-do-nome>
```

Se o modelo acabou de sair (ou o aviso diz que o catálogo veio de cache
vencido), `--refresh-models` força recarregar.

## `config.unpriced_models` (código 3)

Com `--budget` ligado, todo modelo precisa de preço exato no catálogo: variantes
de roteamento (`:nitro`, `:floor`, `:online`, `:exacto`) e modelos de preço
variável (`openrouter/auto`) não têm. Use o id base ou `--budget none`.

## `usage.confirmation_required` (código 2)

O teto está dentro da faixa estimada: a run pode parar no meio (código `7`).
Fora de um terminal isso exige `--yes` — ou suba o `--budget` acima do teto
estimado (`error.details.estimateHighUsd`).

## `run.locked` (código 2)

Outro processo **vivo** roda a mesma config agora (`error.details.holder`: pid,
comando, run). Rodar de novo gastaria o mesmo experimento em dobro. Espere-o
terminar (`runs show <runId>`), ou repita com a mesma `--idempotency-key` que
ele usou para se anexar sem gastar. Réplica intencional: `--allow-concurrent`.

## `control.daily_cap_reached` (código 7)

O teto diário da máquina (padrão US$ 20, dia UTC, somando todos os processos)
acabou. `prompt-builder limits show` mostra quem gastou; o teto zera às 00:00
UTC. Subir o teto é decisão humana: `limits set --daily <usd>`.

## `usage.idempotency_conflict` (2) / `run.orphaned` (1)

A `--idempotency-key` identifica UM experimento: reusada com outra config é
conflito (use uma key nova). `run.orphaned` = a execução dona da key morreu sem
terminar; o parcial fica em `runs show`, e rodar de novo exige outra key.

## `doctor` com código 4

Sem key válida (ausente ou recusada) o `doctor` falha com `4` e o relatório
inteiro em `error.details.checks`. Com key boa ele sai `0` e, se a key não tem
limite (ou não tem reset diário), recomenda `limit` + `limit_reset=daily` no
OpenRouter — a única camada que vale entre máquinas.

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
avisa no stderr. `models list` funciona offline — e sem key: o catálogo é
público, e sem key o CLI usa o cache mais recente que houver em disco; runs,
não.

## Modo container — `docker: comando não encontrado` / daemon indisponível

Quando `isolation.kind` é `"container"`, o run precisa do Docker **CLI** no PATH e de um
**daemon acessível sem sudo** (o container chama o OpenRouter pela rede padrão). Se o CLI
falta ou o daemon está inacessível, a preparação/execução falha. Instale/ative o Docker e
garanta acesso sem sudo. Confirme com `agents doctor --container`: o pré-voo ecoa o estado
do Docker (`· docker ok (prompt-builder-pi:<ver>)` ou `docker CLI AUSENTE` / `imagem ausente`)
e **falha com exit `3`** quando o CLI/imagem faltam.

## Modo container — imagem docker `prompt-builder-pi:<ver>` ausente

A imagem default `prompt-builder-pi:<executorVersion>` (ex. `prompt-builder-pi:0.84.2`) é
**criada e cacheada na primeira preparação de run em container** (`ensurePiImage` — o
`doctor` não builda). Se o pré-voo acusar a imagem ausente, rode uma run em container para
buildá-la automaticamente; ou adiante com `docker build` seguindo o Dockerfile (em produção,
embutido em `src/agent/container.ts`).
