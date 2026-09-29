---
name: task-edit-newrun-form
description: Procedimento para alterar o formulário de Nova Run LLM (web/src/pages/NewRun.tsx, atrás do seletor LLM | JEV de pages/NewBenchmark.tsx), que tem DUAS superfícies sobre o mesmo estado — o fluxo GUIADO de 5 passos (default, components/GuidedSetup.tsx) e a página única COMPLETA (seções + Avançado recolhível). Adicionar/remover campo, mexer na validação, nos seletores de modelo, no guiado, no Avançado ou no import de JSON. Use sempre que a tarefa tocar a tela de criação de run/sessão ou a montagem do RunConfig enviado.
metadata:
  version: 0.6.0
  type: task
---
# Tarefa: alterar o formulário de Nova Run

Pré-requisitos: memória CoALA — `coala.py search "frontend nova run"`. A rota `/new` é o wrapper
`web/src/pages/NewBenchmark.tsx`: o seletor **LLM | JEV** fica no topo (`?tipo=jev|llm`, escolha
lembrada em `localStorage['pb.benchKind']`) e cada lado só monta quando visitado. O lado JEV é
`pages/jev/NewJevRun.tsx` (decisões tipadas, contrato próprio `jev-config@1`); **não** misture campo de JEV no `NewRun` nem o contrário. O formulário LLM vive em
`web/src/pages/NewRun.tsx` e tem, desde 2026-09-27 (pedido do dono), **DUAS superfícies sobre o
MESMO estado**: o fluxo **GUIADO** (default, `components/GuidedSetup.tsx` — `SmoothTabs` de 5
passos: `objetivo | teste | participantes | limites | revisao`, uma pergunta por passo + plano em
linguagem natural) e a página única **COMPLETA** (IMPL-106, sem abas). O `formStyle` (`pb.formStyle`
no localStorage) decide qual renderiza; o rodapé **fixo** (pendência + estimativa + `<MultiStateButton
type="submit">`) é comum às duas.

## Anatomia
Ordem fixa: `<PageHeader>` (título + roving-toolbar `Ações da configuração`: `[Importar JSON]`
`[Exportar JSON]` + `[Guiado]` `[Completo]`) → avisos de import → **guiado** (`<GuidedSetup>`) ou
**completo** (segmentado de modo → seções) → rodapé fixo.

⚠️ O switch Guiado/Completo e o Importar/Exportar vivem no MESMO `RovingToolbar` de propósito: são
UMA parada de Tab, e o orçamento IMPL-106 (c) — ≤ 10 paradas do topo do formulário até "Iniciar" — é
CONTRATO de teste (`test/ux-nova-run-e2e.test.ts`). Controle novo no caminho do formulário → some do
orçamento; ponha-o no roving, fora do `<form>` ou depois do "Iniciar".

- Os campos compactos (`NumRow`, `TxtNumRow`, `SwitchRow`, `AreaRow`, `LinkButton`) vivem em
  `components/formRows.tsx` (extraídos p/ o guiado compor as MESMAS perguntas); `TxtNumField` e
  `EffortField` continuam locais no NewRun (só o eixo configs usa).
- As seções da completa têm **ids estáveis**: `cenarios | sujeitos | juizes | avancado`. Só o
  rótulo de `sujeitos` muda por modo (`Modelos` no compare, `Prompts` em variation/training).
  **Não crie uma seção condicional** — a âncora sumiria ao trocar de modo.
- `problems()` devolve `{ section, text, step?, onlyComplete? }`; no guiado o `irPara` vai ao
  `step` explícito ou ao que o `SECTION_STEP` (`components/GuidedSetup.tsx`) mapeia da seção —
  e, com `onlyComplete`, abre a completa (campo que o guiado não tem). Ao adicionar pendência
  nova, escolha a `section` certa E confira que o passo apontado MOSTRA o campo (o gerador é
  seção `cenarios`, mas mora em "Participantes" no guiado). O trilho mostra o ponto de pendência
  por passo (IMPL-106 d no guiado; gate E2E em `test/ux-nova-run-e2e.test.ts`).
- Gabarito (IMPL-048): obrigatório e distinto de juízes/sob teste em variation/training — regra
  única em `src/engine/roleSeparation.ts` (schema, portão da SPA e `referenceProblemTexts`). Na
  completa fica no Avançado (orçamento de Tab) e é citado na seção Juízes; no guiado, em
  "Participantes". Regras puras do form em `web/src/newRunRules.ts` (esforço por papel,
  `clampStages`, default de gabarito) — teste direto em `test/newrun-rules.test.ts`.

- Cada seção é um `<SettingGroup status={…}>` de `<SettingRow>`s (rótulo + explicação à esquerda,
  controle à direita; `wide` desce o controle para baixo). Ambos vêm de `components/primitives.tsx`.
- Dentro use os campos locais já prontos, não escreva `<label>` cru:
  `NumRow`/`TxtNumRow` (número; a versão Txt aceita vazio = default/sem limite), `AreaRow`
  (textarea), `SwitchRow`, `EffortField` (select de reasoning), `TxtNumField`, `Chip`,
  `LinkButton`, `ImportedLine`, `<ModelSelector>`.
- **Progressive disclosure**: o que é opcional começa escondido atrás de um `LinkButton`
  (ex.: `briefOpen`, `genOpen`). O que já veio pronto de um arquivo **colapsa** para uma linha
  `✓ … [remover/editar]` (`ImportedLine`) e some da seleção.

### Onde pôr um campo novo
Regra: **se 9 em 10 runs não mexem nele, vai na seção Avançado**; só sobe para uma seção de
conteúdo o que muda o resultado da run com frequência. O Avançado já concentra finalistas,
tokens/timeout/concorrência, juiz em 2 ordens, modelos de referência e reescritor, esforço por
papel, o eixo compare-llms, os gates de training, LGPD e o filtro de preço. Campo que o guiado
não mostra ganha `onlyComplete` na pendência (ver abaixo).

## Validação — `problems(): { section, text, step?, onlyComplete? }[]`
Uma função só, sem estado, que devolve **uma frase por problema, com a seção que a resolve** (e o
passo do guiado, quando não é o da seção). `const pendencias = problems()` alimenta o rodapé
(mostra `pendencias[0]`, clicável — leva à seção/passo) e o ponto de pendência no rótulo;
`submit()` a chama de novo e mostra o erro. O botão **não** fica `disabled` por pendência (só
enquanto `submitting`).

- **Ao adicionar uma pendência, escolha a `section` certa** — mandar o usuário para o lugar errado
  é pior que não navegar.
- **Só exija um campo que a UI está mostrando.** Exigir campo escondido trava o `Iniciar` sem o
  usuário ver o porquê — foi o caso do gerador quando os cenários já vieram do arquivo (hoje o
  check é `if (precisaGerar && datagen.length !== 1)`).
- Ao adicionar um filtro que pode invalidar seleções (LGPD, preço), **pode** as seleções órfãs no
  efeito de poda existente — senão a validação trava sem explicação.

## Cenários prontos vs. gerador
Três estados derivados no topo do componente governam metade da tela — mexeu em import, revise-os:
`rawStages` (array cru manda) · `seedCount` (pacote entra como seed) · `plannedStages`
(`max(stages, seedCount)`) · **`precisaGerar`** (só chama o datagen quando ainda falta cenário).

## Import unificado
UM `<input type="file">` escondido + `handleImport(file)` → `readImportFile` (`api.ts`), que nunca
lança e discrimina o formato:
- `kind: 'config'` → `applyArenaConfig(config)` + `setConfigSummary(arenaConfigSummary(config))`;
- `kind: 'pack'` → vira `pack` (seed), puxa tema e prompt base;
- `kind: 'stages'` → vira `customStages` (substitui o gerador).

**`applyArenaConfig` é campo-a-campo e `undefined` NÃO pisa o estado atual** — mantenha esse
contrato. Ao adicionar um campo ao `arena-config@1`: `configFile.ts` (parse+validação, nos DOIS
lados: `src/` e `web/src/engine/`) → `src/arenaConfig.ts` (tradução para `RunConfig`, a mesma do
CLI) → `applyArenaConfig` → `agent-docs/config.md` (o contrato lido por IA geradora; o
`ARENA-CONFIG.md` da raiz não existe mais — o docs-lint valida os exemplos de lá).

## Montagem do `RunConfig` (`submit`)
`submit()` monta um objeto **`common`** (tudo que os três modos compartilham) e depois ramifica:
compare eixo models (`competitorModelIds`) · compare eixo configs (**só** `competitorConfigs`, sem
`competitorModelIds`) · variation/training (`contestantModelId`, variantes, e o bloco extra de
training). Depois `createSession` (training) ou `createRun`, e navega.

Convenções do `common` que já mordem quem edita:
- **clamp no envio, não na digitação** (`Math.max/min/round`) — o input aceita qualquer coisa;
- campos opcionais entram por spread condicional (`...(x ? { x } : {})`) para não mandar `undefined`;
- `referenceJudging` e `finalists` vão **sempre explícitos** (o default muda por modo/eixo);
- `stages: plannedStages`, não o estado `stages`. Trocar para **treino** sobe `stages` abaixo de 10
  para `TRAINING_DEFAULT_STAGES` (10) e lembra de onde veio (`web/src/arenaForm.ts`) — com 5
  cenários o gate quase não consegue promover; a pendência de poder diz isso ao usuário.

**Ao adicionar ou remover um campo, são ~5 pontos de toque** e o type-check só pega alguns:
`useState` → JSX do bloco/Avançado → `estimate` (**incluindo o array de deps do `useMemo`**, que tem
`eslint-disable exhaustive-deps`) → `applyArenaConfig` → `common`/`config` do `submit`. Se o campo
existe no backend, feche o ciclo em `RunConfig` (`src/types.ts`, `web/src/engine/types.ts` **e** `web/src/api.ts`) e no Zod de
`src/runConfigSchema.ts` (ver `task-add-endpoint`). **Grep pelo nome do campo antes de fechar.**

## Estilos
Tailwind com classe semântica; **não** existe mais `.nr-*`/`.picker-*`/`.link-toggle` — ver memória
CoALA (`search "code style tokens"`). Componha de `components/primitives.tsx` antes de repetir cadeia de classe.
O rodapé é `fixed bottom-0`, e é o `pb-32` do `<Screen>` que impede o último campo de ficar embaixo
dele: se aumentar a altura do rodapé, aumente o padding também.

## registo de aprendizado (memória CoALA local)
Ao concluir:
1. Só persista aprendizados se o type-check passou e o formulário funcionou de ponta a ponta nos
   três modos (smoke manual — inclusive com um JSON importado e no Avançado aberto).
2. Registre gotchas (layout de grid, elemento sempre renderizado, validação de campo escondido,
   deps órfãs de `useMemo`) em `LEARNINGS.md` com data + fonte.
3. Padrão estável → destile no corpo + incremente `version`.
4. Nova área (ex.: persistência de rascunho do formulário) → a memória CoALA local (`coala.py add`).
5. Não faça merge sozinho: diff git para revisão humana.
