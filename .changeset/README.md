# Changesets — notas de release escritas à mão (IMPL-105, R-18:REC-2)

Cada release do `prompt-builder-cli` nasce de um **changeset**: um ficheiro
`.changeset/*.md` escrito **por humano**, uma linha de bump + o que mudou e por
quê. Commits do repositório não são conventional (medição da pesquisa: 78%
fora do padrão), por isso `semantic-release`/`release-please` omitiriam a
maioria das mudanças — a nota humana é a fonte.

## Como funciona (≤2 ações manuais por release)

1. **1 changeset por PR** (não por commit): `npm run changeset` gera o ficheiro;
   escreva as notas em PT-BR, para quem vai ler a release.
2. Abrir o PR normalmente. O CI mantém o PR **"Version Packages"** (bump +
   CHANGELOG a partir dos changesets) enquanto houver notas pendentes.
3. **1 merge** do PR "Version Packages": o `scripts/release-tag.mjs` cria a tag
   `v<versão>`, dispara o `publish-npm.yml` nessa tag e a GitHub Release fica
   associada à tag.

O `npm publish` **só** acontece no job `publish` do
[`publish-npm.yml`](../.github/workflows/publish-npm.yml), cuja referência é a
tag, por **trusted publishing (OIDC)** — não há `NPM_TOKEN` no repositório e um
publish manual (notebook, outro workflow) não autentica. Ver o cabeçalho do
workflow para o teste negativo documentado e para o registo do trusted
publisher no npmjs.com.

## Gates

`prepublishOnly` corre sempre (também num `npm publish` local):

1. `npm run test:full` (a suíte inteira, com Docker/Monte Carlo)
2. `npm run gate:publint` (`publint`)
3. `npm run gate:attw` (`attw --pack --profile esm-only` — o pacote é
   ESM-only; o perfil `strict` reprova o `require` de ESM que o pacote nunca
   prometeu suportar)
4. `npm run gate:tarball` (`scripts/tarball-gate.mjs`: allowlist positiva do
   tarball; o diff contra `scripts/tarball-allowlist.json` reprova em CI)
5. `npm run gate:smoke` (instala o tarball em directório vazio e sobe os 3 bins)

Ao mudar o que embarca (novos módulos, docs, dados), regenere a allowlist:

```bash
npm run build && node scripts/tarball-gate.mjs --update
```

e leve a mudança de `scripts/tarball-allowlist.json` no mesmo PR — é o registo
versionado do conteúdo do pacote. Não dá para esquecer: o `npm test`
(`test/tarball-gate.test.ts`) roda o mesmo gate strict do CI e confere a
allowlist contra `src/`, então módulo/doc nova sem `--update` já reprova no PR,
não no job de release. O `--update` recusa regravar sem `dist/` compilado.
