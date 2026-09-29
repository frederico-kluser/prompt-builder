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
| `competitorOutcomeCounts` | `{ blocked, refused, error }` — bloqueio de moderação/guardrail (defesa do gateway, sem veredito) ≠ recusa declarada pelo modelo (julgável) ≠ erro de infra |
| `stages[].responses[].status` | `ok` \| `blocked` \| `refused` \| `error`; `finishReason`/`nativeFinishReason` quando o provedor informa |
| `stages[].responses[].truncated` | resposta cortada no teto de tokens **mesmo após 1 retry com teto x2** (`truncationRetried`, `maxTokens`, `reasoningTokens`, `truncationSignals` dizem como; `firstAttempt` = sinais da 1ª tentativa, a truncada) |
| `stages[].incomplete` / `incompleteReason` | etapa **fora** do placar e do julgamento — `budget`, `cancelled` ou `truncation` (uma resposta truncada) |
| `stages[].gabaritoCall` | sinais de fim da chamada do gabarito (`firstAttempt` quando houve retry); `truncated: true` = régua cortada, descartada — a etapa é julgada sem gabarito |
| `truncationRate` / `truncationCounts` | fração das chamadas de **todos os papéis** (competidor, gabarito, juiz, duelo, datagen; cada tentativa conta) cortadas no teto; o CLI alerta acima de **2%** (`truncationAlert` + `truncationByRole` no `--json`) |
| `finishSignalsByRole` | por papel: `calls`, `truncated`, histogramas de `finishReasons`/`nativeFinishReasons` (`(none)` = ausente) e contagem de cada sinal — 100% das chamadas que completaram |
| `stages[].referenceJudge` | vereditos pointwise por contestant, com o motivo |
| `completeness` | n **nominal** × n **efetivo** por contestant (`byContestant[id]`: `nEfetivo`, `missing`, `completeness`, `missingByReason`) e o pareamento com a régua (`vsControl[id]`: `nEfetivo`, `excludedPairs`, Δ só sobre pares completos). `runs show` sempre mostra — e recalcula para runs antigas |
| `finalists` | ids que disputaram a final |
| `verdictAggregation` | `"majority"` = painel por maioria simples (IMPL-007); ausente = escala antiga |
| `stages[].referenceJudge.verdictTieByContestant` | empates técnicos do painel: id → votos |
| `judgeDiagnostics` | pin do **contrato do juiz** (hash do prompt + modelos) + viés de verbosidade medido (correlação score×comprimento) |
| `fairnessWarnings` | avisos de imparcialidade (juiz da família do competidor) — não-bloqueantes |
| `repeats` (compare) | `record.stages.length === cenários × repeats` — cópias são observações independentes |

Uma etapa `incomplete` é o que separa "parou cedo, honesto" de "terminou,
mentindo": ela não vira veredito `parcial` nem entra na média.

Veredito **ausente** (juiz falhou, etapa pulada ou cortada) é "sem observação",
nunca `nao`: o par sai **dos dois lados** das médias e do teste. Compare sempre
`nEfetivo` com `n` antes de confiar num Δ.

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
| `bestPromptByIteration[]` | o campeão pós-gate de cada iteração, com o prompt e o `gate` (Δ pareado BRUTO `gainPp`, `gainCorrectedPp` do winner's curse, `test` da melhor de K com `pAdjusted`/`k`/`method`, `minGain` + `minGainSource`, `heldBy`, `pairing`, `sensitivity`, `decision`: `promoted` \| `held` \| `inconclusive`) |
| `convergedAtIteration` | parou por falta de ganho (bom sinal) |
| `holdout` | `{ n, controlScore, championScore, gain, regressed, nEfetivo, excludedPairs, completeness }` — scores são médias só sobre os pares completos |
| `pairing` | o pareamento final (`source`: `holdout` \| `training`): `n`, `nEfetivo`, `excludedPairs`, `completeness`, Δ — presente mesmo quando `significance` é `null` |
| `significance` | teste pareado exato (troca de sinais): `pValue` (unilateral, o do gate), `pValueTwoSided` (o do relatório), `ci95Pp` (IC95 por inversão), `n`/`nEfetivo`/`excludedPairs`, `pMinUnilateral`, `signTest`, `sensitivity` (exclusões > 10%) — ou `null` (< 5 pares) |
| `holdoutSkipped` | **campeão não validado** contra sobreajuste |
| `holdoutSkipReason` | por que não houve holdout: `min-scenarios` (< 20 cenários) \| `budget` \| `cancelled` \| `run-failed` \| `disabled` \| `no-change` \| `no-base` |
| `reevalRunIds` | runs da re-avaliação limpa (fora de `runIds`) |
| `stoppedAtIteration` | onde o orçamento interrompeu |
| `pool` | front Pareto final (com `paretoPool` > 1) |
| `judgeDrift` | `true` = o **contrato do juiz mudou** no meio da sessão (calibration drift — deltas podem ser do juiz) |

`regressed: true` significa que o campeão foi **pior** que a base no holdout —
o ganho do treino era ruído ou sobreajuste. Não promova esse prompt: o
`sessions winner --apply` **bloqueia** (ver abaixo).


## Reprodutibilidade e handoff

```bash
prompt-builder runs reproduce <id>          # config + comando exato para re-rodar
prompt-builder runs reproduce <id> --replay # re-pontua as respostas GRAVADAS a US$ 0 (exit 3 se divergir)
prompt-builder runs export <id> -o run.json # artefato auto-contido (gabaritos, prompts, vereditos)
prompt-builder sessions winner <sid> --apply prompt.md [--commit] [--override "<motivo>"]
prompt-builder registry validate            # guarda de drift: o needle do prompt ainda existe no fonte?
```

O `runs reproduce` devolve o RunConfig **lossless** (passa em `config validate`)
e a vista `arena-config@1`; com `--replay` ele roda o pipeline de HOJE sobre as
respostas e saídas de juiz GRAVADAS (nenhuma chamada sai para a rede, custo $0)
e compara o judge-score por cenário — divergência = drift de pontuação (exit 3,
`config.replay_mismatch`); run de agente não tem replay. O `runs export` produz `prompt-builder-run@1` —
auditoria completa sem o disco original. O `--apply` nunca perde o prompt de
produção: backup `<destino>.bak-<ts>` antes de sobrescrever, diff sempre.

### Gate do handoff (`--apply`)

| Sinal na sessão | Efeito |
|---|---|
| `holdout.regressed` | **BLOQUEIA**: exit `10`, `error.kind: "gate"`, `error.code: "handoff.holdout_regressed"`; o destino não é tocado (nem backup, nem commit) |
| `holdoutSkipped` / sem `holdout` | aviso — campeão não validado contra sobreajuste |
| IC95% contendo 0 (ou abaixo de 0, ou sem IC) | aviso — ganho indistinguível de ruído |
| `judgeDrift` | aviso — parte do ganho pode ser do juiz |

O bloqueio só cede com `--override "<motivo>"` (decisão **humana**; motivo
vazio é exit `2`). O motivo aparece no stdout, no payload (`data.override`,
aviso `override.applied`) e no trailer `Override-Reason:` do commit
(`--commit`). Toda tentativa — aplicada ou bloqueada — vira uma linha em
`<data-dir>/handoffs.jsonl` (`handoff-audit@1`). Sem `--apply`,
`sessions winner <sid> --json` já traz o laudo em `data.handoff`
(`wouldBlock`, `blocks`, `warnings`). `--prompt-only` imprime o prompt cru e
**não** passa pelo gate (só avisa no stderr).

## Levar para outra máquina e apagar (troca e LGPD)

```bash
prompt-builder runs export <id> --format exchange -o pacote/   # prompt-builder-exchange@1, record VERBATIM
prompt-builder sessions export <sid> -o sessao.json            # a sessão E as runs dela (um arquivo só)
prompt-builder runs import pacote/                             # noutro --data-dir: ida e volta = identidade
prompt-builder runs delete <id>                                # apaga de verdade (zero resíduo)
prompt-builder sessions delete <sid> [--keep-runs]
prompt-builder runs prune --older-than 30d --dry-run           # o que o TTL apagaria agora
```

O import grava runs **e** sessões do pacote, sem normalizar (campo que esta
versão não conhece sobrevive). Mesmo id com conteúdo diferente recusa o pacote
inteiro (exit `3`, `records.import_conflict`) — `--overwrite` substitui; o
idêntico é pulado (reimportar é idempotente). O `runs delete` leva record,
dono, `.tmp`, journal de chamadas, job (inclusive o do `--detach`), chave de
idempotência e `agent-runs/<id>/`; record `running` com dono vivo é recusado
(pare antes com `runs cancel`). O TTL de retenção é de **90 dias por default**
(`PB_RETENTION_DAYS`; `0` desliga) e roda sozinho no `runs list`/`sessions
list` e antes de cada run real — o que venceu some das listas e do disco. A
idade conta do **mais recente** entre `startedAt` e `importedAt`: o import
carimba `importedAt` no record gravado (metadado local — o `export` não o
leva), então importar o arquivo de uma run antiga não a condena ao próximo
`runs list`.

### Registro de aprovação (`prompt-approval@1`)

```bash
prompt-builder sessions winner <sid> --apply prompt.md --commit --approver "Ana <ana@empresa.com>"
prompt-builder sessions winner <sid> --apply prompt.md --record   # grava o registro sem commitar
```

Toda aplicação monta um registro `prompt-approval@1`: `promptHash` (sha256 dos
bytes gravados — confere com `sha256sum`), `datasetHash` (JCS do **conjunto**
de cenários: ordem e formatação não mudam o hash), `configHash`, sessão, runs,
aprovador, instante, evidência (holdout n/Δ/regressed, IC95%/p e a origem do p,
custo, k de n curados) e o override. Ele vai **sempre** na linha da trilha
local (`handoffs.jsonl`); com `--record` também em
`<repo>/.prompt-approvals/<approvalId>.json`, e o `--commit` (que implica
`--record`) commita o registro junto do prompt com os trailers
`Approved-by:`, `Prompt-Approval:`, `Prompt-Hash:` e `Dataset-Hash:`
(`git interpret-trailers --parse`). O aprovador é `--approver` ou a identidade
que o git usaria no commit; sem nenhum dos dois, `--record`/`--commit` recusam
com exit `2` (`usage.approver_required`) antes de tocar o destino.
