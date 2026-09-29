# `vary` — testar variações de um prompt

Uma rodada só (sem iterações): gera variantes do prompt base aplicando técnicas
de engenharia de prompt, roda todas no **mesmo** modelo e julga.

```bash
prompt-builder vary \
  --model openai/gpt-5-mini \
  --judge anthropic/claude-sonnet-5 \
  --reference deepseek/deepseek-v4-pro \
  --theme "Classificação de tickets de suporte" \
  --base-prompt-file prompt.md \
  --techniques persona,constraints,format,fewshot \
  --stages 8 --budget 1
```

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
