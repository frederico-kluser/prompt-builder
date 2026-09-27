# Catálogo de Skills — prompt-builder

> **Consolidado em 2026-09-27:** as *knowledge skills* (`knowledge-*`) e o `project-router` foram
> destiladas para a **memória CoALA local** do projeto
> ([`prompt-builder-coala-memory-agent-skill`](prompt-builder-coala-memory-agent-skill/SKILL.md)) e
> apagadas. O conhecimento do projeto lê-se com
> `python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py recall/search`
> (chaves `skill:<antiga-skill>:<tema>`, `R-xx:DEC-n`, `docs:Q-xx`, …). Fonte única em
> `.agents/skills/`; `.claude/skills` é um symlink.

## Memória (fonte de conhecimento)
- **[prompt-builder-coala-memory-agent-skill](prompt-builder-coala-memory-agent-skill/SKILL.md)** —
  memória CoALA/SQLite local: episódica, semântica e procedimental + working memory orçamentada.
  Use `recall` no início de cada tarefa e `search` para "o que sabemos sobre…".

## Tarefa (memória procedural) — terminam com passo `<evolution>`
- **[task-add-endpoint](task-add-endpoint/SKILL.md)** — adicionar um endpoint na API `/v1/benchmark`.
- **[task-edit-newrun-form](task-edit-newrun-form/SKILL.md)** — alterar o formulário de Nova Run.
- **[task-run-and-verify](task-run-and-verify/SKILL.md)** — rodar o app e verificar uma mudança ponta a ponta.

## Meta-skills
- **[meta-skill-evolution](meta-skill-evolution/SKILL.md)** — decide atualizar/criar/descartar skills
  a partir de aprendizados (ou registá-los na memória CoALA); sempre via `git diff` para revisão humana.
- **[meta-skill-consolidate](meta-skill-consolidate/SKILL.md)** — GC periódico: deduplicação,
  detecção de contradição, versionamento temporal, poda.
