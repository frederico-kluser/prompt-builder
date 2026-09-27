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
