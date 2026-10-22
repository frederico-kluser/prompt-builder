# Benchmark de visão — `vision-mvjlu4j4-8625c52b`

- **dataset**: `vision-dataset@0.3.0` (hash `sha256:debb7a1fa…`) · 7 cenário(s)
- **modos**: action · **coordenadas pedidas**: pixels 0–1920/0–1080
- **modelos**: 3 · **células**: 1440 · **chamadas HTTP**: 1440 (erros 0, puladas 0)
- **custo medido**: $0.6455 · **status**: finished
- **prompt**: vision-matrix-prompt@1 · **banco**: matrix · **provedor fixado**: DeepInfra · **início**: 2026-10-22T13:56:37.360Z · **fim**: 2026-10-22T14:01:43.012Z

## Placar

Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).

Nesta rodada, a **nota é a média entre variantes**; a coluna “mapa F1”/“ação pass” acima é a micro-média global.

| # | modelo | nota | mapa F1 | rótulo F1 | ação pass | erro | custo | tokens in/out | latência |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `xiaomi/mimo-v2.6-pro` | **61.7%** | — | — | 61.7% | 0 | $0.3599 | 851426/147078 | 7.8 s |
| 2 | `z-ai/glm-5.3-flash` | **51.7%** | — | — | 51.7% | 0 | $0.1677 | 1036944/24328 | 1.9 s |
| 3 | `deepseek/deepseek-v4.1-flash-1017` | **39.8%** | — | — | 39.8% | 2 | $0.1179 | 576254/295036 | 8.8 s |

## Matriz — resolução × grade (sem grade em cima do print)

Cada célula combina uma resolução com uma grade sem overlay: `plain` (sem grade), `frame-axis` (réguas nas margens), `frame-mark` (letras/números nas margens) ou `sidecar-grid` (grade em imagem separada). O print nunca recebe grade. O ponto é remapeado para 1920×1080 antes de pontuar.

| variante | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| 1920x1080+plain | 70.0% (21/30) | 73.3% (22/30) | 70.0% (21/30) |
| 1920x1080+frame-axis | 73.3% (22/30) | 30.0% (9/30) | 10.0% (3/30) |
| 1920x1080+frame-mark | 73.3% (22/30) | 60.0% (18/30) | 13.3% (4/30) |
| 1920x1080+sidecar-grid | 73.3% (22/30) | 70.0% (21/30) | 66.7% (20/30) |
| 1280x720+plain | 73.3% (22/30) | 73.3% (22/30) | 60.0% (18/30) |
| 1280x720+frame-axis | 73.3% (22/30) | 16.7% (5/30) | 66.7% (20/30) |
| 1280x720+frame-mark | 63.3% (19/30) | 56.7% (17/30) | 46.7% (14/30) |
| 1280x720+sidecar-grid | 73.3% (22/30) | 70.0% (21/30) | 60.0% (18/30) |
| 960x540+plain | 70.0% (21/30) | 60.0% (18/30) | 40.0% (12/30) |
| 960x540+frame-axis | 66.7% (20/30) | 46.7% (14/30) | 53.3% (16/30) |
| 960x540+frame-mark | 66.7% (20/30) | 66.7% (20/30) | 40.0% (12/30) |
| 960x540+sidecar-grid | 70.0% (21/30) | 56.7% (17/30) | 50.0% (15/30) |
| 640x360+plain | 33.3% (10/30) | 43.3% (13/30) | 16.7% (5/30) |
| 640x360+frame-axis | 33.3% (10/30) | 20.0% (6/30) | 6.7% (2/30) |
| 640x360+frame-mark | 36.7% (11/30) | 36.7% (11/30) | 13.3% (4/30) |
| 640x360+sidecar-grid | 36.7% (11/30) | 46.7% (14/30) | 23.3% (7/30) |
| **melhor combinação** | 1920x1080+frame-axis (73.3%) | 1920x1080+plain (73.3%) | 1920x1080+plain (70.0%) |

## Modo ação — o que clicar

| família | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| Bootstrap | 89.8% (128) | 74.2% (128) | 60.9% (128) |
| Fluent UI | 15.0% (80) | 11.3% (80) | 10.0% (80) |
| macOS | 76.6% (128) | 66.4% (128) | 48.4% (128) |
| Material 3 | 28.7% (80) | 31.3% (80) | 25.0% (80) |
| React95 | 75.0% (64) | 53.1% (64) | 35.9% (64) |

| ação | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| click | 59.5% (400) | 51.0% (400) | 38.3% (400) |
| select | 56.3% (48) | 37.5% (48) | 33.3% (48) |
| type | 96.9% (32) | 81.3% (32) | 68.8% (32) |

## Células com problema

| célula | modelo | status | motivo |
|---|---|---|---|
| `action:react95-painel-a1@1280x720+sidecar-grid` | `deepseek/deepseek-v4.1-flash-1017` | ok | saída não parseável |
| `action:fluent-painel-a1@960x540+sidecar-grid` | `deepseek/deepseek-v4.1-flash-1017` | ok | saída não parseável |

## Metodologia

- A verdade de cada cenário vem do DOM renderizado: caixa de cada controle interativo em pixels de uma imagem 1920×1080 (não é anotação humana).
- **Mapa**: uma previsão casa com um elemento quando o ponto cai DENTRO da caixa. O casamento é um-para-um, guloso, por qualidade (rótulo > tipo > proximidade do centro). Precisão = casados/previsões; recall = casados/elementos; F1 harmônico. Rótulo normaliza acento/caixa e aceita contenção e aliases; tipo compara o vocabulário fechado.
- **Ação**: a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto digitado confere (quando há texto).
- Erro de chamada conta como resposta errada no denominador; célula pulada por orçamento/cancelamento fica FORA das métricas (o status da run diz que o placar é parcial).
- **Matriz**: o print é reduzido para a resolução da célula e recebe uma grade SEM overlay. `frame-*` acrescenta margens com réguas/letras e pede o ponto na ÁREA DA CAPTURA (as margens não entram na conta); `sidecar-grid` manda a captura limpa + uma imagem separada de grade. O ponto final é reescalado para 1920×1080 antes de pontuar.
