# Orçamento e custo

## A flag

```bash
--budget 5        # teto de US$ 5 para a execução inteira
--budget none     # sem teto, assumido explicitamente
```

**Fora de um terminal interativo, `--budget` é obrigatório.** Sem ele o comando
sai com código `2` e não gasta nada. Isso existe porque um agente autônomo
rodando sem teto por omissão é exatamente o risco a evitar.

Em `train`, o teto vale para a **sessão inteira**, não por iteração.

## Como a parada acontece

O gasto é medido a partir do campo `usage.cost` que o OpenRouter devolve em cada
resposta — o valor **efetivamente cobrado**, incluindo cache, tokens de
raciocínio e preços por faixa. Não é uma estimativa.

Há duas portas:

- **Porta suave**, nas fronteiras entre grupos de fase. Antes de começar um
  grupo, o custo projetado é comparado com o saldo. Não cabendo, o grupo **não
  começa** e a run fecha com o que já tem. Os grupos são:
  `datagen+gabaritos`, `competidores+julgamento` (**indivisível**), `finais`,
  e, no treino, cada iteração e o holdout.
- **Porta dura**, dentro de cada chamada. Se o gasto comprometido já cruzou o
  teto, a chamada é recusada antes mesmo de entrar na fila.

Competidores e julgamento são um grupo **atômico** de propósito: autorizar as
respostas sem poder pagar o julgamento produziria etapas com resposta e sem
nota — um resultado incompleto com aparência de completo.

## O que você recebe ao parar cedo

Código de saída **`7`** (não é erro) e, no resultado:

```json
{ "budgetExhausted": true, "stoppedAtPhase": "finals", "totalCostUsd": 2.88 }
```

Mais o melhor resultado obtido até ali — e **qual régua foi usada**:
`standings` (duelos das finais) se elas rodaram, senão o ranking por
judge-score. As duas não são intercambiáveis.

Em `train`, o campeão da última iteração promovida é entregue, com
`holdoutSkipped: true` se o gate final não coube no orçamento.

## Contabilidade por papel

```
Gasto      $1.8734 de $5.0000 (37%)
Por papel  competidor    $0.9210  52 chamadas
           juiz          $0.6612  240 chamadas
           duelo         $0.1803  48 chamadas
           gabarito      $0.0774  12 chamadas
           datagen       $0.0335  3 chamadas
Precisão   288 exatas · 0 estimadas · 0 SEM PREÇO
```

"SEM PREÇO" significa que a chamada **não pôde ser precificada** pelo catálogo —
nunca confunda com "custou zero". O pré-voo recusa id inexistente sempre
(`config.unknown_model`) e, com `--budget` ligado, modelo sem preço exato
(variante de roteamento como `:nitro`, preço variável como `openrouter/auto`).

## Pré-voo

Antes de gastar, na ordem (a primeira recusa encerra a execução real):

| # | Checagem | Recusa (`error.code`, exit) |
|---|---|---|
| 1 | `--budget` presente fora de TTY | `usage.budget_required` (2) |
| 2 | catálogo (público; cache em disco 24 h) | `network.catalog_unavailable` (8) |
| 3 | todo modelo chamado existe no catálogo | `config.unknown_model` (3) |
| 4 | com `--budget`, todo modelo tem preço exato | `config.unpriced_models` (3) |
| 5 | `--max-price-in/out` cobre o preço dos modelos | `config.price_cap_below_model` (3) |
| 6 | teto abaixo do piso estimado (sem `--force`) | `usage.budget_below_estimate` (2) |
| 6 | teto dentro da faixa, fora de TTY, sem `--yes` | `usage.confirmation_required` (2) |
| 7 | key presente | `auth.key_missing` (4) |
| 7 | key aceita pelo OpenRouter (`GET /key`) | `auth.key_invalid` (4) |
| 8 | saldo da key ≥ piso estimado | `credit.insufficient` (5) |

Teto acima do teto estimado roda direto; saldo menor que o teto só avisa.
A faixa é larga (~2,2×) de propósito. Leia `assumptions` no `--json` em vez de
tratar um número como promessa.

### `--dry-run` = o mesmo pré-voo, sem gastar

O dry-run percorre **a mesma sequência** (é o mesmo código) e faz só leituras
gratuitas e sem efeito: o catálogo público e, com key, `GET /key`. Por isso o
código de recusa dele é **sempre** o da run real com as mesmas flags:

- recusa → envelope `{ok:false, error:{code, …}}` com o exit da recusa real;
  `error.details.wouldRefuse` lista **todas** as recusas, na ordem acima, e
  `error.details.estimate` traz a estimativa (use-a para escolher o `--budget`);
- sem recusa → exit `0`, `data.wouldRefuse: []`, `data.estimate`,
  `data.checks` (catálogo, key, saldo) e `data.requires`.

A única diferença é a **key**: sem ela o dry-run não recusa — lista em
`requires` o que a run exigiria (`auth.key_missing` e, sem key, o saldo mínimo
como `credit.insufficient` não verificado). Como a key é a última checagem,
toda recusa de configuração sai igual com ou sem key.

`agents run --dry-run` estima com o catálogo e espelha as recusas da execução
de agentes (só `usage.budget_required`; a key vai em `requires`).

## Teto por requisição

`--max-price-in` / `--max-price-out` viram `provider.max_price` no OpenRouter —
o único teto **por requisição** garantido pelo provedor. **A unidade é USD por
MILHÃO de tokens** (o catálogo é por token). Um teto apertado demais faria o
OpenRouter não achar provedor nenhum, então o pré-voo confere e recusa antes.

## Cancelamento

`Ctrl-C` aborta com elegância: as chamadas em voo são canceladas, a run é
finalizada, salva e o parcial é impresso (código `130`). Um segundo `Ctrl-C`
mata na hora.
