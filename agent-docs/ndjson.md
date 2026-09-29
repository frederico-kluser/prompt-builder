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
| `run.warning` | aviso agregado ANTES da run (hoje: itens da biblioteca não curados) | `code`, `message`, `curatedKofN`, `unapproved[]` (teto 20) |
| `datagen.report` | uma vez, logo após gerar os cenários e antes de gastar com o resto | `requested`, `generated`, `final`, `shortfall`, `dedupedExact`/`dedupedSemantic`, `backfillRounds`, `stoppedBy`, `warning` (faltou cenário) |
| `stage.generating` / `stage.generated` | cenários | `stageIndex`, `question`, `hasReference`; `referenceTruncated` + `warning` quando o gabarito truncou mesmo após o retry x2 e foi descartado (etapa julgada sem gabarito) |
| `stage.failed` | a geração da etapa falhou (etapa pulada) | `stageIndex`, `error` |
| `progress` | lotes agregados | `phase` (`gabarito` \| `duels`), `done`, `total` |
| `competitor.finished` | uma resposta pronta | `contestantId`, `status` (`ok`\|`blocked`\|`refused`\|`error`), `tokensIn/Out`, `costUsd`, `chars`, `truncated`/`truncationRetried` (só quando `true`) |
| `stage.incomplete` | etapa fora do placar e das médias | `stageIndex`, `reason` (`truncation`), `detail`, `contestantIds` (quem truncou) |
| `judge.truncated` | veredito invalidado por saída do juiz cortada (teto/timeout) — o contestant fica SEM veredito, o duelo sem resultado | `stageIndex`, `phase` (`judge`\|`duel`), `contestantIds`, `kinds`, `detail` |
| `stage.judging` / `stage.judged` | julgamento | `verdicts`, `missing` (id → motivo do veredito **ausente**), `ranked`, `scoreboard`, `totalCostUsd` |
| `finals.started` | finais | `finalists[]` |
| `stage.dueled` | duelos de um cenário | `pairs[]`, `failedPairs[]` (sem resultado — não pontuam) |
| `budget` | gasto acumulado | `spentUsd` (da run/iteração), `totalSpentUsd` (só no `train`: a sessão inteira — é ele que se compara com `budgetUsd`), `budgetUsd` (teto do comando), `byRole` |
| `budget.gate` | uma porta decidiu | `phase`, `projectedUsd`, `remainingUsd`, `decision` |
| `run.finished` | run terminou | `status` (`finished` \| `inconclusive` \| …), `totalCostUsd`, `standings`, `failureCountByRole`, `inconclusiveReasons`, `competitorOutcomeCounts`, `truncationRate`/`truncationCounts`/`truncationByRole` (todos os papéis; + `truncationAlert` acima de 2%), `costLedger` (spent/committed/pending), `judgeCascade` (vereditos/escalonados/fração, com `--judge-cascade`), `securitySummary` (com cenários adversariais) |
| `run.error` | a run falhou | `error` |
| `agent.started` / `agent.turn` / `agent.tool` / `agent.finished` / `agent.verified` | modo agente (`docs agents`) | ids + `turn`/`toolName`/`stopReason`/`results`; nunca a saída da ferramenta |
| `session.started` | treino começou | `iterations`, `theme` |
| `iteration.started` / `iteration.finished` / `iteration.promoted` | treino | `iteration`, `runId`, `gain` (bruto); no `promoted` também `gainCorrected`, `pAdjusted`, `k`, `method`, `minGain` |
| `session.holdout` / `session.converged` / `session.finished` | treino | ver `docs train`; o `finished` traz `significance`, `pairing`, `holdoutSkipped` + `holdoutSkipReason`, `costLedger` |
| `session.error` | o treino falhou | `error` |
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
# acompanhar só o custo (no train, `spentUsd` é da iteração e zera a cada uma;
# o acumulado da sessão é `totalSpentUsd`)
prompt-builder train --config a.json --budget 10 --output-format ndjson \
  | jq -r 'select(.type=="budget") | "\(.totalSpentUsd // .spentUsd)/\(.budgetUsd)"'

# guardar tudo e ler o resultado no fim
prompt-builder train --config a.json --budget 10 --output-format ndjson | tee run.ndjson
jq 'select(.type=="result")' run.ndjson
```
