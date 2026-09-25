---
name: task-run-and-verify
description: Procedimento para rodar o prompt-builder e verificar uma mudança ponta a ponta (testes de contrato + type-check + build + smoke). Use ANTES de dar qualquer tarefa por concluída — type-check dos dois lados, build, e smoke test (curl nos endpoints ou a UI no navegador).
metadata:
  version: 0.2.0
  type: task
---
# Tarefa: rodar e verificar

Há **testes de contrato** (`npm test`, vitest, pasta `test/`) — rode-os SEMPRE, antes e depois.
O resto da verificação é type-check + execução + observação.

## Verificação rápida (type-check — barato, faça sempre)
- Backend: `npx tsc -p tsconfig.json --noEmit`
- Frontend: `cd web && npx tsc -b`
- Ambos juntos + bundle: `npm run build`

## Rodar em dev
- `npm run dev` → backend `:3001`, frontend `:5173` (Vite faz proxy de `/v1` e `/health`).
- Acesse `http://localhost:5173`. A key OpenRouter fica em `localStorage` (tela de Configurações).

## Smoke de backend (sem subir o Vite)
- `BENCHMARK_PORT=<porta> node dist/server.js` (após `npm run build`).
- `curl localhost:<porta>/health` → `{"status":"ok",...}`.
- Endpoints públicos: `curl localhost:<porta>/v1/benchmark/techniques`, `.../lgpd`.
- Endpoints com key: enviar header `-H 'x-openrouter-key: <key>'`.
- **Pare o servidor depois** (`pkill -f "dist/server.js"`); confirme que parou.

## Smoke de UI headless (sem depender do usuário abrir o navegador)
`npm run web:build && npx vite preview --port 4173` (dentro de `web/`) e dirija com Playwright.
Não há Playwright no projeto — reaproveite uma instalação vizinha
(`import { chromium } from '<outro-projeto>/node_modules/playwright/index.mjs'`).

O que vale medir, porque a olho passa batido:
- **erros de console e `pageerror`** por rota, nos dois `colorScheme` (`light`/`dark`);
- **overflow horizontal**: `documentElement.scrollWidth - clientWidth` tem de ser 0;
- **contraste WCAG real**: `getComputedStyle` devolve `oklch(...)`, que não dá para converter na mão
  — pinte a cor num `<canvas>` 1×1 (empilhando os fundos até um opaco) e leia o RGB de volta.
  Foi assim que as células do heatmap apareceram em 2,78:1 no tema claro.
- **estado sem dado é enganoso**: semeie o IndexedDB (`prompt-builder` v2, store `runs` +
  `runSummaries`) com um `RunRecord` sintético terminado para exercitar heatmap, finais e o
  accordion de cenários. Guarde o script no scratchpad, não no repo.
- A chave fica em `localStorage['openrouter_api_key']` — um valor falso já passa o `KeyGate` sem
  nenhuma chamada real.
- **Pare o preview depois** (`pkill -f "vite preview"`).

## Smoke de feature (exemplos)
- Run curta: crie uma run com `stages=1` e confira o `data/runs/<id>.json` gerado.
- Filtro LGPD: no Avançado, troque a área e veja o catálogo dos seletores mudar; "Livre" volta tudo.

## Critério de "pronto"
Type-check verde + comportamento observado bate com o esperado. Relate honestamente o que foi (e
o que não foi) verificado.

## <evolution>
Ao concluir:
1. Persista só se a verificação realmente passou.
2. Registre em `LEARNINGS.md` qualquer passo de verificação novo/útil ou armadilha de ambiente
   (porta ocupada, cwd errado, cache) com data + fonte.
3. Padrão estável → destile no corpo + incremente `version`.
4. Não faça merge sozinho: diff git para revisão humana.
