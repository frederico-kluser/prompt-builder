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

### Preço variável (roteadores como `openrouter/auto`)

O catálogo manda `"-1"` como preço de roteador: o preço depende do modelo para
onde a chamada for roteada. Isso vira **desconhecido** — nunca `-1`, nunca
"grátis":

- a estimativa (`estimate`, `--dry-run`) deixa o modelo **fora da soma** e o lista
  em `unknownPriceModelIds` (`assumptions.unknownPrice: "exclude"`) — o custo real
  será maior;
- as portas de orçamento projetam pelo **pior caso dos endpoints elegíveis**: o
  preço mais alto do catálogo, limitado por `--max-price-in`/`--max-price-out`;
- com `--budget`, o pré-voo **recusa** (exit 3) a menos que os DOIS tetos de preço
  estejam definidos — aí o orçamento é conferido por esse pior caso;
- o custo cobrado continua vindo de `usage.cost` da resposta.

## Pré-voo

Antes de gastar, na ordem (a primeira recusa encerra a execução real):

| # | Checagem | Recusa (`error.code`, exit) |
|---|---|---|
| 0 | nenhum outro processo vivo roda a MESMA config | `run.locked` (2) |
| 1 | `--budget` presente fora de TTY | `usage.budget_required` (2) |
| 2 | catálogo (público; cache em disco 24 h) | `network.catalog_unavailable` (8) |
| 3 | todo modelo chamado existe no catálogo | `config.unknown_model` (3) |
| 4 | com `--budget`, todo modelo tem preço exato | `config.unpriced_models` (3) |
| 5 | `--max-price-in/out` cobre o preço dos modelos | `config.price_cap_below_model` (3) |
| 6 | teto abaixo do piso estimado (sem `--force`) | `usage.budget_below_estimate` (2) |
| 6 | teto dentro da faixa, fora de TTY, sem `--yes` | `usage.confirmation_required` (2) |
| 6b | teto diário da máquina não esgotado (e ≥ piso, salvo `--force`) | `control.daily_cap_reached` (7) |
| 7 | key presente | `auth.key_missing` (4) |
| 7 | key aceita pelo OpenRouter (`GET /key`) | `auth.key_invalid` (4) · sem rede: `network.key_check_failed` (8) |
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

## Defesa anti-gasto N× (vários processos, retentativas)

O `--budget` é por **processo**. Um agente que re-dispara o comando (timeout do
harness, laço de retentativa, dois terminais) gastaria N× sem que um visse o
outro. Por isso há camadas por cima dele:

1. **Lock da config.** Um 2º processo com a MESMA config (o hash ignora só o
   `--budget`) enquanto o 1º roda é recusado com `run.locked` (exit `2`) antes
   de tocar a rede; `error.details.holder` diz quem (pid, run). Lock de processo
   morto ou com heartbeat parado há mais de 2 min é quebrado sozinho. Réplica
   intencional em paralelo: `--allow-concurrent`.
2. **`--idempotency-key <k>`.** Use SEMPRE numa retentativa. Repetir a mesma key
   com a mesma config **anexa** à run existente: se ela ainda roda, espera (NDJSON
   `attached`) e devolve o resultado dela; se já terminou, devolve na hora. Nada é
   gasto (nem key nem `--budget` são exigidos) e o resultado traz
   `idempotency: {key, reused: true, attached}`. Mesma key com OUTRA config =
   `usage.idempotency_conflict` (2). Dona morta sem terminar = `run.orphaned`
   (1) — rodar de novo exige outra key. O `--dry-run` diz `wouldReuse`.
3. **Teto diário da máquina** (padrão US$ 20 por dia UTC): cada chamada reserva
   num ledger em arquivo (`<data-dir>/ledger/`, escrita atômica, mutex entre
   processos) que soma **todos** os processos. Esgotado no pré-voo:
   `control.daily_cap_reached` (7, nada gasto). Esgotado no meio: a run para como
   por orçamento (exit `7`, parcial) com `dailyCapReached: true`. Vale também com
   `--budget none`. Veja/ajuste com `limits show` e `limits set --daily <usd|none>`
   (ou `$PROMPT_BUILDER_DAILY_CAP_USD`); é por diretório de dados.
4. **Limite da key no OpenRouter** — a ÚNICA camada que vale entre máquinas e
   contra agente desgovernado. `prompt-builder doctor` mostra `limit` e
   `limit_reset` da key e recomenda `limit_reset=daily` (reset 00:00 UTC) quando
   falta. `doctor` sai `4` sem key válida (e `8` sem rede).

## Teto por requisição

`--max-price-in` / `--max-price-out` viram `provider.max_price` no OpenRouter —
o único teto **por requisição** garantido pelo provedor. **A unidade é USD por
MILHÃO de tokens** (o catálogo é por token). Um teto apertado demais faria o
OpenRouter não achar provedor nenhum, então o pré-voo confere e recusa antes.

## Cancelamento

`Ctrl-C` aborta com elegância: as chamadas em voo são canceladas, a run é
finalizada, salva e o parcial é impresso (código `130`). Um segundo `Ctrl-C`
mata na hora.
