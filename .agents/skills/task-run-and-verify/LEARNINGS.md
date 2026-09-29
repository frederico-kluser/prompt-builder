> **MEMÓRIA APOSENTADA (2026-09-27):** o conteúdo deste ficheiro foi migrado para a memória CoALA local do projeto (`.agents/prompt-builder-coala-memory-agent-skill/`). Fica só como **fonte histórica** — não escrever mais aqui. Aprendizado novo: `python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py add --type episodic --content "…"`.

# LEARNINGS — task-run-and-verify

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda. Só persista o não-óbvio.

- 2026-06-17 (inferência) — `node dist/server.js` lê `src/data/*.json` por `process.cwd()`; rode a
  partir da raiz do repo, senão não acha os dados.
- 2026-06-17 (inferência) — Os endpoints `/api/v1/models` e `/api/v1/endpoints/zdr` do OpenRouter
  são públicos — dá para verificar classificação/catálogo via `curl` sem key.
- 2026-07-17 (inferência) — O `npx tsc` resolvido fora de `web/node_modules` pode ser uma versão
  antiga (ex: 4.9.5) que não reconhece `moduleResolution: "bundler"`. Para type-check do frontend,
  use `./node_modules/.bin/tsc -b` dentro de `web/` após `npm install`.
- 2026-07-25 (inferência) — Dá para verificar se o Zod de `POST /v1/benchmark/runs` aceita (ou
  descarta) um campo **sem key válida**: `runConfigSchema.safeParse` roda ANTES do `validateKey`.
  Resposta `401` = o schema passou; `400 "Config invalida"` = o schema rejeitou. Útil para provar
  compatibilidade retroativa ao remover um campo (o Zod, sem `.strict()`, apenas o descarta).
- 2026-07-25 (inferência) — Módulos puros de `web/src/engine/` rodam headless com
  `npx tsx <script.ts>` executado **a partir de `web/`** (os imports sem extensão resolvem). Bom
  para smoke de parsers (`parseArenaConfig`, `parseScenarioPack`) sem subir navegador.
- 2026-07-25 (inferência) — O shell é **zsh**: `${PIPESTATUS[0]}` vem vazio (lá é `$pipestatus[1]`).
  Para conferir exit code de type-check, rode o comando **sem pipe** e leia `$?` — senão você lê
  "sucesso" de um comando que falhou.
- 2026-07-17 (inferência) — Sem navegador disponível, o smoke de responsividade mobile pode ser
  complementado verificando se as media queries e as classes do menu hambúrguer aparecem no CSS
  gerado (`web/dist/assets/index-*.css`) e se o servidor de produção responde `200` com o
  `<meta viewport>` correto.

## 2026-09-27 — verificação da superfície guiada (fonte: sessão DSH)
- [2026-09-27] [session:dshe-premium] [e2e] `test/ux-nova-run-e2e.test.ts` já roda o SPA de verdade (vite build + playwright-core + fixture de 459 modelos) e aceita `pb.formStyle` via `addInitScript` — gates de UI headless não precisam de Playwright de fora. `páginaNova(viewport, 'guided'|'complete')`.
- [2026-09-27] [session:dshe-premium] [armadilha] `pkill -f "dist/server.js"` MATA o próprio shell do agente (o padrão casa com a linha de comando do bash); use padrão que não casa com a própria linha (`pgrep -af "dist/server"`) e confirme o fim.

## 2026-09-29 — auditoria de docs da wave3 (fonte: sessão DSH)
- [2026-09-29] [inferência] [armadilha] Para reproduzir exemplos do CLI com `HOME` descartável, use
  `<repo>/node_modules/.bin/tsx` + caminho ABSOLUTO de `src/cli/index.ts`: o `npx tsx` com HOME de
  scratch rebaixa o cache do npx (baixa o tsx de novo) e um cwd fora da raiz quebra o entrypoint
  relativo com ERR_MODULE_NOT_FOUND.
- [2026-09-29] [inferência] [armadilha] O universo de ids do OpenRouter é
  `GET /models?output_modalities=all` (631 modelos em 2026-09-29): os modelos de DECISÃO do modo
  JEV (`typesafe/jev-1.13`) só saem aí — o `/models` puro (460) reprova `agent-docs/jev.md` como
  falso-positivo. `scripts/check-model-ids.ts` usa o escopo completo; o cache do catálogo público
  é por escopo (`q` no arquivo).
- [2026-09-29] [inferência] No caminho feliz `config example --mode train`, o pré-voo real estima
  US$ 5,94–7,94: `--budget 10` passa (exit 0); dentro da faixa (ex.: 7) pede `--yes`
  (`usage.confirmation_required`) e abaixo do piso recusa (`usage.budget_below_estimate`). Exemplos
  de doc têm de ter folga sobre o `estimate.high`.
