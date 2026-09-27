> **MEMÓRIA APOSENTADA (2026-09-27):** o conteúdo deste ficheiro foi migrado para a memória CoALA local do projeto (`.agents/prompt-builder-coala-memory-agent-skill/`). Fica só como **fonte histórica** — não escrever mais aqui. Aprendizado novo: `python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py add --type episodic --content "…"`.

# LEARNINGS — task-add-endpoint

> Append-only durante o trabalho. Cada entrada: data (AAAA-MM-DD), fonte (usuário|inferência) e o
> aprendizado. A `meta-skill-consolidate` deduplica/promove/poda periodicamente. Só persista o que
> é surpreendente, não-óbvio e não está no código.

- 2026-06-17 (inferência) — `tsc` não copia `.json` para `dist/`; leia dados estáticos por
  `process.cwd()` (não por import estático), senão o endpoint quebra em produção. Ex.: `src/lgpd.ts`.
- 2026-06-17 (inferência) — Rotas públicas (sem `requireKey`): `/techniques` e `/lgpd`. Use o mesmo
  padrão para servir dados estáticos que não dependem da key do usuário.
