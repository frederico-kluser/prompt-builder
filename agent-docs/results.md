# Lendo os resultados

```bash
prompt-builder runs list                       # últimas runs
prompt-builder runs show <id> --json           # o RunRecord inteiro
prompt-builder runs winner <id> --prompt-only  # só o prompt vencedor, cru
prompt-builder sessions list | show | winner
```

## Duas réguas, não intercambiáveis

- **`judgeScoreByContestant`** — `(resolve + 0,5 × parcial) / total × 100` sobre
  os cenários com gabarito. Comparável **entre runs** com o mesmo juiz.
- **`standings`** — pontos Copeland dos duelos das finais (vitória 1, empate
  0,5). Só existe se as finais rodaram, e mede apenas os **finalistas** entre si.

O CLI sempre diz qual usou. Se as finais não rodaram (`--no-duels`,
`finalists: 0`, orçamento), a régua é o judge-score.

## Campos do `RunRecord` que importam

| Campo | O que é |
|---|---|
| `status` | `finished` \| `error` \| `aborted` |
| `stoppedReason` | `budget` \| `cancelled` — discrimina o `aborted` |
| `budgetExhausted` / `stoppedAtPhase` | parou cedo, e onde |
| `totalCostUsd` | gasto **total**, todos os papéis |
| `costByRole` | quebra por `competitor` / `judge` / `duel` / `gabarito` / `datagen` / `rewriter` |
| `costByContestant` | fatia **dos competidores** (gasto de juiz não é atribuível a ninguém) |
| `costAccuracy` | quantas chamadas tiveram preço exato / estimado / desconhecido |
| `stages[].incomplete` | etapa cortada no meio — **fora** do placar e do julgamento |
| `stages[].referenceJudge` | vereditos pointwise por contestant, com o motivo |
| `completeness` | n **nominal** × n **efetivo** por contestant (`byContestant[id]`: `nEfetivo`, `missing`, `completeness`, `missingByReason`) e o pareamento com a régua (`vsControl[id]`: `nEfetivo`, `excludedPairs`, Δ só sobre pares completos). `runs show` sempre mostra — e recalcula para runs antigas |
| `finalists` | ids que disputaram a final |
| `judgeDiagnostics` | pin do **contrato do juiz** (hash do prompt + modelos) + viés de verbosidade medido (correlação score×comprimento) |
| `fairnessWarnings` | avisos de imparcialidade (juiz da família do competidor) — não-bloqueantes |
| `repeats` (compare) | `record.stages.length === cenários × repeats` — cópias são observações independentes |

Uma etapa `incomplete` é o que separa "parou cedo, honesto" de "terminou,
mentindo": ela não vira veredito `parcial` nem entra na média.

Veredito **ausente** (juiz falhou, etapa pulada ou cortada) é "sem observação",
nunca `nao`: o par sai **dos dois lados** das médias e do teste. Compare sempre
`nEfetivo` com `n` antes de confiar num Δ.

## `SessionRecord` (treino)

| Campo | O que é |
|---|---|
| `bestPromptByIteration[]` | o campeão pós-gate de cada iteração, com o prompt e o `gate` (Δ pareado `gainPp`, `pairing`, `sensitivity`, `decision`: `promoted` \| `held` \| `inconclusive`) |
| `convergedAtIteration` | parou por falta de ganho (bom sinal) |
| `holdout` | `{ n, controlScore, championScore, gain, regressed, nEfetivo, excludedPairs, completeness }` — scores são médias só sobre os pares completos |
| `pairing` | o pareamento final (`source`: `holdout` \| `training`): `n`, `nEfetivo`, `excludedPairs`, `completeness`, Δ — presente mesmo quando `significance` é `null` |
| `significance` | teste pareado exato (troca de sinais): `pValue` (unilateral, o do gate), `pValueTwoSided` (o do relatório), `ci95Pp` (IC95 por inversão), `n`/`nEfetivo`/`excludedPairs`, `pMinUnilateral`, `signTest`, `sensitivity` (exclusões > 10%) — ou `null` (< 5 pares) |
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
