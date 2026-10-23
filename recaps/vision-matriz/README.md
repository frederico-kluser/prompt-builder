# Matriz resolução × grade — qual combinação funciona melhor?

Rodada real em **22/10/2026**, dataset `vision-dataset@0.3.0` (hash
`sha256:debb7a1fa…`), 7 cenários · 30 tarefas de ação, provedor fixado em
**DeepInfra** (`auditable`, sem fallback). **1440 chamadas** · **$0,6455** ·
zero erros de transporte.

O que foi cruzado:

- **Resoluções:** 1920×1080, 1280×720, 960×540, 640×360 (downscale da mesma tela);
- **Grades sem cobrir o print:** `plain` (controle), `frame-axis` (réguas nas
  margens), `frame-mark` (letras/números nas margens) e `sidecar-grid` (grade
  numa segunda imagem; a captura vai limpa);
- **Modelos:** DeepSeek V4.1 Flash, MiMo V2.6-Pro e GLM 5.3 Flash.

O ponto previsto é remapeado para 1920×1080 antes de pontuar. Nas molduras, o
prompt pede coordenadas **da área da captura** (0..w, 0..h); as margens são só
referência. No sidecar, o ponto é pedido na **primeira** imagem (a captura).

## Placar por combinação

| combinação | MiMo V2.6-Pro | GLM 5.3 Flash | DeepSeek V4.1 | média | custo total |
|---|---:|---:|---:|---:|---:|
| 1920×1080 + plain | 70,0% | **73,3%** | **70,0%** | **71,1%** | $0,0442 |
| 1920×1080 + sidecar-grid | **73,3%** | 70,0% | 66,7% | 70,0% | $0,0847 |
| 1280×720 + plain | **73,3%** | **73,3%** | 60,0% | 68,9% | $0,0251 |
| 1280×720 + sidecar-grid | **73,3%** | 70,0% | 60,0% | 67,8% | $0,0432 |
| 960×540 + sidecar-grid | 70,0% | 56,7% | 50,0% | 58,9% | $0,0294 |
| 960×540 + frame-mark | 66,7% | 66,7% | 40,0% | 57,8% | $0,0301 |
| 960×540 + plain | 70,0% | 60,0% | 40,0% | 56,7% | $0,0180 |
| 1280×720 + frame-mark | 63,3% | 56,7% | 46,7% | 55,6% | $0,0363 |
| 960×540 + frame-axis | 66,7% | 46,7% | 53,3% | 55,6% | $0,0366 |
| 1280×720 + frame-axis | **73,3%** | 16,7% | 66,7% | 52,2% | $0,0441 |
| 1920×1080 + frame-mark | **73,3%** | 60,0% | 13,3% | 48,9% | $0,0629 |
| 1920×1080 + frame-axis | **73,3%** | 30,0% | 10,0% | 37,8% | $0,0724 |
| 640×360 + sidecar-grid | 36,7% | 46,7% | 23,3% | 35,6% | $0,0257 |
| 640×360 + plain | 33,3% | 43,3% | 16,7% | 31,1% | $0,0195 |
| 640×360 + frame-mark | 36,7% | 36,7% | 13,3% | 28,9% | $0,0323 |
| 640×360 + frame-axis | 33,3% | 20,0% | 6,7% | 20,0% | $0,0412 |

## Efeitos principais

| resolução | média nas 4 grades × 3 modelos |
|---|---:|
| 1280×720 | **61,1%** |
| 960×540 | 57,2% |
| 1920×1080 | 56,9% |
| 640×360 | 28,9% |

| grade | média nas 4 resoluções × 3 modelos |
|---|---:|
| sidecar-grid | **58,1%** |
| plain | 56,9% |
| frame-mark | 47,8% |
| frame-axis | 41,4% |

## Qual escolher

1. **Qualidade máxima:** `1920×1080 + plain` — **71,1%** de média, o melhor
   placar geral e o mais consistente entre os três modelos (70,0 / 73,3 / 70,0).
   O sidecar chega a 70,0% (uma tarefa de diferença): na prática é **empate
   técnico**, não uma vantagem estatística.
2. **Se a grade for obrigatória:** `1920×1080 + sidecar-grid` — **70,0%**,
   praticamente o controle, mas quase **2× o custo** ($0,0847 vs $0,0442) por
   mandar duas imagens.
3. **Melhor custo/qualidade:** `1280×720 + plain` — **68,9%** por **$0,0251**
   (43% mais barato que 1080p, 2,2 p.p. abaixo). Se precisar de grade nessa
   escala, `1280×720 + sidecar-grid` dá 67,8%.
4. **Moldura não compensa.** `frame-axis` é a pior grade na média (41,4%) e
   `frame-mark` (47,8%) fica abaixo do controle. No 1080p a moldura cresce para
   2070×1177 e parece sofrer um resize extra do provedor; no 1280×720 o efeito
   muda de modelo para modelo (MiMo empata, DeepSeek sobe, GLM desaba). Não há
   ganho generalizável.
5. **640×360 não serve para clique preciso** (20–36%). O sidecar ainda ajuda
   nessa escala (+4,5 p.p. sobre o plain), mas o absoluto é baixo.

## O que isso significa para o produto

- O **gerador** e o tutorial estão em [`recaps/vision-gerador/`](../vision-gerador/README.md):
  ele produz resoluções + molduras/sidecar sem desenhar em cima do print e baixa
  um ZIP com `manifest.json` + `INSTRUCOES.md`.
- O benchmark agora tem `--benchmark matrix` para cruzar
  `--resolutions` × `--matrix-grids`.
- A melhor instrução para usuário é: **não use grade em cima do print**;
  prefira a captura limpa. Se precisar de referência, use o sidecar; moldura só
  se você puder testar no seu modelo/provedor.
- Sempre fixe o provedor (`--provider`) e recalcule o ponto pela escala; o
  record guarda `resolution`, `grid`, `margins` e `imageViewport`.

## Arquivos

- [`report.md`](./report.md) · [`report.html`](./report.html) · [`record.json`](./record.json)
- [`telas/`](./telas/) — plain/frame-axis/frame-mark/sidecar em 1280×720 e 640×360
- [`../vision-gerador/index.html`](../vision-gerador/index.html) — gerador
- [`../vision-gerador/INSTRUCOES.md`](../vision-gerador/INSTRUCOES.md) — tutorial
- [`../vision-gerador/gerador-de-variantes.zip`](../vision-gerador/gerador-de-variantes.zip) — pacote para baixar

## Limites

- 30 tarefas, 7 cenários, **uma rodada por combinação**; sem IC. Cada tarefa
  vale 3,3 p.p., então diferenças de 1–2 tarefas não separam combinações.
- Um provedor (DeepInfra); os rankings podem mudar com outro.
- A moldura usa a convenção “coordenadas da área da captura”; se você mudar a
  convenção, a conta de volta muda (o tutorial mostra as duas).
- `frame-axis` no 1080p tem 2070×1177; se o provedor redimensiona a imagem, o
  ponto pode deslocar. Isso é parte do custo da moldura, não um bug do parser.
