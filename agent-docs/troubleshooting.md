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
quais truncaram (`truncationByRole` no `--json`). Para corrigir: competidor →
suba `--max-output-tokens` (ou `maxTokens` do cenário) ou baixe
`--effort-competitor`; juiz, duelo ou gabarito (tetos fixos de 1024/512/1500
tokens) → baixe `--effort-judge`. Gabarito que continuou truncado é descartado
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
