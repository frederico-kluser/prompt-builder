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

## 2026-09-28 — onda 1 web-form (IMPL-048/082/106/107, web-code#3/6/15/16)
- [2026-09-28] [inferência] [guiado × completa] A pendência precisa apontar o passo que MOSTRA o campo, não o da seção: o gerador é da seção `cenarios` (→ "Teste"), mas no guiado o seletor mora em "Participantes" — o rodapé mandava para um passo sem o campo. `Problem.step` (passo explícito) e `Problem.onlyComplete` (técnicas/variantes manuais, eixo configs, grupo multi-prompt — campos que o guiado não tem: o link abre a completa). O trilho do guiado ganhou ponto de pendência (`data-pendente` + "(pendente)" no nome acessível) — é o IMPL-106 (d) do guiado.
- [2026-09-28] [inferência] [orçamento de Tab] Guiado: "Participantes" em teste/treino (com o Gabarito) e "Limites" estão EXATAMENTE em 10 paradas; completa variation/training também em 10. Nada novo cabe entre o topo e o Iniciar nesses caminhos — o Gabarito obrigatório da completa ficou no Avançado e é CITADO (texto, zero parada) no rodapé da seção Juízes.
- [2026-09-28] [inferência] [E2E] A transição de rota do AppShell (`AnimatePresence mode="wait"`) remonta a página ao fim da saída: digitar logo depois de um redirect (ex.: gate → /welcome) cai na instância que sai e some. No E2E, esperar o MESMO elemento sobreviver a 2 sondagens antes de digitar (ver o E2E BYOK). No produto é um defeito do AppShell (autofill de gerenciador de senhas no 1º ½ s pode perder a key).
- [2026-09-28] [inferência] [default derivado] Default de papel que depende do modo (gabarito em teste/treino) = `useEffect` keyed no `isSingle` + ref do valor AUTO: sai ao voltar ao compare só se intocado; remover à mão vira pendência (nunca re-default).

## 2026-09-29 — onda 2 web-form-2 (web-live#5/#10/#12/#13/#14, IMPL-056)
- [2026-09-29] [medido] [poder do treino] O gate da melhor de K é max-T por troca de sinais EXATA: o menor p ajustado com n cenários de TREINO é 1/2ⁿ (amarrado ao `bestOfKTest` real em `test/newrun-form-2.test.ts`). Com 5 (o default antigo) um único empate dá 0,0625 > α — a sessão s17 da auditoria nunca promovia. Entrar no treino sobe o nº para 10 (`stagesForModeChange`, `arenaForm.ts`; volta ao anterior se intocado); < 5 de treino é pendência bloqueante, 5–7 é aviso. Com o default novo a mesma sessão promoveu na rodada 1 (p ajustado 0,002, fake OpenRouter). Regra LOCAL em `arenaForm.ts` até o helper de `src/engine/trainingPolicy.ts` (cluster trainer-features) existir.
- [2026-09-29] [medido] [pendência velha] `submit()` gravava a 1ª pendência em `error`, e o rodapé mostra `error` quando não há mais pendência — trocar de modo depois de "Iniciar" deixava a frase do outro modo no rodapé. Pendência NÃO vai para `error`: com `tried` o rodapé já mostra a ATUAL.
- [2026-09-29] [inferência] [sem gabarito] Comparar modelos (default) não gera gabarito (`referenceJudging` false) → juiz listwise e ZERO finais (`stagesParaDuelo` exige `spec.reference`). Controle que não age não é oferecido (switch/finalistas saem, a linha diz o porquê) e o plano diz "lado a lado"; cenário IMPORTADO com referência traz régua e final de volta (`importedRefs`).
- [2026-09-29] [medido] [390 px] O invólucro de ações do `PageHeader` não encolhe: a fileira Importar/Exportar/Guiado/Completo fazia a página ter 466 px. Abaixo de `sm` Importar/Exportar ficam só com ícone (nome acessível + title seguem) e a fileira quebra; o bloco de custo do rodapé perdeu o `shrink-0`. Gate E2E: `scrollWidth ≤ innerWidth` em todo passo/seção a 390 px e em /runs.
- [2026-09-29] [inferência] [idiomas] `languages` na tela é TEXTO ("pt-BR, en") separado por vírgula/ponto e vírgula — espaço NÃO separa ("pt BR" viraria ['pt','BR'], e 'br' é bretão). A regex é a mesma do runConfigSchema e dos dois arena-config (teste de paridade).
