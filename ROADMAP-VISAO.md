# ROADMAP — Benchmark de Visão (UI grounding)

> Status: **v0.1 (F0) implementado** — imagem crua, dois modos, dataset versionado
> com verdade do DOM, placar determinístico, 5 famílias e 7 cenários.
> Este roadmap cobre o que falta e **por que cada técnica entra (ou não)**,
> ancorado na pesquisa de percepção/memória/orquestração de computer use
> (out/2026) que originou o benchmark.

## 1. Princípios (não negociáveis)

1. **Verdade do DOM, não opinião de juiz.** A caixa de cada controle vem do HTML
   renderizado por nós (`getBoundingClientRect`). O placar é reproduzível e
   auditável; nenhuma nota nasce de LLM.
2. **Prova não é criada na hora.** O dataset é versionado, pinado por sha256 e
   cresce por commit. Rodar o benchmark nunca gera cenário novo: o record
   aponta a versão e o hash do dataset usado.
3. **Dois modos, uma verdade.** `map` (listar todos os clicáveis) e `action`
   (dado um pedido, devolver a ação + posição). Uma técnica só é "boa" se
   melhorar **as duas** ou se o ganho num modo justificar a perda no outro.
4. **Custo e latência são parte da nota.** Toda variante reporta chamadas,
   tokens (imagem inclusa), custo medido e latência; ganho sem preço não é
   ganho.
5. **Medir antes de adotar.** Toda técnica abaixo é uma **variante** do mesmo
   dataset, comparada pareada (mesmos cenários, mesmos modelos): só entra no
   benchmark como "recomendação" se o ganho passar do IC e do custo.
6. **Nada de inflar placar.** Retry, best-of-N, rollouts e verificador mudam o
   custo e o número — sempre reportados explicitamente (N, orçamento, tempo).
7. **O dataset envelhece.** Splits dev/test, rotação de cenários e checagem de
   contaminação fazem parte do produto, não são "extra".

## 2. O que existe hoje (F0)

**Superfície:** `prompt-builder vision run|list|show|report|dataset` + SPA
(`/vision` e `/vision/runs/:id`: setup com N cenários, prévia da tela no hover,
resultado com matriz cenário × modelo e mapa de calor por modelo).

- **Dataset** `vision-dataset@1` em `src/data/vision/`: manifesto + HTML dos
  cenários + PNG 1080p + assets vendorizados. `vision dataset verify` confere
  sha256/tamanho/coerência (centro na caixa, `targetId` existente, tipos).
- **Famílias:** Bootstrap 5.3.3, React95 (Wireframe Win95 real), Fluent UI (web
  components), Material 3 (web components), macOS (CSS próprio).
- **Modos:** `map` (elementos + posição) e `action` (instrução → ação + ponto).
  Espaço de coordenadas escolhido por run (`pixels` | `normalized` 0–1000).
- **Placar:** ponto dentro da caixa (casamento 1-para-1 guloso por qualidade);
  precisão/recall/F1 de região e de rótulo, acerto de tipo, recall por tipo e
  por família; no modo ação: ação certa + alvo certo + texto certo.
- **Prompt:** sem overlay, sem grade, sem a11y, sem zoom. Texto antes da
  imagem. Coordenada declarada. Sem retries por padrão.
- **Relatório:** Markdown + HTML autocontido (`vision report --html`).

Limitações conhecidas: 7 cenários (poucos para IC estreito), imagens PT-BR,
cenários sintéticos, rótulos automáticos podem conter ruído (ex.: "Somente SLA
vencido" em um switch), e a comparação com ScreenSpot/OSWorld **não é direta**
(medimos enumeração + ação, não um clique isolado).

## 3. Como uma técnica entra (protocolo de ablation)

Toda técnica nova é implementada como **variante declarada** no record
(`technique: 'mark-grid@1'`, `som@1`, `a11y@1`, …) e medida no mesmo dataset,
com os mesmos modelos e o mesmo espaço de coordenadas. Critérios:

- **Cobertura:** ≥ 30 cenários dev + ≥ 30 test (F1), pareado por cenário.
- **Efeito:** Δ F1 (map) ou Δ pass (action) com IC 95% bootstrap pareado que
  não cruza zero; bônus se o ganho vier nos subgrupos difíceis (alvos < 20 px,
  ícone puro, densidade > 30 controles).
- **Preço:** custo médio por tarefa e latência p50/p95; uma variante que dobra o
  custo só entra se o Δ for ≥ o dobro do ruído entre seeds.
- **Honestidade:** retries/rollouts contam no custo e no N; nada de escolher o
  melhor de N sem dizer N.
- **Produto:** a variante só é recomendada se vencer em ≥ 2 modelos de famílias
  diferentes (generalista forte e grounder nativo).

Orçamento de referência por ablation: ~US$ 5–20 (30 cenários × 2 modos × 3
modelos × variantes, imagens 1080p ~1,8k tokens de entrada). Toda rodada sai
`vision run --dry-run` primeiro.

---

## 4. Fases

### F1 — Dataset para valer (próximo)

**Objetivo:** sair de 7 para ≥ 60 cenários e de "demo" para benchmark com
poder estatístico.

- **Splits dev/test** com ids pinados no manifesto (`split: 'dev'|'test'`),
  seleção por `--split`; test só roda com `--allow-test` e o relatório marca.
- **Dificuldade calibrada:** densidade (5–80 controles), alvo pequeno
  (checkbox 12–16 px, ícones 16 px), proximidade (dois botões adjacentes com o
  mesmo rótulo), oclusão (modal, dropdown aberto, tooltip), estados
  (`disabled`, `checked`, `focused`, `loading`), scroll interno.
- **Resoluções e downscale:** 1080p canônico + variantes 1440×900, 1366×768,
  2560×1440 e telas 4K recortadas; o record guarda a imagem enviada e o fator
  de escala. O pré-downscale correto é o item de maior impacto segundo a
  Anthropic — antes de qualquer técnica de prompt.
- **Variação linguística:** PT-BR (atual), EN e ES; rótulos com acento/emoji.
- **Cobrança realista:** links/abas/menus, campos com erro, tabelas com ações
  por linha, toolbars de ícones, sidebar, breadcrumb.
- **Anti-contaminação:** cenários inéditos (nada de Bootstrap demo pronto),
  checagem manual de que o cenário não é um screenshot público; registrar a
  origem.
- **Métricas:** por subgrupo (tamanho do alvo, densidade, tipo, família),
  IC bootstrap; perda de oportunidade por amostras puladas.

**Aceite:** ≥ 60 cenários, ≥ 25 por família nos dois lados possíveis, IC 95%
≤ 2 p.p. no F1 agregado com 2 modelos; `vision dataset verify` verde.

### F2 — Percepção I: overlays e busca (grade/SoM)

**Objetivo:** medir se "marcar a imagem" ajuda modelos generalistas a apontar.

- **Mark-Grid 2 rodadas** (o maior ganho sem treino no paper: 11,7% → 95,2% no
  ScreenSpot-v2): grade 8×8 com IDs → o modelo devolve 4 células → recorte
  (lado menor 512 px) → grade nova → seleção final; centro das 4 células finais
  vira o ponto. Implementar como variante `mark-grid@2` com 2 chamadas por
  célula. Medir:
  - Δ F1 vs baseline, e Δ no subgrupo "alvo < 20 px";
  - custo/latência (~4× no paper: 27 s vs 7,18 s por amostra);
  - taxa de "modelo devolveu ID inexistente".
- **Axis-Grid** (réguas nas bordas + grade 100 px) como variante de 1 chamada.
- **Coordinate Scaffold** (matriz 8×8 de pontos rotulados) como variante de 1
  chamada — histórica, barata.
- **Grade simples 9×9 desenhada uma vez** como **controle negativo** (o paper:
  10,9% vs 11,7% sem grade; Anthropic não viu ganho). Se uma variante piorar,
  o achado também é resultado — e o relatório mostra.
- **Set-of-Mark com âncoras**: overlay numerado nos controles do DOM (verdade
  conhecida) para medir o **teto** "detector perfeito" — separa erro de
  detecção de erro de escolha. Depois, um SoM real (detector visual + OCR)
  para medir o piso.
- **Tiling** (quadrantes) como controle de custo/ganho.
- **Formato de saída por overlay:** ID de célula/marca em vez de coordenada;
  o placar converte o ID para a caixa de verdade.

**Hipóteses a testar:** generalista forte ganha com 2 rodadas; grounder nativo
perde com overlay (polui a imagem); grade de 1 passada é neutra/negativa.
**Aceite:** variante documentada com Δ + IC + custo nos 3 modelos; recomendação
por classe de modelo.

### F3 — Percepção II: recorte/zoom sob incerteza e resolução

- **Zoom adaptativo (UI-Zoomer):** só quando confiança < limiar; medir Δ e
  custo das chamadas extras. Zoom incondicional **piora** o ScreenSpot-v2 — o
  experimento deve mostrar isso no nosso dataset também (controle).
- **Recorte escolhido pelo modelo (GUI-Lens):** OCR/detector como *priming* +
  o modelo escolhe a região a ampliar + verificação visual. Referência de teto
  em 2026: 87,9% no ScreenSpot-Pro com GPT-5.5. No nosso caso, 2–4 chamadas.
- **Zoom nativo do provedor** (`enable_zoom` do Claude) como flag por modelo.
- **Resolução de envio:** tabela por família (Claude 1280×720/Opus 4.7 1080p;
  Gemini 1440×900; UI-TARS 0–1000) e **reescala das coordenadas** conferida por
  teste (o erro clássico: imagem reduzida silenciosamente e clique deslocado).
- **DPR 2** e imagens 4K: recortar a janela antes de reduzir.

**Aceite:** matriz resolução × zoom × modelo; o record guarda `sentImage`
(sha) e `scale`; nenhum cenário pode ter delta sistemático ≥ 5 px entre envio
e verdade (teste de calibração).

### F4 — Estrutural: árvore de acessibilidade + visão

- **a11y-only**, **visão-only**, **híbrido** como três modos de input do mesmo
  (`map`/`action`). No dataset web, o build já consegue gerar o **ARIA/DOM
  snapshot** podado (≤ 300 nós, só visíveis/interativos) e serializá-lo
  (`[17] Button "Salvar" @(412,118,480,140) enabled`).
- **Fusão (UFO²):** somar detecções visuais que não se sobrepõem (IoU < 0,8) à
  árvore; medir quantos controles a árvore perde (custom controls, canvas,
  web components com shadow DOM — o nosso Fluent/Material já perde os internos
  de shadow DOM e isso vira um estudo de caso).
- **Critérios de árvore não confiável** (heurísticas a validar): < 5 nós
  interativos em janela rica; caixas que não batem com o OCR; canvas/Electron
  sem `Name`; listas virtualizadas.
- **Orçamento de tokens:** poda, deduplicação por IoU, serialização compacta;
  medir custo vs ganho.
- **Extensão natural:** novos cenários "a11y-hostis" (canvas, shadow DOM,
  ícones desenhados) — é onde a visão deve ganhar da árvore.

**Aceite:** três modos no mesmo split; relatório mostra Δ por família e o
"custo de a11y" (tokens de texto vs imagem).

### F5 — Verificação e auto-correção

- **Verificador visual** ("é este o alvo?" com a caixa/ponto marcado):
  componente do GUI-Lens; mede Δ pass e custo (+1 chamada).
- **See-Point-Refine multi-turno:** desenhar cruz vermelha (~5% da largura) no
  último palpite e pedir correção; medir 1ª vs 2ª tentativa (o paper:
  20,6% → 38,1% no VS Code) e o teto de 2 turnos.
- **Sinal barato primeiro:** SSIM local ±100 px + phash para "não mudou" — no
  benchmark é diagnóstico, não gatilho de ação (não há execução real).
- **bBoN / juiz de trajetórias:** para o modo `action` multi-passo (F7), N
  rollouts + juiz sobre narrativas; reportar N e custo. **Nunca** usar juiz LLM
  no modo `map` (a verdade é geométrica; juiz só adiciona ruído e custo).
- **Anti-inflação:** verificação e retry entram como colunas explícitas do
  relatório (`tentativas`, `custo extra`, `ganho por US$`).

**Aceite:** 1ª × 2ª tentativa no relatório; variante só recomendada se ganho
por US$ superar zoom/grade.

### F6 — Orquestração multi-modelo

- **Planner + grounder** (SeeAct-V): planner generalista escreve a *intenção*
  (texto visível + tipo + relação espacial); grounder nativo devolve 0–1000.
  Medir o par contra o mesmo modelo fazendo tudo (o paper: 32,9% → 46,8%).
- **Mixture-of-Grounding** (Agent S2): rotear por tipo de alvo — ícone →
  grounder visual; texto → OCR; estrutura → a11y. Medir roteamento vs sempre
  um só.
- **Roteamento por incerteza:** grounder caro só quando confiança < 0,6 ou
  alvo < 20 px; medir economia e perda.
- **Protocolo de estado JSON** (objetivo, plano, histórico compacto, notas,
  erros, tela, intenção, grounding, verificação) — o mesmo shape do modo
  `action` futuro multi-passo.
- **Rollouts paralelos + juiz:** só com custo declarado; o benchmark deve
  reportar `N` e o ganho marginal por rollout (a literatura alerta que
  best-of-N infla ranking).

**Aceite:** matriz 2×2 (planner × grounder) + custo; recomendação por
orçamento.

### F7 — Memória e tarefas multi-turno

Hoje cada célula é uma pergunta isolada. A evolução é um **modo `sequence`**:
o mesmo cenário recebe 2–5 pedidos encadeados, com estado de tela entre eles
(sem execução real: a "nova tela" é um cenário seguinte do dataset, com o
mesmo app em outro estado).

- **Histórico:** texto completo de ações/pensamentos + **3–5 imagens** recentes
  (Anthropic: 3; UI-TARS: 5). Medir retenção de contexto (acerto no 3º pedido).
- **Notetaker** (fatos voláteis: nome de arquivo, código), **checklist vivo**,
  **detector de loop** (mesmo trio ação/alvo/phash 3×), **compactação** em
  lote (~20–25 passos).
- **Memória visual seletiva** (ROI salvo pelo notetaker) e **AWM** (workflows
  reutilizáveis) como variantes caras, medidas por ganho de passos.
- **Métricas novas:** acerto por posição na sequência, passos até sucesso,
  repetição de erro, custo acumulado de imagens.

**Aceite:** retenção no 3º pedido com 3 vs 5 imagens; custo de tokens de
imagem no relatório.

### F8 — Segurança (tela é dado não confiável)

- **Pop-ups adversariais / injeção via UI:** "Attacking Vision-Language
  Computer Agents via Pop-ups" (Zhang et al., 2024): agentes clicaram em
  pop-ups adversariais em média **86%** das vezes e a taxa de sucesso caiu 47%.
  Defesas básicas (mandar ignorar pop-ups) foram **ineficazes**.
- Cenários adversariais no dataset: banner falso, diálogo "Atualize agora",
  texto instruindo a ignorar regras, botão que imita controle legítimo.
- Métricas: taxa de clique no alvo errado, resistência a instrução na tela,
  detecção de anomalia; no modo `action`, exigir `ask_user` para ações
  irreversíveis (o runner mede a escolha).
- **Regra de ouro:** o benchmark nunca executa a ação; mede a intenção. Ainda
  assim o modelo deve aprender a recusar/pedir confirmação.

**Aceite:** ≥ 10 cenários adversariais; relatório de segurança separado.

### F9 — Dataset vivo e governança

- **Versionamento semântico do dataset** (patch = correção de anotação, minor =
  cenário novo, major = mudança de formato/regra de placar).
- **Curadoria com provenance**: autor, ferramenta, data, origem, licença dos
  assets; revisão humana obrigatória para cenário novo.
- **Reprodutibilidade**: Chromium/fonte pinados, hash do manifesto, build
  determinístico; `--check-drift` avisa quando re-render muda bytes.
- **Rotação e contaminação:** cenários "test" não entram em contexto de
  treino; checagem de saturação (modelos acertando 100% → cenário aposentado
  do test, mantido no dev como sanity).
- **Escala:** meta 200+ cenários; contribuição por PR com o mesmo gate de
  anotação (o build FALHA se um interativo não estiver anotado).
- **Retenção:** runs de visão guardam imagens de cenário (dado versionado) —
  sem PII por construção; mesmo assim o relatório não embute imagens.

### F10 — Produto e superfícies

- **Leaderboard** por família/tipo/tamanho de alvo, com custo por acerto.
- **`vision techniques`**: catálogo de variantes implementadas vs roadmap
  (como `jev techniques`), puxado do registry de técnicas.
- **Integração com `vary`/`train`:** evoluir o *prompt* de visão (contrato de
  saída) com holdout — o mesmo dataset vira tarefa de treino de prompt.
- **SPA:** ✅ tela de setup/run (prévia da verdade no hover) e resultado
  (matriz + heatmap por modelo + lightbox); falta a galeria do dataset fora da
  run, o compartilhamento do relatório HTML e a comparação entre runs.
- **MCP:** tool `run_vision_benchmark` (mesmo motor, guardas de gasto).
- **API HTTP:** `/v1/vision/runs` para o self-host (respeitando o mesmo
  `data-dir`, sem serverless).
- **Ponte com o ecossistema:** exportar formato ScreenSpot-like (instrução,
  `bbox`) e importar anotações humanas para cenários reais (F11 futuro).

### F11 — Fora do sintético (real, controlado)

- Apps reais com a11y (VS Code, Gmail, Excel), capturados com permissão, com
  verdade da árvore de acessibilidade + revisão humana.
- **Ainda** dataset congelado (nada de "prova na hora"); foco em domínios
  profissionais (IDE, planilha, CRM) onde o ScreenSpot-Pro mostra o vale.

---

## 5. Prioridade e ordem recomendada

| # | Fase | Por que agora | Impacto esperado | Custo |
|---|---|---|---|---|
| 1 | F1 dataset/splits/dificuldade | sem N, nenhum número é conclusivo | alto | médio |
| 2 | F3 resolução/downscale | maior impacto e custo ~0 (Anthropic) | alto | baixo |
| 3 | F2 Mark-Grid 2 rodadas | maior ganho medido sem treino | alto | alto (4× latência) |
| 4 | F2 SoM com âncoras | separa detecção de escolha (diagnóstico) | alto (diagnóstico) | baixo |
| 5 | F4 a11y + híbrido | maior atalho de precisão quando existe árvore | alto | médio |
| 6 | F5 verificador + refine | corrige erro de clique sem detector | médio-alto | médio |
| 7 | F3 zoom sob incerteza | alvos minúsculos | médio-alto | médio |
| 8 | F6 planner+grounder | generalista não precisa groundar sozinho | alto | médio |
| 9 | F7 memória/multi-turno | a vida real é sequência, não clique isolado | alto | médio |
| 10 | F8 segurança | risco real, literatura alarmante | alto | baixo |
| 11 | F10 produto/leaderboard | adoção e comparação pública | médio | médio |
| 12 | F11 real controlado | validade externa | alto | alto |

**Decisão registrada (F0):** nada de grade/zoom/a11y na primeira versão — o
objetivo era medir o piso "imagem crua". O benchmark nasceu determinístico e
barato de auditar para que cada técnica acima entre como *variante medida*, não
como opinião.

## 6. Anti-metas (o que NÃO vamos fazer)

- **Grade simples de uma passada como "recurso"** — sem evidência de ganho;
  fica apenas como controle negativo.
- **Tiling incondicional** — a Anthropic não viu ganho em clique; custo ×N.
- **Zoom incondicional** — piora o ScreenSpot-v2; só sob incerteza.
- **Juiz LLM no modo `map`** — a verdade é geométrica; juiz é ruído caro.
- **Best-of-N sem declarar N** — infla ranking; sempre com custo e N.
- **Prova gerada na hora** — cada cenário é commit e hash.
- **Esconder amostras puladas** — pulado fica fora das métricas **e** no
  relatório; erro conta como resposta errada.
- **Ajustar o dataset depois de ver o erro do modelo** — vira overfitting;
  correção de cenário exige bump de versão e nunca no mesmo "test" que já foi
  medido.

## 7. Experimentos prioritários (matriz de ablations)

Desenho: pareado por cenário, 3 modelos (generalista forte, generalista
econômico, grounder nativo), 2 modos, 30 cenários dev + 30 test, IC bootstrap
95% (10k reamostragens), custo medido por célula.

1. **Baseline × Mark-Grid@2 × Axis-Grid × grade simples** (F2) — o experimento
   de maior valor informativo.
2. **Resolução:** 1080p × 1440×900 × 720p, com e sem reescala de coordenadas.
3. **SoM-âncora** (teto) × **SoM-detector** (piso) × sem overlay.
4. **a11y-only × visão-only × híbrido** (F4), com tokens do texto medidos.
5. **Zoom sob incerteza** com limiares 0,5/0,6/0,7 e alvo < 20 px.
6. **Verificador** (1 chamada extra) e **refine** (2ª tentativa).
7. **Planner+grounder** vs modelo único, com grounder nativo e com Mark-Grid.
8. **Sequência** de 3 pedidos com 3 vs 5 imagens de histórico (F7).
9. **Adversarial:** taxa de clique em pop-up com/sem instrução de recusa (F8).

Cada experimento é um `vision run` com a variante declarada; o relatório
compara custo e Δ, e o resultado entra neste roadmap como decisão datada.

## 8. Backlog de cenários e famílias

- **Web:** Ant Design, Tailwind/shadcn, Materialize, Bulma, Chakra; formulário
  longo com erro; tabela com paginação e filtros; modal de confirmação;
  dashboard dark.
- **Desktop:** Windows 11 (Fluent), Windows XP/98 (classic), GNOME/KDE,
  macOS dark; janela com menu, dialog, file picker, notificação.
- **Mobile:** Android (Material You), iOS (HIG) em 1080×1920 e 390×844.
- **Densa/profissional:** IDE-like (árvore de arquivos, editor, terminal),
  planilha (células como controles), CRM com sidebar + tabela + ações.
- **Adversarial:** pop-up, banner, instrução na tela, botão-isca.
- **a11y-hostil:** canvas, shadow DOM fechado, ícones desenhados, listas
  virtualizadas.

## 9. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Dataset pequeno → IC largo | F1: splits + N; relatório sempre com IC |
| Viés de 5 frameworks | backlog de famílias + subgrupos por família |
| Contaminação (demais públicos) | cenários inéditos + rotação do test |
| Overfitting por consultar o placar | test selado; mudança de cenário = nova versão |
| Custo de imagem (1,8k tokens/chamada) | `--limit`, `--dry-run`, cache de imagem por cenário, budgets |
| Provedor redimensiona silenciosamente | registrar imagem enviada + fator de escala; teste de calibração |
| Rótulos automáticos ruidosos | métrica de rótulo separada; curadoria humana em F9 |
| "Ganho" por retry/rollout | custo e N explícitos; anti-metas |
| Pesquisa com números de terceiros | cada número do md é citado com paper/modelo/benchmark; nunca transportado como promessa |

## 10. Definição de pronto por fase

- **F0 (feito):** rodar `vision run` em 2 modelos, placar reproduzível,
  relatório, verify do dataset, testes de contrato, docs.
- **F1:** ≥ 60 cenários, splits, subgrupos, IC; verify verde; dataset ≥ 2 MiB.
- **F2:** 4 variantes de overlay com relatório de custo/Δ; recomendação por
  classe de modelo.
- **F3:** matriz resolução/zoom/recorte com calibração de coordenadas provada.
- **F4:** três modos de input (a11y/visão/híbrido) + estudo a11y-hostil.
- **F5:** verificador e refine medidos; regra de "ganho por US$".
- **F6:** planner+grounder e roteamento com custo; protocolo JSON versionado.
- **F7:** modo `sequence` com retenção e custo de memória.
- **F8:** cenários adversariais + relatório de segurança.
- **F9:** governança/provenance/rotação + `--check-drift`.
- **F10:** leaderboard, `vision techniques`, SPA e MCP.
- **F11:** ≥ 20 cenários reais com revisão humana.

## 11. Referências (as que sustentam as decisões acima)

Números vêm do material de pesquisa de out/2026 e são de **outros benchmarks**
(ScreenSpot v2/Pro, OSWorld, AITW, GUI-Odyssey). Servem para priorizar, não
como promessa de ganho no nosso dataset.

1. Mark-Grid — <https://arxiv.org/html/2509.11548> (grade 8×8 em 2 rodadas;
   Gemini-3.1-Pro 11,72% → 95,20% no ScreenSpot-v2; ~4× latência).
2. Anthropic, computer/browser use — <https://claude.com/blog/best-practices-for-computer-and-browser-use-with-claude>
   (resolução/reescala como maior impacto; grade e tiling sem ganho; 3
   screenshots recentes; texto antes da imagem; zoom nativo).
3. UI-Zoomer — <https://arxiv.org/pdf/2604.14113> (zoom só sob incerteza;
   incondicional piora ScreenSpot-v2).
4. OSWorld (NeurIPS 2024) — screenshot 5,26% → +a11y 12,17% (GPT-4V).
5. D-GARA — <https://arxiv.org/html/2511.16590> (screenshot+XML 80,26% vs
   45,33%).
6. UFO² — <https://www.alphaxiv.org/abs/2504.14603> (UIA + OmniParser; +9,9
   p.p. em >20 apps Windows; execução especulativa −51% chamadas).
7. OmniParser V2 — <https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/>
   (GPT-4o 0,8% → 39,6% no ScreenSpot-Pro; piso de detector).
8. GUI-Lens — <https://arxiv.org/html/2608.03270> (coordinate priming +
   recorte + verificação; Opus 4.7 57,4% → 82,3% no SS-Pro).
9. See-Point-Refine — <https://www.themoonlight.io/zh/review/see-point-refine-multi-turn-approach-to-gui-grounding-with-visual-feedback>
   (cruz vermelha; GPT-5.4 20,62% → 38,13%).
10. Mobile-Agent-v3/v3.5 — <https://arxiv.org/html/2508.15144v2> (Manager/
    Worker/Reflector/Notetaker; CoT unificado importa).
11. MementoGUI — <https://arxiv.org/html/2605.18652v1> (memória multimodal
    seletiva; 54,58 → 68,32 AMS).
12. Less is More — <https://arxiv.org/html/2507.03730> (descartar imagens
    históricas custa −1,7/−3,1 p.p.).
13. Agent S3 / bBoN — <https://arxiv.org/pdf/2510.02250> (62,6% → 69,9% com
    best-of-10; alerta de inflação de ranking).
14. UI-TARS — <https://arxiv.org/html/2501.12326v1> (0–1000; histórico de 5
    imagens; state transition captioning).
15. Agent Workflow Memory — <https://arxiv.org/abs/2409.07429> (+51,1% rel.
    no WebArena).
16. Pop-ups adversariais — <https://arxiv.org/abs/2411.02391> (clique em
    pop-up em 86% das vezes; defesas básicas ineficazes).
17. ScreenSpot-Pro — <https://iclr.cc/virtual/2025/32743> (referência de
    grounding profissional; 48,1% sem treino na época).
18. AgentAtlas — <https://arxiv.org/html/2605.20530v1> (best-of-N e retries
    inflam leaderboards).

> Nota metodológica: os números acima são de **clique isolado** em benchmarks
> públicos. O nosso modo `map` mede enumeração de clicáveis (F1 de região e
> rótulo) e o `action` mede intenção + posição; a comparação com aqueles
> placares é qualitativa.
