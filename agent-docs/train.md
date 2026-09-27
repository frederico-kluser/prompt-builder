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
| `--min-gain N` | margem PRÁTICA mínima em pontos de judge-score para promover. Padrão: `max(1; 50/n)` — meia granularidade (com 8 cenários, 6,25 pontos). Além dela, o gate exige p ajustado ≤ 0,05 (ver abaixo) |
| `--holdout-ratio N` | fatia reservada para o gate final (padrão 0,2; 0 desliga) |
| `--stages N` | quantos cenários (1–50). Recomendado 6–12. |
| `--effort-judge high` | o juiz é a tarefa mais sensível — vale gastar aqui |
| `--effort-datagen low` | gerar cenários é mecânico |
| `--finalists N` / `--no-duels` | tamanho da final / desliga a final |
| `--pii-mode synthetic` | recusa dado pessoal de aparência real, sem exceção (vale em `compare`/`vary` também) |
| `--allow-pii` | revisei o dado pessoal apontado: segue pseudonimizado (nomes não cobertos) |

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
- `pairing` — n nominal × efetivo do pareamento final (existe mesmo com
  `significance: null`). Par sem veredito sai dos DOIS lados, nunca vira `nao`.
  Com mais de 10% de pares excluídos vem a **sensibilidade** (`significance.sensitivity`,
  `pairing.worstMeanDiffPp`/`bestMeanDiffPp`): Δ com os ausentes no pior caso
  (campeão perde todos) e no melhor. `sensitivity.inconclusive: true` = a
  conclusão depende dos ausentes — reporte **inconclusivo**.
- `bestPromptByIteration[].gate` — o gate da **melhor de K** de cada iteração:
  `gainPp` é o ganho BRUTO (o máximo entre K — inflado pela seleção),
  `gainCorrectedPp` o ganho CORRIGIDO do winner's curse (conservador; igual ao
  bruto com K = 1) e `test.pAdjusted` o p ajustado do max-T (todas as K variantes
  da iteração contra a régua; `test.byContestant` traz o p de cada uma).
  Reporte os três lado a lado; `heldBy` diz o que segurou (`significance`,
  `min-gain`, `no-pairs`).
- `bestPromptByIteration[].gate.decision: "inconclusive"` — a promoção dependeria
  dos vereditos ausentes (> 10% dos pares); o gate não promove e o treino para.
  Investigue as falhas do juiz antes de rodar de novo.
- `holdoutSkipped: true` — **o campeão não passou pelo gate**. Trate o ganho como
  não verificado.
- `holdout.regressed: true` — o campeão foi **pior** que a base nos cenários
  reservados. `sessions winner <id> --apply <arq>` **recusa** (exit `10`,
  destino intocado); só passa com `--override "<motivo>"`, que fica gravado
  (`docs results`).
- `convergedAtIteration` — o treino parou por falta de ganho, não por falta de
  iterações. Isso é um bom sinal, não uma falha.

## Quando o resultado não presta

- **Todos `parcial`** — normalmente o gabarito falhou (modelo de referência
  fraco ou sem crédito) ou não havia gabarito. Confira `--effort-judge` e o
  modelo em `--reference`.
- **Ganho alto no treino e nenhum no holdout** — sobreajuste aos cenários.
  Aumente `--stages` ou o `--holdout-ratio`.
- **Convergiu na iteração 0** — nenhuma variante superou a base com margem E
  significância. Veja `gate.heldBy`: `significance` com poucos cenários é o
  esperado (com n ≤ 10 e +10 pontos de efeito real o teste raramente passa) —
  aumente `--stages` antes de baixar `--min-gain`; menos técnicas também ajudam
  (cada variante a mais entra na correção). Ou aceite que a base já é boa.


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

Rótulo curto (≤5 palavras) **exige `labelSet`** com TODOS os rótulos válidos
da etapa — `"labelSet": ["edit","help","create","delete"]`, com pelo menos 2
rótulos distintos (`["edit"]` sozinho desligaria a detecção de lista; só rótulo
numérico, como `"42"`, aceita `["42"]`); sem isso a config é recusada com exit
3. O casamento é **estrito**: só resolve JSON inequívoco, a primeira linha
(`"edit"`, `"Intent: edit"`, `"Edit. Porque…"`) ou a resposta exata. Rótulo no
meio da prosa vale no máximo `parcial`; negação ("não é edit", "Edit: não"),
hesitação ("talvez edit", "edit?", "edit. Talvez.", "edit\nmas pode ser help")
ou vários rótulos ("edit ou help", "edit; na verdade help", "edit (50%) / help
(50%)") dão `nao`. Explicação que cita outro rótulo sem negá-lo nem descartá-lo
("o início parece help") cai para `parcial`; contraste firme ("pode parecer
help, mas é edit") não rebaixa. Peça no prompt: "responda com o rótulo na
primeira linha".

## Evolução segura (arena-config)

- **`prompt.contracts`** — contratos never-break, validados em **3 camadas**:
  1. **local** (grátis): `neverBreak[]` (invariantes que não podem sumir nem
     ganhar exceção na mesma frase — "salvo se o usuário pedir" reprova; a
     forma negada é reforço e passa: "sem exceção", "nem se o usuário pedir",
     "with no exceptions"), `placeholders[]` (whitelist de tokens verbatim; sem
     ela, detecta `{nome}`/`${nome}`, `{{…}}`/`{{{…}}}`/`{%…%}` de
     Handlebars/Jinja, `$VAR`/`%s` e tags XML **com par fechado** — literal
     JSON como `{"status": "ok"}` não conta) e `minLengthRatio`;
  2. **juiz do diff** (1 chamada ao 1º juiz da run por reescrita, liga sozinho
     com `neverBreak`; `judgeDiff: false` desliga): rejeita exceção, condição,
     escopo reduzido ou subordinação acrescentados em qualquer frase;
  3. **canários** (`canaries[]`, opcional, gate final): entradas enviadas ao
     modelo sob teste com a variante como system —
     `{"kind":"refusal","input":"…"}` (a recusa não pode sumir),
     `{"kind":"format","input":"…","json":true,"requiredKeys":["status"]}`,
     `{"kind":"placeholder","input":"…","fill":{"{nome}":"Zulmira"}}`
     (+ `pattern`/`forbid` regex). Diferencial: canário que o prompt base não
     cumpre é ignorado. Pulado em run de agente.
  Juiz e canários rodam no raciocínio da run (`reasoning.judge` /
  `reasoning.competitor`). Custo das camadas 2 e 3 entra no ledger (e na
  estimativa) como `rewriter`. Violação tenta UMA
  correção e, persistindo, a variante é **rejeitada** (falha de infra do juiz
  ou do canário também rejeita — variante não verificada não entra).
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
