---
name: knowledge-code-style
description: Convenções de código do prompt-builder — idioma, módulos ESM, tipagem, componentes React e CSS. Use em PRATICAMENTE TODA edição de código neste repositório para escrever no mesmo estilo do que já existe, evitando refações por inconsistência.
metadata:
  version: 0.2.0
  type: knowledge
---
# Estilo de código — prompt-builder

Escreva código que se pareça com o que já está em volta. Pontos não-óbvios:

## Idioma
- **PT-BR** em strings de UI, mensagens de erro e comentários. Identificadores em inglês.

## Backend (TypeScript, ESM NodeNext)
- **Imports relativos DEVEM terminar em `.js`** mesmo apontando para um `.ts` (`import { x } from './foo.js'`). É exigência do NodeNext — sem isso o runtime quebra.
- `strict: true`, sem `any`. Erros tratados com mensagens claras em PT-BR (ver `describeOpenRouterError` em `openrouter.ts`).
- Validação de entrada com **Zod** em `routes.ts` (union discriminada por `mode`).
- Comentários explicam o **porquê** (há vários explicando armadilhas de concorrência/SSE) — preserve esse estilo.

## Frontend (React 19 + TS)
- Componentes funcionais; props tipadas como `interface Props { ... }` no topo do arquivo.
- Estado local com `useState`/`useMemo`/`useEffect`; estado compartilhado via **React Context** (`theme.ts`, `help.ts`, o `ToastContext` do `AppShell`) — **não** há Redux/Zustand.
- Estrutura **plana** em `pages/`; em `components/` há duas subpastas geradas por CLI que **não se edita à mão**: `components/ui/` (shadcn) e `components/motion-ui/` (Motion UI). Import direto por arquivo, sem barril.
- Alias `@/` → `web/src/`. Código do app usa import relativo (`../api`); as peças de CLI usam `@/`.

## CSS (Tailwind v4 + shadcn + Motion UI)
- **Não existe mais `styles.css`.** O estilo é Tailwind utilitário no JSX; `web/src/index.css` só carrega o Tailwind e declara a camada de tokens.
- Use **só classes semânticas**: `bg-background`, `bg-card`, `text-muted-foreground`, `border-border`, `ring-foreground/10`, `rounded-xl`. **Nunca** hex, nunca `text-zinc-*`, nunca `px` cravado onde há escala.
- Tokens próprios do domínio: `resolve` / `parcial` / `nao` (+ `-soft`) — são os vereditos do juiz e existem porque o heatmap precisa deles com contraste AA nos dois temas. Ao mexer neles, **meça** (ver `scratchpad/contrast.mjs` no histórico: canvas + WCAG, 8 amostras × 2 temas).
- Movimento vem do tema: `useMotionUITransition('snap'|'ui'|'gentle'|'lively'|'ambient')`. Nunca escreva `stiffness`/`damping` na mão. Anime só `transform`/`opacity`/`filter`.
- Tema claro/escuro pela classe `dark` no `<html>` (`theme.ts`), com opção `system`.

## Geral
- **Testes:** `npm test` (vitest) roda os testes de contrato em `test/` — adicione testes ao mexer
  em lógica de pipeline (seeds/desempates/whitelists têm guardas lá). Valide o resto por
  type-check + execução manual (ver `task-run-and-verify`).
- Mensagens de commit em PT-BR, estilo conventional (`feat:`, `feat(web):`, `fix:` …).
