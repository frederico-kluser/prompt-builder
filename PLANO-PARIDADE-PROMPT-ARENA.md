# Plano de Paridade prompt-builder × Prompt Arena

> Análise profunda dos dois sistemas (2026-09-25) com o objetivo declarado pelo dono:
> **dar ao prompt-builder tudo o que o Prompt Arena tem e deixá-lo perfeito para
> treinamento e evolução de prompts.**
>
> Fontes: código real dos dois projetos (inventário módulo a módulo), o sistema online
> verificado ao vivo (`https://ondokai-admin.web.app/api/health` → `{"ok":true,"dryRun":false}`,
> Cloud Run `prompt-arena-studio`) e pesquisa de estado da arte (GEPA/ICLR 2026, vieses de
> juiz LLM — seção 8 e Fontes).

---

## 1. Sumário executivo

1. **Os dois sistemas já compartilham o mesmo núcleo metodológico.** O `prompt-builder` é,
   na prática, a versão portátil/CLI do motor do Arena: `holdout.ts` declara "portado do
   prompt-arena", os duelos Copeland com `duelTopK` + shuffle cego FNV-1a + 2 ordens com
   desacordo=empate são idênticos, as 19 técnicas são a mesma biblioteca, o bootstrap
   pareado (`stats.ts`) e o `MIN_HOLDOUT_SCENARIOS=5` são os mesmos. **A paridade
   metodológica de avaliação já existe.**
2. **O gap verdadeiro está nos DADOS e no CICLO DE VIDA do prompt**, não na estatística:
   o Arena tem um **banco persistente de 138 cenários curados com gabaritos por item**,
   **regras de geração por-alvo** com grounding real, **treino multi-prompt por fragmento**
   (coordinate ascent), **contratos never-break** no rewriter e **handoff versionado** do
   vencedor. O prompt-builder gera cenários efêmeros por run (theme/scenarioBrief), treina
   **um prompt por sessão** e entrega o vencedor como texto (`sessions winner --prompt-only`).
3. **O prompt-builder lidera em superfície de operação**: CLI desenhada para agentes
   (docs embarcadas, ndjson enxuto, exit 7 = parcial, `--budget` obrigatório sem TTY),
   orçamento com sinais de controle (nunca degrada resultado em "plausível e errado"),
   **Agent Arena** (executor `pi` + oráculo determinístico + dossiê auto-hasheado + container
   + canário de isolamento), MCP server, filtro LGPD e UI 100% client-side. **Nada disso
   deve regredir.**
4. **Risco de qualidade transversal**: o pacote publicado no npm **não tem testes nem lint**
   (verificação = type-check + smoke). Antes de qualquer onda de features, entrarão testes de
   contrato — os portes vindos do Arena já provaram que valem (o Arena tem 156+ testes e
   contract tests que travam a byte-compatibilidade dos seams).
5. **Para "perfeito para treinamento e evolução"**, a paridade não basta: faltam (a)
   seleção **Pareto/população** em vez de campeão único elitista (GEPA), (b) controle do
   **viés de verbosidade/auto-preferência do juiz**, (c) **calibração do juiz** e rotação
   entre famílias, e (d) **parada precoce** de variantes perdedoras. Seção 8.

**Veredito:** o prompt-builder está a **uma onda bem escopada** (seções 6–7, fases F0–F2)
de ser a melhor ferramenta de treino de prompts do mercado — porque o que falta é
*plumbing de dados e ciclo de vida*, e o que é difícil (rigor estatístico, anti-viés,
orçamento) ele já tem.

---

## 2. Escopo e método

| Sistema | O que é | O que foi analisado |
|---|---|---|
| **Prompt Arena** (o "sistema online de prompt area") | Estúdio web de retreino de prompts do monorepo Ondokai: motor `monorepo/poc/ondokai-prompt-arena/server/**`, UI em `ondokai-admin/src/features/promptArena/**`, driver `electron-huu/ai-eval`, deploy Cloud Run `prompt-arena-studio` (online, verificado) | `studio-server.mjs` (API), `studio/{evolve,referenceJudge,datagen,holdout,llmVariants,openrouterModels,reasoning,stats,eventHub,runAudit,scenarioStore,embedDedup}.mjs`, `arena/{techniques,targets,select,rewriter,apply,cloudPromptSource,promptCloudCatalog,*Judge}.mjs`, `banks/*.bank.mjs`, `registry/*`, `drivers/*`, telas/componentes do admin |
| **prompt-builder** | CLI npm `prompt-builder-cli` v0.1.1 (repo `frederico-kluser/prompt-builder`): benchmark de LLMs + evolução de system prompts, com web UI e Agent Arena | `src/**` (orchestrator, trainer, variator, judge/refJudge/duels/rank/holdout/stats, datagen/scenarioPack/dedup, budget/estimate, agent/**, cli/**), `web/**`, `ARENA-CONFIG.md`, `FUNCIONAMENTO.md`, `PLANO-AGENT-ARENA.md`, `README.md` |

---

## 3. Panorama do Prompt Arena (o que ele tem)

- **11 alvos ativos** (`STUDIO_TARGETS`): workflow-editor (2 fragmentos), magic-mode,
  help-tutorial (2), response-generation, intent-router, magic-phrase-picker,
  voice-workflow-selector, store-moderation, recap-analysis, computer-use, browser-flow.
  **Fragmento** = um `export const SYMBOL` estático num fonte real, com seam
  `promptOverride` (produção byte-idêntica quando não injetado) — o estúdio treina
  prompts **de produção de verdade**.
- **Biblioteca de cenários persistente**: `banks/*.bank.mjs` = **138 itens curados à mão**
  (tier, persona, context, successCriteria, rationale, dimensionTags, cenários adversariais
  e pares de invariância) + geração IA por **regras por-alvo** (`promptArena/generation/*.ts`
  com `{{blockCatalog}}`/`{{fewShot}}`/`{{setupKeys}}` groundeados no catálogo real de 60
  blocos) + Firestore `arena_scenarios/{targetId}__{itemId}` (cap 200/alvo, `official:false`
  para itens IA, seed idempotente `prompt-arena:seed`).
- **Gabarito por item** (`gabaritoSpec`): 7 alvos `kind:'reference'` (texto de referência —
  lido do banco, **custo zero**, idêntico para todas as variantes/rodadas) e 4 alvos
  `kind:'labels'` (**veredito determinístico sem juiz LLM** — ex.: `expected∈{edit,help}`).
  `/api/evolve` **recusa item sem gabarito** (409).
- **Evolução**: 19 técnicas → rewriter cirúrgico com `<fragment_role>` (brief por
  fragmento), `<lessons_from_previous_round>` (reflexão GEPA opt-in `feedbackDriven`),
  contrato **never-break** (`taskBrief.contract`) + placeholders verbatim + gates de
  tamanho; rodadas elitistas com `minGain`, holdout (piso 5), significância pareada.
- **Juízes**: pontual `sim|parcial|nao` contra o gabarito (com rúbricas custom por alvo —
  recap/computer-use/browser-flow) + **duelos Copeland** (`duelTopK=5`, bracket = controle
  sempre + K−1 melhores) com barreira por cenário. Listwise e pairwise swap-and-average
  foram **removidos** no refactor de 2026-07-23.
- **Infra**: lanes AIMD compartilhadas + fila justa por dono (`DynamicSemaphore`),
  `eventHub` por-op (multi-run), audit durável `arena_runs/{runId}` (todos os duelos com os
  2 vereditos+explicações), catálogo OpenRouter com preços reais + inteligência curada +
  `fairnessWarnings` (juiz da família do competidor), think-level por papel espelhando a
  produção (`ASSISTANT_REASONING_BY_TARGET`, editable/readonly), `CostPreview` pré-run.
- **Dois modos**: `evolve` (modelo fixo, texto varia) e `compare-llms` (prompt fixo ×
  N configs modelo/reasoning/temperatura, `repeats` 1–3, vencedor por Copeland).
- **Entrega do vencedor (estado atual)**: o estúdio **não escreve em produção** —
  `/api/apply`, `arena/commit.mjs` e `publishTargetToCloud` **não existem mais**; o
  operador copia o prompt vencedor (diff + handoff) e cola na aba **Prompts** do admin
  (coleção versionada `prompts/{docId}` + blob do app). Base/controle vem do prompt vivo
  (`readCloudPromptText`).
- **Registro de prompts**: 29 prompts inventariados (11 active · 10 planned · 8 excluded)
  com guarda de drift sem LLM (`validate.mjs`, no pre-push) e catálogo cloud de 19 docIds.

---

## 4. Panorama do prompt-builder (o que ele tem)

- **3 modos**: `compare` (modelos), `vary` (variações de prompt) e `training` (evolução
  iterativa) — mais o **Agent Arena** (`arena-agent-config@1`: competidor = processo `pi`
  em worktree/container, oráculo `verify[]` determinístico que **manda sobre o LLM**,
  dossiê com self-hash sha256, `forbiddenPaths` anti-reward-hacking, canário que mede
  vazamento de isolamento, `agents replay/reconcile/gc`).
- **Pipeline** (`orchestrator.ts` `runLoop`): datagen em lotes paralelos (ou
  `customStages`/packs pinados; dedup exato + ROUGE-L 0,7 + backfill) → gabaritos temp-0
  (`gabarito.ts`, 1500 tokens) → participantes em paralelo (streaming) → julgamento
  pointwise cego multi-juiz (`refJudge.ts`) com fallback listwise (`judge.ts`,
  `judgePasses:2` anti-viés) → finais com **duelos Copeland** (`selectDuelists` topK,
  2 ordens, desacordo=empate) → placar/medalhas/judge-score.
- **Treino** (`trainer.ts`): iterações sequenciais, cenários pinados após a iteração 0,
  holdout intercalado (`splitHoldout`, piso 5 — descarta holdout espúrio), reflexão
  **GEPA determinística** (`buildLessons`: até 8 falhas do campeão, cap 4000 chars),
  promoção só com `gain ≥ minGain` (convergência sem margem), gate final
  `finalizeHoldout` + **bootstrap pareado** (2000 resamples, mulberry32/seed 1337).
- **Contratos**: `arena-config@1` (declarativo) + `RunConfig` Zod (união discriminada,
  superRefine anti-viés: juiz≠competidor, datagen≠competidor, ≥2 variantes) +
  `arena-agent-config@1`. Identidade de competidor = tripla modelo/temperatura/reasoning
  (`llmVariants.ts`) — o mesmo slug pode competir 2×.
- **Modelos/custo**: catálogo OpenRouter em cache (TTL 24h) com capacidades
  (`supported_parameters`), `fitEffort` model-aware (7 degraus; zero HTTP 400),
  estimativa low–high por papel **antes** de gastar (`estimate.ts`, com
  `pricing.overrides` por faixa de prompt — sem isso subestima 3–7×), `BudgetLedger`
  com reserva pré-fetch e **portas suaves por grupo atômico** (G1 datagen+gabaritos;
  G2 respostas+julgamento), `--budget` obrigatório sem TTY, orçamento esgotado →
  **exit 7 (resultado parcial válido)**, nunca resultado "plausível e errado".
- **Superfícies**: CLI (docs embarcadas versionadas com custo em tokens, ndjson enxuto,
  `--json`, códigos de saída distintos), servidor Express+SSE, **web 100% client-side**
  (`web/src/engine` = cópia do motor no browser; Vercel estático), **servidor MCP**
  (8 tools), filtro LGPD consultivo por criador/família/origem.

---

## 5. Matriz de paridade

Legenda: ✅ paridade · ⚠️ parcial · ❌ gap real · 🟢 o prompt-builder lidera

### 5.1 Metodologia de avaliação

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Veredito ternário vs gabarito | `sim/parcial/nao` | `resolve/parcial/nao` | ✅ |
| Gabarito persistido por cenário (reusado entre runs, custo 0) | `gabarito` no banco; `buildReferencesFromGabaritos` | gera gabarito **em runtime** por run (`gabarito.ts`) | ❌ |
| Duelos Copeland (V=1/E=0,5/D=0), 2 ordens, desacordo=empate | ✓ | ✓ (idêntico) | ✅ |
| `duelTopK` (controle sempre + K−1 melhores) | ✓ | ✓ (portado) | ✅ |
| Shuffle cego semeado (FNV-1a/mulberry32) | ✓ | ✓ | ✅ |
| Judge-score `(sim+0,5·parcial)/N` + `minGain` | ✓ | ✓ | ✅ |
| Holdout com piso `MIN_HOLDOUT_SCENARIOS=5` | ✓ | ✓ (portado) | ✅ |
| Significância pareada (bootstrap 2000, seed fixa) | ✓ | ✓ | ✅ |
| Veredito **determinístico** por rótulo esperado (ground-truth) | 4 alvos (`gabaritoSpec kind:'labels'`) | só no modo agente (oráculo) | ❌ |
| Rúbrica de juiz custom por alvo (`judgeRubric`) | ✓ (recap/computer-use/browser-flow) | rubric só como texto no cenário | ⚠️ |
| Múltiplos juízes agregados (média ordinal) | 1 juiz | ✓ (`judges[]`) | 🟢 |
| Fallback listwise sem gabarito | removido | ✓ | 🟢 |
| Attendance ("conf. X% de N") + invariante pódio=banner | ✓ (§8.15) | placar único, sem attendance | ⚠️ |

### 5.2 Dados de treino (cenários)

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Banco persistente curado (138 itens, 11 alvos) | `banks/*.bank.mjs` + Firestore | packs export/import (`prompt-builder-pack@1`) + `customStages` | ❌ |
| Cenário enriquecido (tier, persona, context, successCriteria, rationale, dimensionTags, adversarial, pares de invariância) | ✓ | `question/productContext/maxTokens/rubric` | ❌ |
| Regras de geração **por-alvo** com grounding (catálogo real, few-shot, `{{setupKeys}}`) | `generation/*.ts` no admin | `theme`/`scenarioBrief` genérico | ❌ |
| Proveniência (oficial/IA/manual) + seed idempotente + cap por alvo | ✓ (`official:false`, `prompt-arena:seed`) | — | ❌ |
| Dedup | exato + ROUGE-L/MinHash (embeddings opcionais) | exato + ROUGE-L 0,7 | ⚠️ |
| Gabarito obrigatório antes de rodar (409 sem) | ✓ | `reference` opcional (juiz listwise cobre) | ⚠️ (por design) |

### 5.3 Evolução de prompt

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Biblioteca de 19 técnicas | ✓ | ✓ (idêntica) | ✅ |
| Rewriter cirúrgico (só o que a técnica pede) | regra SURGICAL explícita | "cirúrgico" no meta-prompt | ✅ |
| Lições do campeão (feedback-driven) | reflexão GEPA **por LLM** (opt-in) | lições **determinísticas** (`buildLessons`) | ⚠️ |
| Contrato never-break (`taskBrief.contract`) | ✓ | — | ❌ |
| Proteção de placeholders (`{os}`, `{lang}`…) + gates de tamanho (stripFences, ≥30% do base) | ✓ | não verificado | ❌ |
| Rodadas elitistas + `minGain` + convergência | ✓ | ✓ | ✅ |
| **Multi-prompt / coordinate ascent** (fragmentos; irmãos congelados) | ✓ (features de 2 prompts) | 1 prompt por sessão | ❌ |
| Variantes manuais | — | ✓ (`manualVariants`) | 🟢 |
| Seleção Pareto / população diversa | — | — | ambos ❌ (EAP, seção 8) |

### 5.4 Modelos, raciocínio e custo

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Catálogo OpenRouter (preços, tools, reasoning) | ✓ + **inteligência curada** (tier) | ✓ + filtros LGPD por área | ⚠️ |
| Think-level model-aware (`fit`) | 5 níveis | 7 degraus + `fitEffort` + `mandatory` | 🟢 |
| Think-level por papel **espelhando a produção** (editable/readonly) | `ASSISTANT_REASONING_BY_TARGET` | `effort` livre por papel | ❌ |
| Avisos de equidade (juiz da família do competidor) | `fairnessWarnings` | só hard-check juiz≠competidor | ⚠️ |
| Estimativa pré-run por papel/etapa | `CostPreview` (na UI) | `estimate` (comando; fora da UI) | ⚠️ |
| Teto de gasto real e honesto | budget + `pricesFromCatalog` | `BudgetLedger` + portas suaves + exit 7 | 🟢 |
| Custo total conta todos os papéis | ✓ | ✓ (o README está **desatualizado** — seção 9) | ✅ (doc ⚠️) |

### 5.5 Infra, operação e entrega

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Concorrência adaptativa (AIMD) | lanes por papel + **fila justa por dono** | limitador global AIMD | ⚠️ |
| Barreira de duelos sobreposta ao run (latência) | `createDuelBarrier` | finais após todas as runs | ⚠️ |
| Multi-run isolado (logs por operação) | `eventHub` por `opId` | eventos por run (runs independentes) | ✅ |
| Auditoria durável com **todos os duelos + explicações** | `arena_runs/{runId}` (`MAX_DUELS=600`) | record de run em JSON | ⚠️ |
| Handoff versionado do vencedor (diff + destino versionado) | copy → coleção `prompts/{docId}` versionada | `sessions winner --prompt-only` + `/prompts` (IndexedDB) | ❌ |
| Registro de prompts + guarda de drift (validação sem LLM, pre-push) | `registry/validate.mjs` | — | ❌ |
| Testes automatizados | 156+ (vitest + contract tests) | **nenhum** | ❌ (transversal) |
| CLI para agentes (docs/ndjson/exit codes/`--budget`/key via stdin) | — | ✓ | 🟢 |
| Agent Arena (executor/oráculo/dossiê/container/canário) | — | ✓ | 🟢 |
| MCP server | — | ✓ (8 tools) | 🟢 |
| Filtro LGPD | — | ✓ | 🟢 |
| Cloud multiusuário + auth (admin token + App Check) | ✓ (Cloud Run) | local por design | não-objetivo (seção 10) |

### 5.6 UI

| Capacidade | Prompt Arena | prompt-builder | Status |
|---|---|---|---|
| Wizard de configuração multi-passo | ✓ | ✓ (5 passos) | ✅ |
| Heatmap variante×cenário **ao vivo** | `VariantScenarioHeatmap` | heatmap de posições (pós-run) | ❌ |
| Heatmap rodada×variante + colocação medalhada | `RoundVariantHeatmap`/`PlacementHeatmap` | placar corrida + medalhas por etapa | ⚠️ |
| "Onde falhou" (explicação do juiz por falha) | `FailureDigest` | painéis de referência parciais | ❌ |
| Drawer do prompt variante (Completo/Diff/Lado-a-lado) | `VariantPromptDrawer` | `web/src/diff.ts` existe; sem drawer dedicado | ⚠️ |
| Dashboard de fan-out (progresso por item/fase/concorrência) | `FanoutDashboard` | eventos SSE por etapa | ❌ |
| Preview de custo pré-run na UI | `CostPreview` | só via CLI `estimate` | ❌ |
| Painel de metodologia (holdout + significância + aviso) | `Methodology` | parcial na `TrainingView` | ⚠️ |
| Pódio + baseline do controle + attendance | ✓ | placar + medalhas | ⚠️ |
| Tema claro/escuro | ✓ | ✓ | ✅ |

---

## 6. Gaps P0 — o que trava o "treinamento e evolução" hoje

### P0.1 Banco de cenários persistente com gabaritos (o gap mais importante)
O Arena treina sobre um **dataset versionado e curado**; o prompt-builder re-gera cenários
a cada run (mesmo com packs, o fluxo é export/import manual). **Sem dataset estável não há
evolução comparável entre sessões** — o `minGain` compara contra o controle, mas o
*próprio dataset muda* de run para run.

**Recomendação:** novo módulo `src/library/` + comando `pb library`:
- **Itens** no formato já existente de cenário **alargado**: `{id, title, tier
  (mft|invariance|adversarial|edge), persona, context, successCriteria[], rationale,
  dimensionTags[], question, productContext, maxTokens, rubric, expected|reference}` —
  o shape do `banks/*.bank.mjs` do Arena é o template (portar a normalização do
  `scenarioStore.mjs`).
- **Persistência local-first** coerente com a filosofia do projeto: diretório
  `~/.prompt-builder/library/<profileId>/*.json` (ou SQLite quando surgir necessidade),
  com `official|ai|manual` + `createdAt` + seed idempotente (`pb library seed`).
- `arena-config@1` ganha `scenarios.from: "library"`, `scenarioIds[]`, e o evolve **recusa
  item sem gabarito** (paridade com o 409 do Arena).

### P0.2 Regras de geração de cenários por-prompt (com grounding)
Hoje o datagen é genérico (theme/scenarioBrief). O Arena injeta **grounding real** do
domínio (`{{blockCatalog}}` com 60 blocos, `{{fewShot}}`, `{{setupKeys}}`), gera em K
batches paralelos, deduplica e **produz o gabarito de cada item**.

**Recomendação:** campo `scenarioRules` no perfil do prompt (arquivo Markdown/JSON
versionado junto do prompt): templates com placeholders `{{context}}`/`{{fewShot}}`/
`{{count}}`, regra "1 gabarito por item" (modelo de referência temp-0) e matriz de
cobertura sugerida (tier × dimensionTags) — ver P0.5.

### P0.3 Contratos never-break no rewriter (evolução que não quebra produção)
O rewriter do Arena protege o prompt com `taskBrief.contract` (invariantes que nunca podem
ser removidos), placeholders verbatim, regra SURGICAL e gates (stripFences, reescrita
< `max(40, 30% do base)` é rejeitada). O `variator.ts` do prompt-builder não tem gates.

**Recomendação:** bloco `contracts` no perfil do prompt: `neverBreak[]` (regras
invioláveis), `placeholders[]` (tokens que devem sobreviver verbatim), `minLengthRatio`
(0,3 default) + verificador pós-rewriter (rejeita/regenera). Barato (validação local, sem
LLM) e transforma o modo `train` de "evolui e torça" para "evolui com cinto de segurança".

### P0.4 Multi-prompt (coordinate ascent)
Sistemas reais têm >1 prompt por feature (ex.: regras + críticas do Arena). Hoje o
prompt-builder treina um prompt por sessão. **Recomendação:** `promptGroup` no perfil
(`prompts[]` com `id/label`), treino por prompt com **irmãos congelados** (o texto dos
outros vira contexto fixo no rewriter e no gabarito), `/api/evolve`-equivalente exigindo
`promptId` quando o grupo tem >1 — exatamente a semântica de fragmento do Arena, genérica.

### P0.5 Veredito determinístico por rótulo esperado (ground-truth)
Para tarefas classificáveis (rotear intenção, moderar, escolher workflow — os 4 alvos
ground-truth do Arena), o juiz LLM é **ruído puro**. **Recomendação:** suporte a
`expected` no cenário (`string | string[] | {field: value}`) com comparação determinística
(normalização + BCP-47 para idiomas, como o `languageMatches` do Arena), judge bypassado
sem gastar LLM, `judgeScore` calculado direto. Reusa o padrão do oráculo do Agent Arena
("quando existe determinístico, ele manda").

### P0.6 Testes e lint (transversal)
Pacote npm público sem `test`/`lint`. Os portes vindos do Arena já quebraram 1× por
drift (o próprio Arena tem um CLI quebrado por remoção de `pairwiseTiebreak` — seção 9).
**Recomendação:** vitest + contract tests dos contratos (`arena-config@1`, packs, vereditos,
`selectDuelists`, `splitHoldout`, `pairedSignificance`) — golden tests que travam
determinismo (seeds) antes de qualquer refactor.

---

## 7. Gaps P1 — paridade de operação e visualização

1. **Auditoria de duelos + `FailureDigest`**: persistir, por run, cada confronto com os 2
   vereditos + explicações (`arena_runs`-like) e mostrar "por que perdeu" por cenário.
   Hoje as explicações do juiz existem nos records, mas não há digested view.
2. **Fan-out dashboard + heatmap variante×cenário ao vivo**: os eventos já carregam
   `stageIndex`; falta a visualização por item/fase (o Arena prova que é o que faz a run
   longa "não parecer travada").
3. **VariantPromptDrawer** (Completo/Diff/Lado-a-lado) e **DeltaBars vs controle**:
   comparar variante × campeão é o ato central do treino.
4. **CostPreview na UI** (hoje só `estimate` na CLI): chamadas e US$ por etapa/papel antes
   de rodar, com os preços reais do catálogo.
5. **Reflexão GEPA por LLM opt-in** (`--rewriter llm-reflection`): além das lições
   determinísticas, um meta-modelo resume as falhas do campeão em
   `<lessons_from_previous_round>` (o Arena faz isso com `buildReflection`). Custo extra
   contado no ledger; default fica determinístico (zero custo).
6. **Handoff versionado**: `sessions winner` ganha `--apply <arquivo|docId>` com
   backup + diff (`git diff --no-index`) + opção de commit — e a `/prompts` (IndexedDB)
   vira um registro versionado com `activeVersion`, como a aba Prompts do admin.
7. **Guarda de drift** (`pb registry validate`): para quem treina prompts que vivem em
   código, validar que o símbolo/needle do prompt ainda existe no fonte (o `validate.mjs`
   do Arena, genérico) e avisar quando o prompt de produção divergir da base treinada.
8. **Fairness warnings + política de think-level por perfil**: avisar quando juiz e
   competidor são da mesma família (auto-preferência — seção 8) e permitir que o perfil
   fixe o think-level "de produção" com edição travada (fidelidade do que será medido).
9. **`repeats` de volta** (medição de instabilidade): o Arena clona cenários 1–3× no modo
   comparar; o prompt-builder removeu `repeats` do `arena-config@1`. Repetir é o modo
   honesto de mostrar variância — sobretudo com N pequeno.

## 8. Rumo ao "perfeito para treinamento e evolução" (além da paridade)

Lastro no estado da arte (Fontes):

1. **Seleção Pareto/população em vez de campeão único (GEPA, ICLR 2026 oral).** Tanto o
   Arena quanto o prompt-builder são elitistas: um campeão vira a base da próxima rodada.
   O GEPA mantém uma **população diversa** e seleciona pais por dominância de Pareto —
   prompts diferentes ganham em subconjuntos diferentes do dataset, e colapsar cedo num
   único campeão é preso a ótimo local. **Ação:** manter pool de até K campeões por
   "fatia" (dimensionTags/tier), mutar os pais diversos, e reportar o Pareto-front na UI.
   É a maior alavanca de qualidade que falta nos dois sistemas.
2. **Viés de verbosidade do juiz.** Juízes LLM pontuam respostas mais longas mesmo em
   qualidade igual (Wang 2023); o desempate atual do prompt-builder prefere prompt mais
   **curto**, mas o score em si é length-blind. **Ação:** (a) calibração — regressão
   score×comprimento num conjunto de ~100–200 pares conhecidos; (b) reportar a correlação
   no painel de metodologia; (c) opcional, parear respostas truncadas.
3. **Auto-preferência do juiz** (10–25% de favoritismo pela própria família). O Arena
   já emite `fairnessWarnings`; o prompt-builder só impede juiz=competidor. **Ação:**
   warning por família + recomendação de juiz de outra família + rotação de juiz entre
   rodadas (mantendo o contrato fixo).
4. **Calibração e pinning do contrato do juiz.** "Calibration drift" (mesma rúbrica,
   distribuição diferente após bump do modelo do juiz) quebra comparações entre sessões.
   **Ação:** versionar o contrato do juiz no record da run (hash do prompt do juiz +
   modelo) e avisar quando uma sessão comparar juízes diferentes.
5. **Parada precoce (sequential halving).** Com V variantes × C cenários, rodar tudo é
   quadrático no agregado; cortar as piores variantes a ~30% dos cenários (mantendo o
   controle) reduz custo sem afetar o ranking final. Complementa o `duelTopK` já existente.
6. **Tamanho de amostra e múltiplas comparações.** O bootstrap pareado é bom e já é
   "suporte, não gate" — falta **orientação explícita**: avisar quando n<10 por variante,
   e mostrar o intervalo de confiança junto de cada delta (não só o p-value).
7. **Curriculum e cobertura.** Os banks do Arena usam `tier`/`dimensionTags`/pares de
   invariância; adotar isso (P0.1) + um relatório de **cobertura** (quantos cenários por
   dimensão) evita o treino "aprender o dataset" e dá ao datagen um alvo de preenchimento.
8. **Reprodutibilidade total.** Seeds já existem (FNV-1a/mulberry32/seed 1337); faltar
   `pb runs reproduce <id>` (o `agents replay` já faz isso para o modo agente) e export do
   pacote completo (config + cenários + gabaritos + prompts + juiz) como artefato único.

---

## 9. Achados pontuais (corrigir junto)

1. **README desatualizado** (`README.md:600`): afirma que `totalCostUsd` não conta
   datagen/juiz — o `BudgetLedger` já contabiliza todos os `CostRole`. Corrigir o doc.
2. **`arenaConfig.ts:289` (TODO)**: `arena-agent-config@1` sem `base`/`techniques` — treino
   do modo agente com variantes de prompt está incompleto (ganha prioridade com o P0.4).
3. **`web/src/engine` duplicado** (25 módulos espelhados): cada feature nova desta lista
   precisa ser implementada 2× ou extraída num pacote compartilhado. **Recomendação:**
   extrair o motor para `src/engine/` consumido por CLI, server e web (bundler no browser)
   antes das ondas P1 — senão o custo de manutenção dobra a cada item.
4. **Bug no projeto irmão (Arena)**: `electron-huu/ai-eval/arena.mjs` importa
   `pairwiseTiebreak` (removido) e aborta no import — documentado como pré-existente.
5. **Pendências do Agent Arena** (não bloqueiam esta lista): `dockerExec` para
   `setup[]`/`verify[]`, canário `--deep` (`canary.ok:false` — pi lê `$HOME/SYSTEM.md`),
   reconciliação de custo OpenRouter indisponível (veredito "NÃO" no
   `reconcile-evidence.md`).

---

## 10. Roadmap sugerido

| Fase | Conteúdo | Por quê nesta ordem | Esforço |
|---|---|---|---|
| **F0 — Fundação** | Testes de contrato + lint (P0.6) · correção do README · extração do motor de `web/src/engine` (item 9.3) | sem isto, cada feature é implementada 2× e regressões passam despercebidas | Médio |
| **F1 — Dados de treino** | Biblioteca de cenários+gabaritos (P0.1) · regras de geração por-prompt (P0.2) · ground-truth determinístico (P0.5) · cobertura/curriculum (§8.7) | é o que faz treino ser comparável entre sessões; tudo downstream depende | Médio-alto |
| **F2 — Evolução segura** | Contratos never-break (P0.3) · multi-prompt (P0.4) · reflexão GEPA opt-in (§7.5) · `repeats` (§7.9) | treino "perfeito" = evoluir sem quebrar, em features reais | Médio |
| **F3 — Operação/UX** | Auditoria de duelos + FailureDigest (§7.1) · heatmaps ao vivo/drawer/deltas (§7.2–3) · CostPreview na UI (§7.4) · handoff versionado (§7.6) · drift guard (§7.7) · fairness warnings (§7.8) | produtividade de quem treina; vem depois de os dados existirem | Médio |
| **F4 — Excelência** | Pareto/população (§8.1) · calibração do juiz (§8.2–4) · sequential halving (§8.5) · orientação de amostra (§8.6) · `reproduce` (§8.8) | o que coloca acima do estado da arte | Alto |
| **F5 — Opcional** | Cloud/multiusuário, 2º adaptador de agente, datagen de tarefas de agente | deliberadamente fora (§ abaixo) | — |

**Não-objetivos recomendados** (manter o prompt-builder enxuto e portátil):
cloud multiusuário/auth (o Arena já cobre esse caso de uso no monorepo); banco externo
(SQLite local resolve); reescrever a web em cima do server (o modo client-side é um
diferencial); replicar o registry Ondokai-specific (o drift guard genérico do §7.7 cobre).

---

## 11. Riscos

1. **Custo crescente**: reflexão GEPA, gabaritos e repeats adicionam chamadas. Mitigação:
   tudo opt-in + contado no `BudgetLedger` + `estimate` cobrindo os novos papéis.
2. **Overfit ao banco curado**: com dataset fixo e pequeno, evoluir demais vira "decorar o
   banco". Mitigação: holdout humano separado (não-gerado), `dimensionTags` + relatório de
   cobertura, e datagen continuando a complementar (como o Arena faz: bancos + IA).
3. **Complexidade de configuração**: o `arena-config@1` já é grande. Mitigação: perfis
   versionados separados (`prompt profile` = identidade+contratos+regras) e `config example`
   sempre gerando o arquivo completo comentado.
4. **Dupla implementação CLI×web** até o item 9.3 estar feito — por isso ele é F0.

---

## Fontes (estado da arte consultado)

- [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning (ICLR 2026) — visão geral](https://www.morphllm.com/gepa-prompt-optimization) · [repo gepa-ai/gepa](https://github.com/gepa-ai/gepa) · [DeepEval — como o GEPA funciona (Pareto selection, train/validation split)](https://deepeval.com/docs/prompt-optimization-gepa) · [Pydantic AI — montando dataset de avaliação (happy/edge/adversarial) e loop GEPA](https://pydantic.dev/articles/prompt-optimization-with-gepa)
- [LLM-Judge Bias Mitigation 2026 (posição/verbosidade/auto-preferência/formato/calibração + mitigações mecânicas)](https://futureagi.com/blog/evaluating-llm-judge-bias-mitigation-2026) · [AI/TLDR — LLM judge biases (swap consistency, regressão score×comprimento, self-preference delta)](https://ai-tldr.dev/learn/evaluation-safety/llm-as-judge/llm-judge-biases) · [Self-Preference Bias in LLM-as-a-Judge (alphaXiv)](https://www.alphaxiv.org/overview/2410.21819v1)
- [promptolution: A Unified, Modular Framework for Prompt Optimization (arXiv)](https://arxiv.org/html/2512.02840v2) — taxonomia de otimizadores (contínuo/discreto; instruction + few-shot).
