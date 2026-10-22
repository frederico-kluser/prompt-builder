---
"prompt-builder-cli": minor
---

Benchmark de visão v0.3: banco `matrix` cruza resolução × grade e mede grades
que NÃO cobrem o print. `frame-axis`/`frame-mark` colocam réguas e letras nas
margens; `sidecar-grid` manda a captura limpa + uma imagem separada de grade.
O dataset `vision-dataset@0.3.0` pina frames/sidecars por resolução e o runner
remapeia o ponto para 1920×1080 antes de pontuar. Inclui o gerador web
`recaps/vision-gerador/index.html` (PNG/JPEG → resoluções + grades + ZIP com
`manifest.json` e `INSTRUCOES.md`) e o tutorial de remapeamento. Resultado da
matriz de 1440 chamadas em `recaps/vision-matriz/`.
