# Política de Segurança

A segurança é uma preocupação de primeira classe do **prompt-builder** (`frederico-kluser/prompt-builder`).
Obrigado por ajudar a manter o projeto e os seus utilizadores seguros.

## Versões suportadas

Apenas a linha de release mais recente recebe correções de segurança. Atualize antes de reportar
problemas que podem já ter sido resolvidos.

| Versão                          | Suporte            |
| ------------------------------- | ------------------ |
| Release mais recente (`main`)   | :white_check_mark: |
| Minor anterior (n-1)            | :white_check_mark: (best effort) |
| Versões mais antigas            | :x:                |

## Reportar uma vulnerabilidade

**Não reporte vulnerabilidades em issues, discussões ou pull requests públicos.**

Usamos o GitHub **Private Vulnerability Reporting**:

1. Abra o separador **Security** do repositório → **Advisories** → **Report a vulnerability**
   (<https://github.com/frederico-kluser/prompt-builder/security/advisories/new>).
2. Alternativamente, contacte o dono do projeto pelo perfil do GitHub
   (<https://github.com/frederico-kluser>) com um assunto descritivo, o relatório detalhado e o
   nome com que prefere ser creditado.

Inclua sempre que possível:

- Descrição da vulnerabilidade e o impacto potencial.
- Passo-a-passo de reprodução ou prova de conceito.
- Versões/commits afetados e, se souber, o commit que introduziu o problema.
- Correção ou mitigação sugerida.

### O nosso SLA

| Marco                                          | Alvo                       |
| ---------------------------------------------- | -------------------------- |
| Reconhecimento do relatório                    | **48 horas**               |
| Triagem e avaliação inicial de severidade      | **3 dias úteis**           |
| Atualizações de estado                         | a cada **7 dias**          |
| Correção/mitigação de achados críticos         | **30 dias**                |
| Correção/mitigação dos restantes achados       | **90 dias**                |

Se um relatório estiver fora do escopo ou não for aceite, explicamos porquê e apontamos o canal
adequado, quando relevante.

## Divulgação coordenada

- Mantenha a vulnerabilidade **confidencial** até a correção ser lançada e um advisory público ser
  publicado.
- Combinamos a data de divulgação, creditamos no advisory (a não ser que prefira o anonimato) e
  avisamos quando a correção sair.
- **Embargo**: até **90 dias** a partir do reconhecimento; nunca estendemos um embargo sem o seu
  acordo e divulgamos assim que houver correção.
- Com a correção lançada, publicamos um GitHub Security Advisory (CVE quando aplicável) e uma nota
  de release a referir a correção.

## Escopo

Dentro do escopo:

- O código do `prompt-builder`, os pacotes publicados (`prompt-builder-cli` no npm) e as pipelines
  de build/release deste repositório.

Fora do escopo (reporte ao fornecedor correspondente):

- Vulnerabilidades em dependências de terceiros com advisory upstream existente.
- Problemas exclusivos de versões não suportadas.
- Engenharia social, ataques físicos e negação de serviço contra o GitHub ou infraestrutura de
  terceiros.

## Hardening

O projeto mantém as proteções de cadeia de fornecimento abaixo; mantenha-as ativas:

- **Secret scanning** no GitHub e varredura com **gitleaks** (workflow `.github/workflows/gitleaks.yml`)
  em todo o push/PR — a API key do OpenRouter é do utilizador e nunca entra no repositório.
- **Dependabot** (`.github/dependabot.yml`) para alertas e atualizações de dependências vulneráveis
  (npm e GitHub Actions).
- **Rulesets** em `main` (`.github/rulesets/regras-main.json`): PR obrigatório, squash-only, status
  checks strict, sem force-push, sem delete; tags `v*` imutáveis (`regras-tags.json`).
- **OpenSSF Scorecard** (`.github/workflows/scorecard.yml`) com resultados publicados.
- **GitHub Actions fixadas por SHA** (`owner/repo@<sha> # vX.Y.Z`) para que tags móveis de terceiros
  não possam ser reescritas por baixo de nós.
- Actions com `permissions:` mínimos e `timeout-minutes` em todos os jobs.

## Contacto

- Segurança: GitHub Private Vulnerability Reporting (acima).
- Questões públicas não-sensíveis: issues/discussões em <https://github.com/frederico-kluser/prompt-builder>.
