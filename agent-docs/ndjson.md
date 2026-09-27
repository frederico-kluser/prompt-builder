# Saída NDJSON

`--output-format ndjson` emite **um objeto JSON por linha**, com flush a cada
linha. Peça sempre explicitamente: sem a flag (ou `--json`) a saída é texto.

Toda linha tem `{ type, ts, seq }`. `seq` é um contador monotônico: os
barramentos internos não garantem ordem, e quem faz tail precisa de uma.
Linhas de run trazem `scope: "run"` e `runId`; num treino trazem **também**
`sessionId`, senão os dois níveis intercalados ficariam ambíguos.

As runs abrem em `start`; **todo** stream termina em `result` — inclusive
quando o comando falha antes de começar (flag inválida, key ausente, pré-voo).

## Erro

Erro é a linha `result` com `ok: false` e o **mesmo** objeto `error` do
`--json` (mesmos campos, mesma ordem):

```json
{"type":"result","ts":"…","seq":7,"ok":false,"command":"train",
 "error":{"code":"control.budget_exceeded","kind":"control",
          "message":"…","hint":"…","details":{"spentUsd":3,"budgetUsd":3}}}
```

- `kind` decide o próximo passo: `usage` (corrija a chamada) · `config`
  (corrija o arquivo) · `auth` (key) · `credit` (saldo) · `network` (tente de
  novo) · `control` (parou por orçamento/interrupção) · `inconclusive` ·
  `timeout` · `gate` (um portão de qualidade recusou promover — exit `10`; não
  sobreponha sem decisão humana) · `internal`.
- `code` é estável (`usage.unknown_flag`, `auth.key_missing`,
  `config.invalid_json`, …); `hint` traz o comando que resolve.
- `ok: true` com código de saída `7`/`130` é **resultado parcial**, não erro: o
  `result` traz `stoppedReason` (`budget` | `cancelled`).

## Eventos

| `type` | Quando | Campos principais |
|---|---|---|
| `start` | primeira linha | `command`, `runId` ou `sessionId` (+ `idempotencyKey`) |
| `attached` | a `--idempotency-key` já tem run em voo: esperando ela (nada é gasto) | `idempotencyKey`, `runId` ou `sessionId`, `ownerPid` |
| `run.started` | run começou | `mode`, `stages`, `contestants[]` |
| `variants.generating` / `variants.generated` | geração de variantes | `contestants[]` |
| `stage.generating` / `stage.generated` | cenários | `stageIndex`, `question`, `hasReference`; `referenceTruncated` + `warning` quando o gabarito truncou mesmo após o retry x2 e foi descartado (etapa julgada sem gabarito) |
| `progress` | lotes agregados | `phase` (`gabarito` \| `duels`), `done`, `total` |
| `competitor.finished` | uma resposta pronta | `contestantId`, `status` (`ok`\|`blocked`\|`refused`\|`error`), `tokensIn/Out`, `costUsd`, `chars`, `truncated`/`truncationRetried` (só quando `true`) |
| `stage.incomplete` | etapa fora do placar e das médias | `stageIndex`, `reason` (`truncation`), `detail`, `contestantIds` (quem truncou) |
| `stage.judging` / `stage.judged` | julgamento | `verdicts`, `ranked`, `scoreboard`, `totalCostUsd` |
| `finals.started` | finais | `finalists[]` |
| `stage.dueled` | duelos de um cenário | `pairs[]` |
| `budget` | gasto acumulado | `spentUsd`, `budgetUsd`, `byRole` |
| `budget.gate` | uma porta decidiu | `phase`, `projectedUsd`, `remainingUsd`, `decision` |
| `run.finished` | run terminou | `status`, `totalCostUsd`, `standings`, `competitorOutcomeCounts`, `truncationRate`/`truncationCounts`/`truncationByRole` (todos os papéis; + `truncationAlert` acima de 2%) |
| `iteration.started` / `iteration.finished` / `iteration.promoted` | treino | `iteration`, `runId`, `gain` (bruto); no `promoted` também `gainCorrected`, `pAdjusted`, `k`, `method`, `minGain` |
| `session.holdout` / `session.converged` / `session.finished` | treino | ver `docs train` |
| `result` | última linha | `ok`, `status`, `totalCostUsd`, `budgetExhausted`, `stoppedReason`, `dailyCapReached`, `idempotency` (`reused` = nada gasto agora), … — ou `ok:false` + `error` |

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
