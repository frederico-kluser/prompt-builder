---
name: task-add-endpoint
description: Procedimento para adicionar ou alterar um endpoint na API /v1/benchmark do prompt-builder, do schema Zod no backend até o que a UI e o CLI/MCP consomem. Use sempre que a tarefa envolver uma nova rota HTTP, um novo campo de RunConfig, ou expor dados novos para a UI.
metadata:
  version: 0.2.0
  type: task
---
# Tarefa: adicionar um endpoint

Pré-requisitos de conhecimento: memória CoALA — `coala.py search "backend api"`, `"frontend"` se a
UI consome, `"openrouter"` se chama modelo (as antigas skills `knowledge-*` foram consolidadas lá).

> **Três superfícies, um motor.** A API HTTP (`src/routes.ts`) é só uma delas: o CLI
> (`src/cli/commands/*`), o MCP (`src/cli/commands/mcp.ts`) e o SPA (`web/src/engine/`, que roda na
> aba e NÃO chama o backend para criar runs) consomem o MESMO motor. Dado novo = função pura em
> `src/engine/` (fonte única, com shim no web) que as superfícies só renderizam — o relatório de
> ciclos é o modelo: `src/engine/sessionReport.ts` → `sessions report` (CLI), `get_session_report`
> (MCP), `GET /sessions/:id/report` (HTTP) e `/training/:id/report` (web), sem recalcular nada.
> Ver memória CoALA (`search "arquitetura shim mirror"`).

## Procedimento
1. **Rota** em `src/routes.ts`: `router.get/post('/<rota>', ah(async …))`. Decida se precisa de
   key (`requireKey` para chamadas ao OpenRouter) ou é pública (como `/techniques`, `/lgpd` e as
   leituras de runs/sessões). Valide o id (`isValidRecordId`) e os query params ANTES de ler o
   disco: parâmetro ruim = `400 { error }`, record ausente = `404 { error }`.
2. **Validação de config** (se recebe RunConfig): o schema é `src/runConfigSchema.ts` (campo
   opcional de todos os modos → `baseFields`). A API é **fail-closed**: chave desconhecida vira
   `400` (`refuseUnknownKeys`, a mesma regra do CLI/MCP) — campo novo tem de existir no schema.
3. **Tipos**: `src/types.ts`, `web/src/engine/types.ts` **e** `web/src/api.ts` (triplicados de
   propósito — mantenha os três). Campo novo em `RunConfigBase`/`RunRecord`: cheque os dois
   whitelists silenciosos — `normalizeRunRecord` (`normalize.ts`) e `variationConfigFrom`
   (`trainer.ts`, nos DOIS motores) — e, se entra no arquivo, `arena-config@1`
   (`src/arenaConfig.ts` + `configFile.ts` nos dois lados) + `agent-docs/config.md`.
4. **Lógica**: regra de negócio no módulo certo (`src/engine/` se pura; `openrouter.ts` se chama
   modelo — sempre pelo gateway, com `role` para o ledger); a rota fica fina. JSON estático por
   **`PKG_DATA_DIR` (`src/paths.ts`)** — nunca `process.cwd()`.
5. **UI**: no SPA a "chamada" é uma função do motor exposta por `web/src/api.ts`. Só leitura do
   backend self-host (SPA servido pelo Express) vai em `web/src/backend.ts` (GET com timeout,
   `null` quando não há backend — a SPA da Vercel não tem).
6. **Docs e paridade**: rota nova entra na tabela da API do `README.md`; comando/flag novo no
   `--help` (`npx tsx scripts/docs-lint.ts --update-help`) e em `agent-docs/`.
7. **Verifique**: `task-run-and-verify` (type-check dos dois lados + `npm test` + curl + smoke).

## Convenções
- Lista: `{ data: [...] }`. Erro: `{ error: string }` (+ `code` quando o CLI tem um). Rota
  inexistente sob `/v1` já responde `404` JSON — não crie catch-all.
- SSE: feche no evento terminal (`finished`/`inconclusive`/`error`/`aborted`).
- Mensagens em PT-BR. Reúse `describeOpenRouterError` para erros do OpenRouter.

## registo de aprendizado (memória CoALA local)
Ao concluir, só se o type-check passou e o endpoint respondeu como esperado: registe surpresas
(peculiaridade do Zod, ordem de middleware, CORS/proxy) com
`python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py add --type procedural --content "…"`
(o `LEARNINGS.md` está aposentado). Padrão estável → destile no corpo e incremente `version`.
Não faça merge sozinho: a mudança fica como diff para revisão humana.
