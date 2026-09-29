# Calibração juiz × humano (`calib`)

O juiz LLM dá as notas de toda run. `calib` responde **"o juiz serve neste
domínio?"** comparando os vereditos dele com os de **pessoas**, num conjunto
rotulado por você. Só disco: sem key, sem rede, **sem gasto**.

O que o código NÃO faz por você: rotular. Os rótulos humanos (≥ 2 anotadores
por item, às cegas) são trabalho humano — um agente pode montar o arquivo, rodar
o relatório e ler o resultado, mas **nunca inventar rótulos**. Item inventado
vai com `"synthetic": true` e o relatório com sintético nunca fica "pronto".

## Ordem obrigatória

1. **Piloto** (30–50 itens) — só anotador × anotador:
   `prompt-builder calib report --file <arq> --pilot`. Se o α humano ficar
   abaixo de **0,667**, a rubrica/instrução de anotação está ruim: corrija,
   adjudique e refaça o piloto. Medir o juiz contra humanos que discordam entre
   si é medir ruído — por isso o juiz nem é lido no piloto.
2. **Conjunto completo** (≥ 150 itens, ≥ 30 por classe de veredito e por tipo
   de tarefa) com o veredito do juiz rotulado **depois** dos humanos:
   `prompt-builder calib report --file <arq>`. O juiz só é medido com α humano
   ≥ 0,667.
3. **Juiz aceitável** = α juiz × humano ≥ 0,667 **e** dentro da faixa
   humano × humano nos mesmos itens (α do juiz ≥ limite inferior do IC95% do
   α humano).

```bash
prompt-builder calib template -o data/calibration/suporte.jsonl   # exemplo comentado (itens SINTÉTICOS)
prompt-builder calib report --file data/calibration/suporte.jsonl --pilot
prompt-builder calib report --file data/calibration/suporte.jsonl --json
prompt-builder calib report --file data/calibration/suporte.jsonl --strict   # CI: exige o protocolo inteiro
```

## Formato `calibration-jsonl@1`

Um item JSON por linha; linhas vazias e linhas começando com `#` são
comentário. Um arquivo por domínio (`data/calibration/<dominio>.jsonl`).
**Chave desconhecida é erro** (um typo como `judgeVerdit` sumiria com o rótulo
do juiz em silêncio); metadado livre vai em `meta` ou numa chave `_…`.

```json
{"id": "sup-001", "domain": "suporte", "taskType": "factual", "question": "Qual o prazo de troca?", "candidate": "30 dias corridos.", "reference": "30 dias.", "humanLabels": [{"annotator": "a1", "verdict": "resolve"}, {"annotator": "a2", "verdict": "resolve"}], "judgeVerdict": "resolve", "judgeModel": "anthropic/claude-sonnet-5", "gold": "resolve"}
```

| Campo | Obrigatório | O que é |
|---|---|---|
| `id` | sim | único no arquivo |
| `domain` | sim | o domínio do arquivo (misturar domínios é pendência) |
| `taskType` | sim | `extracao`, `factual`, `raciocinio`, `formato`, `recusa`, `aberta` (outro valor = aviso) |
| `question`, `candidate` | sim | o pedido e a resposta julgada |
| `reference` | não | o gabarito mostrado ao juiz |
| `humanLabels` | sim | `[{annotator, verdict, note?}]` — ≥ 2 anotadores **distintos**; item com menos fica fora do α |
| `judgeVerdict` | não | veredito do juiz em calibração (`resolve`/`parcial`/`nao`, sem til) |
| `judgeModel` | não | qual juiz/contrato produziu o veredito (um setup por arquivo) |
| `gold` | não | rótulo **adjudicado** — habilita sensibilidade/especificidade |
| `synthetic` | não | `true` só em exemplo/teste |

`annotator` é um **pseudônimo** estável — nunca nome ou e-mail. O arquivo é
versionado: o relatório varre `question`/`candidate`/`reference` atrás de dado
pessoal e avisa no stderr.

## O que o relatório calcula

- **α ordinal de Krippendorff** (matriz de coincidências; só a ordem
  `nao < parcial < resolve` importa) — a métrica do portão.
- **AC2 de Gwet** com pesos ordinais — reportado junto porque, com prevalência
  desbalanceada (quase tudo `resolve`), o α despenca mesmo com concordância
  quase perfeita. α baixo com AC2 alto = olhe a distribuição de classes antes
  de culpar os anotadores.
- **IC95%** de ambos por bootstrap percentil **por item** (semeado:
  `--seed`, default 58; `--resamples`, default 2000) — reproduzível.
- **Juiz × humano** por unidades replicadas (juiz, anotador_k): um α de 2
  codificadores, comparável ao humano × humano; mais o Δ juiz − humano com IC
  pareado.
- **Com `gold`**: sensibilidade `P(juiz=resolve | ouro=resolve)`,
  especificidade `P(juiz≠resolve | ouro≠resolve)`, acerto exato (IC de Wilson)
  e a matriz de confusão 3×3 — a base da correção de viés do score.

Faixas: α ≥ 0,800 confiável · 0,667–0,800 tentativo · < 0,667 insuficiente.

## Saída (`--json`)

Sucesso: `{ok:true, command:"calib.report", data:{file, report, pii, warnings}}`.
Campos de `report` (`calibration-report@1`) que decidem:

<!-- docs-lint: snippet -->
```json
{
  "mode": "full",
  "human": {"alpha": 0.81, "alphaCi95": {"low": 0.76, "high": 0.86}, "ac2": 0.87, "pairs": []},
  "judge": {"status": "measured", "agreement": {"alpha": 0.74}, "withinHumanBand": false, "acceptable": false,
            "gold": {"sensitivity": {"value": 0.9}, "specificity": {"value": 0.85}}},
  "readiness": {"ready": false, "issues": ["…"]},
  "gate": {"passed": false, "code": "gate.calibration_judge_outside_human_band", "reasons": ["…"]}
}
```

`judge.status: "skipped"` traz `reason`: `pilot`, `human_alpha_below_min` ou
`no_judge_labels`.

## Códigos de saída

| Exit | `error.code` | Quando |
|---|---|---|
| 0 | — | portão aprovado (α humano ≥ 0,667; e, se o juiz foi medido, juiz aceitável) |
| 10 | `gate.calibration_human_alpha_low` | α humano < 0,667 **ou indefinido** (fail-closed) |
| 10 | `gate.calibration_judge_alpha_low` | α juiz × humano < 0,667 |
| 10 | `gate.calibration_judge_outside_human_band` | juiz abaixo da faixa humano × humano |
| 10 | `gate.calibration_not_ready` | só com `--strict`: pendência de prontidão |
| 3 | `config.calibration_invalid` | arquivo inválido (`details.errors[]` com a linha) |
| 2 | `usage.file_unreadable` / `usage.missing_file` | caminho errado / sem `--file` |

No exit 10 o relatório inteiro vai em `error.details.report` — o agente lê os
números sem rodar de novo. **Não contorne o portão**: ele diz que as notas do
juiz não podem ser publicadas como medida neste domínio.

**Prontidão** (`report.readiness`) não reprova sem `--strict`: diz se o
conjunto cumpre o protocolo (≥ 150 itens, ≥ 30 por classe e por tipo de tarefa,
IC do α com largura ≤ 0,2, nenhum item sintético, um domínio e um juiz).
