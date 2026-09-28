# Modelos sugeridos por papel (defaults do dono, 2026-09-27)

Listas por ORDEM de preferência. Os defaults da interface e do `config example`
usam o início de cada lista (juízes = 2 primeiros; compare = os 3 competidores;
papéis de 1 só modelo = o 1º). Qualquer seletor continua livre — isto é só o que
vem pré-escolhido.

## Juízes (default: os 2 primeiros)
1. `google/gemini-3.8-flash`
2. `meta/muse-spark-1.3`
3. `xiaomi/mimo-v2.6-pro`
4. `z-ai/glm-5.3-flash`
5. `deepseek/deepseek-v4.1-flash`

## Gerador de cenários (default: o 1º)
1. `xiaomi/mimo-v2.6-pro`
2. `z-ai/glm-5.3-flash`
3. `deepseek/deepseek-v4.1-flash`

No modo **compare** o gerador não pode ser competidor (`runConfigSchema`) e os 3
da lista competem, então o default do compare é `meta/muse-spark-1.3` (o 1º
livre do universo preferido — decisão do dono).

## Competidores, modo compare (default: os 3)
1. `deepseek/deepseek-v4.1-flash`
2. `z-ai/glm-5.3-flash`
3. `xiaomi/mimo-v2.6-pro`

## Modelo sob teste, vary/train (default: o 1º)
1. `xiaomi/mimo-v2.6-pro`
2. `deepseek/deepseek-v4.1-flash`
3. `z-ai/glm-5.3-flash`

## Gabarito (reference), vary/train

Obrigatório e ≠ juiz ≠ modelo sob teste (IMPL-048). Default sugerido:
`z-ai/glm-5.3-flash` (o 1º livre quando os juízes são os 2 primeiros e o modelo
sob teste é o `xiaomi/mimo-v2.6-pro`).
