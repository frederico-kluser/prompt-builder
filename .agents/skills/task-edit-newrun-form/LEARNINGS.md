> **MEMÓRIA APOSENTADA (2026-09-27):** o conteúdo deste ficheiro foi migrado para a memória CoALA local do projeto (`.agents/prompt-builder-coala-memory-agent-skill/`). Fica só como **fonte histórica** — não escrever mais aqui. Aprendizado novo: `python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py add --type episodic --content "…"`.

# LEARNINGS — task-edit-newrun-form

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda. Só persista o não-óbvio.

- 2026-06-17 (inferência) — Ao podar seleções por mudança de filtro, NÃO inclua as seleções nas
  deps do efeito: use um `useRef` com o estado mais recente e rode o efeito só em
  [área, rigor, dados]. Incluir as seleções faz o aviso de "removidos" piscar e sumir.
- 2026-06-17 (inferência) — `models={models}` aparece com indentações diferentes (seletores
  aninhados no ternário de `players` vs. seletores do passo `eval`). Um replace_all por string
  exata só pega uma das indentações — confira ambas.
- 2026-06-17 (inferência) — Default de filtro ficou em `livre` de propósito: qualquer área não-livre
  poda os defaults de origem chinesa (`deepseek` gerador, `moonshotai` juiz) na carga inicial.
- 2026-07-25 (usuário) — Não existe mais seletor de rodadas/repetições: `repeats` foi removido, cada
  cenário roda 1× nos três modos. Ao **remover** um campo do assistente são **6** pontos de toque, e
  o type-check só pega alguns: `useState`, o card JSX, a estimativa de custo **+ o array de deps do
  `useMemo`** (tem `eslint-disable exhaustive-deps` — deps órfãs passam batido), `applyArenaConfig`,
  o objeto de `submit()` e a linha do resumo do passo **Revisar**. Grep pelo nome do campo antes de
  fechar.
- 2026-07-25 (inferência) — Refatoração do assistente → página única. Três armadilhas de UI que o
  type-check NÃO pega:
  (a) Um `<span className="nr-err">` **sempre renderizado** (o rodapé mostra erro/pendência/vazio)
      vira uma caixa vermelha vazia quando não há mensagem — o estilo tem borda/fundo próprios.
      Corrigido com `.nr-err:empty { display: none; }`. Vale para todo slot de mensagem fixo.
  (b) `.nr-field` é `grid-template-columns: 132px minmax(0,1fr)`: qualquer filho solto (um
      `<button class="link-toggle">` "gerar com IA", por ex.) cai na **coluna do rótulo** e fica
      espremido em 132px. Precisa de `.nr-field > .link-toggle { grid-column: 2; justify-self: start }`.
  (c) Validação não pode exigir campo que a UI esconde: com os cenários já vindos do arquivo o
      seletor de gerador nem aparece, mas `problems()` ainda pedia "Selecione 1 modelo gerador" →
      botão `Iniciar` travado sem nada visível para corrigir. Hoje o check é guardado por
      `precisaGerar`. Regra geral: a condição de render e a condição de validação do mesmo campo
      têm de ser a MESMA expressão.
- 2026-06-18 (usuário) — Filtros são por PAPEL: participantes (competidores/contestant) recebem o
  catálogo filtrado (LGPD + preço via `participantModels`); gerador e juiz recebem `models` (completo,
  sem filtro) e a poda NÃO os toca. Gerador e juiz podem repetir o mesmo modelo (sem `excludeIds`
  entre eles; o check `datagen===judge` do Zod no backend foi relaxado). Filtro de preço = USD por 1M
  tokens (`pricing.prompt/completion * 1e6`).

## 2026-09-27 — superfície guiada na Nova Run (fonte: sessão DSH, pedido do dono)
- [2026-09-27] [session:dshe-premium] [ux guiado] `pb.formStyle` (`guided` default | `complete`) decide a superfície; ESTADO é compartilhado (mesmos `useState` do NewRun passados por props ao `GuidedSetup`). Trocar de superfície não pode perder nada.
- [2026-09-27] [session:dshe-premium] [orçamento de Tab] Um `SegmentedToggle` novo de 2 opções DERRUBOU o gate IMPL-106 (c) (11 paradas no modo variation). Solução: 2 `RovingItem` no toolbar existente do PageHeader (Importar/Exportar) = custo ZERO de paradas. Controles de preferência não podem viver entre o topo do form e o Iniciar.
- [2026-09-27] [session:dshe-premium] [testes] Os contratos SSR (`test/ux-nova-run.test.ts`) precisam de `vi.mock` de TODO import `@/…` não resolvidos pelo vitest (sem alias no vitest.config): `smooth-tabs` foi o novo. `routerStub` precisa de `useLocation` quando a página o consome.
- [2026-09-27] [session:dshe-premium] [fantasma focável] O `AnimatePresence` dos chips do ModelSelector mantinha o chip a SAIR com botões focáveis ~½ s (`popLayout` + spring) — trocar de modo (que troca o chip do gerador default) estourava o gate IMPL-106 (c) com 11 paradas. Fix: `exit` com `transition: { duration: 0 }` (o chip some de imediato). Medir paradas de Tab com `scratchpad/tab-stops.mjs` (Tab real + descrição do foco), nunca a olho.
