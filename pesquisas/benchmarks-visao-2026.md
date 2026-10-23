# Benchmarks de UI grounding em 2026 — dossier de pesquisa

**Data:** 22/10/2026 · **Escopo:** desenho dos bancos 1 (resolução), 2 (grade)
e 3 (ação executada) do benchmark de visão do `prompt-builder`.

> **Tavily:** o modo `--deep-research` não rodou. O pool tem 36 chaves e, na
> data, **todas** estavam `QUOTA_EXHAUSTED` (HTTP 432) ou `REVOKED` (HTTP 401);
> `research init --deep-research` falhou antes de gerar o dossier. Este
> documento é a pesquisa possível sem o Tavily: 4 rodadas de busca web, leitura
> dos fontes primários abaixo e a evidência que já estava no `ROADMAP-VISAO.md`.
> Não há fonte inventada nem resumo de paper que eu não tenha aberto.

## 1. Perguntas

1. O que a evidência mostra sobre **resolução/downscale** em GUI grounding?
2. O que é o **Mark-Grid** de verdade — e o nosso variante mede a mesma coisa?
3. Como medir **ação executada** (clique com efeito) sem juiz LLM?
4. Que cuidados de **comparação entre modelos** o desenho precisa ter?

## 2. O que a evidência mostra

### 2.1 Mark-Grid: 4 IDs, 8×8, crop 512, duas imagens

O paper *How Auxiliary Reasoning Unleashes GUI Grounding in VLMs*
([arXiv:2509.11548v2](https://arxiv.org/abs/2509.11548), HTML
[v2](https://arxiv.org/html/2509.11548v2)) propõe três scaffolds zero-shot:
**Coordinate Scaffold** (matriz 8×8 de pontos com coordenadas reais),
**Axis-Grid** (réguas de 100 em 100 px nas bordas + grade) e **Mark-Grid**.

O Mark-Grid **não** escolhe uma célula e pede um ponto. O mecanismo descrito:

1. overlay de uma grade **8×8**, cada célula com um ID no centro;
2. rodada 1: o modelo devolve **4 IDs** — esquerda, topo, direita e base do
   elemento (podem repetir);
3. o bbox implícito é recortado e o **lado menor é redimensionado para 512 px**;
4. a mesma grade 8×8 é aplicada ao recorte;
5. rodada 2 recebe **duas imagens** (overview com a caixa prevista + recorte
   ampliado com grade) e devolve outros 4 IDs;
6. o ponto final é o **centro** do bbox dos 4 IDs finais.

Resultado de manchete: Gemini-3.1-Pro de **11,72% → 95,20%** no ScreenSpot-v2;
SOTA no ScreenSpot e perto dos melhores fine-tuned no ScreenSpot-v2 e
UI-I2E-Bench, em 4 benchmarks e 7 VLMs. Ao lado, o paper usa **grade 9×9
simples** como controle negativo (Grid-Augmented Vision) e mostra que ela
**não** resolve o problema sozinha.

**Implicação para nós:** o nosso `mark-grid` da v0.2 é um **Mark-Grid-lite**:
grade **6×4**, **1 célula**, recorte com padding e uma pergunta de **ponto** na
rodada 2. Ele mede "zoom por célula", não a técnica do paper. O resultado
negativo nos 3 modelos (GLM −20 p.p.; MiMo 0; DeepSeek −3,3) **não refuta** o
Mark-Grid. Para testar a técnica de verdade falta: 8×8, 4 IDs, crop 512 no lado
menor e as duas imagens na rodada 2 — está no roadmap como `mark-grid@2` fiel.

### 2.2 Resolução: o problema é real, mas a resposta não é "só reduzir"

- **ScreenSpot-Pro** ([paper](https://dl.acm.org/doi/pdf/10.1145/3746027.3755688),
  [resumo deep-read](https://kendrick-stein.github.io/MCISLAB_DeepRead/Papers/2504-ScreenSpotPro))
  tem 1.581 tarefas, 23 aplicações, 3 sistemas e screenshots que **passam de
  4K**; o encoder vê uma versão reduzida e perde detalhe fino.
- **FastFocus** (IJCAI 2026, [página oficial](https://www.ijcai.org/proceedings/2026/49))
  argumenta o oposto do senso comum: alta resolução preserva detalhe, mas
  **dispersa a atenção**; baixa resolução estabiliza o layout global. A solução
  é coarse-to-fine: atenção em baixa resolução propõe candidatos, verificação
  paralela amplia só os candidatos e filtra falso positivo. É SOTA no
  ScreenSpot-Pro.
- Os nossos números são consistentes com "resolução importa e não é linear":
  GLM 92,2% em 1080p → 52,3% em 360p; DeepSeek 69,0% → 16,7% (e no 360p ele
  continua emitindo coordenadas de 1920×1080 — falha de contrato, não de visão).
  O 720p do DeepSeek subir para 73,1% mostra que a curva não é monotônica numa
  amostra de 7 cenários.

**Implicação:** o banco `resolution` está bem desenhado para medir a perda, mas
o próximo banco de percepção deve ser **zoom condicional** (só quando a
confiança/atenção é baixa), não downscale cego. O `mark-grid@2` fiel também é
uma forma de coarse-to-fine.

### 2.3 Ação executada: verificação por estado do ambiente

- **Interactive Reward Agent (IRA)** ([arXiv:2607.25904](https://arxiv.org/abs/2607.25904))
  define o problema: avaliar uma tarefa de GUI exige **estado do ambiente**
  (arquivos, configurações, apps), não só o screenshot da trajetória. O IRA
  propõe condições de conclusão e verifica com ferramentas de sistema/app/GUI.
  No **GUI-RewardBench** (321 trajetórias, 10 categorias de apps Ubuntu) chega a
  **86,9%** de acurácia de avaliação; como reward no RL, leva o OSWorld a 34,0%.
- **VLAA-GUI** ([arXiv:2604.21375](https://arxiv.org/abs/2604.21375)) torna um
  **Completeness Verifier** obrigatório em todo `finish`: a alegação de sucesso
  precisa de evidência visual/determinística; sem isso, rejeita. Reporta 77,5%
  no OSWorld e 61,0% no WindowsAgentArena, com 3 de 5 backbones acima do humano
  (72,4%) em uma passada.
- **ReflexAct** ([ACM](https://dl.acm.org/doi/10.1007/978-981-92-3403-5_14))
  fecha o loop de agentes web com verificação visual e grounding adaptativo.
- A **survey platform-aware** de execução/verificação/risco
  ([IEEE](https://ieeexplore.ieee.org/document/11640914/)) organiza o espaço:
  execução, verificação e risco são camadas separadas; avaliar só o clique é
  insuficiente.

**Implicação:** o banco 3 (`executed`) está na direção certa, mas no nosso caso
o "ambiente" é o DOM do cenário — o que é uma **vantagem** de determinismo, não
uma limitação escondida. O efeito declarado (`value`, `checked`, `navigation`,
`domAppears`) é o análogo synthetic do que o IRA verifica com ferramentas.
Precisamos de reload entre tarefas e de separar `pointInBox` de `effectOk`,
exatamente para não confundir "clicou no lugar" com "produziu o efeito".

### 2.4 Comparação entre modelos: o provedor é uma variável escondida

Não é um achado de paper, é um achado desta rodada: sem `--provider`, o
OpenRouter trocou de provedor entre células. O GLM caiu de **88,7%** para
**9,2%** em 720p porque 14/28 chamadas foram para um provedor que recebeu ~830
tokens de entrada (a imagem não entrou) em vez de ~3.200. Fixar `DeepInfra`
(`auditable`, sem fallback) restaurou o número. Qualquer leaderboard de
grounding que não fixe/registre o provedor está medindo roteamento.

## 3. Implicações para o benchmark

| banco | evidência | decisão |
|---|---|---|
| `resolution` | ScreenSpot-Pro/FastFocus | manter; reportar a escala enviada e separar erro de espaço de coordenada; próximo: zoom condicional |
| `grid` | Mark-Grid 4 IDs/8×8 | renomear o nosso para **Mark-Grid-lite** e não usá-lo para refutar o paper; implementar `mark-grid@2` fiel |
| `executed` | IRA/VLAA/ReflexAct | executar e verificar efeito no DOM, com reload e `effectOk` separado de `pointInBox` |
| todos | nossa rodada | fixar provedor, registrar `provider`, uma rodada ≠ IC; aumentar N antes de ranking público |

## 4. Fontes

1. Li et al. *How Auxiliary Reasoning Unleashes GUI Grounding in VLMs*.
   arXiv:2509.11548v2, 10/06/2026. <https://arxiv.org/abs/2509.11548> ·
   <https://arxiv.org/html/2509.11548v2>
2. *ScreenSpot-Pro: GUI Grounding for Professional High-Resolution Computer
   Use*. ACM, 2025. <https://dl.acm.org/doi/pdf/10.1145/3746027.3755688>
3. Yang et al. *Focus Like a Human: Efficient GUI Grounding via Coarse-to-Fine
   Visual Attention and Parallel Verification*. IJCAI 2026, pp. 428–436.
   <https://www.ijcai.org/proceedings/2026/49>
4. Shi et al. *Interactive Reward Agent: GUI Task Evaluation via
   Environment-State Verification*. arXiv:2607.25904v2, 29/07/2026.
   <https://arxiv.org/abs/2607.25904>
5. Han et al. *VLAA-GUI: Knowing When to Stop, Recover, and Search*.
   arXiv:2604.21375v3, 24/09/2026. <https://arxiv.org/abs/2604.21375>
6. *ReflexAct: Closing the Loop for Web Agents via Visual Verification and
   Adaptive Grounding*. ICIC 2026. <https://dl.acm.org/doi/10.1007/978-981-92-3403-5_14>
7. *A Platform-Aware Survey of Execution, Verification, and Risk of Graphical
   User Interface Agents*. IEEE, 2026.
   <https://ieeexplore.ieee.org/document/11640914/>
8. *GUI-G²: Gaussian Reward Modeling for GUI Grounding*. AAAI 2026.
   <https://ojs.aaai.org/index.php/AAAI/article/download/40606/44567>

## 5. Limites desta pesquisa

- **Não é deep research do Tavily**: foram 4 buscas e 6 fontes abertas, não uma
  auditoria sistemática de lacunas com sub-perguntas e rondas.
- Os números de Mark-Grid/FastFocus/IRA/VLAA são os reportados pelos autores;
  não os reproduzi.
- A conclusão sobre provedor é da nossa rodada (3 modelos, 7 cenários, uma
  execução), não da literatura.
- Para um leaderboard público, ainda faltam: ≥ 30 cenários, IC pareado, splits
  dev/test e uma segunda rodada para estimar variância entre execuções.
