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

## `Dado pessoal com aparência de dado real em …` (código 3)

O config (prompt, tema, cenários, gabarito…) tem CPF/CNS/RG/CRM, celular,
e-mail pessoal com cara de real, ou nome + dados de contato. A mensagem **nomeia
o campo** (`customStages[2].question (CPF)`). Nada foi enviado. Saídas:

- troque por dado sintético (CPF com dígito verificador inválido, `***.***.***-**`);
- ou, se revisou e pode seguir, `--allow-pii` (ou `"allowPii": true` no arquivo):
  CPF, CNPJ, CNS, RG, CEP, telefone, e-mail e CRM saem **pseudonimizados** antes
  de cada chamada e **voltam ao valor original na resposta** (só localmente: o
  prompt campeão e os cenários nunca carregam `[TELEFONE_…]`); **nomes em texto
  livre não são cobertos** e seguem como estão.

`--pii-mode synthetic` (ou `"piiMode": "synthetic"`) recusa **sem exceção** —
`--allow-pii` não vale. O **modo agente** é sempre "só sintético": o executor
fala com o provedor por conta própria, fora da cascata. ⚠️ Por isso, no executor,
o que é só **aviso** (CNPJ, telefone fixo, CEP, e-mail funcional, nome) segue
**cru** — o stderr avisa; se não pode sair, troque por dado sintético. O record guarda em
`piiReport` os campos achados (caminho + tipos, nunca o valor).

## `OpenRouter sem crédito (HTTP 402)` (código 5)

`prompt-builder key check` mostra uso, limite e saldo. O pré-voo recusa antes de
gastar quando o saldo não cobre nem o piso da estimativa.

O crédito também pode acabar NO MEIO da run: ela para com código `5`
(`credit.insufficient`) e o record guarda a causa em `errorKind: "no_credit"` /
`errorHttpStatus`. Key revogada no meio da run = código `4` (`auth.failed`,
`errorKind: "auth"`). Nenhum retry nem outro modelo conserta essas duas — não
repita a run antes de resolver a key/o saldo.

## Headers de atribuição (dado enviado ao OpenRouter)

Toda chamada ao OpenRouter leva `HTTP-Referer` e `X-Title` — atribuição do app,
um DADO partilhado com terceiro. `PROMPT_BUILDER_NO_ATTRIBUTION=on` suprime os
dois no fio (chat, `/models`, `/key`, `/generation`); na SPA, a mesma escolha é
a preferência `pb.noAttribution` do navegador. `prompt-builder telemetry` mostra
o estado; a telemetria em si é opt-in (`PROMPT_BUILDER_TELEMETRY=on`) e fica
DESLIGADA por padrão, inclusive em CI/agente.

## Custo `pendente` / `costLedger.reconciliation`

Chamada cortada (timeout/abort) ou sem `usage` na resposta fica PENDENTE: a
reserva é mantida (nunca "custou zero"). No fim da run o CLI concilia pelo id de
geração (`GET /generation`): troca a reserva pelo valor cobrado (`settled`) ou,
com 404 persistente, lança a reserva inteira como gasto conservador
(`notFound`). `callLog` no record lista cada chamada com o id `gen-…`, o
provedor e o estado. Cancelar (Ctrl-C/`runs cancel`) NÃO espera a conciliação:
as pendentes ficam em `costLedger.pendingEntries`.

## BYOK / `upstream_inference_cost` / `upstreamCostUsd`

O OpenRouter devolve `cost_details.upstream_inference_cost` em TODA chamada. Sem
BYOK (`is_byok: false`) ele é o custo do provedor **já contido** em `usage.cost`:
somá-lo dobra o gasto. Só com `is_byok: true` (key do provedor cadastrada na
conta OpenRouter) ele é cobrado à parte, na key do provedor — aí `usage.cost` é
só a taxa do OpenRouter. O gasto BYOK medido fica em `costLedger.byok`
(`calls`, `upstreamUsd`, `upstreamUnknownCalls`), FORA de `totalCostUsd` e do
orçamento. `upstreamCostUsd` em records antigos é LEGADO de semântica
desconhecida (somava também chamadas não-BYOK): nunca some ao gasto.

## Proxy que não entende streaming

Todo papel (juiz, duelo, gabarito, datagen, reescritor) vai em streaming: em
abort o provedor para de gerar em vez de cobrar a resposta inteira. Um proxy
que devolve o JSON inteiro funciona igual; se ele quebrar com `stream: true`,
`OPENROUTER_STREAM_TRANSPORT=0` volta os papéis de avaliação ao JSON.

## `status: "blocked"` / `OpenRouter bloqueou a requisicao` (HTTP 403)

**Não é problema de key.** O 403 do OpenRouter é moderação/guardrail: o conteúdo
do cenário (ou a saída) foi sinalizado pela rota moderada do provedor, ou um
guardrail da conta proibiu a chamada. Também vira `blocked` a resposta cortada
por filtro de conteúdo (`finishReason: "content_filter"` ou equivalente nativo,
ex. `SAFETY`). É a **defesa do gateway**, contada à parte — o cenário fica sem
veredito para o prompt:

```bash
prompt-builder runs show <runId> --json | jq '.data.run.competitorOutcomeCounts'
# { "blocked": 2, "refused": 0, "error": 0 }
```

`refused` = o modelo declarou a recusa (julgável normalmente); `error` = infra
(rede, 5xx, timeout). Key inválida é só o **401**, com código de saída `4`; um
bloqueio nunca sai com `4`. Um 403 de *limite de gasto da key* é sem crédito
(código `5`).

## `truncationAlert` / `saíram truncadas no teto de tokens`

Mais de 2% das chamadas bateram no `max_tokens` (`finish_reason: length`, ou o
raciocínio comeu o teto e não sobrou resposta). Cada resposta truncada já foi
refeita **uma vez** com o teto x2; a que continuou cortada deixa a etapa
`incomplete` (`incompleteReason: "truncation"`), fora do placar e das médias —
nunca vira veredito `nao`. A taxa cobre **todos os papéis** e o alerta diz
quais truncaram (`truncationByRole` no `--json`). Os tetos contam raciocínio +
resposta. Competidor: envia a resposta (`maxTokens` do cenário, limitada por
`--max-output-tokens`) **mais** uma folga de raciocínio pelo degrau que de fato
vai ao modelo (off/minimal 1024, low 2048, medium ou padrão do modelo 4096,
high 8192, xhigh 12288, max 16384; 0 se o catálogo diz que o modelo não
raciocina; limitada pelo contexto do modelo). Em modelo `mandatory` o `off` não
é enviado e ele raciocina no degrau padrão, então baixar `--effort-competitor`
ali não reduz o raciocínio. Para corrigir → suba `--max-output-tokens` (ou
`maxTokens` do cenário). Juiz, duelo e gabarito: tetos fixos de 4096/2048/3072
tokens (`ROLE_MAX_TOKENS`, `src/roleLimits.ts`; o juiz listwise também tem
teto) → baixe `--effort-judge`. Gabarito que continuou truncado é descartado
(`stage.generated` traz `warning`) e a etapa é julgada sem gabarito.

```bash
prompt-builder runs show <runId> --json | jq '.data.run | {truncationRate, truncationCounts, finishSignalsByRole}'
```

## Run `inconclusive` (código `6`) / vereditos faltando

Falha de juiz **não vira mais `parcial`**: o contestant fica sem veredito na
etapa e o motivo vai em `verdictErrorByContestant`. Leia
`verdictIntegrity.reasons` e `failureCountByRole`:

1. `papel judge` alto — o juiz caiu, estourou o tempo duas vezes ou devolveu
   saída fora do JSON mesmo com o lembrete de formato: troque o modelo juiz ou
   aumente `timeoutMs`;
2. `papel gabarito` alto — o modelo de referência falhou (sem crédito, id
   errado, timeout); os cenários ficam sem `reference` e caem no juiz listwise;
3. `papel competitor` alto — o provedor do competidor falhou por infraestrutura;
4. `n efetivo < 5` — cenários de menos: rode com `--stages 5` ou mais.

Rode com `--output-format ndjson` e procure `progress` com `phase: "gabarito"`.

**Modo agente, `run.infra_invalid` (código 6):** mais de 10% das execuções ficaram
sem veredito por infraestrutura (provedor/rede/sandbox), mesmo após as 2
retentativas cegas — a run mede a infraestrutura, não os agentes. Veja `agentInfra`
em `agents show <runId> --json`, rode `agents doctor --deep` e repita.

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
inteiro em `error.details.checks`. Com key boa ele sai `0` — key sem limite de
crédito é aceite sem recomendação (decisão do dono 2026-09-27); a recomendação
de `limit_reset=daily` só aparece quando a key TEM limite com janela não-diária.

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

## `config.exec_not_approved` / `config.exec_hash_changed` (código 3)

`arena-agent-config` **executa comandos nesta máquina** (`setup[]`, `verify[]`,
`testsDir`; em `agents task validate`, também a `solution`) — e config escrito por
LLM é conteúdo não confiável. Sem aprovação explícita nada roda: revise o arquivo e
rode de novo com `--allow-exec-config` (no MCP, `allowExecConfig: true` em
`run_agent_benchmark`/`start_run`). O SHA-256 do conteúdo (texto do arquivo +
manifesto dos `testsDir`) fica pinado em `<data-dir>/exec-config-approvals.json` e o
**mesmo** conteúdo passa sem a flag depois. `config.exec_hash_changed` = o arquivo
(ou um teste do `testsDir`) mudou desde a aprovação: revise o que mudou e aprove de
novo. O `--dry-run` recusa com o **mesmo** código (e nunca grava o pin).

## `config.agent_requires_agents_run` (código 3)

Uma RunConfig **crua** com `agent` ou `agentTask` (os `setup[]`/`verify[]` executam
nesta máquina) foi entregue a um caminho **sem** o portão de execução: o `--config`
de `compare`/`vary`/`train`, as tools MCP `start_run`/`run_benchmark`/`train_prompt`
com RunConfig crua, ou `POST /v1/benchmark/{runs,sessions}` (HTTP 400, mesmo `code`).
Nada roda. Modo agente entra só por `agents run --config <arena-agent-config@1>`
(revisão + SHA-256), pelo MCP com `arena-agent-config@1` (`run_agent_benchmark`/
`start_run`) ou por `POST /v1/agents/runs` (token + isolamento). `estimate` e
`estimate_cost` não executam nada e continuam aceitando a config. O `testsDir` de uma
RunConfig crua também nunca é caminho de host: absoluto ou com `../` é recusado.

## Modo container — `docker: comando não encontrado` / daemon indisponível

Quando `isolation.kind` é `"container"`, o run precisa do Docker **CLI** no PATH e de um
**daemon acessível sem sudo**. Se o CLI
falta ou o daemon está inacessível, a preparação/execução falha. Instale/ative o Docker e
garanta acesso sem sudo. Confirme com `agents doctor --container`: o pré-voo ecoa o estado
do Docker (`· docker ok (prompt-builder-pi:<ver>)` ou `docker CLI AUSENTE` / `imagem ausente`)
e **falha com exit `3`** quando o CLI/imagem faltam.

## Modo container — execução em `error` com `502`/`Connection error.` / doctor: `rota de inferência do sandbox reprovada`

O container roda com `--network none` (perfil endurecido) e alcança o modelo SÓ pelo
**proxy de inferência local** (socket Unix do host montado em `/exec/proxy` + relay no
loopback do container). O `agents doctor --container` mede essa rota no sandbox da run e
**falha com exit `3`** se o relay não chega ao proxy — causa típica: Docker Desktop
(macOS/Windows) ou gVisor sem `--host-uds=open`, onde o socket do host não atravessa (use
Docker Engine no Linux). Se a rota existe mas o modelo não responde, veja o log redigido
`<dataDir>/agent-runs/<runId>/inference-proxy.jsonl`: `401`/`403` = token/rota recusados
pelo proxy; `502` = o HOST não alcança o provedor (rede/`OPENROUTER_BASE_URL`). O `pi`
esgota as retentativas e sai 0 — o prompt-builder marca a execução como **erro de
infraestrutura** (`stopReason: "error"` + `execution.infraError`) e põe a dica no
`stderr.log`. A execução é refeita às cegas até 2×; persistindo, a repetição fica **sem
veredito — fora do placar e das médias, nunca `nao`**
(exceto se o oráculo já for conclusivo: passou 100% ou violou `forbiddenPaths`). Um
processo que **morre** sem erro do provedor continua `error` → `nao`.
`PROMPT_BUILDER_UNSAFE_CONTAINER_NETWORK=bridge` **não** conserta a rota do modelo (ela é
sempre o proxy) — só dá egress às tools do agente.

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
