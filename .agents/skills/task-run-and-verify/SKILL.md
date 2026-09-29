---
name: task-run-and-verify
description: Procedimento para rodar o prompt-builder e verificar uma mudança ponta a ponta (testes de contrato + type-check + build + smoke). Use ANTES de dar qualquer tarefa por concluída — type-check dos dois lados, build, e smoke test (CLI em --dry-run, curl nos endpoints, relatório de ciclos ou a UI no navegador).
metadata:
  version: 0.3.0
  type: task
---
# Tarefa: rodar e verificar

Há **testes de contrato** (`npm test`, vitest, pasta `test/`) — rode-os SEMPRE, antes e depois. O
`pretest` compila `dist/` (os testes de CLI executam o binário compilado); `npm run test:full`
inclui docker/Monte Carlo. O resto da verificação é type-check + execução + observação.
**Nunca gaste dinheiro de verdade:** testes usam fakes (`test/fakeOpenRouter.ts`, …) e o smoke de
run é `--dry-run`.

## Verificação rápida (faça sempre)
- Backend/CLI: `npx tsc -p tsconfig.json --noEmit` · Frontend: `cd web && npx tsc -b`
- Build: `npm run build` (só `dist/`) · `npm run build:all` (`dist/` + `web/dist/`)
- Mexeu em docs, help ou flags do CLI: `npx tsx scripts/docs-lint.ts` (exemplos de config e
  comandos contra o CLI real) e `npx vitest run test/docs-run-examples.test.ts` (cada
  `compare`/`vary`/`train` das docs passa no pré-voo com o `--budget` escrito). Mudou o `--help`:
  `npx tsx scripts/docs-lint.ts --update-help` e commite o snapshot.

## Máquina de agentes (bins, skill, Plannotator)
- `npm run agent-setup:doctor` — confere os lançadores `prompt-builder` do PATH (apontam para ESTE
  `dist/`?), a skill ligada em cada diretório de agente e o Plannotator + skills do relatório.
  Exit 1 = algo falta; `npm run agent-setup` corrige (idempotente). Num worktree, o doctor acusa
  "DESATUALIZADO" em tudo (os links apontam para o checkout principal) — esperado.
- Sem o setup, `npx prompt-builder-cli` roda a versão PUBLICADA; para testar a sua mudança use
  `node dist/cli/index.js …` ou `npm run cli -- …`.

## Smoke do CLI (sem gastar)
- Isole dados e key: `PROMPT_BUILDER_HOME=<tmp> node dist/cli/index.js …` sem `OPENROUTER_API_KEY`.
- Run: `config example --mode train -o a.json` → `train --config a.json --budget 10 --dry-run --json`
  (exit 0 com `data.requires` = key/saldo; recusa sai com o MESMO `error.code` da run real).

## Smoke do relatório de ciclos
- Contrato: `npx vitest run test/session-report.test.ts` (fixture de 2 ciclos com holdout, sem rede).
- CLI numa sessão gravada (só lê o disco): `sessions report <id>` (Markdown), `--json`
  (`.data.report.quality`, `.data.report.cycles`), `--html <arq>`; sem sessão real, semeie a
  fixture `test/support/sessionReportFixture.ts` num data-dir descartável (script no scratchpad:
  `setDataDir` + `saveRun`/`saveSession`) e rode com `--data-dir`.
- HTTP: `curl "localhost:<porta>/v1/benchmark/sessions/<id>/report?format=markdown"` (e `html`/`json`).
- Web: `/training/<id>/report` — "Baixar HTML" gera o mesmo arquivo do `--html`.

## Rodar em dev
- `npm run dev` → backend `:3001`, frontend `:5173` (Vite faz proxy de `/v1` e `/health`).
- Acesse `http://localhost:5173`. A key fica na memória da aba (ou `localStorage` com «Lembrar»).

## Smoke de backend (sem subir o Vite)
- `BENCHMARK_PORT=<porta> node dist/server.js` (após `npm run build`). Ele grava em `./data`.
- `curl localhost:<porta>/health` → `{"status":"ok",...}`.
- Públicos: `curl localhost:<porta>/v1/benchmark/techniques`, `.../lgpd`. Com key: header
  `-H 'x-openrouter-key: <key>'`. Rota inexistente sob `/v1` = `404` JSON.
- **Pare o servidor depois** — mas NÃO com `pkill -f "dist/server.js"` (o padrão casa com a linha
  do próprio shell e o mata); use `pgrep -af "dist/server"` + `kill <pid>` e confirme que parou.

## Smoke de UI headless
Os E2E já dirigem o SPA num browser de verdade: `playwright-core` está nas devDependencies
(`test/ux-nova-run-e2e.test.ts`, `test/web-views-e2e.test.ts`, `test/web-jev-browser-e2e.test.ts`).
Para um smoke avulso: `npm run web:build && npx vite preview` (dentro de `web/`) e dirija com o
mesmo `playwright-core`.

O que vale medir, porque a olho passa batido:
- **erros de console e `pageerror`** por rota, nos dois `colorScheme` (`light`/`dark`);
- **overflow horizontal** (inclusive a 390 px): `documentElement.scrollWidth - clientWidth` = 0;
- **contraste WCAG real**: `getComputedStyle` devolve `oklch(...)` — pinte a cor num `<canvas>`
  1×1 (empilhando os fundos até um opaco) e leia o RGB de volta;
- **estado sem dado é enganoso**: semeie o IndexedDB (`prompt-builder` **v3**: `runs` +
  `runSummaries`, `sessions` + `sessionSummaries`, `prompts`, `jevRuns`/`jevSessions`/
  `jevSummaries` — lista em `web/src/idb.ts`) com um record sintético terminado. Guarde o script
  no scratchpad, não no repo.
- A chave fica em `localStorage['openrouter_api_key']` — um valor falso já passa o `KeyGate`.

## Critério de "pronto"
Type-check verde + `npm test` verde + comportamento observado bate com o esperado. Relate
honestamente o que foi (e o que não foi) verificado.

## registo de aprendizado (memória CoALA local)
Ao concluir, só se a verificação passou: registe o passo novo/útil ou a armadilha de ambiente
(porta ocupada, cwd errado, cache) com
`python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py add --type procedural --content "…"`
(o `LEARNINGS.md` está aposentado). Padrão estável → destile no corpo e incremente `version`.
Não faça merge sozinho: a mudança fica como diff para revisão humana.
