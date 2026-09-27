# Lendo os resultados

```bash
prompt-builder runs list                       # últimas runs
prompt-builder runs show <id> --json           # o RunRecord inteiro
prompt-builder runs winner <id> --prompt-only  # só o prompt vencedor, cru
prompt-builder sessions list | show | winner
```

## Duas réguas, não intercambiáveis

- **`judgeScoreByContestant`** — `(resolve + 0,5 × parcial) / julgados × 100`
  sobre os cenários com gabarito (veredito ausente fica fora da conta).
  Comparável **entre runs** com o mesmo juiz **e a mesma convenção de
  agregação** (ver abaixo).
- **`standings`** — **taxa de vitória** (`winRate`) nos duelos das finais:
  `(vitórias + 0,5 × empates) / duelos disputados`, em 0..1, com V–E–D ao lado.
  Só existe se as finais rodaram, e mede apenas os **finalistas** entre si.
  (Records antigos traziam também `points`, a soma crua — não use.)

## Painel de juízes: maioria simples e empate técnico

Com 2+ juízes (`judgeModelIds`), o veredito de cada cenário é a **maioria
simples** dos votos. Sem maioria clara é **empate técnico**: o contestant ganha
chave em `verdictTieByContestant[id]` (os votos, do pior ao melhor) e o
veredito gravado é o nível que a maioria endossa — `resolve`+`parcial` vira
`parcial`, `parcial`+`nao` vira `nao`, **nunca** o voto de cima. Painel ímpar
(3 juízes) quase não empata.

**Mudança de escala:** até o IMPL-007 o painel usava média ordinal arredondada
para cima (`resolve`+`parcial` contava `resolve`). Runs novas gravam
`verdictAggregation: "majority"`; run **sem** esse campo e com 2+ juízes tem
judge-score em outra escala (inflado) — `runs show` avisa
(`judgeScaleWarning`) e ele não deve ser comparado com o de runs novas. Com
juiz único nada muda.

O CLI sempre diz qual usou. Se as finais não rodaram (`--no-duels`,
`finalists: 0`, orçamento), a régua é o judge-score.

## Campos do `RunRecord` que importam

| Campo | O que é |
|---|---|
| `status` | `finished` \| `inconclusive` \| `error` \| `aborted` |
| `failureCountByRole` | vereditos **perdidos** por papel (juiz que falhou, duelo sem resultado, competidor com erro de infra, cenário sem gabarito) — `0` = medido e sem falha |
| `verdictIntegrity` | a conta por trás do `inconclusive`: esperados/degradados por papel, cenários julgados por contestant, limiares e `reasons` |
| `stoppedReason` | `budget` \| `cancelled` — discrimina o `aborted` |
| `budgetExhausted` / `stoppedAtPhase` | parou cedo, e onde |
| `totalCostUsd` | gasto **total**, todos os papéis |
| `costByRole` | quebra por `competitor` / `judge` / `duel` / `gabarito` / `datagen` / `rewriter` |
| `costByContestant` | fatia **dos competidores** (gasto de juiz não é atribuível a ninguém) |
| `costAccuracy` | quantas chamadas tiveram preço exato / estimado / desconhecido |
| `stages[].incomplete` | etapa cortada no meio — **fora** do placar e do julgamento |
| `stages[].referenceJudge` | vereditos pointwise por contestant, com o motivo |
| `finalists` | ids que disputaram a final |
| `verdictAggregation` | `"majority"` = painel por maioria simples (IMPL-007); ausente = escala antiga |
| `stages[].referenceJudge.verdictTieByContestant` | empates técnicos do painel: id → votos |
| `judgeDiagnostics` | pin do **contrato do juiz** (hash do prompt + modelos) + viés de verbosidade medido (correlação score×comprimento) |
| `fairnessWarnings` | avisos de imparcialidade (juiz da família do competidor) — não-bloqueantes |
| `repeats` (compare) | `record.stages.length === cenários × repeats` — cópias são observações independentes |

Uma etapa `incomplete` é o que separa "parou cedo, honesto" de "terminou,
mentindo": ela não vira veredito `parcial` nem entra na média.

## Veredito ausente e run `inconclusive`

Falha **não é veredito**. Quando o juiz cai, devolve saída fora do formato
mesmo depois de um lembrete, estoura o tempo duas vezes, ou o competidor falha
por infraestrutura/é bloqueado pelo gateway, o contestant fica **sem chave** em
`verdictByContestant` naquela etapa — nunca um `parcial` inventado. O motivo
está em `verdictErrorByContestant[id]` (`judge_failed`, `invalid_output`,
`timeout`, `blocked`, `competitor_error`, `no_reference`, …) e a origem de todo
veredito presente em `verdictSourceByContestant[id]` (`judge`, `auto`,
`ground-truth`, `degraded` = painel de juízes reduzido). Veredito ausente sai do
judge-score (numerador **e** denominador), do placar e das lições do treino.
Duelo sem resultado vai para `stages[].duels.failedDuels` e não pontua.

A run termina `inconclusive` (código de saída `6`) quando, em algum papel,
falhas + vereditos degradados passam de **10%** dos esperados, ou quando algum
contestant tem **menos de 5 cenários julgados**. O motivo está em
`verdictIntegrity.reasons`. Rode com mais cenários (`--stages 5` ou mais) ou
investigue o papel que falhou antes de confiar no ranking.

## `SessionRecord` (treino)

| Campo | O que é |
|---|---|
| `bestPromptByIteration[]` | o campeão pós-gate de cada iteração, com o prompt |
| `convergedAtIteration` | parou por falta de ganho (bom sinal) |
| `holdout` | `{ n, controlScore, championScore, gain, regressed }` |
| `significance` | `{ n, meanDiffPp, ci95Pp, pValue }` ou `null` |
| `holdoutSkipped` | **campeão não validado** contra sobreajuste |
| `stoppedAtIteration` | onde o orçamento interrompeu |
| `pool` | front Pareto final (com `paretoPool` > 1) |
| `judgeDrift` | `true` = o **contrato do juiz mudou** no meio da sessão (calibration drift — deltas podem ser do juiz) |

`regressed: true` significa que o campeão foi **pior** que a base no holdout —
o ganho do treino era ruído ou sobreajuste. Não promova esse prompt.


## Reprodutibilidade e handoff

```bash
prompt-builder runs reproduce <id>          # config + comando exato para re-rodar
prompt-builder runs export <id> -o run.json # artefato auto-contido (gabaritos, prompts, vereditos)
prompt-builder sessions winner <sid> --apply prompt.md [--commit]  # backup + diff + commit opcional
prompt-builder registry validate            # guarda de drift: o needle do prompt ainda existe no fonte?
```

O `runs reproduce` devolve o RunConfig **lossless** (passa em `config validate`)
e a vista `arena-config@1`; o `runs export` produz `prompt-builder-run@1` —
auditoria completa sem o disco original. O `--apply` nunca perde o prompt de
produção: backup `<destino>.bak-<ts>` antes de sobrescrever, diff sempre.
