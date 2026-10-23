# Comparativo de visão — DeepSeek V4.1 Flash × MiMo V2.6-Pro × GLM 5.3 Flash

Rodada real em **22/10/2026**, dataset `vision-dataset@0.1.0` (hash `sha256:0afe12079…`),
7 cenários · 197 controles · 30 tarefas de ação · **111 chamadas** · custo medido **$0.07855**
· prompt `vision-prompt@1` · coordenadas em pixels.

Os **dois benchmarks** = os dois modos do benchmark de visão:
- **mapa** — listar todos os controles clicáveis com posição;
- **ação** — dado o pedido, devolver a ação e a posição do alvo.

## Placar

| modelo | nota | mapa F1 | mapa P | mapa R | rótulo F1 | tipo | ação pass | ação certa | alvo | custo | tokens in/out | latência |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **MiMo-V2.6-Pro** `xiaomi/mimo-v2.6-pro` | **78.1%** | 82.8% | 89.4% | 77.2% | 62.7% | 82.9% | 73.3% (22/30) | 93.3% | 80.0% | $0.05270 | 92424/16961 | 11.4 s |
| **DeepSeek V4.1 Flash** `deepseek/deepseek-v4.1-flash-1017` | **66.1%** | 72.3% | 77.8% | 67.5% | 53.3% | 79.7% | 60.0% (18/30) | 90.0% | 70.0% | $0.01326 | 52706/14809 | 4.2 s |
| **GLM 5.3 Flash** `z-ai/glm-5.3-flash` | **42.3%** | 51.3% | 88.8% | 36.0% | 38.3% | 100.0% | 33.3% (10/30) | 90.0% | 40.0% | $0.01258 | 74156/15447 | 5.5 s |

**Vencedor:** `xiaomi/mimo-v2.6-pro` — nota **78.1%**.

## Por família (mapa F1 / ação pass)

| família | MiMo-V2.6-Pro | DeepSeek V4.1 Flash | GLM 5.3 Flash |
|---|---:|---:|---:|
| bootstrap | 100.0% / 100.0% | 85.0% / 87.5% | 100.0% / 25.0% |
| react95 | 0.0% / 100.0% | 0.0% / 75.0% | 0.0% / 100.0% |
| fluent | 90.7% / 20.0% | 72.9% / 0.0% | — / 20.0% |
| material | 89.4% / 40.0% | 89.4% / 40.0% | 89.4% / 20.0% |
| macos | 99.3% / 87.5% | 93.4% / 75.0% | 50.0% / 25.0% |

## Por cenário (mapa F1 / ação pass)

| cenário | MiMo-V2.6-Pro | DeepSeek V4.1 Flash | GLM 5.3 Flash |
|---|---:|---:|---:|
| bootstrap-painel-cursos | 100.0% / 4/4 | 70.0% / 3/4 | 100.0% / 2/4 |
| bootstrap-login | 100.0% / 4/4 | 100.0% / 4/4 | 100.0% / 0/4 |
| react95-painel | 0.0% / 4/4 | 0.0% / 3/4 | 0.0% / 4/4 |
| fluent-painel | 90.7% / 1/5 | 72.9% / 0/5 | — / 1/5 |
| material-painel | 89.4% / 2/5 | 89.4% / 2/5 | 89.4% / 1/5 |
| macos-finder | 98.7% / 3/4 | 86.8% / 2/4 | 0.0% / 2/4 |
| macos-salvar-como | 100.0% / 4/4 | 100.0% / 4/4 | 100.0% / 0/4 |

## O que os números mostram

- **MiMo V2.6-Pro** venceu nos dois modos, com mapa F1 82.8% e ação 73.3%.
- **React95** derrubou todos no mapa (0%): a UI Win95 densa, com muitos itens de menu e janelas sobrepostas, é o pior cenário do dataset.
- **Fluent/Material** separam os modelos na ação: MiMo 20.0% / 40.0%, DeepSeek 0.0% / 40.0%, GLM 20.0% / 20.0%.
- **Custo:** GLM é o mais barato ($0.01258), MiMo o mais caro ($0.05270); a diferença de nota é muito maior que a de custo nesta amostra.
- **Falha registrada:** GLM 5.3 Flash · `map:fluent-painel` · terminated — conta como resposta errada no denominador (1 de 111 chamadas).

## Telas

As imagens estão em [`telas/`](./telas/) e a galeria navegável em [`index.html`](./index.html).
Relatório gerado pelo CLI: [`report.md`](./report.md) · [`report.html`](./report.html).
Record completo (para auditar célula a célula): [`record.json`](./record.json).
