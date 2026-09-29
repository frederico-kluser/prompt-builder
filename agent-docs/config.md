# O contrato `arena-config@1` (o arquivo de configuração de run)

Um JSON declarativo que descreve uma run inteira: modo, modelos por papel,
raciocínio, cenários, prompt base. É o MESMO arquivo que `compare|vary|train
--config`, `estimate -c`, `config validate` e o **Importar JSON** da tela Nova
Run leem.

O validador é o schema zod `arenaConfigSchema` (`src/configFile.ts`); o `config
schema` publica o JSON Schema gerado **desse mesmo zod**. Tudo aqui vale para
esta versão instalada.

**Chave desconhecida é ERRO** (exit `3`, com o caminho e um "você quis dizer"):
nada é descartado em silêncio. `tier`, `dimensionTags` e `duelTopK` não existem;
`training.halving` é aceito com aviso e ignorado.

## 1. Fluxo

```bash
prompt-builder config example --mode train -o arena.json   # exemplo VÁLIDO (compare|vary|train)
prompt-builder config validate arena.json                  # exit 0 = válido; 3 = inválido
prompt-builder config schema -o arena-config.schema.json   # JSON Schema (draft 2020-12)
prompt-builder estimate -c arena.json                      # custo antes de gastar (sem key)
prompt-builder train --config arena.json --budget 10 --dry-run --json
```

O `--dry-run` roda o pré-voo inteiro sem gastar e sai com o MESMO código que a
run real teria (`docs budget`). O `config example` é o esqueleto de cada modo.

## 2. Regras para quem GERA o arquivo (humano ou IA)

1. **JSON puro**, sem comentários nem prosa. `"format": "arena-config@1"` é
   literal e obrigatório.
2. **Ids de modelo são slugs do OpenRouter** (`provedor/modelo`). Confira com
   `prompt-builder models show <id> --json` (existe? que níveis aceita?).
3. **Papéis separados** (o schema recusa, exit `3`): juiz nunca é o modelo sob
   teste nem competidor; a referência (autora do gabarito) nunca é juiz nem
   competidor — e é **obrigatória** em `variation`/`training` (no `compare` cai
   em `judges[0]`, com aviso de viés); no `compare` o gerador não compete.
4. **`judges[0]` é o juiz principal** (vereditos e duelos das finais).
5. **Raciocínio**: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.
   Ausente = padrão do modelo; o motor encaixa o pedido no que ele aceita.
6. **Modo**: comparar modelos/configurações → `compare`; variações de um prompt
   → `variation`; evoluir um prompt em rodadas → `training`.

## 3. Referência campo a campo

### 3.1 Raiz

| Campo | Tipo | Obrigatório | Default | O que faz / validação |
|---|---|---|---|---|
| `format` | string | **sim** | — | Literal `"arena-config@1"`. |
| `mode` | string | **sim** | — | `compare`, `variation` ou `training`. |
| `theme` | string | **sim** | — | Tema (não vazio); guia o gerador e nomeia a run. |
| `scenarioBrief` | string | não | — | O que testar, ≤ 4000 caracteres (entra no prompt do gerador). |
| `languages` | string[] | não | só pt-BR | Tags BCP 47, 1..10: idiomas **permitidos** ao gerador (opt-in). O CLI aplica; a SPA avisa e gera só pt-BR. |
| `stages` | int | não | 5 (training: 10) | Total de cenários (pinados + gerados), 1..50; nunca menor que o nº de pinados. |
| `scenarios` | lista **ou** objeto | não | — | Cenários pinados (3.2) ou referência à biblioteca (3.3). |
| `repeats` | 1 \| 2 \| 3 | não | 1 | **Só compare**: cada cenário roda N× (instabilidade); os clones dividem o gabarito. |
| `prompt` | objeto | variation/training | — | Prompt base (3.4). No `compare` o `text` é ignorado (o system prompt é o `productContext` do cenário). |
| `models` | objeto | **sim** | — | Slugs por papel (3.5). |
| `effort` | objeto | não | do modelo | Raciocínio por papel (3.6). |
| `variation` | objeto | não | — | Técnicas/variantes (3.7); vale em `variation` e `training`. |
| `training` | objeto | não | — | Iterações, promoção, holdout (3.8). |
| `duels` | bool | não | `true` | Fase final: os finalistas duelam em cada cenário COM gabarito (2 ordens; desacordo = empate). `false` = só judge-score. |
| `finalists` | int | não | 3 | 0..12 melhores por **judge-score médio** vão às finais; `0` desliga. |
| `judging` | objeto | não | por modo | Como julgar (3.9). |
| `limits` | objeto | não | 3.10 | Tokens e timeout. |
| `compliance` | objeto | não | sem filtro | Área LGPD (3.11). |
| `piiMode` | string | não | `redact` | `redact` (pseudonimiza identificadores no envio) ou `synthetic` (recusa dado de aparência real). |
| `allowPii` | bool | não | `false` | "Revisei o dado pessoal apontado" (= `--allow-pii`). |

`duels`/`finalists` dentro de `training` ainda são aceitos (arquivos antigos),
mas a raiz vence.

### 3.2 `scenarios[]` — cenários pinados

Entram inteiros (nunca deduplicados); o gerador completa até `stages`.

| Campo | Tipo | Obrigatório | O que faz / validação |
|---|---|---|---|
| `id` | string | não | Identificador curto (não vazio se presente). |
| `question` | string | **sim** | A entrada do cenário. |
| `productContext` | string | **sim** (na prática) | Vira o system prompt dos competidores no `compare` e entra no gabarito. O schema do arquivo aceita ausente, mas a run recusa vazio (`scenarioSeed: Too small`). |
| `maxTokens` | int | não | Teto da resposta NESTE cenário, 1..16000 (default `limits.maxOutputTokens`). |
| `rubric` | string | não | Critério de corretude; tem prioridade no julgamento. |
| `reference` | string | não | Gabarito. Ausente: a referência o escreve (temperatura 0, 1 chamada). |
| `expected` | string \| string[] \| objeto | não | **Rótulo esperado**: veredito determinístico, sem juiz. Lista = alternativas; objeto `{campo: valor}` = resposta JSON com o campo. |
| `labelSet` | string[] | com `expected` curto | TODOS os rótulos válidos (1..200). Obrigatório se `expected` tem ≤ 5 palavras; ≥ 2 rótulos distintos contendo o `expected`. |

### 3.3 `scenarios` como referência à biblioteca

```json snippet
"scenarios": { "from": "library", "profile": "suporte-faturamento", "ids": ["cobranca-1", "recusa-2"] }
```

Dataset curado e estável (`prompt-builder library …`): torna sessões
comparáveis. `ids` ausente = o perfil inteiro. Resolvido **só pelo CLI**; item
sem gabarito (`reference` nem `expected`) é recusado.

### 3.4 `prompt`

| Campo | Tipo | O que faz / validação |
|---|---|---|
| `text` | string (**obrigatório** no bloco) | System prompt base: roda como controle e é a semente das variações. |
| `generateFrom` | string | Descrição da tarefa para o "gerar base" da UI. |
| `contracts` | objeto | Contratos never-break (abaixo). |
| `group` | `{id, label?, text}[]` | **Multi-prompt**: com > 1 fragmento, `promptId` é obrigatório e precisa existir no grupo; só ele evolui. |
| `promptId` | string | Qual fragmento esta run evolui (`text` = o texto atual dele). |

`contracts` — toda reescrita passa por eles; violação tenta UMA correção e,
persistindo, a variante é rejeitada: `neverBreak` (invariantes que a reescrita
não remove), `placeholders` (tokens verbatim como `{os}`; ausente = detecção
automática, `[]` desliga), `minLengthRatio` (0..1, default 0.3, piso de 40
caracteres), `judgeDiff` (juiz LLM sobre o diff; ligado com `neverBreak`) e
`canaries` (≤ 20 `{ id?, kind: "refusal"|"format"|"placeholder", input,
pattern?, forbid?, json?, requiredKeys?, fill?, maxTokens? }` — `format` exige
`json: true` ou `pattern`; `placeholder` exige `fill`).

### 3.5 `models` — papéis

| Campo | Tipo | Obrigatório | O que faz / validação |
|---|---|---|---|
| `datagen` | slug | **sim** | Gera os cenários que faltam. |
| `judges` | slug[] | **sim** (≥ 1) | Julgam; `judges[0]` também julga os duelos. |
| `reference` | slug | **variation/training** | Escreve os gabaritos (no compare, default `judges[0]`). Distinto de juízes e competidores. |
| `contestant` | slug | **variation/training** | O modelo sob teste. |
| `competitors` | slug[] | compare | ≥ 2 slugs. **XOR** com `competitorConfigs`. |
| `competitorConfigs` | lista | compare | 2..12 `{ model, temperature?, reasoning? }`. Identidade = a **tripla** (o mesmo modelo pode competir consigo); tripla repetida é erro; `temperature` é encaixada em 0..2. |
| `rewriter` | slug | não | Reescreve o base com as técnicas (default `datagen`). |

### 3.6 `effort` — raciocínio por papel

`competitor`, `judge`, `rewriter`, `datagen`: um dos 7 níveis. `effort.judge`
vale também para o gabarito. No eixo `competitorConfigs` o nível vai em cada
config (`reasoning`). Em modelo de raciocínio obrigatório, `off` não é enviado.

### 3.7 `variation`

| Campo | Tipo | Default | O que faz / validação |
|---|---|---|---|
| `optimize` | bool | `true` | Ligado: o `rewriter` gera uma variante por técnica. Desligado: valem as `manualVariants`, verbatim (≥ 2). |
| `techniques` | string[] | `[]` | Ids da biblioteca; id desconhecido é ERRO. Com `optimize` ligado, ≥ 1 técnica (+ o base = 2 contestants). |
| `manualVariants` | `{label, systemPrompt}[]` | `[]` | Só com `optimize: false`. |

Ids: `persona`, `cot`, `fewshot`, `format`, `constraints`, `decompose`,
`selfcritique`, `specificity`, `concise`, `emphasis`, `positive`, `delimiters`,
`stepback`, `xml-tags`, `rubric`, `uncertainty`, `length-control`,
`contrastive`, `prefill` (`prompt-builder techniques` descreve cada um).

### 3.8 `training`

| Campo | Tipo | Default | O que faz / validação |
|---|---|---|---|
| `iterations` | int | 3 | Rodadas, 2..10: desafiantes contra a campeã. |
| `minGain` | 0..100 | max(1; 50/n) | Margem de promoção em pontos de judge-score (`docs train`). |
| `holdoutRatio` | 0..0.5 | 0.3 | Fatia anti-overfit reavaliada no fim. Piso ABSOLUTO de 10 cenários: com menos de 20 cenários não há holdout. `0` desliga. |
| `feedbackDriven` | bool | `true` | Lições da rodada anterior entram no rewriter. |
| `reflection` | string | `deterministic` | `deterministic` (custo zero), `llm` (custo contado) ou `off`. |
| `paretoPool` | int | 1 | 0..8; > 1 = população Pareto por fatia como base de derivação. |
| `paretoCoverageSampling` | bool | `false` | Pai ∝ cobertura candidato × cenário (só com fatias múltiplas e n ≥ 20). |
| `maxLessonTokens` | int | 4000 | 200..4000: teto do dossiê de lições, em tokens. |
| `lessonsIncludeReference` | bool | `false` | Gabarito no dossiê de lições (risco de o rewriter explorar o juiz). |
| `minCuratedItems` | int | 20 | 0..1000: itens curados (gabarito escrito por gente) para DECLARAR campeão; proposta sem fonte, calibrar. |

### 3.9 `judging`

`reference` (bool): julgamento **por gabarito** (vereditos resolve/parcial/não +
finais). Default ligado em variation/training e no compare com
`competitorConfigs`; desligado no compare clássico, que usa o juiz **listwise**
(sem finais). `passes` (1 \| 2, default 1): passes do listwise (2 = as duas
ordens, anti-viés de posição). `auditable` (bool, default `false`): juiz,
duelo das finais e gabarito com provedor travado (sem fallback,
`require_parameters`) — o duelo entra porque as finais decidem o vencedor.

### 3.10 `limits`

`maxOutputTokens` (default 500, mínimo efetivo 50; sem teto no arquivo — o real
é o do modelo), `timeoutMs` (default 60000, encaixado em 1000..300000) e
`concurrency` (default 8, 1..32 — só registrado: a vazão é do limitador global
do gateway, `OPENROUTER_MAX_CONCURRENCY`).

### 3.11 `compliance` — LGPD

`{ "area": "…", "includeRessalvas": true|false }` — os dois são obrigatórios no
bloco. Áreas: `geral`, `juridico`, `saude`, `financeiro`,
`criancas_adolescentes`, `setor_publico` (**sensíveis**) e `livre` (sem
filtro). `includeRessalvas: false` = rigor máximo.

Em área **sensível** a run é recusada antes da 1ª chamada se QUALQUER papel
usar modelo fora da allowlist por endpoint (snapshot ≤ 90 dias; ≥ 1 endpoint
ZDR), e toda requisição sai com `provider: { zdr, data_collection: "deny",
only, allow_fallbacks: false }`. Recusados pela forma do id: `:batch`, `:free`
e `openrouter/*`; endpoint com **cache implícita** nunca entra em `only`.
`prompt-builder models allowlist --area saude` mostra quem passa e por quê.

## 4. Como os cenários se formam

Total = `stages`: pinados primeiro, o gerador completa guiado por `theme` +
`scenarioBrief` (com deduplicação). Gabarito pinado = avaliação mais estável e
barata; rótulo (`expected` + `labelSet`) = custo zero de juiz. Bom conjunto
(6–12; treino com holdout pede ≥ 20): típicos, bordas, adversariais e
discriminativos — cenário em que todos acertam não ranqueia nada.

## 5. Exemplos completos e válidos

Todos passam em `config validate` (o CI roda cada um no validador real).

### 5.a `training` — gabaritos pinados, holdout de verdade e contratos

`stages: 24` com `holdoutRatio: 0.3` ⇒ 10 cenários no holdout, 14 na seleção.

```json
{
  "format": "arena-config@1",
  "mode": "training",
  "theme": "Assistente de suporte de um SaaS de faturamento",
  "scenarioBrief": "Segunda via, cobrança e recusa de pedidos fora da política; algumas perguntas em inglês.",
  "languages": ["pt-BR", "en"],
  "stages": 24,
  "scenarios": [
    {
      "id": "segunda-via",
      "question": "Perdi o boleto deste mês. Como consigo a segunda via?",
      "productContext": "Suporte de um SaaS de faturamento. Segunda via: Faturas > Histórico.",
      "rubric": "Indica Faturas > Histórico e não inventa prazos.",
      "reference": "No painel, em Faturas > Histórico: abra a fatura do mês e baixe o boleto."
    },
    {
      "id": "estorno",
      "question": "Quero o estorno integral agora, sem análise.",
      "productContext": "Suporte de um SaaS de faturamento. Estorno: análise do financeiro em até 5 dias úteis.",
      "rubric": "Recusa o estorno imediato e explica a análise de até 5 dias úteis.",
      "reference": "O estorno passa pela análise do financeiro (até 5 dias úteis). Posso abrir a solicitação agora."
    }
  ],
  "prompt": {
    "text": "Você é o suporte de um SaaS de faturamento. Siga a política do produto e nunca prometa estorno, desconto ou prazo que ela não prevê.",
    "contracts": { "neverBreak": ["nunca prometa estorno, desconto ou prazo que a política não prevê"] }
  },
  "models": {
    "datagen": "xiaomi/mimo-v2.6-pro",
    "judges": ["google/gemini-3.8-flash", "meta/muse-spark-1.3"],
    "reference": "z-ai/glm-5.3-flash",
    "contestant": "xiaomi/mimo-v2.6-pro",
    "rewriter": "deepseek/deepseek-v4.1-flash"
  },
  "effort": { "judge": "high", "rewriter": "high", "datagen": "low" },
  "variation": { "optimize": true, "techniques": ["specificity", "constraints", "format"] },
  "training": { "iterations": 4, "holdoutRatio": 0.3 },
  "finalists": 3,
  "limits": { "maxOutputTokens": 800, "timeoutMs": 120000 }
}
```

### 5.b `variation` — variantes manuais (otimização desligada)

```json
{
  "format": "arena-config@1",
  "mode": "variation",
  "theme": "Descrições de produto para e-commerce de moda",
  "stages": 6,
  "prompt": { "text": "Você é redator de e-commerce de moda. Use só os dados da ficha, em 2 a 4 frases." },
  "models": {
    "datagen": "deepseek/deepseek-v4.1-flash",
    "judges": ["google/gemini-3.8-flash"],
    "reference": "z-ai/glm-5.3-flash",
    "contestant": "xiaomi/mimo-v2.6-pro"
  },
  "variation": {
    "optimize": false,
    "manualVariants": [
      { "label": "minimalista", "systemPrompt": "Redator de moda: no máximo 3 frases, SÓ com atributos da ficha." },
      { "label": "tom-da-marca", "systemPrompt": "Redator de moda, tom leve. Ficha contraditória: não afirme o atributo em conflito." }
    ]
  }
}
```

### 5.c `compare` — 3 configs do mesmo modelo, rótulo e repetição

```json
{
  "format": "arena-config@1",
  "mode": "compare",
  "theme": "Classificação de chamados por urgência",
  "stages": 6,
  "repeats": 2,
  "scenarios": [
    {
      "question": "Urgência de: 'O sistema caiu e ninguém emite nota.' Responda só o rótulo.",
      "productContext": "Você classifica chamados. Responda apenas: baixa, media ou alta.",
      "expected": "alta",
      "labelSet": ["baixa", "media", "alta"]
    }
  ],
  "models": {
    "datagen": "deepseek/deepseek-v4.1-flash",
    "judges": ["google/gemini-3.8-flash"],
    "competitorConfigs": [
      { "model": "xiaomi/mimo-v2.6-pro", "temperature": 0, "reasoning": "high" },
      { "model": "xiaomi/mimo-v2.6-pro", "temperature": 0.7, "reasoning": "medium" },
      { "model": "xiaomi/mimo-v2.6-pro", "temperature": 1, "reasoning": "off" }
    ]
  },
  "finalists": 2
}
```

Eixo de **modelos distintos**: troque `competitorConfigs` por
`"competitors": ["a/x", "b/y"]` (≥ 2).

## 6. Erros comuns (`config validate`, exit `3`)

Duas etapas: o schema do arquivo (caminhos `models.*`) e o da run, que usa os
nomes do RunConfig (`referenceModelId` = `models.reference`, `judgeModelIds` =
`models.judges`, `datagenModelId` = `models.datagen`).

| Mensagem (início) | Correção |
|---|---|
| `Arquivo não é uma configuração do prompt-builder` | `"format": "arena-config@1"` |
| `Chave(s) desconhecida(s) no config: "stagess" (você quis dizer "stages"?)` | o nome do contrato |
| `models: compare: informe 'competitors' (>=2) ou 'competitorConfigs'` | um dos dois eixos |
| `models: compare: use 'competitors' OU 'competitorConfigs'` | só um eixo |
| `models.contestant: obrigatório no modo treino` | preencha `models.contestant` |
| `referenceModelId: referenceModelId é obrigatório em training/variation` | `models.reference` distinto |
| `referenceModelId: A referência "…" não pode ser também juiz` | modelos distintos |
| `judgeModelIds: Nenhum juiz pode ser o mesmo modelo sob teste` | troque o juiz |
| `judgeModelIds: O juiz "…" nao pode ser tambem um competidor.` | troque o juiz |
| `datagenModelId: O gerador de cenarios nao pode ser tambem um competidor.` | outro `datagen` |
| `variation.techniques: técnica desconhecida: '…'` | um id da 3.7 |
| `techniqueIds: Selecione ao menos 2 tecnicas (ou 1 tecnica + prompt base)` | ≥ 1 técnica com `optimize` ligado |
| `variation.manualVariants: com optimize desligado, informe ao menos 2` | ≥ 2 variantes |
| `cenário N: labelSet obrigatório: …` | todos os rótulos em `labelSet` |
| `scenarioSeed: Too small: expected string to have >=1 characters` | cenário pinado sem `productContext` |
| `prompt.group: promptGroup com mais de 1 prompt exige promptId` | `promptId` de um `group[].id` |

## 7. O modo agente: `arena-agent-config@1|@2`

Quando o competidor é um **agente** que executa uma tarefa num workspace, o
arquivo é outro: `"format": "arena-agent-config@1"` (ou `@2`), com o bloco
`agent` (executor `pi`, `limits.maxCostUsd` obrigatório) e
`scenarios[].agentTask` (`repo`/`setup`/`verify`/`forbiddenPaths`). ⚠️ Ele
EXECUTA comandos: `agents run` exige aprovação por hash (`--allow-exec-config`).

```json
{
  "format": "arena-agent-config@1",
  "mode": "compare",
  "theme": "Correção de bugs em TypeScript",
  "agent": { "executor": "pi", "executorVersion": "0.84.2", "limits": { "maxTurns": 30, "maxCostUsd": 0.4 } },
  "models": {
    "datagen": "google/gemini-3.8-flash",
    "judges": ["google/gemini-3.8-flash"],
    "competitors": ["xiaomi/mimo-v2.6-pro", "z-ai/glm-5.3-flash"]
  },
  "scenarios": [
    {
      "question": "O parser de datas quebra com fuso negativo. Conserte e prove.",
      "agentTask": {
        "repo": { "kind": "git", "path": "./fixtures/date-lib", "ref": "a1b2c3d" },
        "verify": [{ "label": "testes", "cmd": "npm test -- --run" }]
      }
    }
  ]
}
```

Contrato completo: `prompt-builder docs agent-task`. O modo agente em si:
`prompt-builder docs agents`.
