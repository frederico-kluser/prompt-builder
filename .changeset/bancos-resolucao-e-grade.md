---
"prompt-builder-cli": minor
---

Benchmark de visão v0.2: dois bancos novos medem variantes do MESMO dataset,
com verdade do DOM e placar determinístico. `--benchmark resolution` roda a
mesma tela em 1080p/720p/540p/360p e reescala as coordenadas para 1920×1080;
`--benchmark grid` compara `plain`, grade 9×9, eixos e `mark-grid` 6×4 em duas
rodadas (célula → recorte ampliado). O build pina cada variante por sha256 no
manifesto (`vision-dataset@0.2.0`) e o record guarda banco, variante, viewport
enviado, rastros das rodadas e provedor fixado. `--provider` desliga o fallback
do OpenRouter (sem ele o roteamento pode trocar de provedor entre células e
confundir a medição). Relatório ganhou tabela por variante, retenção vs 1080p e
delta vs controle. Terceiro banco (ação executada/closed-loop) especificado no
`ROADMAP-VISAO.md`.
