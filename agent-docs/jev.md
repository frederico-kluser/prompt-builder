# Modo JEV — decisões tipadas (noul/choice/score)

O modo JEV **mede e evolui definições de decisão** para o Jev (TypeSafe, via
OpenRouter) e outros modelos de decisão (Solar Decide, Kev-4b, Span-01). Ele
não gera texto: recebe um **estado** (texto/JSON) e **perguntas tipadas**, e
devolve distribuições:

- `noul` — sim/não → `P(sim)` (sem `confidence`);
- `choice` — 1 de N opções (≤ 255) → probabilidades + `confidence`;
- `score` — régua ordenada (≤ 10 níveis, índice 0 = mais baixo) → E[nível] + probabilidades + `confidence`.

**Quando usar JEV × LLM.** JEV para classificação, roteamento, triagem,
guardrail e scoring em ALTO volume: ~US$ 0,00002 por request, 0,3 s. LLM para
gerar texto, raciocinar em várias etapas, contas e datas. O JEV **mede**; ele
não "melhora" a acurácia de um LLM. Espere acurácia igual ou menor que LLMs
médios, custo e latência muito menores. O ganho aparece na **cascata**: o Jev
decide o que cai na banda de confiança e escala o resto para o LLM.

## Começo rápido

```bash
prompt-builder jev example --kind triagem --mode eval -o jev.json
prompt-builder jev validate jev.json
prompt-builder jev run -c jev.json --dry-run --budget 0.05
prompt-builder jev run -c jev.json --budget 0.05 --json
prompt-builder jev report <runId> --markdown relatorio.md
```

`jev validate` e `--dry-run` não gastam nada, e o `--dry-run` não precisa de key.
O catálogo de modelos de decisão é público:

```bash
prompt-builder jev models --json
```

## `jev-config@1`

Formato próprio, irmão do `arena-config@1`. É estrito: chave desconhecida dá
exit 3. Os casos vão **inline** ou em `cases: {"path": "casos.jsonl"}`
(relativo ao config, só no CLI; o MCP aceita só inline).

```json
{
  "format": "jev-config@1",
  "mode": "eval",
  "theme": "Triagem de tickets",
  "language": "pt-BR",
  "spec": {
    "questions": {
      "team": {
        "type": "choice",
        "instructions": "Qual time deve assumir o ticket descrito em `ticket`?",
        "criteria": {
          "pagamentos": { "what": "Cobrança, checkout, estorno", "not_for": "Tela quebrada sem cobrança" },
          "frontend": "Tela, layout, botão que não responde",
          "outro": null
        }
      },
      "is_bug": {
        "type": "noul",
        "instructions": "O cliente relata um defeito de software?",
        "criteria": { "true": "Algo do produto quebrado", "false": "Pergunta, pedido ou elogio" }
      }
    }
  },
  "cases": [
    { "id": "a1", "state": { "ticket": "O cartão foi recusado no checkout." }, "expected": { "team": "pagamentos", "is_bug": true } },
    { "id": "a2", "state": { "ticket": "O botão Salvar não responde." }, "expected": { "team": "frontend", "is_bug": true } },
    { "id": "a3", "state": { "ticket": "Vocês têm vaga de estágio?" }, "expected": { "team": "outro", "is_bug": false } },
    { "id": "a4", "state": { "ticket": "Fui cobrado duas vezes este mês." }, "expected": { "team": "pagamentos", "is_bug": true } },
    { "id": "a5", "state": { "ticket": "Queria um modo escuro no app." }, "expected": { "team": "frontend", "is_bug": false } }
  ],
  "models": { "decision": ["typesafe/jev-1.13"] },
  "repeats": 1,
  "budgetUsd": 0.05
}
```

Campos da raiz:

| campo | o que faz |
|---|---|
| `mode` | `eval` (1 competidor), `compare` (≥ 2; o 1º é o controle), `train` (evolui a definição). O verbo do CLI (`jev eval/compare/train`) sobrescreve. |
| `spec` | a definição: `questions` (mapa id → pergunta), `stateView` (projeção do estado: `{fields:[{from, as, maxChars}]}`) e `policy` (bandas por pergunta). |
| `variants` | `[{label, spec:{questions:{…}}}]`: reescreve perguntas existentes (compare). |
| `models.decision` | modelos de decisão (default `typesafe/jev-1.13`). |
| `models.llm` | LLMs na MESMA decisão: `{modelId, reasoning, temperature, batching:"per-question"\|"per-case"}`. |
| `repeats` | repetições por caso (1–5). O Jev não é determinístico; com 2+ sai o `flipRate`. |
| `bands` | limiares por TIPO. Default choice/score `auto 0,90 / hitl 0,50` sobre `confidence`; noul `auto 0,90 / hitl 0,60` sobre `max(p,1−p)`. |
| `fit` | ajusta temperatura + limiares no split `calib` (default ligado no eval). |
| `compare.primary` | `accuracy` (default com LLM) ou `brierScore`. |
| `train` | `iterations`, `variantsPerIteration`, `repeats`, `targetQuestions`, `operators`, `rewriterModelId`, `metric` (`brier-cal`\|`accuracy`), `minGainPp`, `maxAccuracyDropPp`, `patience`, `targetPrecision`. |
| `split` | `holdoutRatio`, `calibrationRatio`, `seed`, `stratifyBy` (estratificado e determinístico; o `split` pinado no caso vence). |
| `budgetUsd`, `compliance`, `piiMode`, `allowPii` | como no resto do produto. |

Regras do fio (verificadas ao vivo; o lint recusa antes de gastar):

- `noul.criteria` é opcional, mas quando vem precisa das **duas** chaves, `true` e `false`, não nulas.
- `choice` aceita rubrica `null` e objeto `{what, not_for, examples}`. O limite é 255 opções.
- `score`: de 2 a 10 níveis, do mais baixo ao mais alto. Descreva **situações**, não números.
- O **nome da opção é lido pelo modelo** e domina a rubrica (5 de 6 respostas seguiram o nome trocado). Chave como `yes`/`no` dispara aviso. Renomeie para o conceito e use `keyMap` (`{chaveNoFio: rótuloDoOuro}`).
- O id da pergunta nunca vai ao modelo: escreva a pergunta inteira em `instructions`.
- Estado vazio é erro nosso (a API aceita e cobra).

## Casos rotulados

| formato | forma |
|---|---|
| JSONL | um caso por linha: `{id?, state, expected:{qid: valor\|[alternativas]}, split?, tags?}` |
| CSV | colunas `id`, `state` ou `state.<caminho>`, `expected.<qid>` (`a\|b` = alternativas), `split`, `tags` (`;`) |
| `jev-dataset@1` | `{format, cases:[…]}` |
| `evals.json` da jev-agent-skill | `[{name, state, questions, expected}]`: a definição sai do próprio arquivo |

O ouro é normalizado por tipo. Em `noul` valem `true/false/sim/não/1/0`. Em
`choice` vale o rótulo (ou a chave do fio, traduzida pelo `keyMap`). Em `score`
vale o índice do nível ou o texto exato dele. Erros saem com linha e coluna.

```bash
prompt-builder jev import --from tickets.csv --spec jev.json -o casos.jsonl
```

Sem id, o caso recebe o hash do estado. Ids duplicados são descartados com aviso.

## Subcomandos

```bash
prompt-builder jev validate jev.json --strict
prompt-builder jev eval -c jev.json --budget 0.05
prompt-builder jev compare -c jev.json --budget 0.10 --repeats 2 --output-format ndjson
prompt-builder jev train -c jev.json --budget 0.50
prompt-builder jev list --kind session
prompt-builder jev show <id> --json
prompt-builder jev report <id> --json
prompt-builder jev export <sessionId> --request -o req.json
prompt-builder jev techniques
```

Sem `--budget` e fora de um terminal, `run`/`eval`/`compare`/`train`
**recusam** (exit 2, nada gasto). O `--dry-run` percorre a MESMA sequência de
recusas da execução real: orçamento, lint, LGPD/PII, lock da config e teto
diário. Sem key, ele lista em `requires` o que falta. Mesma config em outro
processo gera `run.locked`; use `--allow-concurrent` só para réplica
intencional.

## Métricas

As métricas cobrem as perguntas × casos com ouro. Casos **incompletos** (corte
por orçamento ou cancelamento) ficam FORA de tudo. Célula com erro de
infraestrutura fica **sem nota** e sai dos dois lados do pareamento. Resposta
fora do contrato conta **errada**, com p uniforme.

| métrica | definição |
|---|---|
| acurácia | noul `p ≥ 0,5`; choice argmax; score `\|E[ŝ] − y\| ≤ 0,5` |
| macro-F1 | média das classes (noul/choice) |
| Brier (`brierScore` = 100·(1−Brier)) | noul `(p−y)²`; choice `½Σ(p−1[k=y])²`; score = RPS normalizado |
| Brier pior-caso | igual, com resposta inválida = 1 (o LLM que falha no parse não sai "melhor") |
| log-loss | `−ln max(0,001, p_ouro)` (o fio arredonda em 2 casas) |
| ECE top-label | 10 bins de largura igual e de massa igual, sobre **p da classe prevista** (nunca o `confidence` opaco) |
| bandas | `auto` ≥ limiar auto; `hitl` ≥ limiar hitl; senão `abstain`. Cobertura e precisão em auto, e "errado com confiança" |
| AURC / AUROC | risco × cobertura ordenado pelo sinal; o sinal separa acerto de erro? |
| latência | p50/p95 nearest-rank, sem a 1ª request (fria) |
| custo | **medido** (`usage.cost`): US$ por 1k requests e por 1k decisões; `costExact=false` se houve chamada sem usage ou pendente |

A comparação contra o controle é **pareada por caso**. O Brier usa sign-flip
com IC95%, e a acurácia usa McNemar exato, ambos com p **bilateral**. A
cascata vem de `jev compare` com decisão + LLM: o Jev decide na banda auto e o
resto escala. Ela reporta acurácia × % escalado × US$/1k e quanto é preciso
escalar para empatar com o LLM.

Calibração pós-hoc (`fit`): a temperatura por pergunta é ajustada no split
`calib` (NLL) e os limiares são escolhidos para a precisão-alvo (default 0,95).
Os números calibrados são medidos **fora** do `calib`. `choice`/`score`
costumam sair superconfiantes; `noul`, subconfiante.

## Treino (evolução da definição)

A cada ciclo o treino gera variantes das perguntas-alvo e avalia a campeã e as
variantes no treino inteiro, intercaladas. Uma variante é **promovida** quando:

- o p ajustado (max-T, melhor de K) é ≤ 0,05;
- o ganho é ≥ `minGainPp` (em 1−Brier calibrado por variante, ou em acurácia);
- a acurácia não cai mais que `maxAccuracyDropPp`;
- o snapshot do modelo não mudou.

Operadores da v1:

- `add_examples` (determinístico, grátis): copia casos do **treino** para `examples` da rubrica. Esses casos saem do gate daquele ciclo.
- `add_not_for`, `describe_option`, `literalize`: proponente LLM (`rewriterModelId`, papel `rewriter`).

O **contrato never-break** recusa sem gastar a variante que muda tipo, rótulos,
nº/ordem de níveis, pergunta de guarda, pergunta congelada ou projeção.

No fim vêm a política (T + limiares) ajustada no `calib` e o **holdout
intocado**: original × campeã, todas as perguntas. O relatório de ciclos
(`jev report <sessionId>`) responde três perguntas: quanto melhorou, quanto a
mudança mexe no custo de USAR (só tokens de ENTRADA, porque a saída é grátis)
e quanto custou otimizar.

`jev techniques` mostra o mapa das 19 técnicas de prompt LLM no Jev:

- 2 transferem direto (specificity, rubric);
- 9 mudam de lugar: few-shot vira exemplo dentro da rubrica, contrastive vira
  `not_for`, uncertainty vira opção de saída + bandas + temperatura, concise vira
  estado enxuto;
- 8 não se aplicam, porque o Jev não gera texto (persona, CoT, formato,
  autocrítica…).

## Custo

O Jev cobra US$ 0,042 por milhão de tokens de **entrada**; a saída é grátis. O
piso é de ~270–400 tokens por request mesmo com estado vazio, então o número
de requests pesa mais que o tamanho do estado. Uma run de 200 casos × 2
definições × 2 reps sai por cerca de US$ 0,03. O custo vem sempre de
`usage.cost`, somado no mesmo ponto do resto do produto. Um 400 do provedor
com id de geração fica **pendente** (pode ter sido cobrado), nunca "grátis".

## LGPD e dado pessoal

O estado e as perguntas passam pela cascata de pseudonimização antes do envio,
em qualquer profundidade. O pré-voo varre os **estados** inteiros, e uma chave
como `clienteId` não esconde um CPF. Com dado de aparência real a run recusa
(exit 3): revise e confirme com `--allow-pii`, ou use `piiMode: "synthetic"`.
Em área sensível (`compliance.area`), o modo JEV fica **indisponível na v1**:
nenhum modelo de decisão está na allowlist ZDR, e a recusa é fail-closed antes
de qualquer request.

## Armadilhas

- **Alias**: `~typesafe/jev-latest` muda de snapshot. Fixe `typesafe/jev-1.13` para calibrar limiares. A run grava `resolvedModels`, e a deriva interrompe o treino.
- **Rótulo sintético**: o modo MEDE contra ouro. Rótulo gerado por IA cria circularidade (a v1 só aceita casos importados).
- **pt-BR**: o Jev não tem avaliação oficial fora do inglês. Os números do seu dataset SÃO a avaliação.
- **Contas, datas e contagens**: são falhas documentadas (jaggedness). Calcule em código e envie o resultado no estado.
- **`confidence` ≠ probabilidade**: ele decide a banda e nunca entra no ECE.

## Códigos de saída e NDJSON

| exit | quando |
|---|---|
| 0 | concluída |
| 2 | uso inválido, incluindo sem `--budget` fora de TTY |
| 3 | config/lint/dataset inválido, `jev.dataset_too_small`, recusa LGPD/PII, `jev.spec_rejected` (400 da API; o gasto até a recusa vem em `details.spentUsd`) |
| 4 / 5 | key recusada / sem crédito |
| 6 | inconclusiva: > 10% das células sem nota, ou < 5 casos pontuados numa pergunta |
| 7 | parcial por orçamento (`ok:true`, `stoppedReason:"budget"`) |
| 8 | rede |
| 10 | `jev export` com holdout regredido (use `--override "<motivo>"` só por decisão humana) |
| 130 | Ctrl-C/SIGTERM (parcial salvo) |

Com `--output-format ndjson` saem, uma por linha, as linhas `jev.started`,
`jev.progress`, `jev.contestant` (manchete das métricas), `jev.iteration`,
`jev.budget` e `jev.finished`/`jev.session`, e por último **sempre** `result`.
`jev.cell` sai só com `--emit-cells`. Nenhuma linha traz estado de caso nem
texto de rubrica.

## Interop com a jev-agent-skill

- `jev import --from evals.json` lê o formato de eval da skill: a definição sai das próprias perguntas.
- `jev export <sessionId> --request -o req.json` produz o `DecisionsRequest` da definição campeã (troque `"<<STATE>>"` pelo estado) e é a entrada de `jev.mjs ask --file` / `batch`.
- O handoff completo (`jev export` sem `--request`) leva a política POR PERGUNTA. O `jev.mjs` aplica UM par de limiares a todas e não aplica temperatura.

## MCP

`start_run`/`estimate_cost` aceitam `jev-config@1` (casos inline). `get_result`
lê runs e sessões JEV. `list_models {"modality":"decisions"}` lista os modelos
de decisão.
