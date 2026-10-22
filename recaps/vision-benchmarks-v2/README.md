# Benchmarks 1 e 2 — resolução e grade (3 modelos, provedor fixado)

Rodada real em **22/10/2026**, dataset `vision-dataset@0.2.0` (hash `sha256:8d0de4203…`),
7 cenários · 197 controles · 30 tarefas de ação. **Provedor fixado em `DeepInfra`**
(`--provider`, `auditable`: sem fallback) — sem isso o OpenRouter troca de provedor
entre células e o número mede roteamento, não o modelo.

| banco | o que muda | células | chamadas HTTP | custo medido |
|---|---|---:|---:|---:|
| `resolution` | mesma tela em 1080p / 720p / 540p / 360p | 84 | 84 | **$0.0870** |
| `grid` | mesma tarefa com `plain` / 9×9 / eixos / Mark-Grid-lite 6×4 | 360 | 449 | **$0.0954** |

Os dois bancos usam a **mesma verdade do DOM** do F0; só a apresentação muda.
`grid` tem uma célula que não chegou à 2ª rodada (449 em vez de 450 chamadas):
o modelo não devolveu uma célula válida na rodada 1.

## Banco 1 — resolução (mapa, F1 de região)

Nota = média entre as 4 escalas. Coordenadas foram convertidas de volta para
1920×1080 antes de pontuar.

| modelo | nota | 1080p | 720p | 540p | 360p | retenção em 360p | custo | latência |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| **GLM 5.3 Flash** | **76.2%** | **92.2%** | **88.7%** | **71.6%** | **52.3%** | **56.7%** | $0.0179 | 10.3 s |
| MiMo V2.6-Pro | 60.4% | 82.4% | 62.9% | 62.2% | 34.1% | 41.4% | $0.0506 | 55.5 s |
| DeepSeek V4.1 Flash | 54.7% | 69.0% | 73.1% | 60.0% | 16.7% | 24.2% | $0.0186 | 31.1 s |

Precisão/recall completos (e por tipo/família): [`report-resolucao.md`](./report-resolucao.md).

## Banco 2 — grade (ação, taxa de acerto; 30 tarefas)

Nota = média das 4 variantes. `plain` é o controle; delta em pontos percentuais
contra ele.

| modelo | nota | plain | 9×9 | eixos | Mark-Grid-lite | Δ vs plain | alvo (geral) | custo | latência |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **MiMo V2.6-Pro** | **70.8%** | 70.0% | 70.0% | **73.3%** | 70.0% | **0.0** | 78.3% | $0.0268 | 9.8 s |
| GLM 5.3 Flash | 66.7% | **73.3%** | 73.3% | 66.7% | 53.3% | **−20.0** | 75.0% | $0.0553 | 2.0 s |
| DeepSeek V4.1 Flash | 60.8% | 60.0% | 63.3% | 63.3% | 56.7% | **−3.3** | 69.2% | $0.0133 | 3.8 s |

Custo/latência completos, por família e por ação: [`report-grade.md`](./report-grade.md).

## O que os números mostram

- **Resolução derruba todo mundo, mas não na mesma forma.** GLM é o melhor em
  1080p (92.2%) e o que retém mais em 360p (56.7%). MiMo mantém precisão alta e
  perde recall (vê menos controles). DeepSeek **colapsa** em 360p (16.7%): na
  inspeção das células, ele continua devolvendo coordenadas na escala 1920×1080
  quando a imagem tem 640×360 — é falha de contrato de coordenada, não só de
  visão. Um benchmark de resolução precisa reportar as duas coisas.
- **720p não é monotônico.** DeepSeek sobe de 69.0% (1080p) para 73.1% (720p).
  Com uma rodada e 7 cenários, isso é ruído/variação de amostra, não “720p é
  melhor”; o teste não tem IC.
- **Mark-Grid-lite não reproduziu o ganho do paper — e não deveria ser lido
  como refutação.** Nos 3 modelos ficou empatado ou pior que o controle (GLM
  −20 p.p.). O nosso variante é 6×4 em 2 rodadas com **1 célula** e pede um
  ponto; o paper usa **8×8, 4 IDs de extremidade**, recorta o bbox resultante,
  redimensiona o lado menor para 512 px e mostra **duas imagens** (overview com
  caixa + recorte com grade). São técnicas diferentes; o resultado mede o custo
  de um zoom por célula, não o Mark-Grid completo. O original fica no roadmap
  como `mark-grid@2` fiel.
- **Grade simples e eixos são quase neutros.** No máximo ±1 tarefa (±3,3 p.p.)
  e o sinal troca de modelo para modelo. É exatamente o controle negativo que a
  literatura previa; não justificam o custo de imagem/tokens.
- **Custo não acompanha nota.** GLM foi o mais caro no grid ($0.0553) e o mais
  barato no resolution ($0.0179); MiMo foi o mais caro no resolution ($0.0506)
  por verbosidade de saída (62,4k tokens out) e o mais lento (55,5 s).

## O achado metodológico que mudou a rodada

A primeira rodada (sem `--provider`) parecia mostrar GLM com **9,2%** em 720p.
Ao inspecionar `provider` por célula, 14 das 28 chamadas de resolução do GLM
tinham ido para **OpenInference**, com ~830 tokens de entrada (a imagem não
entrou) em vez de ~3.200 no **Wafer**. Fixar `DeepInfra` levou o mesmo 720p a
**88,7%**. Ou seja: sem pin de provedor, o banco de resolução mede o roteamento.
As rodadas sem pin foram descartadas e não entram nas tabelas.

## Pesquisa

O dossier com fontes e implicações está em
[`pesquisas/benchmarks-visao-2026.md`](../../pesquisas/benchmarks-visao-2026.md).
Ele documenta o mecanismo exato do Mark-Grid (4 IDs/8×8/crop 512), a evidência
de resolução do ScreenSpot-Pro/FastFocus e a verificação por estado do ambiente
(IRA/GUI-RewardBench, VLAA-GUI). O Tavily não estava disponível (todas as chaves
do pool esgotadas/revogadas); a pesquisa foi feita com busca web + a base já
versionada no ROADMAP, sem inventar fonte.

## Terceiro banco (proposto, não implementado)

**Ação executada (closed-loop).** Em vez de comparar o ponto com a caixa,
executar a previsão num Chromium e ler o efeito no DOM (`value`, `checked`,
`navigation`, `domAppears`). Zero chamadas extras de LLM; reload obrigatório
entre tarefas; métricas `effectRate`, `actionOk`, `pointInBox`, `effectOk`.
Especificação completa em [`ROADMAP-VISAO.md`](../../ROADMAP-VISAO.md#f12--ação-executada-o-clique-fecha-o-ciclo-proposta).

## Limites

- 7 cenários e 30 tarefas; **uma rodada por célula**; sem IC bootstrap.
- Só o provedor `DeepInfra`; conclusões não se transferem para outro provedor.
- `resolution` é downscale da mesma imagem (sem reflow); não mede layout responsivo.
- `grid` só roda no modo ação; o F0 (mapa + ação) continua sendo o placar base.
- Mark-Grid-lite é a variante 6×4/1 célula/2 rodadas deste repositório, não a
  implementação de 4 IDs/8×8 do paper.

## Arquivos

- [`report-resolucao.md`](./report-resolucao.md) · [`report-resolucao.html`](./report-resolucao.html)
- [`report-grade.md`](./report-grade.md) · [`report-grade.html`](./report-grade.html)
- [`record-resolucao.json`](./record-resolucao.json) · [`record-grade.json`](./record-grade.json)
- [`telas/`](./telas/) — 1080p/720p/540p/360p e os três overlays + recorte do Mark-Grid
- [`index.html`](./index.html) — galeria navegável com as tabelas

Reprodução:

```bash
prompt-builder vision run --models deepseek/deepseek-v4.1-flash-1017,xiaomi/mimo-v2.6-pro,z-ai/glm-5.3-flash \
  --benchmark resolution --provider DeepInfra --budget 2 --retries 2 --timeout 300000

prompt-builder vision run --models deepseek/deepseek-v4.1-flash-1017,xiaomi/mimo-v2.6-pro,z-ai/glm-5.3-flash \
  --benchmark grid --provider DeepInfra --budget 3 --retries 2 --timeout 300000
```
