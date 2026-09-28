---
name: task-add-endpoint
description: Procedimento para adicionar ou alterar um endpoint na API /v1/benchmark do prompt-builder, do schema Zod no backend até o wrapper fetch no frontend. Use sempre que a tarefa envolver uma nova rota HTTP, um novo campo de RunConfig, ou expor dados novos para a UI.
metadata:
  version: 0.1.0
  type: task
---
# Tarefa: adicionar um endpoint

Pré-requisitos de conhecimento: memória CoALA — `coala.py search "backend api"`, `"frontend"` se a
UI consome, `"openrouter"` se chama modelo (as antigas skills `knowledge-*` foram consolidadas lá).

> **Modo client-side (SPA):** lá não há rota Express — "expor dados" = uma função no
> `web/src/engine/` + wrapper em `web/src/api.ts` (que mantém a mesma interface pública). Se a
> feature precisa valer nos dois modos, reflita no backend (`src/`) E no engine. Ver memória CoALA
> (`search "arquitetura shim mirror"`).

## Procedimento
1. **Rota** em `src/routes.ts`: adicione `router.get/post('/<rota>', ...)`. Decida se precisa de
   key (`requireKey` para chamadas ao OpenRouter) ou é pública (como `/techniques` e `/lgpd`).
2. **Validação** (se recebe body): defina/estenda o schema Zod. Para um campo opcional em todos os
   modos de run, adicione em `baseFields` como `.optional()`. Retorne `400` com
   `{ error, details: parsed.error.flatten() }` em falha.
3. **Tipos**: atualize `src/types.ts` (ex.: campo novo em `RunConfigBase`) e **espelhe** em
   `web/src/api.ts` (os tipos são duplicados de propósito — mantenha sincronizados).
4. **Lógica**: coloque regra de negócio no módulo certo (`openrouter.ts`, `storage.ts`, novo
   módulo) — a rota deve ser fina. Para ler JSON estático, use **`PKG_DATA_DIR` (`src/paths.ts`)** —
   nunca `process.cwd()` (instalado como pacote dá ENOENT).
5. **Wrapper no frontend**: em `web/src/api.ts`, crie `fetchX()`/`postX()` no padrão existente
   (`authHeaders()`, checagem de `res.ok` com mensagem PT-BR, retorno de `json.data`).
6. **Verifique**: rode `task-run-and-verify` (type-check dos dois lados + curl + smoke na UI).

## Convenções
- Resposta de lista: `{ data: [...] }`. Erro: `{ error: string }`.
- Mantenha PT-BR nas mensagens. Reúse `describeOpenRouterError` para erros do OpenRouter.

## registo de aprendizado (memória CoALA local)
Ao concluir:
1. Só persista aprendizados se o type-check passou e o endpoint respondeu como esperado.
2. Registre surpresas/gotchas (ex.: peculiaridade do Zod, ordem de middleware, CORS/proxy) em `LEARNINGS.md` com data + fonte (usuário > inferência).
3. Se virar padrão estável, destile no corpo desta skill e incremente `version`.
4. Se surgiu área nova (ex.: auth, websockets), invoque a memória CoALA local (`coala.py add`).
5. Não faça merge sozinho: deixe a mudança como diff git para revisão humana.
