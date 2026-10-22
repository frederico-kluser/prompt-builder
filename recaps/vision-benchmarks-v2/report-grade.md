# Benchmark de visão — `vision-mvjhv60e-2a930f47`

- **dataset**: `vision-dataset@0.2.0` (hash `sha256:8d0de4203…`) · 7 cenário(s)
- **modos**: action · **coordenadas pedidas**: pixels 0–1920/0–1080
- **modelos**: 3 · **células**: 360 · **chamadas HTTP**: 449 (erros 0, puladas 0)
- **custo medido**: $0.0954 · **status**: finished
- **prompt**: vision-grid-prompt@1 · **banco**: grid · **provedor fixado**: DeepInfra · **início**: 2026-10-22T12:05:27.470Z · **fim**: 2026-10-22T12:07:04.759Z

## Placar

Nota = média das notas disponíveis (mapa: F1 de região; ação: taxa de acerto).

Nesta rodada, a **nota é a média entre variantes**; a coluna “mapa F1”/“ação pass” acima é a micro-média global.

| # | modelo | nota | mapa F1 | rótulo F1 | ação pass | erro | custo | tokens in/out | latência |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `xiaomi/mimo-v2.6-pro` | **70.8%** | — | — | 70.8% | 0 | $0.0268 | 329774/22874 | 9.8 s |
| 2 | `z-ai/glm-5.3-flash` | **66.7%** | — | — | 66.7% | 0 | $0.0553 | 406819/4952 | 2.0 s |
| 3 | `deepseek/deepseek-v4.1-flash-1017` | **60.8%** | — | — | 60.8% | 0 | $0.0133 | 196829/19776 | 3.8 s |

## Grade — controle × técnicas

Todas as variantes usam a MESMA verdade e o MESMO pedido; `plain` é o controle. `mark-grid` pode ter 2 rodadas (recorte + ampliação).

| variante | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| axis-grid | 73.3% (22/30) | 66.7% (20/30) | 63.3% (19/30) |
| grid-simple | 70.0% (21/30) | 73.3% (22/30) | 63.3% (19/30) |
| mark-grid | 70.0% (21/30) | 53.3% (16/30) | 56.7% (17/30) |
| plain | 70.0% (21/30) | 73.3% (22/30) | 60.0% (18/30) |
| **delta vs plain** | axis-grid +3.3 p.p. · grid-simple +0.0 p.p. · mark-grid +0.0 p.p. | axis-grid -6.7 p.p. · grid-simple +0.0 p.p. · mark-grid -20.0 p.p. | axis-grid +3.3 p.p. · grid-simple +3.3 p.p. · mark-grid -3.3 p.p. |

## Modo ação — o que clicar

| família | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| Bootstrap | 96.9% (32) | 87.5% (32) | 84.4% (32) |
| Fluent UI | 20.0% (20) | 20.0% (20) | 5.0% (20) |
| macOS | 84.4% (32) | 84.4% (32) | 78.1% (32) |
| Material 3 | 40.0% (20) | 35.0% (20) | 35.0% (20) |
| React95 | 93.8% (16) | 87.5% (16) | 81.3% (16) |

| ação | `xiaomi/mimo-v2.6-pro` | `z-ai/glm-5.3-flash` | `deepseek/deepseek-v4.1-flash-1017` |
|---|---:|---:|---:|
| click | 70.0% (100) | 67.0% (100) | 62.0% (100) |
| select | 58.3% (12) | 50.0% (12) | 33.3% (12) |
| type | 100.0% (8) | 87.5% (8) | 87.5% (8) |

## Metodologia

- A verdade de cada cenário vem do DOM renderizado: caixa de cada controle interativo em pixels de uma imagem 1920×1080 (não é anotação humana).
- **Mapa**: uma previsão casa com um elemento quando o ponto cai DENTRO da caixa. O casamento é um-para-um, guloso, por qualidade (rótulo > tipo > proximidade do centro). Precisão = casados/previsões; recall = casados/elementos; F1 harmônico. Rótulo normaliza acento/caixa e aceita contenção e aliases; tipo compara o vocabulário fechado.
- **Ação**: a tarefa passa quando a ação declarada é a esperada, o ponto cai na caixa do alvo (quando há alvo) e o texto digitado confere (quando há texto).
- Erro de chamada conta como resposta errada no denominador; célula pulada por orçamento/cancelamento fica FORA das métricas (o status da run diz que o placar é parcial).
- **Grade**: todas as variantes usam a mesma verdade e o mesmo pedido; `plain` é o controle. `grid-simple` desenha 9×9 sem rótulos, `axis-grid` usa réguas de x/y e `mark-grid` usa células 6×4. No `mark-grid`, a rodada 2 recebe o recorte ampliado da célula escolhida e contribui SÓ com o ponto refinado; ação/alvo/texto vêm da rodada 1.
