# Benchmark de visão — `vision-mvjhpg8h-a097fb59`

- **dataset**: `vision-dataset@0.2.0` (hash `sha256:8d0de4203…`) · 7 cenário(s)
- **modos**: map · **coordenadas pedidas**: pixels 0–1920/0–1080
- **modelos**: 3 · **células**: 84 · **chamadas HTTP**: 84 (erros 0, puladas 0)
- **custo medido**: $0.0870 · **status**: finished
- **prompt**: vision-prompt@1 · **banco**: resolution · **provedor fixado**: DeepInfra · **início**: 2026-10-22T12:01:00.786Z · **fim**: 2026-10-22T12:03:06.491Z

## Placar

Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).

Nesta rodada, a **nota é a média entre variantes**; a coluna “mapa F1”/“ação pass” acima é a micro-média global.

| # | modelo | nota | mapa F1 | rótulo F1 | ação pass | erro | custo | tokens in/out | latência |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `z-ai/glm-5.3-flash` | **76.2%** | 76.5% | 51.6% | — | 0 | $0.0179 | 48622/22768 | 10.3 s |
| 2 | `xiaomi/mimo-v2.6-pro` | **60.4%** | 61.2% | 43.6% | — | 0 | $0.0506 | 40950/62391 | 55.5 s |
| 3 | `deepseek/deepseek-v4.1-flash-1017` | **54.7%** | 56.4% | 38.0% | — | 0 | $0.0186 | 29540/62013 | 31.1 s |

## Resolução — a mesma tela em outras escalas

Coordenadas foram convertidas de volta para 1920×1080 antes de pontuar; a imagem enviada está em `cell.imageViewport`.

| variante | `z-ai/glm-5.3-flash` | `xiaomi/mimo-v2.6-pro` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| 1920x1080 | 92.2% (P 88.4% · R 96.4%) | 82.4% (P 88.4% · R 77.2%) | 69.0% (P 74.3% · R 64.5%) |
| 1280x720 | 88.7% (P 87.6% · R 89.8%) | 62.9% (P 83.9% · R 50.3%) | 73.1% (P 77.7% · R 69.0%) |
| 960x540 | 71.6% (P 69.2% · R 74.1%) | 62.2% (P 83.1% · R 49.7%) | 60.0% (P 57.4% · R 62.9%) |
| 640x360 | 52.3% (P 53.4% · R 51.3%) | 34.1% (P 45.0% · R 27.4%) | 16.7% (P 22.8% · R 13.2%) |
| **retenção vs 1080p** | 720p 96.2% · 540p 77.6% · 360p 56.7% | 720p 76.3% · 540p 75.5% · 360p 41.4% | 720p 105.9% · 540p 87.0% · 360p 24.2% |

## Modo mapa — todos os elementos interativos

### Por tipo de elemento — `z-ai/glm-5.3-flash`

| tipo | elementos | vistos | recall |
|---|---:|---:|---:|
| button | 352 | 264 | 75.0% |
| link | 132 | 108 | 81.8% |
| input | 80 | 70 | 87.5% |
| menuitem | 64 | 53 | 82.8% |
| tab | 56 | 53 | 94.6% |
| checkbox | 52 | 30 | 57.7% |
| select | 28 | 24 | 85.7% |
| radio | 12 | 6 | 50.0% |
| switch | 8 | 4 | 50.0% |
| slider | 4 | 2 | 50.0% |

## Metodologia

- A verdade de cada cenário vem do DOM renderizado: caixa de cada controle interativo em pixels de uma imagem 1920×1080 (não é anotação humana).
- **Mapa**: uma previsão casa com um elemento quando o ponto cai DENTRO da caixa. O casamento é um-para-um, guloso, por qualidade (rótulo > tipo > proximidade do centro). Precisão = casados/previsões; recall = casados/elementos; F1 harmônico. Rótulo normaliza acento/caixa e aceita contenção e aliases; tipo compara o vocabulário fechado.
- **Ação**: a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto digitado confere (quando há texto).
- Erro de chamada conta como resposta errada no denominador; célula pulada por orçamento/cancelamento fica FORA das métricas (o status da run diz que o placar é parcial).
- **Resolução**: a imagem enviada é um downscale da tela canônica (sem reflow). O prompt declara o viewport enviado; o parser converte o ponto para a grade da variante e o runner reescala para 1920×1080 ANTES de pontuar. `imageViewport` fica no record.
