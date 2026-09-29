# `vary` — testar variações de um prompt

Uma rodada só (sem iterações): gera variantes do prompt base aplicando técnicas
de engenharia de prompt, roda todas no **mesmo** modelo e julga.

```bash
prompt-builder vary \
  --model xiaomi/mimo-v2.6-pro \
  --judge google/gemini-3.8-flash --judge meta/muse-spark-1.3 \
  --reference z-ai/glm-5.3-flash \
  --theme "Classificação de tickets de suporte" \
  --base-prompt-file prompt.md \
  --techniques persona,constraints,format,fewshot \
  --stages 8 --budget 3
```

`--reference` (quem escreve o gabarito) é **obrigatório** em `vary`/`train` e
não pode ser juiz nem o `--model` — sem ele a config sai exit `3`. O pré-voo
desse exemplo estima ~US$ 2–2,5 (preços de 2026-09); se o `--dry-run` recusar
por orçamento, `error.details.estimate.high` diz o teto que passa.

Use `vary` quando quiser **uma medição**; use `train` quando quiser que o prompt
**evolua** (com holdout e significância).

## Técnicas

`prompt-builder techniques` lista as 19 disponíveis, com quando cada uma ajuda
e quando atrapalha. Ids: `persona`, `cot`, `fewshot`, `format`, `constraints`,
`decompose`, `selfcritique`, `specificity`, `concise`, `emphasis`, `positive`,
`delimiters`, `stepback`, `xml-tags`, `rubric`, `uncertainty`, `length-control`,
`contrastive`, `prefill`.

São necessários **pelo menos 2 contestants**: `nº de técnicas + (1 se houver
prompt base)`. O prompt base entra como **controle** — sem ele você compara
variantes entre si, sem saber se alguma melhorou algo.

## Variantes escritas à mão

Num `arena-config@1`, com `variation.optimize: false`, o reescritor não roda e
as variantes são exatamente as que você escreveu:

```json
"variation": {
  "optimize": false,
  "manualVariants": [
    { "label": "curto", "systemPrompt": "…" },
    { "label": "com exemplos", "systemPrompt": "…" }
  ]
}
```

## Resultado

```bash
prompt-builder runs winner <runId> --prompt-only > melhor.md
```
