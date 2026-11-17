# Benchmark de visão — `vision-mvjf79fb-36cbd99e`

- **dataset**: `vision-dataset@0.1.0` (hash `sha256:0afe12079…`) · 7 cenário(s)
- **modos**: map + action · **coordenadas pedidas**: pixels 0–1920/0–1080
- **modelos**: 3 · **células**: 111 (erros 1, puladas 0)
- **custo medido**: $0.0785 · **status**: finished
- **prompt**: vision-prompt@1 · **início**: 2026-10-22T10:50:52.920Z · **fim**: 2026-10-22T10:52:23.176Z

## Placar

Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).

| # | modelo | nota | mapa F1 | rótulo F1 | ação pass | erro | custo | tokens in/out | latência |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `xiaomi/mimo-v2.6-pro` | **78.1%** | 82.8% | 62.7% | 73.3% | 1 | $0.0527 | 92424/16961 | 11.4 s |
| 2 | `deepseek/deepseek-v4.1-flash-1017` | **66.1%** | 72.3% | 53.3% | 60.0% | 0 | $0.0133 | 52706/14809 | 4.2 s |
| 3 | `z-ai/glm-5.3-flash` | **42.3%** | 51.3% | 38.3% | 33.3% | 3 | $0.0126 | 74156/15447 | 5.5 s |

## Modo mapa — todos os elementos interativos

### Por família

| família | `xiaomi/mimo-v2.6-pro` | `deepseek/deepseek-v4.1-flash-1017` | `z-ai/glm-5.3-flash` |
|---|---:|---:|---:|
| Bootstrap | 100.0% (2) | 85.0% (2) | 100.0% (2) |
| Fluent UI | 90.7% (1) | 72.9% (1) | — |
| macOS | 99.3% (2) | 93.4% (2) | 50.0% (2) |
| Material 3 | 89.4% (1) | 89.4% (1) | 89.4% (1) |
| React95 | 0.0% (1) | 0.0% (1) | 0.0% (1) |

### Por tipo de elemento — `xiaomi/mimo-v2.6-pro`

| tipo | elementos | vistos | recall |
|---|---:|---:|---:|
| button | 88 | 64 | 72.7% |
| link | 33 | 24 | 72.7% |
| input | 20 | 17 | 85.0% |
| menuitem | 16 | 7 | 43.8% |
| tab | 14 | 14 | 100.0% |
| checkbox | 13 | 13 | 100.0% |
| select | 7 | 7 | 100.0% |
| radio | 3 | 3 | 100.0% |
| switch | 2 | 2 | 100.0% |
| slider | 1 | 1 | 100.0% |

## Modo ação — o que clicar

| família | `xiaomi/mimo-v2.6-pro` | `deepseek/deepseek-v4.1-flash-1017` | `z-ai/glm-5.3-flash` |
|---|---:|---:|---:|
| Bootstrap | 100.0% (8) | 87.5% (8) | 25.0% (8) |
| Fluent UI | 20.0% (5) | 0.0% (5) | 20.0% (5) |
| macOS | 87.5% (8) | 75.0% (8) | 25.0% (8) |
| Material 3 | 40.0% (5) | 40.0% (5) | 20.0% (5) |
| React95 | 100.0% (4) | 75.0% (4) | 100.0% (4) |

| ação | `xiaomi/mimo-v2.6-pro` | `deepseek/deepseek-v4.1-flash-1017` | `z-ai/glm-5.3-flash` |
|---|---:|---:|---:|
| click | 72.0% (25) | 60.0% (25) | 36.0% (25) |
| select | 66.7% (3) | 33.3% (3) | 33.3% (3) |
| type | 100.0% (2) | 100.0% (2) | 0.0% (2) |

## Células com problema

| célula | modelo | status | motivo |
|---|---|---|---|
| `map:react95-painel` | `xiaomi/mimo-v2.6-pro` | ok | saída não parseável |
| `map:react95-painel` | `z-ai/glm-5.3-flash` | ok | saída não parseável |
| `map:fluent-painel` | `z-ai/glm-5.3-flash` | error | terminated |
| `map:macos-finder` | `z-ai/glm-5.3-flash` | ok | saída não parseável |

## Metodologia

- A verdade de cada cenário vem do DOM renderizado: caixa de cada controle interativo em pixels de uma imagem 1920×1080 (não é anotação humana).
- **Mapa**: uma previsão casa com um elemento quando o ponto cai DENTRO da caixa. O casamento é um-para-um, guloso, por qualidade (rótulo > tipo > proximidade do centro). Precisão = casados/previsões; recall = casados/elementos; F1 harmônico. Rótulo normaliza acento/caixa e aceita contenção e aliases; tipo compara o vocabulário fechado.
- **Ação**: a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto digitado confere (quando há texto).
- Erro de chamada conta como resposta errada no denominador; célula pulada por orçamento/cancelamento fica FORA das métricas (o status da run diz que o placar é parcial).
- Coordenada fora do espaço pedido é convertida pelo parser (0–1000 ↔ pixels) e registrada na célula (`coordScale`); nenhuma técnica de grade/zoom/SoM é aplicada nesta versão.
