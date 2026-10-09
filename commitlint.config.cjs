// Configuração do commitlint para o prompt-builder.
//
// Impõe os Commits Convencionais (https://www.conventionalcommits.org/).
// Ligado ao hook `commit-msg` via husky (ver .husky/commit-msg e CONTRIBUTING.md):
// mensagens inválidas são rejeitadas no momento do commit.
// Extensão .cjs porque o pacote é ESM ("type": "module").
//
// As regras usam a forma [nível, aplicável, valor]: 2 = erro, 'always' = impor.
module.exports = {
  // Parte do preset comunitário: type-enum, type-empty, subject-empty,
  // header-max-length, body-leading-blank, ...
  extends: ['@commitlint/config-conventional'],

  rules: {
    // Só estes tipos são permitidos. Mapeiam 1:1 para as secções do changelog
    // e para as notas de release (CHANGELOG.md).
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],

    // Sem ponto final no fim do sujeito (do preset comunitário, reforçado).
    'subject-full-stop': [2, 'never', '.'],

    // Header curto o suficiente para `git log --oneline`, a UI do GitHub e as
    // notas de release. Os detalhes vão no corpo; breaking changes no rodapé.
    'header-max-length': [2, 'always', 72],

    // NOTA: sem `subject-case` de propósito — o commitlint valida o sujeito
    // INTEIRO e rejeitaria siglas do domínio (JEV, LGPD, CLI…), que são norma
    // neste projeto. O estilo do sujeito é convenção documentada no
    // CONTRIBUTING.md, não gate.
  },
};
