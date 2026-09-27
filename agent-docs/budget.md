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

"SEM PREÇO" significa que o modelo não estava no catálogo e a chamada **não pôde
ser precificada** — nunca confunda com "custou zero". Com `--budget` ligado, um
modelo fora do catálogo faz o comando recusar no pré-voo.

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

Antes de gastar: o catálogo é aquecido, a key é validada e o custo é estimado.

| Situação | O que acontece |
|---|---|
| estimativa toda abaixo do teto | roda direto |
| teto dentro da faixa estimada | avisa; fora de TTY exige `--yes` |
| teto abaixo do piso estimado | **recusa** (use `--force` para insistir) |
| saldo da key menor que o teto | avisa e informa o teto real |
| saldo menor que o piso | recusa — a run não teria como terminar |

A faixa é larga (~2,2×) de propósito. Leia `assumptions` no `--json` em vez de
tratar um número como promessa.

## Teto por requisição

`--max-price-in` / `--max-price-out` viram `provider.max_price` no OpenRouter —
o único teto **por requisição** garantido pelo provedor. **A unidade é USD por
MILHÃO de tokens** (o catálogo é por token). Um teto apertado demais faria o
OpenRouter não achar provedor nenhum, então o pré-voo confere e recusa antes.

## Cancelamento

`Ctrl-C` aborta com elegância: as chamadas em voo são canceladas, a run é
finalizada, salva e o parcial é impresso (código `130`). Um segundo `Ctrl-C`
mata na hora.
