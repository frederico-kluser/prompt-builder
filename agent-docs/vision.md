# Modo visão — o que é clicável nesta tela?

O benchmark de visão mede **UI grounding**: o modelo recebe uma captura de tela
1920×1080 e precisa dizer **onde estão os controles** — e, no segundo modo, **o
que clicar** para cumprir um pedido. Diferente dos modos de chat, aqui não há
juiz LLM: a verdade é o DOM do cenário (caixa de cada botão/input/campo), então
o placar é determinístico e barato de auditar.

O dataset é **versionado e cresce por commit** — imagens + caixas + o código HTML
que as gerou viajam em `src/data/vision/` e são pinados por sha256. Não existe
"prova criada na hora": o record aponta a versão e o hash do dataset usado.

## Dois modos, um dataset

- **map** — o modelo recebe só a imagem e devolve **todos** os elementos
  interativos visíveis, no formato
  `{"type":"button","label":"Entrar","iconDescription":null,"x":100,"y":300}`.
- **action** — o modelo recebe a imagem **e um pedido em linguagem natural**
  ("Clique em Novo curso") e devolve a ação + a posição do alvo:
  `{"action":"click","target":"Novo curso","x":100,"y":300,"text":null}`.

`x`/`y` são o **centro** do controle. O espaço de coordenadas é escolhido por
run: `--coord-space pixels` (padrão, 0–1920/0–1080) ou `normalized` (0–1000, a
convenção de UI-TARS/Gemini, melhor para modelos com grounding nativo). O
parser converte o que vier (inclusive `bbox` e `%`) e registra na célula o
espaço detectado.

## Bancos de prova (variantes medidas)

O F0 é a **imagem crua**. Dois bancos experimentais usam a MESMA verdade do DOM e
mudam **uma** variável por célula — o record guarda o banco e a variante:

- **`resolution`** — a mesma tela reduzida para 1280×720, 960×540 e 640×360
  (além do 1080p nativo). O prompt declara o tamanho da imagem enviada e as
  coordenadas voltam para 1920×1080 antes de pontuar. Mede **robustez à escala**,
  não reflow (a imagem é um downscale, o layout não muda).
- **`grid`** — o mesmo pedido de ação com quatro apresentações:
  `plain` (controle), `grid-simple` (grade 9×9 sem rótulos — controle negativo),
  `axis-grid` (réguas de x/y) e `mark-grid` (grade 6×4 com células A1..F4).
  No `mark-grid`, a rodada 1 escolhe a célula e a rodada 2 recebe um **recorte
  ampliado** dela (640×540); a ação/alvo/texto vêm da rodada 1 e a rodada 2 só
  refina o ponto. Custo: 2 chamadas por célula.

**Fixe o provedor** (`--provider DeepInfra`) ao comparar modelos: sem pin, o
OpenRouter pode trocar de provedor entre células (ou cair num provedor que
ignora a imagem) e o número passa a medir o roteamento. O record grava
`config.provider`; o relatório mostra a variante e a retenção/delta.

## Comandos

```bash
# 1) o que existe no dataset (offline, sem key)
prompt-builder vision dataset list
prompt-builder vision dataset show bootstrap-login
prompt-builder vision dataset verify           # sha256 de cada imagem

# 2) pré-voo da run: quantas chamadas, quais cenários, quanto custa no teto
prompt-builder vision run --models google/gemini-3.8-flash \
  --tasks map,action --limit 4 --budget 2 --dry-run

# 3) a run de verdade (texto antes da imagem, temperatura 0)
prompt-builder vision run --models google/gemini-3.8-flash,anthropic/claude-opus-5.5 \
  --tasks map,action --families bootstrap,macos --budget 2

# 4) bancos novos (sempre com provedor fixado)
prompt-builder vision run --models a,b --benchmark resolution \
  --provider DeepInfra --budget 2
prompt-builder vision run --models a,b --benchmark grid \
  --provider DeepInfra --grid-variants plain,mark-grid --budget 2
prompt-builder vision run --models a,b --benchmark grid --grid-variants mark-grid \
  --scenes bootstrap-login --budget 0.2 --dry-run

# 5) resultado
prompt-builder vision list
prompt-builder vision show <id>
prompt-builder vision report <id> --html vision-<id>.html
```

Sem `--budget` fora de um terminal, a run **recusa** (exit 2, nada foi gasto):
`--budget 2` dá teto; `--budget none` assume o custo. `--dry-run` usa a MESMA
sequência de recusas da execução real.

Flags da run:

| flag | efeito |
|---|---|
| `--models a,b` | obrigatório; ids do OpenRouter (o catálogo precisa declarar entrada `image`) |
| `--tasks map,action` | modos a rodar (padrão: os dois; `resolution` força map e `grid` força action) |
| `--benchmark grounding\|resolution\|grid` | banco de prova (padrão: grounding/F0) |
| `--provider <nome>` | fixa o provedor OpenRouter (`auditable`; sem fallback) |
| `--resolutions 1920x1080,…` | escalas do banco `resolution` (padrão: todas do dataset) |
| `--grid-variants plain,…` | variantes do banco `grid` (padrão: todas) |
| `--families bootstrap,react95,fluent,material,macos` | filtra famílias |
| `--scenes id1,id2` | filtra cenários por id |
| `--limit N` | corta o dataset (ordem do manifesto) |
| `--coord-space pixels\|normalized` | espaço pedido no prompt |
| `--temperature 0` · `--max-tokens 4096` · `--reasoning <nível>` | amostragem |
| `--timeout <ms>` · `--retries N` | transporte (erros de rede do chamador) |
| `--dry-run` · `--allow-concurrent` | pré-voo / réplica intencional |

## Como o placar é calculado

Tudo sai do record, sem recálculo em outra superfície.

- **map** — cada previsão casa com **no máximo um** elemento, e cada elemento
  com no máximo uma previsão. O casamento é guloso por qualidade (rótulo > tipo
  > distância ao centro) entre os pontos que caem **dentro** da caixa.
  - `precisão` = casados / previsões (alucinação e duplicata derrubam);
  - `recall` = casados / elementos (controle não visto derruba);
  - `F1` = harmônico dos dois; `rótulo F1` exige o nome reconhecido;
  - `typeAccuracy` entre os casados; `recall` por tipo de elemento.
- **action** — a tarefa passa quando a ação declarada é a esperada **e** o ponto
  cai na caixa do alvo (quando há alvo) **e** o texto confere (quando há texto).
  `scroll`/`key` não têm alvo e não pontuam posição.
- **nota** = média das notas disponíveis (map: F1; action: taxa de acerto). Rodar
  só um modo dá a nota daquele modo — o relatório diz qual. Nos bancos de probe,
  a nota é a **média entre variantes** e o relatório mostra a tabela por variante
  (além da retenção vs 1080p e do delta vs `plain`).
- Erro de chamada conta como resposta errada; célula pulada por
  orçamento/cancelamento fica **fora** das métricas e a run sai `aborted`
  (exit 7 por orçamento, 130 por cancelamento).

Nomes são comparados sem acento/caixa, com contenção ("Enviar formulário" casa
com "Enviar") e **aliases** declarados no cenário (ex.: "pesquisar" para a lupa).
Coordenadas: ponto dentro da caixa é o critério — não há tolerância de raio.

## O que o dataset contém

`src/data/vision/dataset@1.json` lista cada cenário com:

- `image` — PNG 1080p + `sha256` + tamanho (conferido por `vision dataset verify`);
- `code` — o HTML do cenário (o mesmo que gerou a imagem);
- `elements[]` — id estável (`login-entrar`), tipo fechado, rótulo, descrição de
  ícone, aliases, caixa em pixels e centro;
- `tasks[]` — pedidos do modo ação (`instruction`, ação esperada, alvo, texto);
- `probes.resolutions[]` — PNGs reduzidos + largura/altura + sha256 (o 1080p
  nativo reusa a imagem base);
- `probes.overlays[]` — grades pinadas (`grid-simple`, `axis-grid`, `mark-grid`)
  e, no mark-grid, os 24 recortes ampliados com a caixa canônica de origem.

As famílias atuais usam frameworks reais: **Bootstrap 5.3.3**, **React95**,
**Fluent UI**, **Material 3** e um desktop **macOS** em CSS próprio. Cada
cenário é renderizado por um Chromium e a verdade sai de `getBoundingClientRect`
— nenhuma caixa é anotada à mão.

## Na SPA (`/vision`)

A mesma medição roda na aba (o dataset é copiado para `web/public/vision/` pelo
`scripts/vision-web-assets.mjs`, que o `web:build`/`web:dev` chama):

- **Setup**: escolha quantos cenários puxar do banco (3/5/10/Todos + número),
  as famílias, os modos (mapa/ação), os modelos e o **teto** (obrigatório).
  A estimativa é pelo teto (imagem ≈1.800 tokens + `max-tokens`).
- **Durante a run**: cartões por cenário com chamadas concluídas; passar o
  mouse (ou focar) mostra a **tela do teste** com a verdade do DOM. Cancelar
  aborta; o que terminou é salvo.
- **Resultado** (`/vision/runs/:id`): vencedor, matriz cenário × modelo e, ao
  passar o mouse/focar uma célula, o **mapa de calor daquele modelo**: halo
  verde/vermelho nas previsões, caixas dos controles não vistos e alvos das
  ações. "Só a verdade" esconde as previsões. "Ampliar" abre a imagem grande.
- Persistência: IndexedDB v4 (`visionRuns`, `visionSummaries`); gravar nunca
  rejeita — falha de cota vira aviso. Nada de backend: a SPA é estática.
- Sem chave a rota cai no gate normal; a run exige teto (regra da SPA com LLM).

## Exit codes

`0` ok · `2` uso · `3` dataset/config inválidos (inclui modelo sem entrada de
imagem) · `4` key ausente · `7` parcial por orçamento · `8` catálogo indisponível
· `130` interrompido.

## Limites desta versão (e o que vem depois)

- O **F0** continua sendo imagem crua × coordenada. Os bancos `resolution` e
  `grid` já medem escala e overlays; Set-of-Mark por âncora, árvore de
  acessibilidade, zoom condicional e **verificação multi-turno** ainda são
  roadmap (`ROADMAP-VISAO.md`).
- O banco `grid` é CLI-first: a SPA `/vision` ainda só roda o F0 (as variantes
  ainda não são copiadas para `web/public/vision/`).
- O `mark-grid` é uma implementação de 2 rodadas (célula → recorte ampliado);
  o placar usa ação/alvo/texto da rodada 1 e o ponto da rodada 2, de propósito:
  mede localização, não "o modelo reescreve a ação sob zoom".
- O dataset é sintético (cinco famílias, PT-BR). Isso mede grounding, não
  operação de um app real; e não compara diretamente com ScreenSpot/OSWorld.
- Imagens de 1080p custam ~1.800 tokens de entrada por chamada — uma run de 20
  cenários × 2 modos × 2 modelos ≈ 120 chamadas. Use `--dry-run` e `--limit`.

## Terceiro banco (proposto)

**Ação executada (closed-loop).** Em vez de comparar o ponto com a caixa,
executar a previsão num Chromium e ler o efeito no DOM (`value`, `checked`,
`navigation`, `domAppears`). Zero chamadas extras de LLM; reload entre tarefas;
métricas `effectRate`, `actionOk`, `pointInBox` e `effectOk`. A especificação
completa (formato do `effect`, reset, casos de borda e aceite) está em
`ROADMAP-VISAO.md` (F12). **Ainda não implementado.**

## Para quem mantém o dataset

```bash
npm run vision:build            # regenera HTML, PNGs e o manifesto
npm run cli -- vision dataset verify
```

Adicionar um cenário = escrever o HTML com `data-vision-id` em TODO controle
interativo (o build FALHA se algum ficar sem), as tarefas, e commitar o
manifesto + imagem. O build precisa de um Chromium (`npx playwright install
chromium` ou `VISION_CHROME=<executável>`); a run normal NÃO precisa.
