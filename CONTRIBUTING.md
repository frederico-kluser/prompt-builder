# Contribuir para o prompt-builder

Obrigado pelo interesse em contribuir! Este documento explica o fluxo de trabalho, as convenções e
o piso de qualidade de cada mudança em `frederico-kluser/prompt-builder`.

Este projeto é publicado com um [Código de Conduta](CODE_OF_CONDUCT.md). Ao participar, espera-se
que o cumpra.

## Primeiros passos

1. Faça **fork** do repositório no GitHub e clone o seu fork:

   ```bash
   git clone https://github.com/<seu-user>/prompt-builder.git
   cd prompt-builder
   git remote add upstream https://github.com/frederico-kluser/prompt-builder.git
   ```

2. **Ambiente reprodutível** — instale a partir do lockfile para todos terem a mesma árvore de
   dependências (Node `>= 20.11`, ver `engines` no `package.json`):

   ```bash
   npm ci && npm run setup   # raiz + web/ (o MOTION_TOKEN é opcional — ver README)
   ```

   ⚠️ O `npm install`/`npm ci` da raiz **não** instala o `web/`; `npm run setup` é obrigatório para
   o frontend. Não commite churn de lockfile produzido por outro gestor de pacotes.

3. Confirme a base antes de mudar o que quer que seja:

   ```bash
   npm test              # testes de contrato (vitest) + guarda de sincronia motor × web
   npm run typecheck     # tsc do motor/CLI/servidor (sem emit)
   cd web && npx tsc -b  # type-check do frontend
   ```

## Como submeter uma mudança

- **Nunca faça push direto a `main`** — os rulesets do repositório bloqueiam-no; tudo entra por
  pull request.
- Trabalhe num fork (contribuidores externos) ou numa **branch efémera** do repositório principal
  (mantenedores) e abra um pull request contra `main`.
- Mantenha cada branch focada num único assunto: PRs pequenos e revisáveis entram mais depressa.
- Mantenha a branch atualizada com rebase sobre `upstream/main` (não faça merge de `main` para a
  sua branch).

## Nomes de branch

Use um prefixo curto e descritivo:

| Padrão     | Para quê                                | Exemplo                  |
| ---------- | --------------------------------------- | ------------------------ |
| `feat/*`   | Nova funcionalidade                     | `feat/relatorio-csv`     |
| `fix/*`    | Correção de bug                         | `fix/timeout-juiz`       |
| `chore/*`  | Manutenção, tooling, dependências       | `chore/oss-governance`   |
| `docs/*`   | Documentação                            | `docs/guia-treino`       |
| `ci/*`     | Workflows e automação                   | `ci/cache-npm`           |

Outros prefixos convencionais (`refactor/*`, `test/*`, `perf/*`) são bem-vindos onde couberem.

## Convenção de commits

Usamos [Conventional Commits](https://www.conventionalcommits.org/). A mensagem do commit vira a
entrada do changelog e comanda o bump de versão semântica, por isso o formato é imposto.

Aceites:

```text
feat: adiciona backoff exponencial ao cliente HTTP
fix(parser): trata input vazio sem lançar exceção
docs: documenta o ciclo de vida dos plugins
feat!: remove suporte a Node 16

feat: adiciona retentativas ao cliente HTTP

BREAKING CHANGE: o construtor do cliente passa a exigir um objeto de opções.
```

Rejeitados:

```text
Fixed bug                          # sem tipo
FEAT: add stuff                    # tipo tem de ser minúsculo e de entre os permitidos
feat:no space after colon          # falta o espaço depois do separador
feat: um sujeito muito comprido que passa em muito os setenta e dois caracteres  # header > 72
```

Tipos permitidos: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`,
`chore`, `revert`. O header tem no máximo **72 caracteres**. O sujeito escreve-se em português,
com minúscula inicial e sem ponto final (siglas do domínio — JEV, LGPD, CLI — são normais); o
estilo do sujeito é convenção, os gates impostos são o tipo e o comprimento do header.

> O hook `commit-msg` (husky + commitlint) **rejeita mensagens inválidas no momento do commit**. Se
> o seu commit foi recusado, corrija a mensagem com `git commit --amend` (ou `git rebase -i` em
> commits mais antigos) em vez de contornar o hook. **Nunca use `--no-verify`.**

## Gates de qualidade locais

Corra antes de abrir o pull request — tudo tem de passar:

```bash
npm test              # testes de contrato do motor + docs embarcadas (pré-voo dos exemplos)
npm run typecheck     # type-check do backend (motor/CLI/servidor)
cd web && npx tsc -b  # type-check do frontend (React/Vite)
npm run build         # compila dist/ — o que o npm publica
```

Notas do projeto:

- **Não há lint de código** neste repositório (o lint da documentação é teste: `npm test` cobre
  `agent-docs/` e `skills/`).
- Toda a mudança de comportamento leva teste; uma correção de bug leva um teste de regressão que
  falha sem a correção.
- Os exemplos `compare`/`vary`/`train` documentados passam por **pré-voo real** nos testes
  (`test/docs-run-examples.test.ts`): mantenha-os executáveis e com `--budget` realista.
- Os tipos de domínio estão duplicados em `src/types.ts`, `web/src/engine/types.ts` e
  `web/src/api.ts` — mantenha-os sincronizados (a guarda `test/engine-sync.test.ts` vigia a
  duplicação motor × web).

## Processo de pull request

1. **Título = mensagem de Commit Convencional.** O título é usado como mensagem do commit do
   squash-merge, por isso segue a mesma convenção (ex.: `feat(relatorio): exporta CSV do placar`).
2. **Descreva o quê e porquê** no corpo: motivação, abordagem, alternativas consideradas. Use o
   checklist do [template de PR](.github/PULL_REQUEST_TEMPLATE.md).
3. **Ligue issues relacionadas** com palavras-chave de fecho (`Closes #123`) para fecharem
   automaticamente no merge.
4. **Mantenha tudo verde localmente**: os mesmos checks correm no CI e o status check `build` é
   exigido pelos rulesets (`.github/rulesets/regras-main.json`).
5. **Revisões** (impostas pelo [CODEOWNERS](CODEOWNERS) e pelos rulesets):
   - A aprovação do dono dos caminhos alterados é obrigatória (code owner review).
   - Aprovações ficam *stale* (descartadas) quando há push novo na branch.
   - Todas as threads de revisão resolvidas e todos os status checks verdes.
   - O mantenedor (admin) tem bypass para merge via PR — o escape hatch solo-dev; push direto em
     `main` continua bloqueado para todos.
6. **Squash and merge apenas.** Os mantenedores fazem merge com squash e apagam a branch de origem;
   o título do PR vira a mensagem permanente do commit. Sem merge commits nem rebase-merge.

## Reportar bugs

- Use o [template de bug](.github/ISSUE_TEMPLATE/bug_report.md) com reprodução mínima, comportamento
  esperado vs. real, versões e detalhes do ambiente.
- Ideias de funcionalidade vão pelo [template de feature](.github/ISSUE_TEMPLATE/feature_request.md).
- **Vulnerabilidades de segurança nunca são issues públicas.** Siga o processo privado do
  [SECURITY.md](SECURITY.md).

## Reconhecimento

Cada contribuição conta e cada contribuidor é creditado:

- O changelog e as notas de release atribuem as mudanças merged aos seus autores.
- Contribuições significativas e sustentadas são reconhecidas com convite para commit bit.

Obrigado por ajudar a tornar o prompt-builder melhor!
