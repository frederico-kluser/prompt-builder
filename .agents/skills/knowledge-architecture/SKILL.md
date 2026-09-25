---
name: knowledge-architecture
description: Mapa do repositório prompt-builder — layout do monorepo (incl. os módulos do sistema de evolução de prompts em src/ e web/src/engine/), separação backend/frontend, fluxo de dados ponta a ponta e comandos exatos de build/run. Use no início de qualquer tarefa para saber ONDE mora cada coisa antes de varrer o codebase, ou quando precisar entender como as peças se conectam.
metadata:
  version: 0.4.0
  type: knowledge
---
# Arquitetura — prompt-builder

Ferramenta de benchmark de LLMs via OpenRouter. Monorepo TypeScript: backend Express
(`src/`) + frontend React/Vite (`web/`). UI e comentários em **PT-BR**. Testes de contrato em `test/`
(vitest, `npm test`) — inclui a guarda de sincronia do motor (`test/engine-sync.test.ts`).

## Comandos exatos
- `npm run dev` — sobe backend (`tsx watch src/server.ts`, porta 3001) **e** frontend (Vite, 5173) via `concurrently`.
- `npm run build` — `tsc -p tsconfig.json` (backend → `dist/`) **e** `npm run web:build` (`tsc -b && vite build` → `web/dist/`).
- `npm start` — `node dist/server.js` (prod; serve `web/dist` estático na raiz).
- Type-check só backend: `npx tsc -p tsconfig.json --noEmit`. Só frontend: `cd web && npx tsc -b`.
- Testes: `npm test` (vitest, `test/`). Não há lint (os `// eslint-disable` são inertes).

## Layout
```
src/            backend (Express, ESM NodeNext — imports com extensão .js)
  server.ts     entrypoint: monta /v1/benchmark, /health, estático web/dist, SPA fallback
  routes.ts     todas as rotas /v1/benchmark + schemas Zod
  orchestrator.ts / trainer.ts / variator.ts   pipelines de run/treino/variação
  datagen.ts / competitor.ts / judge.ts   etapas do pipeline (juiz listwise = fallback)
  gabarito.ts / refJudge.ts / duels.ts    julgamento por referência: gabarito temp-0, vereditos pointwise, duelos Copeland
  rank.ts / holdout.ts / stats.ts         promoção (minGain), split de holdout, significância bootstrap
  llmVariants.ts / reasoning.ts / dedup.ts / scenarioPack.ts   compare-llms, reasoning por papel, dedup ROUGE-L, pacote de cenários
  openrouter.ts client HTTP do OpenRouter (chat, models, key)
  storage.ts    persistência atômica em data/runs/*.json e data/sessions/*.json
  events.ts     pub/sub para SSE; techniques.ts  biblioteca de técnicas; lgpd.ts  base LGPD
  normalize.ts  migração de records antigos; types.ts  tipos compartilhados; medals.ts  medalhas
  data/         JSON ESTÁTICO versionado (techniques não; lgpd-*.json sim)
web/src/        frontend
  api.ts        wrappers fetch + tipos espelhados do backend
  idb.ts        cache IndexedDB v2 (db "prompt-builder", stores runs/sessions/*Summaries/prompts)
  engine/       CÓPIA client-side do pipeline (ver abaixo) + promptStore.ts (biblioteca de prompts) + configFile.ts (parser arena-config@1)
  diff.ts       diff linha-a-linha (versões de prompt / diff vs. original)
  pages/        NewRun (fluxo em ABAS animadas: segmentado de modo + SmoothTabs),
                RunView, RunsList, TrainingView, PromptsPage, Settings
  pages/runShared.tsx   reducer applyEvent + VERDICT_META/verdictOf/trunc/denseStages/rankColor
                + heatRows/<ScoreHeatmap> + <FinalsPanel> (compartilhado RunView/TrainingView).
                Sem ProcessMonitor/computeStandings/medalStandings (removidos em 2026-07-25).
  components/    AppShell (header + paleta ⌘K + transição de rota + toasts), primitives.tsx
                 (Screen/PageHeader/SectionHead/Banner/SettingRow/Pre/DiffView…), Modal,
                 ModelSelector, ManualVariantsEditor, KeySetup, HelpModal.
    ui/          shadcn (CLI) — button, input, textarea, card, badge, label, switch, select…
    motion-ui/   Motion UI (CLI, registry @motion) — 20 peças + ui-theme. NÃO EDITE:
                 `shadcn add` sobrescreve. Customização vai em wrapper.
                 REMOVIDOS em 2026-07: TechniqueSelector (técnicas viraram chips inline no NewRun),
                 Toggle, e BrainBackground + brain-visualization/ + processing.ts (fundo animado
                 decorativo — cobria conteúdo e queimava CPU)
  lgpd.ts       classificação/filtragem de conformidade
  index.css     entrada do Tailwind v4 + camada de tokens (substituiu styles.css em 2026-07-26)
  ../motion.theme.ts   tokens de MOVIMENTO (raiz do web/, gerenciado pelo CLI da Motion)
data/           runtime: runs/ e sessions/ (IGNORADO no git; ver /data/ no .gitignore)
```

## Fluxo de dados
1. Frontend guarda a key OpenRouter em `localStorage` e a envia no header `x-openrouter-key`.
2. Backend valida (`requireKey`), chama o OpenRouter, persiste o `RunRecord` em `data/runs/<id>.json`.
3. Progresso ao vivo via **SSE** (`GET /v1/benchmark/runs/:id/events`); o frontend espelha em IndexedDB (fallback offline).
4. Catálogo de modelos: cache de 24h no backend + IndexedDB no cliente.
5. As **etapas de uma run rodam todas em paralelo**; a concorrência das chamadas ao OpenRouter é gateada por um **limitador global adaptativo** em `openrouter.ts` (env `OPENROUTER_MAX_CONCURRENCY`). Ver `knowledge-benchmark-modes` / `knowledge-openrouter`.

## Dois modos de execução (atenção: código duplicado)
- **Backend** (`src/`): Express + run no servidor + filesystem. Usado por `npm run dev`/`npm start`.
- **Client-side** (`web/src/engine/`): o MESMO pipeline portado para o navegador (chama o OpenRouter
  direto, orquestra na aba, persiste no IndexedDB). Permite SPA estática (Vercel, `vercel.json`).
  `web/src/api.ts` delega ao engine; `engine/events.ts` (pub/sub) e `engine/storage.ts` (IndexedDB)
  substituem `events.ts`/`storage.ts` do Node.
- **Desde o F0 do PLANO-PARIDADE a duplicação é CLASSIFICADA e vigiada**: módulos puros
  (`rank`/`stats`/`holdout`/`dedup`/`medals`/`techniques`/`reasoning`/`llmVariants`/
  `scenarioPack`/`normalize`) são fonte única em `src/` e `web/src/engine/<nome>.ts` é um
  **shim de re-export**; a matemática dos duelos vive em `src/engine/duelCore.ts`. Módulo novo em
  qualquer lado derruba `test/engine-sync.test.ts` até ser classificado (shim | mirror | web-only).
  Lógica nova PURA vai em `src/engine/` e chega aos dois motores sem duplicar (`libraryCore`,
  `groundTruth`, `contracts`, `promptGroup`, `pareto`, `scenarioRules`, `judgeCalibration`).
- **⚠️ Os pares `mirror` de `web/src/engine/*` ainda são CÓPIA de `src/*`** (datagen/competitor/judge/variator/orchestrator/
  trainer/openrouter/normalize/techniques/types **e os módulos de evolução**: gabarito/refJudge/
  duels/rank/holdout/stats/llmVariants/reasoning/dedup/scenarioPack/medals). Ao mudar a lógica do
  pipeline, **atualize os dois lados** (ou só o engine, se o backend já é legado no seu caso).
  Exceções: `engine/promptStore.ts` (biblioteca de prompts) é **client-only**, e do `scenarioPack`
  o backend só usa `mergeScenarios` (export/import do pacote acontece no frontend). Detalhes do
  sistema de evolução em `knowledge-prompt-evolution`.

## Gotcha: `normalizeRunRecord` não pode ser whitelist
`normalize.ts` (nos DOIS espelhos: `src/` e `web/src/engine/`) montava o `RunRecord` campo a campo
— um **whitelist** que engolia em silêncio todo campo novo. Foi assim que `judgeScoreByContestant`,
`standings` e `finalists` sumiam ao **reler** a run do disco/IndexedDB (painel de finais vazio
depois de um F5), sem nenhum erro de tipo. Hoje o return **espalha `...raw` ANTES** dos campos
normalizados. **Todo campo novo do `RunRecord`/`SessionRecord` tem de sobreviver à releitura** —
ao adicionar um, confira o normalize dos dois lados antes de dar a tarefa por pronta.

## Gotcha de path
`server.ts` resolve `web/dist` por `__dirname` (relativo ao arquivo). Mas **dados runtime e JSON
de `src/data/` são lidos por `process.cwd()`** (ver `storage.ts` e `lgpd.ts`) — porque `tsc` não
copia `.json` para `dist/`. Siga a convenção `process.cwd()` para ler qualquer arquivo de dados.

## Deploy / serverless (gotcha)
- **Produção = SPA estática client-side** (`vercel.json`: build `npm run web:build` → `web/dist`,
  rewrite `/(.*) → /index.html`). O backend `src/` é só para `npm run dev` / self-host persistente.
- **NUNCA publique `src/` (Express) em serverless/Vercel.** `storage.ts` persiste runs no filesystem
  (`process.cwd()/data/runs/*.json`); no serverless o FS é efêmero, isolado por invocação e read-only
  fora de `/tmp` → a run criada no `POST` some no `GET` e `GET /v1/benchmark/runs/:id` devolve
  `404 {"error":"Run nao encontrada"}`. É o mesmo motivo de o backend não rodar lá (não é só pela run
  longa: até **ler** uma run falha).
- **Detectar deploy errado:** na SPA, `GET /health` cai no rewrite e devolve `index.html` (HTML). Se
  devolver `{"status":"ok","service":"prompt-builder"}` (= `server.ts:14`), há um deploy ANTIGO do
  backend preso em produção — force um novo deploy estático (não é bug de código).
- **Na SPA, runs vivem no IndexedDB do navegador** que as criou: não são compartilháveis entre
  dispositivos/navegadores (link de `/runs/:id` em outro navegador → `Run nao encontrada` em `api.ts`).
  Para compartilhar, trocaria `storage.ts`/engine por datastore compartilhado (Vercel KV/Postgres/Blob).
