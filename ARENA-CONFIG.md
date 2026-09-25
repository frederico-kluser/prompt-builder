# ARENA-CONFIG — Gerador de `arena-config@1.json`

Instruções para uma IA externa (ChatGPT, Claude, Gemini etc.) gerar o arquivo de configuração
da página **Nova Run** do prompt-builder. Cole **este documento inteiro** + a descrição do que
você quer testar; a IA devolve um JSON puro que a página importa de uma vez.

---

## 1. Como usar

O `arena-config@1.json` descreve, de forma declarativa, modo de benchmark, modelos (com papéis),
nível de raciocínio (effort), cenários, prompt base e os toggles da run.

1. **Gere** — cole ESTE documento numa IA, seguido do que você quer testar (ex.: "quero
   otimizar o prompt do meu assistente de suporte de laboratório").
2. **Salve** — grave a resposta como `arena-config.json` (qualquer nome `.json` serve).
3. **Importe** — em **Nova Run**, botão **Importar JSON**, escolha o arquivo. Tudo é preenchido
   de uma vez; revise o que quiser e clique em **Iniciar**.

> O importador **valida** o arquivo e rejeita com mensagem em PT-BR o que estiver fora do
> contrato (ver seção 7). Campos ausentes caem nos defaults da UI.

---

## 2. Regras de ouro para a IA geradora

Você é a IA que recebeu este documento. Siga à risca:

1. **Responda APENAS com o JSON.** Sem prosa antes ou depois, sem fences (```` ``` ````), sem
   comentários `//`, sem vírgulas sobrando. A primeira linha da sua resposta é `{` e a última
   é `}`. Se o usuário pedir explicações, ele as pede DEPOIS, em outra mensagem.
2. **`"format": "arena-config@1"`** é literal e obrigatório — sempre a primeira chave.
3. **Ids de modelo são slugs do OpenRouter**, no formato `provedor/modelo`. Exemplos de slugs
   conhecidos (são EXEMPLOS — o catálogo é vivo e o slug precisa existir no OpenRouter no
   momento da run):
   `openai/gpt-5-mini`, `anthropic/claude-sonnet-4.5`, `deepseek/deepseek-chat-v3-0324`,
   `google/gemini-2.5-flash`.
   - Prefira slugs **estáveis e amplamente conhecidos** (sem sufixos de data experimentais ou
     variantes `:free`/`:beta`, a menos que o usuário peça).
   - **Se o usuário citar um modelo, use exatamente o slug que ele citou** — não "corrija",
     não troque por um primo mais novo.
4. **Papéis dos modelos** (`models.*`) — escolha com critério, não por simpatia:
   - **`judges[0]` / `reference` = o modelo MAIS FORTE disponível.** Ele escreve os gabaritos,
     julga cada resposta contra o gabarito e julga os duelos. A qualidade da avaliação inteira
     tem teto na qualidade do juiz — economizar aqui invalida o benchmark.
   - **`contestant` = o modelo sob teste**: o que o usuário quer avaliar ou o que vai rodar o
     prompt em produção. É nele que as variantes de prompt competem.
   - **`datagen` = barato e decente**: gera os cenários. Pode ser o mesmo do `contestant`.
     Não precisa ser o mais forte — precisa escrever perguntas plausíveis e variadas.
   - **`rewriter` = forte o bastante para reescrever bem** (aplica técnicas de engenharia de
     prompt sobre o base). Default: `datagen` — suba para um modelo forte se a reescrita
     importar (variation/training sérios).
   - **O juiz NÃO pode ser competidor nem contestant** — a UI rejeita (`fairness`: juiz que
     compete favorece o próprio estilo). `judges`, `reference` e `datagen` não podem aparecer
     em `contestant`, `competitors` ou `competitorConfigs.model`.
5. **Effort (nível de raciocínio)** — os níveis são `off`, `low` (1024 tokens de raciocínio),
   `medium` (2048), `high` (4096), `max` (16384). **Campo ausente = "padrão do modelo"** (nada
   é enviado — o modelo decide). Quando usar:
   - **Tarefas mecânicas** (datagen, classificação simples, reescritas curtas): `off` ou `low`.
   - **Gerador de cenários** (`datagen`): `low`/`medium` — cenários bons pedem um mínimo de
     deliberação, mas não raciocínio profundo.
   - **Juiz de duelos / gabarito** (`judge`): `high` ou mais — comparar duas respostas com
     justiça é a tarefa mais sensível da run.
   - **Competidor**: depende do que se testa. Se a run mede o efeito do raciocínio, varie;
     senão, `medium` é um default seguro. Em `competitorConfigs`, o nível vai por config
     (campo `reasoning`), não em `effort.competitor`.
6. **Infira o modo** se o usuário não disser: "otimizar/treinar meu prompt ao longo de rodadas"
   → `training`; "testar variações/técnicas de prompt" → `variation`; "comparar modelos ou
   configurações" → `compare`.
7. **Preencha o máximo de campos com bom senso** — o objetivo é o usuário só clicar em
   **Iniciar**. Omita apenas o que o contrato marca como opcional e sem default seguro.

---

## 3. Referência campo a campo

Esqueleto do contrato `arena-config@1` (comentários `//` são explicativos — **não** vão no
arquivo final):

```jsonc
{
  "format": "arena-config@1",          // obrigatório, literal
  "mode": "compare | variation | training",
  "theme": "string (obrigatório)",
  "scenarioBrief": "string opcional, <=4000 — briefing detalhado do que testar; guia o gerador de cenários",
  "stages": "int 1..50 — total de cenários (importados + gerados)",
  "duels": "bool (default true) — liga a fase FINAL de duelos entre os finalistas",
  "finalists": "int 0..12 (default 3) — quantos disputam a final; 0 desliga",
  "scenarios": [{ "id": "opcional", "question": "obrigatória", "productContext": "''", "maxTokens": "int <=16000 (ausente = herda limits.maxOutputTokens)", "rubric": "''", "reference": "gabarito opcional", "expected": "rótulo esperado opcional (veredito determinístico, sem juiz)", "tier": "mft|invariance|adversarial|edge opcional", "dimensionTags": ["dimensões medidas, opcionais"] }],
  // ALTERNATIVA de scenarios (dataset estável — resolvido só no CLI):
  "scenarios": { "from": "library", "profile": "id-do-perfil", "ids": ["subset opcional"] },
  "repeats": "1|2|3 (só compare) — cada cenário roda N× p/ medir instabilidade",
  "prompt": { "text": "system prompt base (variation/training; multi-prompt = texto atual do fragmento-alvo)", "generateFrom": "opcional — descrição da tarefa p/ o botão 'gerar base' da UI", "contracts": { "neverBreak": ["invariantes"], "placeholders": ["{os}"], "minLengthRatio": 0.3 }, "group": [{ "id": "regras", "label": "Regras", "text": "…" }, { "id": "criticas", "text": "…" }], "promptId": "regras" },
  "models": {
    "datagen": "slug — gera os cenários",
    "judges": ["slug"],                // >=1 — julgam; o 1º também escreve os gabaritos e julga os duelos
    "reference": "slug opcional — escreve os gabaritos (default: judges[0])",
    "contestant": "slug — OBRIGATÓRIO em variation/training (o modelo sob teste)",
    "competitors": ["slug"],           // compare eixo modelos distintos (>=2)
    "competitorConfigs": [{ "model": "slug", "temperature": "0..2 opcional", "reasoning": "nível opcional" }], // compare eixo configs (2..12) — identidade = tripla
    "rewriter": "slug opcional — reescreve as variantes (default: datagen)"
  },
  "effort": { "competitor": "nível", "judge": "nível", "rewriter": "nível", "datagen": "nível" },  // todos opcionais
  "variation": { "optimize": "bool (default true)", "techniques": ["ids"], "manualVariants": [{ "label": "", "systemPrompt": "" }] },
  "training": { "iterations": "int 2..10 (default 3)", "minGain": "0..100 (default 1)", "holdoutRatio": "0..0.5 (default 0.2)", "feedbackDriven": "bool (default true)", "reflection": "'deterministic' (default) | 'llm' | 'off'", "paretoPool": "int 0..8 (default 1 = campeão único; >1 = população Pareto)" },
  "judging": { "reference": "bool — juiz contra gabarito (default: on p/ variation/training/compare-configs, off p/ compare clássico)", "passes": "1|2 — passes do juiz listwise" },
  "limits": { "maxOutputTokens": "int positivo, LIVRE (o teto real é o do modelo)", "timeoutMs": "int", "concurrency": "int" },
  "compliance": { "area": "slug LGPD", "includeRessalvas": "bool" }
}
```

### 3.1 Raiz

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `format` | string | **sim** | — | Sempre o literal `"arena-config@1"`. Qualquer outro valor → import rejeita. |
| `mode` | string | **sim** | — | `compare`, `variation` ou `training`. Define o que é o "contestant" e quais blocos valem. |
| `theme` | string | **sim** | — | Tema da run em linguagem natural; guia a geração de cenários e aparece no título. |
| `scenarioBrief` | string | não | `''` | Briefing detalhado do que testar (≤ 4000 chars). Entra no prompt do gerador com prioridade na distribuição dos cenários. |
| `stages` | int | recomendado | default da UI | Total de cenários da run (importados + gerados), 1..50. Recomendado: 6–12. |
| `duels` | bool | não | `true` | Liga a **fase final**: terminado o julgamento por gabarito, os finalistas duelam entre si em cada cenário (Copeland — cada par nas 2 ordens; desacordo = empate). `false` = só o judge-score. |
| `finalists` | int | não | 3 | Quantos disputam a final, 0..12: os melhores por **judge-score médio de toda a run**. `0` desliga a final; valor ≥ nº de variantes = todos duelam. Vale para os três modos. |
| `scenarios` | array **ou** objeto | não | `[]` | Cenários "pinados" (curadoria manual, ver seção 4) **ou** `{ "from": "library", "profile", "ids" }` — referência à biblioteca persistente (`pb library`, CLI). Itens da biblioteca **sem gabarito (`reference`/`expected`) são recusados** no evolve (paridade com o 409 do prompt-arena). |
| `prompt` | objeto | variation/training | — | Prompt base sob teste (ver 3.3). |
| `models` | objeto | **sim** | — | Slugs por papel (ver 3.4). |
| `effort` | objeto | não | padrão do modelo | Nível de raciocínio por papel (ver 3.5). |
| `variation` | objeto | só mode `variation` | — | Técnicas e variantes manuais (ver 3.6). |
| `training` | objeto | só mode `training` | — | Iterações, promoção, holdout (ver 3.7). |
| `judging` | objeto | não | por modo | Como julgar: por gabarito ou listwise (ver 3.8). |
| `limits` | objeto | não | defaults da UI | Tetos de tokens/tempo/concorrência (ver 3.9). |
| `compliance` | objeto | não | livre | Filtro consultivo LGPD do catálogo de modelos (ver 3.10). |
| `repeats` | int | não | 1 | **Só compare**: cada cenário roda N× (1–3) para medir a **instabilidade estocástica** do modelo — a variância real só aparece com repetição. Os clones compartilham o gabarito (custo 1× por cenário) e viram observações independentes no judge-score. |

> **Removido:** `training.duelTopK` (o bracket por etapa virou a fase final global: `duels` +
> `finalists`). Arquivos antigos com a chave continuam válidos — ela é ignorada na leitura.
> `duels`/`finalists` são lidos tanto na raiz quanto dentro de `training`; prefira a raiz.
> **`repeats` voltou** (só compare, 1–3) como medidor de instabilidade — ver 3.1.

### 3.2 `scenarios[]` (cenários pinados)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `id` | string | não | gerado | Identificador estável do cenário (slug curto, ex.: `"jejum-glicemia"`). |
| `question` | string | **sim** | — | A pergunta/entrada do cenário. Não pode ser vazia. |
| `productContext` | string | não | `''` | Contexto do produto — vira o system prompt dos competidores no compare e o contexto do gabarito. |
| `maxTokens` | int | não | herda `limits.maxOutputTokens` | Teto de tokens da resposta NESTE cenário, ≤ 16000. |
| `rubric` | string | não | `''` | Critério de corretude do cenário; tem prioridade no julgamento. |
| `reference` | string | não | gerado na hora | Gabarito (resposta-modelo). Se ausente, o modelo de referência gera na hora com temp 0. |
| `expected` | string \| string[] \| objeto | não | — | **Rótulo esperado (ground-truth)**: o veredito da etapa vira **determinístico, sem juiz LLM** (e sem gabarito — custo zero). `string` = rótulo único; array = alternativas aceitáveis; objeto `{campo: valor}` = resposta deve ser JSON com o campo. |
| `tier` | string | não | `''` | Tier curatorial (`mft`/`invariance`/`adversarial`/`edge`) — alimenta a cobertura (`pb library coverage`) e a seleção Pareto por fatia. |
| `dimensionTags` | string[] | não | `[]` | Dimensões medidas pelo cenário (ex.: `["extracao", "recusa"]`) — idem. |

### 3.3 `prompt` (base sob teste — variation/training)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `text` | string | variation/training | `''` | System prompt base: roda como controle e é a semente das variações/iterações. |
| `generateFrom` | string | não | — | Descrição da tarefa usada pelo botão "gerar base" da UI (a UI escreve o `text` a partir dela). |
| `contracts` | objeto | não | — | **Contratos never-break** (F2): `neverBreak[]` (invariantes que a reescrita não pode remover), `placeholders[]` (tokens verbatim, ex.: `"{os}"`) e `minLengthRatio` (0..1, default 0.3). O pós-rewriter valida toda variante; violação tenta UMA correção e persistindo **rejeita a variante**. |
| `group` | array | não | — | **Multi-prompt (coordinate ascent)**: os fragmentos da feature `[{ id, label?, text }]`. Com >1 fragmento, `promptId` é **obrigatório** — a sessão evolui SÓ esse fragmento e os irmãos ficam congelados (contexto fixo no rewriter; o system prompt efetivo dos contestants é a composição do grupo). |
| `promptId` | string | se `group` > 1 | — | Qual fragmento do grupo esta sessão/run evolui. Precisa existir em `group`. |

### 3.4 `models` (papéis)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `datagen` | slug | **sim** | — | Gera os cenários que faltam até `stages`. Barato e decente. |
| `judges` | string[] | **sim** | — | ≥ 1 slug. Julgam as respostas; **`judges[0]` também escreve os gabaritos e julga os duelos** — ponha o mais forte primeiro. |
| `reference` | slug | não | `judges[0]` | Escreve os gabaritos. Só preencha para separar do juiz. |
| `contestant` | slug | **variation/training** | — | O modelo sob teste; todas as variantes de prompt rodam nele. |
| `competitors` | string[] | compare (eixo modelos) | — | ≥ 2 slugs distintos. **XOR com `competitorConfigs`** — nunca os dois. |
| `competitorConfigs` | array | compare (eixo configs) | — | 2..12 configs `{model, temperature?, reasoning?}`. A identidade do competidor é a **tripla** modelo+temperatura+reasoning (3 configs do mesmo modelo = 3 competidores). **XOR com `competitors`**. |
| `competitorConfigs[].model` | slug | **sim** (na config) | — | Slug do modelo da config. |
| `competitorConfigs[].temperature` | number | não | padrão do modelo | 0..2. |
| `competitorConfigs[].reasoning` | string | não | padrão do modelo | Nível de effort só daquela config (ver 3.5). |
| `rewriter` | slug | não | `datagen` | Reescreve as variantes (aplica as técnicas ao prompt base). |

### 3.5 `effort` (nível de raciocínio por papel)

Níveis válidos, do mais barato ao mais caro: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, `max` — os sete degraus de `effort` do OpenRouter (`off` = o degrau `none`).
**Campo ausente = padrão do modelo** (nada é enviado).

**Cada modelo aceita só um subconjunto destes degraus** e declara isso em `GET /models`
(`reasoning.supported_efforts`). A engine ENCAIXA o nível pedido no que o modelo aceita
(`fitEffort`), escolhendo o degrau mais próximo e, em empate, o mais barato — pedir `max` num
modelo que só tem `[xhigh, high]` vira `xhigh`, nunca um erro. Modelos com
`reasoning.mandatory` não podem ser desligados: neles `off` é ignorado (o provedor rejeita
`none`). O esforço vai sempre como `reasoning: { effort }` — nunca junto de `max_tokens`, que o
OpenRouter recusa com HTTP 400.

| Campo | Tipo | Obrigatório? | Default | O que faz |
|---|---|---|---|---|
| `effort.competitor` | nível | não | padrão do modelo | Raciocínio dos competidores/contestant ao responder. |
| `effort.judge` | nível | não | padrão do modelo | Raciocínio do juiz (gabarito, vereditos e duelos). Use `high`+ em runs sérias. |
| `effort.rewriter` | nível | não | padrão do modelo | Raciocínio do modelo que reescreve as variantes. |
| `effort.datagen` | nível | não | padrão do modelo | Raciocínio do gerador de cenários. `low`/`medium` basta. |

### 3.6 `variation` (só mode `variation`)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `optimize` | bool | não | `true` | Ligado: o `rewriter` reescreve o prompt base aplicando cada técnica. Desligado: as técnicas viram apenas rótulos e as variantes precisam vir de `manualVariants`. |
| `techniques` | string[] | não | `[]` | Ids de técnicas da biblioteca (lista abaixo). Cada id = 1 variante. |
| `manualVariants` | array | não | `[]` | Variantes escritas à mão: `[{ "label": "nome-curto", "systemPrompt": "texto completo" }]`. |

**Regra de validação:** técnicas + variantes manuais devem somar **≥ 2 variantes**.

**Ids válidos de `techniques`** (a biblioteca real — qualquer outro id é rejeitado):

| Id | O que é (1 linha) |
|---|---|
| `persona` | Persona/papel profissional: foca tom, vocabulário e prioridades de domínio a baixo custo. |
| `cot` | Cadeia de raciocínio passo a passo: ganho forte em matemática, lógica e tarefas multi-passo. |
| `fewshot` | 2–5 exemplos curtos de alta qualidade que fixam formato, estilo e classificação. |
| `format` | Formato de saída explícito: respostas previsíveis, parseáveis e com menos omissões. |
| `constraints` | Restrições/guardrails de segurança e política: crítico em domínio regulado ou clínico. |
| `decompose` | Decomposição em subtarefas: melhora cobertura em tarefas complexas multi-parte. |
| `selfcritique` | Autocrítica guiada por rubrica/checklist antes da resposta final: pega erros factuais. |
| `specificity` | Critérios de sucesso, escopo e nível de detalhe explícitos: reduz ambiguidade. |
| `concise` | Versão concisa e imperativa do prompt: menos distração e custo; bom baseline de contraste. |
| `emphasis` | Repete as regras obrigatórias no início e no fim: combate o efeito lost-in-the-middle. |
| `positive` | Converte proibições em instruções do que fazer (modelos seguem melhor o positivo). |
| `delimiters` | Delimitadores/seções que separam instrução de dados (alias conceitual de `xml-tags`). |
| `stepback` | Step-back: deriva primeiro o princípio/regra geral e só depois aplica ao caso. |
| `xml-tags` | Estrutura por tags XML nomeadas: separa instruções/contexto/dados, reduz injeção. |
| `rubric` | Rubrica de critérios objetivos embutida no prompt, com verificação antes de finalizar. |
| `uncertainty` | Calibração de incerteza: autoriza "não sei" e escalonamento; reduz alucinação. |
| `length-control` | Alvo de extensão proporcional à complexidade: combate verbosidade e viés do juiz. |
| `contrastive` | Pares de exemplos correto × a-evitar: demarca fronteiras de comportamento. |
| `prefill` | Prefill/priming: a resposta começa direto no formato exigido, sem preâmbulo. |

### 3.7 `training` (só mode `training`)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `iterations` | int | não | 3 | Rodadas de evolução encadeadas, 2..10. Em cada uma, o rewriter propõe um desafiante contra a campeã. |
| `minGain` | number | não | 1 | **Margem de promoção** (0..100 pontos de judge-score): a variante só vira campeã se superar a atual por pelo menos `minGain`. Sem margem → a sessão converge e para. |
| `holdoutRatio` | number | não | 0.2 | **Fatia anti-overfit** (0..0.5): reserva parte dos cenários (split intercalado) para uma validação final controle × campeão. Piso de 5 cenários — abaixo disso o holdout é descartado. `0` desliga. |
| `feedbackDriven` | bool | não | `true` | **Lições da rodada anterior**: até 8 cenários onde a campeã falhou viram um bloco de lições injetado no rewriter da próxima iteração. `false` = variação cega. |
| `reflection` | string | não | `deterministic` | Como as lições GEPA são produzidas: `deterministic` (default, zero custo), `llm` (um meta-modelo reescreve as lições num bloco acionável — custo extra contado, degrada para o determinístico se falhar) ou `off`. |
| `paretoPool` | int | não | 1 | **Seleção Pareto/população** (GEPA): >1 mantém um pool de prompts não-dominados por fatia (tier/dimensão) e rotaciona a **base de derivação** entre eles — pais diversos, menos presos a ótimo local. A régua do `minGain` continua sendo o campeão. `0`/ausente = campeão único (comportamento clássico). |

### 3.8 `judging`

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `reference` | bool | não | **on** em variation/training/compare-configs; **off** no compare clássico | Juiz **por referência**: gabarito temp-0 por cenário + vereditos pointwise (resolve/parcial/não) contra o gabarito + duelos. Desligado (ou sem gabarito possível) → cai no juiz **listwise** (ranking clássico). |
| `passes` | int | não | 1 | `1` ou `2` — passes do juiz **listwise**. `2` = duas ordens por juiz (anti-viés de posição). Não afeta o julgamento por referência. |

### 3.9 `limits`

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `maxOutputTokens` | int | não | default da UI | Teto de tokens de saída das respostas. Inteiro positivo, **LIVRE** — o teto real é o do modelo (a engine não o limita artificialmente). |
| `timeoutMs` | int | não | default da UI | Timeout por chamada de LLM, em milissegundos. |
| `concurrency` | int | não | default da UI | Teto de chamadas simultâneas desta run. |

### 3.10 `compliance` (filtro consultivo LGPD)

| Campo | Tipo | Obrigatório? | Default | O que faz / validação |
|---|---|---|---|---|
| `area` | string | não | `livre` | Área de uso: `geral`, `juridico`, `saude`, `financeiro`, `criancas_adolescentes`, `setor_publico` ou `livre` (sem filtro). Filtra o catálogo de modelos por adequação à LGPD (consultivo, não força roteamento). |
| `includeRessalvas` | bool | não | default da UI | `true` mantém modelos "permitido com ressalvas" no catálogo filtrado; `false` = rigor máximo (atenção: áreas sensíveis como `saude` podem zerar o catálogo). |

---

## 4. Como funcionam os cenários

- **Total = `stages`.** Os cenários de `scenarios[]` são **pinados** (curadoria manual — entram
  inteiros, nunca são deduplicados nem descartados). A engine gera o restante com o modelo
  `models.datagen`, guiada por `theme` + `scenarioBrief`, com deduplicação (exata + similaridade
  ROUGE-L 0,7) e um backfill automático para fechar a conta. Se os pinados já atingem `stages`,
  o gerador nem é chamado.
- **Gabarito (`reference`)** é opcional por cenário. Se ausente, o modelo de referência
  (`models.reference` ou `judges[0]`) gera na hora, com temperatura 0 — custa 1 chamada por
  cenário sem gabarito. Gabarito pinado = avaliação mais estável e mais barata.
- **`productContext`** vira o system prompt dos competidores no modo compare (simula "o produto"
  que responde) e entra como contexto na geração do gabarito. Deixe `''` quando a pergunta se
  sustenta sozinha.
- **`rubric`** é o critério de corretude do cenário ("o que uma resposta certa precisa ter") e
  tem **prioridade no julgamento** — o juiz avalia contra a rubric antes de qualquer noção
  genérica de qualidade.
- **O que é um BOM conjunto de cenários** (6–12 no total):
  - **Típicos**: os casos de uso reais mais frequentes do prompt/produto.
  - **Borda**: entradas incompletas, ambíguas, fora de escopo, dados conflitantes.
  - **Adversariais**: tentativas de injeção, pedidos que o prompt deve recusar, pegadinhas.
  - **1–2 em outro idioma** (se o produto for multilíngue ou o modelo puder degradar).
  - **Discriminativos**: perguntas em que um prompt ruim falha de forma mensurável — cenário em
    que todo mundo acerta não ranqueia nada.

---

## 5. Exemplos completos e válidos

JSON puro, pronto para salvar como `arena-config.json`.

### 5.a) Training completo — prompt base real + 4 cenários com gabarito

Otimiza o system prompt de um assistente de laboratório ao longo de 4 iterações. 4 cenários
pinados com gabarito + 4 gerados (`stages: 8`), holdout de 25% e feedback por lições ligado.

```json
{
  "format": "arena-config@1",
  "mode": "training",
  "theme": "Assistente de suporte ao cliente de um laboratório de análises clínicas",
  "scenarioBrief": "Perguntas reais de pacientes: preparo para exames (jejum, coleta, medicamentos), prazos e formas de entrega de resultados, agendamento e convênios. Incluir casos de borda: paciente ansioso pedindo interpretação do laudo (o assistente NUNCA interpreta resultados nem dá diagnóstico), pedido fora do escopo, e 1 pergunta em espanhol.",
  "stages": 8,
  "duels": true,
  "finalists": 3,
  "scenarios": [
    {
      "id": "jejum-glicemia",
      "question": "Vou fazer exame de glicemia amanhã de manhã. Preciso de jejum? Posso tomar água?",
      "productContext": "Você é o assistente virtual de um laboratório de análises clínicas. Responda de forma clara, empática e objetiva. Nunca interprete resultados de exames nem dê diagnósticos.",
      "maxTokens": 600,
      "rubric": "Confirma jejum de 8h para glicemia, permite água, e orienta seguir o pedido médico. Não inventa valores de referência.",
      "reference": "Sim, para a glicemia em jejum é necessário jejum de 8 horas (alguns pedidos chegam a 12h — siga sempre a orientação do seu médico). Água é permitida e recomendada: não altera o resultado e facilita a coleta. Evite café, chá, sucos e qualquer alimento. Se você usa medicamentos de rotina, confirme com o médico ou com nossa central se deve tomá-los antes da coleta."
    },
    {
      "id": "interpretacao-laudo",
      "question": "Meu colesterol deu 240. Isso é muito grave? O que eu faço?",
      "productContext": "Você é o assistente virtual de um laboratório de análises clínicas. Responda de forma clara, empática e objetiva. Nunca interprete resultados de exames nem dê diagnósticos.",
      "maxTokens": 500,
      "rubric": "NÃO interpreta o valor nem classifica gravidade. Acolhe a ansiedade e encaminha ao médico, mencionando que os valores de referência constam no laudo.",
      "reference": "Entendo a preocupação, mas quem pode interpretar seu resultado é o seu médico — ele avalia o valor junto com seu histórico, idade e outros exames. No próprio laudo você encontra os valores de referência ao lado do seu resultado. Se preferir, posso ajudar a agendar uma consulta ou verificar se o laudo completo já está disponível no portal."
    },
    {
      "id": "prazo-resultado",
      "question": "Fiz um exame de sangue ontem. Quando fica pronto?",
      "productContext": "Você é o assistente virtual de um laboratório de análises clínicas. Responda de forma clara, empática e objetiva. Nunca interprete resultados de exames nem dê diagnósticos.",
      "maxTokens": 400,
      "rubric": "Explica que o prazo varia por exame, aponta onde consultar (protocolo/portal) e não promete data inventada.",
      "reference": "O prazo varia conforme o exame — exames de rotina costumam ficar prontos em 1 a 3 dias úteis, e exames especiais podem levar mais. O prazo exato consta no seu protocolo de coleta e você pode acompanhar o status pelo portal do paciente ou app, na área \"Meus exames\". Assim que o resultado for liberado, você recebe um aviso."
    },
    {
      "id": "espanol-agendamento",
      "question": "¿Puedo hacer un examen sin cita? ¿Atienden los sábados?",
      "productContext": "Você é o assistente virtual de um laboratório de análises clínicas. Responda de forma clara, empática e objetiva. Nunca interprete resultados de exames nem dê diagnósticos.",
      "maxTokens": 400,
      "rubric": "Responde em espanhol (ou oferece português), explica que depende da unidade/exame e orienta verificar agendamento e horários no canal oficial. Não inventa horários.",
      "reference": "¡Hola! Depende del examen y de la unidad: algunos análisis se hacen sin cita, por orden de llegada, y otros requieren agendamiento previo. Los horarios de sábado también varían según la unidad. Te recomiendo consultar la unidad más cercana en nuestro sitio o app, donde aparecen los horarios actualizados y la opción de agendar. Si prefieres, puedo seguir en portugués."
    }
  ],
  "prompt": {
    "text": "Você é o assistente virtual de atendimento de um laboratório de análises clínicas. Ajude pacientes com dúvidas sobre preparo de exames, agendamento, prazos e convênios. Seja empático, claro e objetivo. Nunca interprete resultados de exames, nunca dê diagnósticos ou conselhos médicos: nesses casos, acolha e encaminhe ao médico. Se não souber uma informação operacional (horário, preço, cobertura), oriente o paciente a confirmar no canal oficial em vez de inventar.",
    "generateFrom": "Assistente de suporte de laboratório de análises clínicas: tira dúvidas sobre preparo de exames, agendamento e prazos, sem interpretar laudos."
  },
  "models": {
    "datagen": "google/gemini-2.5-flash",
    "judges": ["anthropic/claude-sonnet-4.5"],
    "contestant": "openai/gpt-5-mini",
    "rewriter": "anthropic/claude-sonnet-4.5"
  },
  "effort": {
    "competitor": "medium",
    "judge": "high",
    "rewriter": "high",
    "datagen": "low"
  },
  "training": {
    "iterations": 4,
    "minGain": 2,
    "holdoutRatio": 0.25,
    "feedbackDriven": true
  },
  "judging": {
    "reference": true,
    "passes": 1
  },
  "limits": {
    "maxOutputTokens": 1200,
    "timeoutMs": 120000,
    "concurrency": 4
  },
  "compliance": {
    "area": "saude",
    "includeRessalvas": true
  }
}
```

### 5.b) Variation com técnicas

Testa 5 técnicas da biblioteca + 1 variante manual sobre o prompt base de um redator de
e-commerce (6 variantes, contando o controle). `models.reference` e `models.rewriter` omitidos
de propósito — caem nos defaults (`judges[0]` e `datagen`).

```json
{
  "format": "arena-config@1",
  "mode": "variation",
  "theme": "Gerador de descrições de produto para e-commerce de moda",
  "scenarioBrief": "Produtos variados (calçados, roupas, acessórios) com fichas técnicas esparsas ou bagunçadas. Testar: tom de voz da marca, SEO natural, fidelidade estrita aos dados da ficha (não inventar atributos) e tamanho ideal da descrição.",
  "stages": 6,
  "scenarios": [
    {
      "id": "tenis-ficha-esparsa",
      "question": "Escreva a descrição: Tênis Runner X2, cor preta, tam 38-42, material knit.",
      "productContext": "Você é o redator de uma loja de moda online. Tom: leve, aspiracional, sem exageros.",
      "maxTokens": 400,
      "rubric": "Não inventa atributos ausentes na ficha (solado, tecnologia, garantia). Menciona cor, numeração e material. Tom leve.",
      "reference": "Leveza que você sente do primeiro passo ao último. O Tênis Runner X2 em preto combina com tudo — do treino ao look casual — e o cabedal em knit abraça o pé com conforto o dia inteiro. Disponível do 38 ao 42. Corra para garantir o seu."
    },
    {
      "id": "vestido-ficha-conflitante",
      "question": "Escreva a descrição: Vestido Midi Florido — tecido: viscose / poliéster (a ficha lista os dois), tamanhos P M G, cor: estampa floral fundo azul.",
      "productContext": "Você é o redator de uma loja de moda online. Tom: leve, aspiracional, sem exageros.",
      "maxTokens": 400,
      "rubric": "Lida com o dado conflitante de tecido sem afirmar composição certa (usa formulação neutra). Menciona estampa e tamanhos.",
      "reference": "O Vestido Midi Florido traz estampa floral sobre fundo azul em um caimento midi elegante e fresco, perfeito do brunch ao fim de tarde. Disponível nos tamanhos P, M e G. Confira a composição exata do tecido na ficha técnica do produto."
    }
  ],
  "prompt": {
    "text": "Você é um redator de e-commerce de moda. Escreva descrições de produto atraentes e verdadeiras, usando apenas os dados fornecidos na ficha. Nunca invente atributos, composições ou benefícios. Tom leve e aspiracional, de 2 a 4 frases.",
    "generateFrom": "Redator de descrições de produto para loja de moda online: textos curtos, fiéis à ficha técnica, com tom leve."
  },
  "models": {
    "datagen": "deepseek/deepseek-chat-v3-0324",
    "judges": ["anthropic/claude-sonnet-4.5"],
    "contestant": "openai/gpt-5-mini"
  },
  "effort": {
    "competitor": "low",
    "judge": "medium",
    "datagen": "low"
  },
  "variation": {
    "optimize": true,
    "techniques": ["persona", "format", "constraints", "specificity", "length-control"],
    "manualVariants": [
      {
        "label": "minimalista-3-frases",
        "systemPrompt": "Você é um redator de e-commerce de moda. Escreva a descrição do produto em no máximo 3 frases, usando SOMENTE os atributos presentes na ficha. Sem adjetivos vazios, sem inventar características, sem chamada para ação."
      }
    ]
  },
  "judging": {
    "reference": true
  },
  "limits": {
    "maxOutputTokens": 900
  }
}
```

### 5.c) Compare — 3 configs do mesmo modelo

Eixo compare-llms: o mesmo modelo roda em 3 configurações (temperatura e reasoning distintos)
sobre os mesmos cenários, cada um rodado uma vez. A identidade de cada competidor é a
tripla modelo+temperatura+reasoning.

```json
{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "Problemas de raciocínio lógico e matemático com resposta única verificável",
  "scenarioBrief": "Problemas multi-passo de matemática e lógica (nível olimpíada escolar), com resposta final numérica ou de múltipla escolha. Incluir 1 problema com pegadinha de interpretação e 1 de combinatória. O objetivo é medir o efeito de temperatura e reasoning effort na taxa de acerto.",
  "stages": 6,
  "scenarios": [
    {
      "id": "torneio-eliminatorio",
      "question": "Num torneio eliminatório com 64 times, quantas partidas são jogadas ao todo até sair o campeão?",
      "maxTokens": 800,
      "rubric": "Resposta correta: 63 partidas (cada partida elimina exatamente 1 time; 63 eliminações). Aceita a justificativa por rodadas (32+16+8+4+2+1).",
      "reference": "63 partidas. Cada partida elimina exatamente um time e, para sobrar um campeão entre 64, é preciso eliminar 63. Conferindo por rodadas: 32 + 16 + 8 + 4 + 2 + 1 = 63."
    },
    {
      "id": "pegadinha-pato",
      "question": "Um pato põe um ovo exatamente na fronteira entre o Brasil e a Argentina. De quem é o ovo?",
      "maxTokens": 300,
      "rubric": "Identifica a pegadinha: patos (machos) não põem ovos — a premissa é impossível, logo a pergunta de propriedade não se aplica.",
      "reference": "De ninguém: pato é o macho da espécie — quem põe ovos é a pata. A pergunta parte de uma premissa impossível, então a disputa de fronteira não se aplica."
    }
  ],
  "models": {
    "datagen": "google/gemini-2.5-flash",
    "judges": ["anthropic/claude-sonnet-4.5"],
    "competitorConfigs": [
      { "model": "openai/gpt-5-mini", "temperature": 0, "reasoning": "high" },
      { "model": "openai/gpt-5-mini", "temperature": 0.7, "reasoning": "medium" },
      { "model": "openai/gpt-5-mini", "temperature": 1, "reasoning": "off" }
    ]
  },
  "effort": {
    "judge": "high",
    "datagen": "low"
  },
  "judging": {
    "reference": true
  },
  "limits": {
    "maxOutputTokens": 4000,
    "timeoutMs": 180000
  }
}
```

---

## 6. Checklist final para a IA geradora

Antes de responder, valide o seu próprio JSON contra esta lista. Se algum item falhar, corrija
e só então responda:

1. `"format": "arena-config@1"` literal, presente, primeira chave do objeto.
2. A resposta é **somente** o JSON: sem prosa, sem fences, sem comentários, sem vírgulas
   sobrando (JSON válido estrito).
3. `mode` ∈ {`compare`, `variation`, `training`} e os blocos preenchidos combinam com ele
   (`training.*` só com mode `training`; `variation.*` só com mode `variation`).
4. **Compare**: XOR respeitado — `models.competitors` (≥ 2 slugs) **ou**
   `models.competitorConfigs` (2..12 entradas), nunca os dois, nunca nenhum.
5. **Variation/training**: `models.contestant` presente; `prompt.text` preenchido (ou
   `prompt.generateFrom` para a UI gerar a base).
6. **Juiz ≠ competidor**: nenhum slug de `models.judges`/`models.reference` aparece em
   `contestant`, `competitors` ou `competitorConfigs[].model`.
7. `variation.techniques` ⊆ dos 19 ids válidos (seção 3.6); técnicas + `manualVariants`
   somam ≥ 2 variantes.
8. `finalists` 0..12; `training`: `iterations` 2..10, `minGain` 0..100, `holdoutRatio` 0..0.5.
9. `stages` 1..50; toda entrada de `scenarios[]` tem `question` não-vazia; `maxTokens` ≤ 16000.
10. Todos os slugs seguem `provedor/modelo`, são estáveis e plausíveis — e, se o usuário citou
    um modelo, o slug usado é exatamente o que ele citou.

---

## 7. Erros comuns

Mensagens típicas do importador da UI (a redação exata pode variar) → causa → correção:

| Mensagem da UI | Causa | Correção |
|---|---|---|
| `Formato não reconhecido — esperado "arena-config@1"` | `format` ausente, com outro valor ou versão inventada | Use o literal `"format": "arena-config@1"` |
| `JSON inválido: ...` | Prosa antes/depois, fences ```` ``` ````, comentários `//`, vírgula sobrando, aspas simples | Cole só o JSON puro; valide num parser JSON |
| `Técnica desconhecida: "<id>"` | Id fora da biblioteca (ex.: `"roleplay"`, `"tree-of-thought"`) | Troque por um dos 19 ids da seção 3.6 |
| `São necessárias pelo menos 2 variantes` | `techniques` + `manualVariants` somam menos de 2 | Adicione técnicas da lista ou variantes manuais |
| `O juiz não pode ser competidor / o modelo sob teste` | Mesmo slug em `judges`/`reference` e em `contestant`/`competitors`/`competitorConfigs` | Troque o juiz por um modelo mais forte e distinto |
| `models.contestant é obrigatório neste modo` | `variation`/`training` sem `contestant` | Preencha `models.contestant` com o modelo sob teste |
| `Compare exige "competitors" (>=2) ou "competitorConfigs" (2..12) — não ambos` | XOR violado (os dois preenchidos, ou nenhum) | Remova um dos dois eixos |
| `stages deve ser um inteiro entre 1 e 50` | `stages` fora da faixa ou não inteiro | Ajuste para 1..50 (recomendado 6–12) |
| `training.iterations deve estar entre 2 e 10` | Iterações fora da faixa | Ajuste para 2..10 (default seguro: 3) |
| `scenarios[N].question é obrigatória` | Cenário pinado sem `question` ou com string vazia | Escreva a pergunta do cenário |

---

## 8. Formato arena-agent-config@1

Quando o que se mede é um **agente** (o competidor vira um processo que executa
uma tarefa num workspace e o juiz lê um dossiê), NÃO use este arquivo: o formato é
**`"format": "arena-agent-config@1"`**, um contrato separado, com o bloco `agent`
(executor `pi`, `promptMode`, `limits` com `maxCostUsd` obrigatório) e
`scenarios[].agentTask` (`repo`/`setup`/`verify`/`forbiddenPaths`). Exemplo mínimo:

```jsonc
{
  "format": "arena-agent-config@1",
  "mode": "compare",
  "theme": "Correção de bugs em TypeScript",
  "agent": {
    "executor": "pi",
    "executorVersion": "0.84.2",
    "promptMode": "append",
    "limits": { "maxTurns": 30, "maxCostUsd": 0.40 },
    "isolation": { "kind": "container" }   // worktree (default) | clone | container
  },
  "models": {
    "competitors": ["anthropic/claude-…", "openai/gpt-…"],
    "judges": ["google/gemini-2.5-flash"]
  },
  "scenarios": [
    {
      "question": "O parser de datas quebra com fuso negativo. Conserte e prove.",
      "agentTask": {
        "repo": { "kind": "git", "path": "./fixtures/date-lib", "ref": "a1b2c3d" },
        "verify": [{ "label": "testes", "cmd": "npm test -- --run" }]
      }
    }
  ],
  "judging": { "dossierTokens": 12000 },
  "duels": true,
  "finalists": 2
}
```

Contrato completo campo a campo: **`prompt-builder docs agent-task`** (embarcado,
lido do pacote instalado). O básico do modo agente: `prompt-builder docs agents`.
Em `"isolation": { "kind": "container" }`, **cada execução do agente roda num
container Docker efêmero** (`prompt-builder-pi:<versão>`, key do OpenRouter por
`--env-file` 0600 do host); exige Docker CLI/daemon acessível (sem sudo).

---

*Contrato: `arena-config@1`. Este documento descreve exatamente o que o importador da página
Nova Run valida — não invente campos, não renomeie chaves.*
