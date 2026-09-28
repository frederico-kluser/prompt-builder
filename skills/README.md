# skills/ — skill de agente do prompt-builder

Fonte **única** da skill `prompt-builder` ([`prompt-builder/SKILL.md`](./prompt-builder/SKILL.md)):
instruções enxutas para um agente de código operar o benchmark **sem interface web** (CLI/MCP),
apontando para a documentação embarcada (`npx prompt-builder-cli docs <tópico>`) em vez de a
duplicar. Vai no tarball npm (controlado pelo `files` do `package.json`) e é o que o CLI imprime
com `prompt-builder skill`. **Não crie cópias**: instale por symlink ou use o `init` abaixo.

## Instalar num agente

**Global (symlink, recomendado)** — liga `<dir-de-skills>/prompt-builder` à pasta real desta skill
(no checkout do repo ou no pacote instalado); atualizar o repo/pacote atualiza a skill em todos os
agentes, a partir de qualquer diretório:

```bash
bash scripts/install-agent-skill.sh install     # todos os agentes conhecidos que existirem
bash scripts/install-agent-skill.sh doctor      # onde está, link íntegro, SKILL.md visível
bash scripts/install-agent-skill.sh uninstall   # remove só os symlinks desta skill
```

Por defeito cobre os diretórios de skills que existirem (relativos ao home do usuário):
`.claude/skills` (Claude Code) · `.codex/skills` (Codex CLI) · `.dsh/skills` (DSH) ·
`.gemini/skills` (Gemini CLI) · `.config/opencode/skills` (OpenCode, + `.config/opencode/skill`
legado) · `.agents/skills` (genérico, agentskills.io). Cria o diretório quando o agente está
instalado (deteta o diretório de config dele); outros alvos com `--target <dir>`. O script também
roda do pacote: `node_modules/prompt-builder-cli/scripts/install-agent-skill.sh`. Exit codes:
`0` ok · `2` uso inválido · `1` operacional.

**Por projeto (cópia)** — `prompt-builder init --agent <nome|all>` (vem no CLI) copia a skill para
`.claude/skills`, `.agents/skills`, … do repositório corrente e acrescenta um bloco ao `AGENTS.md`.
Útil para versionar a skill com o projeto; o caminho global é para quem quer uma instalação só.

**Sem instalar nada** — o conteúdo vive no pacote: `npx prompt-builder-cli docs --list` (tópicos),
`docs <tópico>` (uma doc) e `prompt-builder skill` (a própria SKILL.md).

## Manutenção

- `SKILL.md` tem de caber no contexto do agente: **corpo (sem frontmatter) até 2.048 bytes** — o
  teste `test/tarball-content.test.ts` reprova acima disso, e também marcadores de dados pessoais.
- Comandos citados têm de ser reais (`node dist/cli/index.js --help`); o que não existe não se escreve.
- Frontmatter no padrão Agent Skills (`name` = `prompt-builder` = nome da pasta, `description`
  rica em gatilhos, em PT-BR).