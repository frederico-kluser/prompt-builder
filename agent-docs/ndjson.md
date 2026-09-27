# Saída NDJSON

`--output-format ndjson` emite **um objeto JSON por linha**, com flush a cada
linha. Liga automaticamente quando não há TTY ou quando `CLAUDECODE`/`CI` estão
definidos — um agente não precisa lembrar da flag.

Toda linha tem `{ type, ts, seq }`. `seq` é um contador monotônico: os
barramentos internos não garantem ordem, e quem faz tail precisa de uma.
Linhas de run trazem `scope: "run"` e `runId`; num treino trazem **também**
`sessionId`, senão os dois níveis intercalados ficariam ambíguos.

O stream **sempre** abre em `start` e **sempre** termina em `result`.

## Eventos

| `type` | Quando | Campos principais |
|---|---|---|
| `start` | primeira linha | `command`, `runId` ou `sessionId` |
| `run.started` | run começou | `mode`, `stages`, `contestants[]` |
| `variants.generating` / `variants.generated` | geração de variantes | `contestants[]` |
| `stage.generating` / `stage.generated` | cenários | `stageIndex`, `question`, `hasReference` |
| `progress` | lotes agregados | `phase` (`gabarito` \| `duels`), `done`, `total` |
| `competitor.finished` | uma resposta pronta | `contestantId`, `status`, `tokensIn/Out`, `costUsd`, `chars` |
| `stage.judging` / `stage.judged` | julgamento | `verdicts`, `ranked`, `scoreboard`, `totalCostUsd` |
| `finals.started` | finais | `finalists[]` |
| `stage.dueled` | duelos de um cenário | `pairs[]` |
| `budget` | gasto acumulado | `spentUsd`, `budgetUsd`, `byRole` |
| `budget.gate` | uma porta decidiu | `phase`, `projectedUsd`, `remainingUsd`, `decision` |
| `run.finished` | run terminou | `status`, `totalCostUsd`, `standings` |
| `iteration.started` / `iteration.finished` / `iteration.promoted` | treino | `iteration`, `runId`, `gain` (bruto); no `promoted` também `gainCorrected`, `pAdjusted`, `k`, `method`, `minGain` |
| `session.holdout` / `session.converged` / `session.finished` | treino | ver `docs train` |
| `result` | última linha | `ok`, `status`, `totalCostUsd`, `budgetExhausted`, … |

## O que **não** vem no stream

`competitor.finished` traz `chars`, **não** o texto da resposta. `run.started` e
`run.finished` trazem um resumo, **não** o record inteiro. Isso é deliberado: os
eventos internos embutem records completos e respostas inteiras, e transmiti-los
verbatim estouraria a janela de contexto de quem está lendo.

Para o conteúdo completo use `runs show <id> --json` (lê do disco) ou
`--verbose`, que reinclui `config` e `systemPrompt`.

## Consumindo

```bash
# acompanhar só o custo
prompt-builder train --config a.json --budget 3 --output-format ndjson \
  | jq -r 'select(.type=="budget") | "\(.spentUsd)/\(.budgetUsd)"'

# guardar tudo e ler o resultado no fim
prompt-builder train --config a.json --budget 3 --output-format ndjson | tee run.ndjson
jq 'select(.type=="result")' run.ndjson
```
