# `train` — evoluir um system prompt

```bash
prompt-builder train \
  --model xiaomi/mimo-v2.6-pro \
  --judge google/gemini-3.8-flash --judge meta/muse-spark-1.3 \
  --reference z-ai/glm-5.3-flash \
  --datagen xiaomi/mimo-v2.6-pro \
  --theme "Suporte técnico de um SaaS de faturamento" \
  --base-prompt-file prompt.md \
  --techniques persona,constraints,format \
  --stages 8 --iterations 3 \
  --budget 10 --output-format ndjson
```

Os modelos acima são os defaults por papel (skill `prompt-builder`, `models.md`);
o pré-voo desse exemplo estima ~US$ 6–8 (preços de 2026-09). Orçamento abaixo do
teto estimado recusa com exit `2` antes de gastar — `error.details.estimate.high`
diz o valor que passa.

Ou, melhor para um agente, tudo declarado num arquivo:

```bash
prompt-builder config example --mode train -o arena.json
prompt-builder train --config arena.json --budget 10 --dry-run
prompt-builder train --config arena.json --budget 10 --output-format ndjson
```

## Flags que importam

| Flag | Efeito |
|---|---|
| `--model <id>` | o modelo sob teste (todas as variantes rodam nele) |
| `--judge <id>` | juiz; repita para um painel. **Não pode ser o `--model`.** |
| `--reference <id>` | quem escreve o gabarito — **obrigatório** em `train`/`vary` (sem ele: exit `3`); não pode ser juiz nem o `--model` |
| `--techniques a,b,c` | técnicas de reescrita (`prompt-builder techniques`) |
| `--base-prompt-file` | o prompt de partida; entra como controle |
| `--iterations N` | teto de iterações (2–10; recomendado 3–5). O laço para antes se convergir: paciência = 2 iterações seguidas sem promoção (`patience` 1–5 num RunConfig cru em `--config` — o `arena-config@1` não tem a chave; default 2) ou parada por platão (IC95 do ganho abaixo de `minGain`; `convergenceReason` diz qual foi) |
| `--min-gain N` | margem PRÁTICA mínima em pontos de judge-score para promover. Padrão: `max(1; 50/n)` — meia granularidade (com 8 cenários, 6,25 pontos). Além dela, o gate exige p ajustado ≤ 0,05 (ver abaixo) |
| `--holdout-ratio N` | fatia reservada para o gate final (padrão 0,3; 0 desliga). **Piso absoluto de 10 cenários**: fatia menor não é holdout — é "confirmação fraca" (`holdoutSkipped`) e a palavra "validado" fica bloqueada no resultado |
| `--stages N` | quantos cenários (1–50; **padrão 10 no `train`**, 5 nos outros). Recomendado 6–12; veja a tabela de poder abaixo (`stages ≤ 5` = **modo econômico**, o `estimate` avisa) |
| `--effort-judge high` | o juiz é a tarefa mais sensível — vale gastar aqui |
| `--effort-datagen low` | gerar cenários é mecânico |
| `--finalists N` / `--no-duels` | tamanho da final / desliga a final |
| `--judge-cascade b1,b2:forte` | modo econômico do juiz: 2 juízes baratos votam e o forte só julga os vereditos em dúvida (`docs compare`) |
| `--auditable` | juiz, duelo e gabarito com provedor travado (sem fallback) |
| `--pii-mode synthetic` | recusa dado pessoal de aparência real, sem exceção (vale em `compare`/`vary` também) |
| `--allow-pii` | revisei o dado pessoal apontado: segue pseudonimizado (nomes não cobertos) |

**Precisa de pelo menos 2 contestants**: `técnicas + (1 se houver prompt base)`.
Uma técnica sem prompt base não basta.

## Poder — quantos cenários decidem o quê (Q5)

Com n pequeno o benchmark só detecta efeitos ENORMES. O `prompt-builder estimate`
imprime o plano do seu config (`deltaDetectavelPp`, `nParaDelta`, `poder`), mas a
referência rápida é esta (α=0,05 unilateral, poder 80%, σd=0,5):

| n (cenários) | Δ detectável (p.p.) | | Δ alvo (p.p.) | n necessário |
|---:|---:|---|---:|---:|
| 5 | 55,6 | | 45 | 8 |
| 8 | 43,9 | | 30 | 18 |
| 10 | 39,3 | | 20 | 39 |
| 14 | 33,2 | | 10 | 155 |
| 20 | 27,8 | | | |
| 30 | 22,7 | | | |
| 50 | 17,6 | | | |

- ⚠️ σd=0,5 é **estimativa não calibrada** (tabela): calibre com um piloto
  GRAVADO — `estimate --config <arq> --pilot-run <runId>` (IC95% recomputado das
  etapas da run: régua × vencedor; num compare, 1º × 2º) ou `--pilot-session
  <id>` (a significância gravada da sessão). O σd sai do **limite superior** do
  IC (conservador com n pequeno); piloto com menos de 5 pares efetivos é
  recusado (exit 3, `estimate.pilot_unusable`).
- `stages ≤ 5` = **modo econômico**: com 5 cenários só se decide Δ ≥ 45 p.p.
- **Repetição ≠ observação independente** (ICC/design effect): com `repeats`/`repetitions`
  ≥ 2, `runs show` reporta ICC, DE=1+(m−1)·ICC e nEfetivo = n·m/DE (no texto **e**
  no `--json`, campo `repetition`), com pass@k (estimador de Chen) e pass^k.
  ICC > 0,3 (faixa típica de tarefas agênticas: 0,30–0,77) → cada cenário novo vale
  mais que uma rep nova: **mais cenários**, não mais repetições.
- Holdout: piso absoluto de 10 cenários (abaixo: "confirmação fraca", nunca
  "holdout"). Seleção com menos de 20 cenários não forma holdout.
- **Evolução planeada (não implementada)**: controle de erro sequencial nas
  iterações em cadeia — **alpha-spending** (α gasto por iteração, ex. O'Brien-
  Fleming) ou **e-values** (testes sempre-válidos, sem correção de multiplicidade
  entre olhadas). Hoje o controle é: gate max-T **por iteração** + UM teste final
  em holdout (α=0,05 unilateral, o único p de confirmação da sessão) + paciência ≥
  2 contra parada falsa — que juntos mantêm P(promoção falsa por sessão) ≤ 6% sob
  H0 (ver `test/training-session-sim.test.ts`).

## Como ler o resultado

```bash
prompt-builder sessions winner <sessionId>              # legível
prompt-builder sessions winner <sessionId> --json       # estruturado
prompt-builder sessions winner <sessionId> --prompt-only > prompt.md
prompt-builder sessions report <sessionId>              # relatório de ciclos (docs report)
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
  `min-gain`, `no-pairs`, `reeval`).
- `bestPromptByIteration[].gate.decision: "inconclusive"` — a promoção dependeria
  dos vereditos ausentes (> 10% dos pares); o gate não promove (conta para a
  paciência: 2 iterações seguidas sem promoção encerram o treino).
  Investigue as falhas do juiz antes de rodar de novo.
- `holdoutSkipped: true` — **o campeão não passou pelo gate de holdout**. O
  MOTIVO vem em `holdoutSkipReason`: `min-scenarios` (seleção com < 20 cenários —
  a fatia reservada ficaria abaixo do piso de 10; **suba `--stages`**, não o
  orçamento), `budget` (o teto não cobria o holdout ou a sessão parou por
  orçamento), `cancelled` ou `run-failed` (a run de holdout terminou sem veredito).
  Sem holdout por desenho, `holdoutSkipped` fica falso e o motivo é `disabled`
  (`holdoutRatio: 0`), `no-change` (campeão = prompt base) ou `no-base`. O
  resultado vem como "confirmação fraca" — sem confirmação contra sobreajuste; a
  palavra "validado" não aparece. O `significance` nesse caso tem
  `pOrigin: "selecao"` (p medido na própria run de seleção — anti-conservador); o
  p de confirmação só existe com holdout (`pOrigin: "holdout"`, α=0,05 unilateral).
- "validado em holdout" só aparece quando o holdout (≥ 10 cenários) RODOU, o
  campeão não regrediu e o p unilateral do próprio holdout ficou ≤ 0,05. Holdout
  que rodou sem confirmar sai "NÃO confirmado" com Δ e p (ou "REGREDIU").
- A fatia de holdout **nunca** entra na seleção: a run da iteração 0 cobre todos
  os cenários (é nela que eles nascem), mas o gate, a re-avaliação e as lições
  leem só os cenários de treino (`gate.pairing.n` da iteração 0 = `pinnedStages`).
- `holdout.regressed: true` — o campeão foi **pior** que a base nos cenários
  reservados. `sessions winner <id> --apply <arq>` **recusa** (exit `10`,
  destino intocado); só passa com `--override "<motivo>"`, que fica gravado
  (`docs results`).
- `bestPromptByIteration[].gate.heldBy: ["reeval"]` — a melhor variante passou
  no gate, mas a re-avaliação limpa (`gate.reeval`: minibatch, Δ limpo) não
  confirmou a melhora. Promoção por acaso barrada — não é falha. Com
  `gate.reeval.runStatus` a re-avaliação NÃO terminou (cancelada/sem orçamento/
  erro): não há Δ a ler, e a sessão para ali (`stoppedReason`). As runs de
  re-avaliação ficam em `reevalRunIds` (fora de `runIds`, que é uma run por
  iteração + a do holdout).
- `convergedAtIteration` — o treino parou por falta de ganho, não por falta de
  iterações. Isso é um bom sinal, não uma falha. `convergenceReason` diz o porquê:
  `"patience"` (2 iterações seguidas sem promoção — configurável via `patience`)
  ou `"plateau"` (o IC95 do ganho fica abaixo de `minGain`: nenhum ganho plausível
  alcança a margem).

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
(`mft|invariance|adversarial|edge|benign-twin`), `persona`, `context`,
`successCriteria[]`, `rationale`, `dimensionTags[]` — `pb library seed --profile X
--generate 10 --theme T --model <id>` gera com gabarito por item (seed idempotente
por id) e guarda os metadados do gerador (tier, dimensões, persona, dificuldade,
grupo de invariância, idioma).

Cenários **adversariais** (injeção, extração do system prompt, jailbreak, fuga de
escopo, dado pessoal e o gêmeo benigno que mede recusa excessiva), condicionados
ao prompt que você quer proteger — ≥ 4 por categoria, `single-turn` (ASR@1 é um
limite inferior), com cobertura e custo por cenário no resultado:

```bash
prompt-builder library seed --profile meu-alvo --generate 30 --tier adversarial \
  --base-prompt-file prompt.md --model <id> --budget 1
```

Para mover o banco entre máquinas sem perder campo, `library export -o <dir>`
grava `prompt-builder-exchange@1` (manifest.json + library.jsonl) e
`library add --profile outro --file <dir>` o reimporta idêntico; campo que um
formato não carrega aparece em `lostFields` (nunca some calado).

**Curadoria.** Item curado = `state: "aprovado"` com o `contentHash` do conteúdo
atual (editou depois da revisão, a aprovação caduca). Toda run com
`scenarios.from: "library"` relata `curatedKofN` ("k de n itens curados") no
resultado e, havendo não aprovados, UM aviso agregado (`run.warning` no NDJSON,
stderr no texto) — sem bloquear. `--require-approved` (compare/vary/train)
recusa com exit 3 (`library.unapproved_items`). O **holdout** exige 100%
aprovados quando o perfil usa curadoria (algum item selecionado tem `state`):
senão exit 3 (`library.unapproved_holdout`, ids em `details.holdoutIds`); perfil
sem curadoria nenhuma só avisa.

**Idioma.** O datagen gera 100% em pt-BR. Variar idioma é opt-in:
`--languages pt-BR,en` (em `compare`/`vary`/`train` e no `library seed`) ou
`"languages": ["pt-BR","en"]` no arena-config@1. Cenário de qualquer fonte com
idioma fora da política sai em `languageWarnings` no record da run.

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
