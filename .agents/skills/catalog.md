# Catálogo de Skills — prompt-builder

> **Consolidado em 2026-09-27:** as *knowledge skills* (`knowledge-*`), o `project-router` e as
> meta-skills foram destiladas para a **memória CoALA local** do projeto
> ([`prompt-builder-coala-memory-agent-skill`](prompt-builder-coala-memory-agent-skill/SKILL.md)) e
> apagadas. O conhecimento do projeto lê-se com
> `python3 .agents/prompt-builder-coala-memory-agent-skill/scripts/coala.py recall/search`
> (chaves `skill:<antiga-skill>:<tema>`, `R-xx:DEC-n`, `docs:Q-xx`, …). Fonte única em
> `.agents/skills/`; `.claude/skills` é um symlink.

## Memória (fonte de conhecimento)
- **[prompt-builder-coala-memory-agent-skill](prompt-builder-coala-memory-agent-skill/SKILL.md)** —
  memória CoALA/SQLite local: episódica, semântica e procedimental + working memory orçamentada.
  Use `recall` no início de cada tarefa e `search` para "o que sabemos sobre…".

## Tarefa (memória procedural) — terminam com registo de aprendizado na memória CoALA local
- **[task-add-endpoint](task-add-endpoint/SKILL.md)** — adicionar um endpoint na API `/v1/benchmark`.
- **[task-edit-newrun-form](task-edit-newrun-form/SKILL.md)** — alterar o formulário de Nova Run
  (guiado de 5 passos + configuração completa, atrás do seletor LLM | JEV).
- **[task-run-and-verify](task-run-and-verify/SKILL.md)** — rodar o app e verificar uma mudança ponta a ponta.

## O papel das antigas meta-skills
Não há mais meta-skills em pasta própria — o que elas faziam vive na memória CoALA
([SKILL.md](prompt-builder-coala-memory-agent-skill/SKILL.md)):
- **destino de um aprendizado novo** (atualizar skill, criar, descartar ou só registar):
  `coala.py add --type episodic|semantic|procedural --content "…" [--key <assunto>]`, e a mudança
  de skill sai como commit separado, revisado pelo diff;
- **GC periódico** (deduplicação, contradição, versão temporal, poda): a supersessão por `--key`
  (o registo novo com a mesma chave aposenta o anterior) ou `coala.py supersede`, e o
  `coala.py doctor` (saúde da base).

## Skill do produto (não é daqui)
A skill **`prompt-builder`** — para quem USA o benchmark (CLI/MCP, relatório de ciclos, JEV) — mora
em [`skills/prompt-builder/`](../../skills/prompt-builder/SKILL.md), vai no pacote npm e é instalada
em todos os agentes da máquina pelo `npm run agent-setup`.
