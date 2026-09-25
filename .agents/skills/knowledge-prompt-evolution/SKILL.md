---
name: knowledge-prompt-evolution
description: O sistema de evolução de prompts do prompt-builder (portado do prompt-arena) — julgamento por referência (gabarito + refJudge pointwise + duelos Copeland), rank/pickWinner com minGain, reflection GEPA, holdout + significância bootstrap, datagen em lotes, pacote de cenários JSON, reasoning por papel e a biblioteca de prompts. Use ao mexer em gabarito/refJudge/duels/rank/holdout/stats/trainer/datagen/llmVariants/scenarioPack/reasoning/dedup/promptStore, ou em qualquer fluxo de treino/julgamento — leia junto com knowledge-benchmark-modes.
metadata:
  version: 0.4.0
  type: knowledge
---
# Evolução de prompts — prompt-builder

Sistema portado do ondokai-prompt-arena. Cada módulo vive em `src/` **e** espelhado em
`web/src/engine/` (sincronize os dois lados). Visão de modos em `knowledge-benchmark-modes`.

## Julgamento por referência (default) vs listwise (fallback)
- `referenceJudging` default **ON** em variation/training e compare-llms; **OFF** no compare
  clássico (`orchestrator.ts`). Toggle explícito sobrepõe. Etapa sem `reference` (gabarito falhou
  ou compare clássico) cai no **listwise** de `judge.ts` — degrada, nunca crash.
- **Gabarito** (`gabarito.ts` → `generateReferences`): 1 chamada por etapa, **temp 0**,
  maxTokens 1500, modelo = `referenceModelId ?? judgeModelIds[0]`, `reasoning.judge`. Um gabarito
  por cenário — cada cenário roda 1× (sem expansão). Progresso agregado via evento
  `stage.gabarito` com **`stageIndex: -1`** (não é etapa — não indexar no array de stages).
- **refJudge** (`refJudge.ts`): **pointwise** — cada resposta isolada vs gabarito, vereditos
  `resolve/parcial/nao` + 1 frase. Multi-juiz agrega por **média ordinal** (2/1/0; ≥1.5 resolve,
  ≥0.5 parcial). Degradações: sem referência → `parcial` p/ todos; resposta vazia/erro → `nao`.
- **Duelos = fase 4 de FINAIS** (`duels.ts`): não há mais bracket por etapa. Depois de TODAS as
  etapas julgadas, `pickFinalists(entries, count, seedFromId(record.id))` escolhe os **N melhores
  globais** por judge-score médio (`record.judgeScoreByContestant`; default **`finalists: 3`**,
  `0`/`duels:false` desliga, `>= n` = todos) — desempate por shuffle cego semeado, **o controle
  NÃO tem mais vaga garantida**. Esses mesmos ids vão a `runStageDuels` de cada etapa com gabarito
  pela opção **`duelists`** (quando presente, **ignora `topK`/`controlId`** e grava
  `topK = duelists.length`); `selectDuelists` (top-K + controle) continua existindo só como
  caminho sem `duelists`. Dentro da etapa: seed **FNV-1a(question) + mulberry32**, cada par julgado
  **nas 2 ordens** (desacordo = empate), **Copeland** vitória 1 / empate 0.5, placements
  fracionários, fora do bracket = `bracketSize+1`. Juiz = `judgeModelIds[0]`. Grava
  **`record.finalists: string[]`**; o Copeland cross-etapa agrega em `record.standings`.
- **JudgeResult SINTETIZADO** (`orchestrator.ts`): `rankedContestantIds` = sort **por veredito**
  (`VERDICT_SCORE`) — **sempre**, já que os duelos só rodam depois; `acceptableByContestant` =
  `verdict !== 'nao'`, `judges: []`, `blindMap: {}`. Referência pontua **1×**; listwise **por juiz**.

## Rank e promoção (rank.ts / trainer.ts)
- `judgeScore` = `(resolve + 0,5·parcial)/total × 100` por contestant (`judgeScoreByContestant`).
  Cadeia de desempate: judgeScore desc → meanPlacement asc → menos erros → prompt mais curto.
- `pickWinner(entries, {minGain})` (default **1**): promoção só se `gain >= minGain` sobre o
  controle (`original` na it. 0, `carry` nas demais — campeã re-testada verbatim). Sem margem →
  `convergedAtIteration` + `session.converged` + **break** (vale já na iteração 0).
- **Reflection GEPA determinístico** (`buildLessons`): até **8** etapas onde a campeã não deu
  `resolve` → bloco `<licoes_da_iteracao_anterior>` injetado pelo variator (cap 4000 chars).
  **Substituiu** a chamada LLM `analyzeIteration` (removida; o evento `iteration.analyzing` saiu
  do `SessionEvent`). `feedbackDriven: false` desliga.
- **Holdout** (`holdout.ts`): split **intercalado** (`k = max(2, round(1/ratio))`), ratio 0–0.5
  (default 0.2, `0` desliga), **piso de 5 cenários** (abaixo disso o holdout é descartado). Se
  houver campeão ≠ base, roda 1 run extra (`iteration = config.iterations`, contestants
  `holdout-control`/`holdout-champion`) → `session.holdout {n, controlScore, championScore, gain,
  regressed}`. Envolve tudo em try/catch — nunca derruba a sessão.
- **Significância** (`stats.ts` → `pairedSignificance`): bootstrap pareado **2000** iterações,
  **seed 1337**, **n≥5** (senão `null`), p unilateral. Gravado em `session.significance` —
  **não há evento** `session.significance` (chega via `session.finished` / GET).
- ⚠️ Dois `VERDICT_SCORE` homônimos **propositalmente diferentes**: `duels.ts` (0–2, bracket) e
  `stats.ts` (0–1, judge-score/bootstrap).

## Datagen em lotes e pacote de cenários
- `generateStages` (`datagen.ts`): lotes paralelos `batchCount = clamp(ceil(n/4), 1, 8)`, **temp
  0.8**, exclusão de prompts existentes no prompt, **dedup exato + ROUGE-L 0.7** (`dedup.ts` →
  `dedupeAdvanced`; keep prefere rubric não-vazia), **1 backfill** (`ceil(falta×1.5)`). Falha de
  lote → lote vazio, nunca derruba. `scenarioBrief` entra no **system** com prioridade na
  distribuição. `generateStage` (singular) mantido, mas **sem chamador** em `src/`.
- **Pacote** (`scenarioPack.ts`): formato `'prompt-builder-pack@1 (legado: ai-benchmark-pack@1)'` (theme, prompt campeão/base,
  cenários com `reference`). `parseScenarioPack` **nunca lança** (`{ok, error}` PT-BR). No merge,
  o seed entra inteiro com `origin: 'import'` (**nunca** deduplicado — é curadoria) e os gerados
  só com ROUGE-L < 0.7 (`origin: 'ai'`). Seed ≥ `stages` → datagen não é chamado. Export/import
  real é **só no frontend** (`api.ts`: `downloadScenarioPack`/`readScenarioPackFile`; botões na
  RunView — só variation — e TrainingView); no backend só `mergeScenarios` é usado.

## Compare-llms e reasoning
- `competitorConfigs` (2–12, **XOR** com `competitorModelIds` na API): a identidade do competidor
  é a **tripla {modelId, temperature, reasoningLevel}** — id determinístico
  `llm__<slug>__<level|def>__t<temp|def>` (`llmVariants.ts`). `sanitizeLlmVariants` falha a run
  **cedo** (antes de qualquer LLM); `fairnessWarnings` não-bloqueantes (juiz que também compete).
  A 1ª variante vira `isOriginal` (controle: âncora do `standings`, não mais dos duelos).
- **Reasoning** (`reasoning.ts`): **7 degraus** `off/minimal/low/medium/high/xhigh/max`, que
  espelham a escala `effort` do OpenRouter (`off` = `none`). O envio é SEMPRE
  `reasoning: { effort }` — junto com `max_tokens` o OpenRouter devolve 400, e budget por tokens
  só 7 de 214 modelos aceitam. Cada modelo declara em `/models` a própria allowlist
  (`reasoning.supported_efforts`, 20 conjuntos distintos no catálogo) e se raciocínio é
  `mandatory`; `fitEffort` encaixa o nível pedido no degrau suportado mais próximo (empate → o
  mais barato) e `applyReasoning` **não envia nada** quando o nível é `off` num modelo mandatory.
  Validado contra o catálogo real: 1498 combinações (214 modelos × 7 níveis), 0 violações.
  Por papel: `reasoning.{competitor, judge, rewriter, datagen}`; na UI o esforço é escolhido
  **por modelo** (ver `knowledge-frontend` → `modelCaps`/`effortOptions`).
  O variator aplica `reasoning.rewriter` via `GenerateContestantsParams.reasoningLevel`.

## Biblioteca de prompts (client-only)
- `web/src/engine/promptStore.ts`: IndexedDB v2, store `prompts` (`idbDelete` novo em `idb.ts`).
  Versionamento **por texto** — renomear não versiona; `HISTORY_LIMIT = 50`. `SavedPrompt.origin`
  (`training|variation|manual` + ids) gera o link "ver treino/run".
- Handoff "usar como base": `localStorage 'arena:prompt-draft'` escrito pela PromptsPage, lido
  **uma vez** (e removido) pelo NewRun no mount. Diff de versões via `web/src/diff.ts`.

## Arquivo de configuração do assistente (client-only)
- `web/src/engine/configFile.ts`: parser do `arena-config@1` — JSON (gerado por IA externa, ver
  **`ARENA-CONFIG.md`** na raiz) que preenche TODO o assistente Nova Run (modo, tema, brief,
  cenários seed, prompt base, modelos por papel, effort, técnicas, toggles de treino, limits).
  `parseArenaConfig` **nunca lança** (`{ok, error}` PT-BR); valida ids de técnica contra
  `getTechnique` e o XOR do compare. É **client-only** (espelha estado do wizard, não vai ao
  backend). Import: botão no rodapé do assistente → `readArenaConfigFile` (`api.ts`) →
  `applyArenaConfig` (NewRun) — campos ausentes não pisam o estado atual.

## Eventos (novos e REMOVIDOS)
- **Novos:** `stage.gabarito` (stageIndex **-1**, agregado) · **`finals.started`** (sem
  stageIndex; `finalists: {id,label,score}[]` — o reducer grava `record.finalists`) ·
  `stage.dueled` (por índice, agora **depois** de todos os `stage.judged`) · `duel.progress`
  (**sem** stageIndex, agregado, `done` = etapas dueladas) · `iteration.promoted` {championId,
  gain} · `session.converged` {iteration} · `session.holdout` {n, scores, gain, regressed}.
- **Removidos:** `competitor.started` e `competitor.progress` (não existem mais no `RunEvent` — o
  orchestrator não passa `onProgress` ao `runCompetitor` nem mantém `stageRecord.live`;
  `CompetitorLiveState`/`StageRecord.live` sobrevivem `@deprecated` só p/ LER records antigos) e
  `iteration.analyzing` (fora do `SessionEvent`).
- Na UI, os agregados (`stage.gabarito`/`duel.progress`) são interceptados **antes** do reducer
  (estado local de progresso); `stage.dueled` entra no reducer **por índice**.


## Novos módulos (F1/F2/F4 do PLANO-PARIDADE) — `src/engine/` (fonte única)
- **`libraryCore` + `src/library.ts` + CLI `pb library`** — banco persistente de cenários+
  gabaritos (`<data-dir>/library/<perfil>/items/*.json`): item enriquecido (tier/persona/
  successCriteria/rationale/dimensionTags), `hasGabarito` (reference OU expected — o evolve
  RECUSA sem, paridade com o 409), `coverageReport` (tier × dimensão + lacunas vs matriz alvo),
  seed idempotente (`mergeSeedItems` por id). `arena-config` aponta via
  `scenarios: {"from":"library","profile","ids"}` (resolvido no CLI → `customStages`).
- **`groundTruth`** — veredito determinístico por rótulo (`expected`: string | alternativas |
  {campo:valor}): normalização + BCP-47 + match standalone/primeira-linha (resolve/parcial/nao).
- **`contracts`** — never-break pós-rewriter (`verifyRewrite`: neverBreak/placeholders/
  minLengthRatio 0.3 + stripFences); o variator tenta UMA correção e rejeita a variante que
  persistir violando.
- **`promptGroup`** — multi-prompt coordinate ascent: `promptGroup`/`promptId` no config;
  `composePrompt` (systemPrompt efetivo) × `promptFragment` (fragmento evoluido, o que o treino
  reusa como campeão); irmãos congelados via `siblingsContext`.
- **`pareto`** — seleção Pareto/população (`training.paretoPool`): `addToPool`/`pickParent`
  (rodízio)/`sliceScores` por fatia (tier/dimensionTags do cenário); `session.pool` = front final.
- **`scenarioRules`** — grounding do datagen por perfil (`{{context}}`/`{{fewShot}}`/
  `{{setupKeys}}` + `coverageInstruction` de curriculum); entra em `generateStages({rules})`.
- **`judgeCalibration`** — `pinJudgeContract` (hash do contrato do juiz), `verbosityReport`
  (Pearson score×comprimento), `sampleSizeWarning` (n<10), `meanCi95` (bootstrap).
- **Reflexão GEPA por LLM**: `training.reflection: 'llm'` → `llmReflectLessons` (variator) reescreve
  as lições deterministicas; falha degrada (nunca derruba a iteração).
