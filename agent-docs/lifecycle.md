# Ciclo de vida dos modelos

O catálogo do OpenRouter muda por baixo das suas runs: em ~99 dias, ~19% dos
ids sumiram. Pior que sumir é **mudar sem mudar de nome**: um alias
`~vendor/…-latest` passa a apontar para outro snapshot e a mesma run, com o
mesmo id, é julgada por outro modelo. Regra do prompt-builder: **nunca migrar
sozinho** — ele grava, avisa e exige uma decisão declarada.

## O que toda run grava

`RunRecord.modelLifecycle` — uma entrada por modelo da run (competidores,
juízes, gabarito, datagen, reescritor), lida do catálogo no início da run:

```json
{
  "capturedAt": "2026-09-27T12:00:00.000Z",
  "source": "catalog",
  "models": {
    "anthropic/claude-sonnet-5": {
      "roles": ["judge", "reference"], "inCatalog": true,
      "canonicalSlug": "anthropic/claude-sonnet-5-20260630",
      "expirationDate": null, "aliasTarget": null
    }
  },
  "alerts": []
}
```

- `canonicalSlug` — o snapshot datado por trás do id.
- `expirationDate` — a data de deprecação publicada (AAAA-MM-DD); `null` = sem data.
- `aliasTarget` — para quem um alias `~…-latest` apontava **naquele dia**.
- `source: "unavailable"` — o catálogo não carregou; nada é afirmado.

Logo depois de atualizar o CLI, o catálogo em cache (24 h) pode ser de uma
versão que não lia esses campos — eles saem `null`. `--refresh-models` resolve.

## Alertas 30 / 14 / 7 dias

Um modelo com `expirationDate` a até 30 dias gera alerta (janelas de 30, 14 e
7 dias) com um **sucedâneo**: declarado por você, nomeado pelo catálogo (um
alias do mesmo vendor e família) ou, na falta, sugerido por heurística — este
último é só sugestão, confirme antes de usar. Data mais distante não avisa e
não falha. Onde aparece:

```bash
prompt-builder models list --expiring 30        # o que sai nos próximos 30 dias
prompt-builder models show openai/gpt-5-mini     # snapshot, alias e expiração
prompt-builder runs show <runId>                # alertas gravados na run
```

Nas runs, os alertas vão para o stderr e ficam em `modelLifecycle.alerts`.

## Política de remoção

| Situação | Ação |
|---|---|
| Modelo sumiu ou expirou (padrão) | **congelar as respostas já gravadas e re-pontuar** — sem regerar, sem trocar o modelo em silêncio |
| Expiração anunciada **e** sucessor nomeado | **run-ponte**: modelo atual × sucessor nos mesmos cenários, antes da data; a re-baseline parte dela |
| Juiz/gabarito removido **sem** sucessor nomeado | **baseline inválida** — declare e refaça a baseline |

Sucessor "nomeado" = declarado por você (`successors` do arquivo de baseline)
ou apontado por um alias do catálogo. Sugestão heurística não conta.

## Gate de CI: juiz/gabarito só mudam com re-baseline declarada

Notas só são comparáveis sob o **mesmo contrato de julgamento**: mesmos juízes,
mesmo gabarito, mesmo prompt de juiz e o mesmo snapshot por trás de cada id.

```bash
# 1. pina o contrato da run que é a sua baseline (versione o arquivo)
prompt-builder baseline pin <runId> -o judge-baseline.json

# 2. no CI: reprova (exit 3) se algo mudou sem re-baseline declarada
prompt-builder baseline check --file judge-baseline.json --config arena.json

# 3. mudança intencional? declare, rode a nova baseline e pine de novo
prompt-builder baseline declare --file judge-baseline.json \
  --reason "juiz anterior expira em 2026-10-20" --judge anthropic/claude-sonnet-5
prompt-builder baseline pin <runIdNova> -o judge-baseline.json
```

`baseline check` **reprova** (exit `3`) quando, sem re-baseline declarada que
cubra o contrato em vigor:

- os juízes ou o gabarito da config diferem dos pinados;
- o hash do contrato do juiz mudou (ex.: versão nova do prompt de julgamento);
- o `canonicalSlug` ou o alvo do alias de um juiz/gabarito mudou.

E reprova **sempre** quando um juiz/gabarito em vigor saiu do catálogo ou
expirou (ele não roda mais). Sem catálogo (rede fora e sem cache), sai com `8`
— o gate é fail-closed. Expiração em até 30 dias é só aviso.

O catálogo é o **público** (`GET /models`, sem key, sem custo, cache de 24 h).
`--catalog <models.json>` usa um snapshot salvo (offline/reprodutível).

## Meta-prompts internos: `prompts regression`

O contrato do juiz não cobre os prompts EMBUTIDOS do reescritor, da reflexão,
das técnicas, do datagen e do gabarito. Toda run grava no pin do juiz
`metaPromptsFingerprint` + `runContractHash` (juiz + meta-prompts): qualquer
edição de texto interno muda o hash da run, sem mexer no hash do juiz (o
`baseline check` acima segue só sobre o julgamento). Quando o fingerprint mudar
(ex.: atualizou o pacote), rode a suíte fixa:

```bash
prompt-builder prompts regression --model xiaomi/mimo-v2.6-pro --judge google/gemini-3.8-flash --dry-run
```

São 80 reescritas × técnicas + 40 canários de contrato + casos rotulados de
reflexão, datagen, gabarito e juiz. Limiares: inválidas ≤ 10%, diversidade
(1 − 8-gramas) ≥ 0,4, acerto do juiz ≥ 85%, κ do gabarito ≥ 0,6 — abaixo, exit
`10` (`gate.prompts_regression`, relatório em `error.details.report`).
`--dry-run` estima o TETO pelo catálogo, sem key (o par acima: ~US$ 1,7 em
2026-09; a meta da suíte é ≤ US$ 2 — juiz caro passa disso), e `--budget` é
obrigatório fora de um terminal. Ganho por técnica NÃO é medido
aqui (sai `null`): isso é o `vary`.

## Docs e exemplos

O repositório roda um job semanal (`scripts/check-model-ids.ts`) que confere os
ids citados em `agent-docs/`, `skills/` e no README: id ausente ou expirado
reprova; expiração em até 30 dias avisa com sucedâneo. Para citar um id de
propósito (ex.: um exemplo de id removido), marque a linha com
`model-ids:ignore`.
