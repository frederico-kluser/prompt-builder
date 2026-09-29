# skills/ — skill de agente do prompt-builder

Fonte **única** da skill `prompt-builder` ([`prompt-builder/SKILL.md`](./prompt-builder/SKILL.md) +
[`prompt-builder/models.md`](./prompt-builder/models.md), os modelos sugeridos por papel):
instruções enxutas para um agente de código operar o benchmark **sem interface web** (CLI/MCP),
apontando para a documentação embarcada (`npx prompt-builder-cli docs <tópico>`) em vez de a
duplicar. Vai no tarball npm (controlado pelo `files` do `package.json`) e é o que o CLI imprime
com `prompt-builder skill`. **Não crie cópias**: instale por symlink ou use o `init` abaixo.

## Instalar num agente

**No checkout do repositório (recomendado)** — um comando prepara a máquina inteira:

```bash
npm install && npm run agent-setup   # build + bins + skill + Plannotator (idempotente)
npm run agent-setup:doctor           # confere tudo (exit 1 se falta algo)
npm run agent-setup:uninstall        # remove só o que ele criou
```

Além de ligar esta skill em todos os agentes (abaixo), ele escreve os lançadores `prompt-builder`,
`pbuilder` e `prompt-builder-cli` em `.local/bin` do home (ou `PB_BIN_DIR`) — que executam ESTE
`dist/`, não a versão publicada do `npx` — e garante o Plannotator com as skills
`plannotator-visual-explainer` e `visual-explainer`, que entregam o relatório de ciclos
(`prompt-builder docs report`). `bash scripts/agent-setup.sh help` lista as opções
(`--no-build`, `--no-bin`, `--no-plannotator`, `--target <dir>`).

**Só a skill, global por symlink** — liga `<dir-de-skills>/prompt-builder` à pasta real desta skill
(no checkout do repo ou no pacote instalado); atualizar o repo/pacote atualiza a skill em todos os
agentes, a partir de qualquer diretório:

```bash
bash scripts/install-agent-skill.sh install     # todos os agentes conhecidos que existirem
bash scripts/install-agent-skill.sh doctor      # onde está, link íntegro, SKILL.md visível
bash scripts/install-agent-skill.sh uninstall   # remove só os symlinks desta skill
bash scripts/install-agent-skill.sh dirs        # os diretórios que o install usaria
```

Por defeito cobre os diretórios de skills que existirem (relativos ao home do usuário), criando o
diretório quando o agente está instalado (deteta o diretório de config dele): `.claude/skills`
(Claude Code), `$CLAUDE_CONFIG_DIR/skills` e `.claude-<perfil>/skills` (perfis reais do Claude
Code), `.codex/skills` (Codex CLI), `.copilot/skills` (Copilot CLI), `.cursor/skills` (Cursor),
`.kiro/skills` (Kiro), `.dsh/skills` (DSH), `.jcode/skills` (jcode), `.pi/agent/skills` (pi),
`.gemini/skills` (Gemini CLI), `.config/opencode/skills` (OpenCode, + `.config/opencode/skill`
legado) e `.agents/skills` (genérico, agentskills.io). Outros alvos com `--target <dir>` ou
`PB_EXTRA_AGENT_DIRS="d1:d2"`. É a fonte única da descoberta — o `agent-setup` lê daqui. O script
também roda do pacote: `node_modules/prompt-builder-cli/scripts/install-agent-skill.sh`. Exit codes:
`0` ok · `2` uso inválido · `1` operacional.

**Por projeto (cópia)** — `prompt-builder init --agent <nome|all>` (vem no CLI) copia a skill para
`.claude/skills`, `.agents/skills`, … do repositório corrente e acrescenta um bloco ao `AGENTS.md`.
Útil para versionar a skill com o projeto; o caminho global é para quem quer uma instalação só.

**Sem instalar nada** — o conteúdo vive no pacote: `npx prompt-builder-cli docs --list` (tópicos),
`docs <tópico>` (uma doc) e `prompt-builder skill` (a própria SKILL.md).

## Manutenção

- `SKILL.md` tem de caber no contexto do agente: **corpo (sem frontmatter) até 2.048 bytes** — o
  teste `test/tarball-content.test.ts` reprova acima disso, e também marcadores de dados pessoais
  e caminhos de home (só `~/.prompt-builder` é aceito) em tudo o que vai no tarball.
- Comandos citados têm de ser reais: o docs-lint (`test/docs-lint.test.ts`) confere cada
  `prompt-builder …` dos blocos bash contra o CLI, e `test/docs-run-examples.test.ts` roda cada
  `compare`/`vary`/`train` como `--dry-run` com o `--budget` escrito — exemplo que o pré-voo
  recusaria reprova. O que não existe não se escreve.
- Frontmatter no padrão Agent Skills (`name` = `prompt-builder` = nome da pasta, `description`
  rica em gatilhos, em PT-BR).
