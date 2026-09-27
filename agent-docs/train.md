# `train` — evoluir um system prompt

```bash
prompt-builder train \
  --model openai/gpt-5-mini \
  --judge anthropic/claude-sonnet-5 \
  --datagen openai/gpt-5-mini \
  --theme "Suporte técnico de um SaaS de faturamento" \
  --base-prompt-file prompt.md \
  --techniques persona,constraints,format \
  --stages 8 --iterations 3 \
  --budget 3 --output-format ndjson
```

Ou, melhor para um agente, tudo declarado num arquivo:

```bash
prompt-builder config example --mode train -o arena.json
prompt-builder train --config arena.json --budget 3 --dry-run
prompt-builder train --config arena.json --budget 3 --output-format ndjson
```

## Flags que importam

| Flag | Efeito |
|---|---|
| `--model <id>` | o modelo sob teste (todas as variantes rodam nele) |
| `--judge <id>` | juiz; repita para um painel. **Não pode ser o `--model`.** |
| `--techniques a,b,c` | técnicas de reescrita (`prompt-builder techniques`) |
| `--base-prompt-file` | o prompt de partida; entra como controle |
| `--iterations N` | teto de iterações (2–10). O laço para antes se convergir. |
| `--min-gain N` | margem mínima em pontos de judge-score para promover (padrão 1) |
| `--holdout-ratio N` | fatia reservada para o gate final (padrão 0,2; 0 desliga) |
| `--stages N` | quantos cenários (1–50). Recomendado 6–12. |
| `--effort-judge high` | o juiz é a tarefa mais sensível — vale gastar aqui |
| `--effort-datagen low` | gerar cenários é mecânico |
| `--finalists N` / `--no-duels` | tamanho da final / desliga a final |

**Precisa de pelo menos 2 contestants**: `técnicas + (1 se houver prompt base)`.
Uma técnica sem prompt base não basta.

## Como ler o resultado

```bash
prompt-builder sessions winner <sessionId>              # legível
prompt-builder sessions winner <sessionId> --json       # estruturado
prompt-builder sessions winner <sessionId> --prompt-only > prompt.md
```

- `holdout` — campeão vs. base nos cenários **reservados**. É a evidência de que
  a melhora generaliza.
- `significance` — teste pareado EXATO por troca de sinais (campeão − base por
  cenário). `pValue` é unilateral (o do gate); reporte `pValueTwoSided`. `ci95Pp`
  é o IC95 por inversão do teste, em pontos percentuais — com n ≤ 5 ele é
  `[-100, 100]` (o teste não tem resolução). `pMinUnilateral` = 2^−n′ é o menor p
  possível: com 5 cenários nem o bilateral chega a 0,05. `nEfetivo` conta só os
  pares com observação nos dois lados. `null` = menos de 5 pares.
- `holdoutSkipped: true` — **o campeão não passou pelo gate**. Trate o ganho como
  não verificado.
- `convergedAtIteration` — o treino parou por falta de ganho, não por falta de
  iterações. Isso é um bom sinal, não uma falha.

## Quando o resultado não presta

- **Todos `parcial`** — normalmente o gabarito falhou (modelo de referência
  fraco ou sem crédito) ou não havia gabarito. Confira `--effort-judge` e o
  modelo em `--reference`.
- **Ganho alto no treino e nenhum no holdout** — sobreajuste aos cenários.
  Aumente `--stages` ou o `--holdout-ratio`.
- **Convergiu na iteração 0** — nenhuma variante superou a base pela margem.
  Baixe `--min-gain`, troque as técnicas, ou aceite que a base já é boa.


## Dataset estável — `prompt-builder library`

Evoluir sem banco fixo compara o campeão contra um controle enquanto o **próprio
dataset muda** de run para run. Para treino comparável entre sessões, use a
biblioteca persistente (`<data-dir>/library/<perfil>/`, um JSON por item):

```bash
prompt-builder library init --profile meu-alvo --name "Roteador de voos"
prompt-builder library add --profile meu-alvo --file itens.json
prompt-builder library verify --profile meu-alvo    # exit 3 se faltar gabarito
prompt-builder library coverage --profile meu-alvo  # tier × dimensão + lacunas
```

E no `arena-config@1`, aponte o banco em vez de pinar cenários:

```json
"scenarios": { "from": "library", "profile": "meu-alvo", "ids": ["t-001", "t-002"] }
```

Itens sem gabarito (`reference` textual OU `expected` de rótulo) são **recusados**
no evolve (paridade com o 409 do prompt-arena). Item enriquecido: `title`, `tier`
(`mft|invariance|adversarial|edge`), `persona`, `context`, `successCriteria[]`,
`rationale`, `dimensionTags[]` — `pb library seed --profile X --generate 10
--theme T --model <id>` gera com gabarito por item (seed idempotente por id).

## Rótulo esperado = veredito sem juiz (`expected`)

Cenário classificável (rotear intenção, moderar, escolher workflow) ganha
`expected`: `"edit"` (rótulo único), `["edit","help"]` (alternativas) ou
`{"intent":"edit"}` (resposta JSON). O veredito vira **determinístico**, o juiz
LLM é contornado (custo zero) e os duelos são decididos pelo oráculo.

## Evolução segura (arena-config)

- **`prompt.contracts`** — contratos never-break: `neverBreak[]` (invariantes que
  a reescrita não pode remover), `placeholders[]` (tokens verbatim) e
  `minLengthRatio`. Toda variante é validada; violação tenta UMA correção e
  persistindo a variante é **rejeitada**.
- **`prompt.group` + `prompt.promptId`** — multi-prompt (coordinate ascent): a
  feature tem vários fragmentos; a sessão evolui **um** e os irmãos ficam
  congelados (contexto fixo no rewriter; o system prompt efetivo é a composição).
  Com >1 fragmento, `promptId` é obrigatório.
- **`training.reflection`** — `deterministic` (default, zero custo) | `llm`
  (meta-modelo reescreve as lições GEPA; degrada se falhar) | `off`.
- **`training.paretoPool`** — >1 mantém uma **população Pareto** (prompts
  não-dominados por fatia tier/dimensão) e rotaciona a base de derivação entre
  eles; a régua do `minGain` continua sendo o campeão. `session.pool` mostra o
  front final.
- **`repeats`** (só compare, 1–3) — cada cenário roda N× para medir instabilidade.
