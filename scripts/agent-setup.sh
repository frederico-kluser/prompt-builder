#!/usr/bin/env bash
# agent-setup.sh — deixa ESTA cópia do prompt-builder pronta para qualquer agente
# de código da máquina (é o `npm run agent-setup`).
#
# A skill `prompt-builder` só vale se o agente conseguir chamar a "API local" que
# ela descreve (o CLI/MCP) e entregar o relatório de ciclos. Por isso o setup faz
# QUATRO coisas, todas idempotentes e conservadoras:
#
#   1. build   — compila dist/ quando falta ou está mais velho que src/ (só num
#                checkout; no pacote npm o dist/ já vem pronto).
#   2. bins    — escreve os lançadores `prompt-builder`, `pbuilder` e
#                `prompt-builder-cli` em ~/.local/bin (PB_BIN_DIR muda o destino)
#                que executam ESTE dist/. Sem eles o agente cai no
#                `npx prompt-builder-cli`, que baixa a versão PUBLICADA no npm —
#                outra versão, com outros comandos. O lançador é um script de 3
#                linhas (não symlink): o `prebuild` apaga dist/ e um symlink para
#                um .js sem bit de execução quebraria a cada build.
#   3. skill   — liga skills/prompt-builder por SYMLINK em todos os diretórios de
#                skills de agentes (descoberta em scripts/install-agent-skill.sh,
#                a fonte única: Claude Code e perfis, Codex, Copilot, Cursor, Kiro,
#                DSH, jcode, pi, Gemini, OpenCode, ~/.agents/skills).
#   4. relatório — garante o Plannotator (binário) e as skills
#                `plannotator-visual-explainer` (quem emite o relatório de ciclos)
#                e `visual-explainer` (de quem ela depende), ligadas nos mesmos
#                diretórios. Uma cópia que já exista na máquina é REUSADA (só
#                ganha links); só se nada existir é que buscamos por git
#                sparse-checkout e marcamos a cópia com .installed-by-prompt-builder.
#                O binário vai pelo instalador oficial em modo --minimal (só o
#                binário: a instalação completa reescreve hooks/config de vários
#                agentes e apaga skills em ~/.claude/skills).
#
# Uso:
#   bash scripts/agent-setup.sh [install]  [opções]   (padrão: install)
#   bash scripts/agent-setup.sh doctor     [opções]
#   bash scripts/agent-setup.sh uninstall  [opções]
#   bash scripts/agent-setup.sh help
#
# Opções:
#   --no-build        não compila (usa o dist/ que houver)
#   --no-bin          não escreve os lançadores em ~/.local/bin
#   --no-plannotator  não mexe no Plannotator nem nas skills de relatório
#   --target <dir>    diretório de skills (repetível; substitui a descoberta)
#
# Ambiente: PB_BIN_DIR (destino dos lançadores) · PB_EXTRA_AGENT_DIRS="d1:d2"
# (alvos extra) · PB_PLANNOTATOR_INSTALL=0 (nunca instala o binário) ·
# PB_PLANNOTATOR_REPO / PB_VE_REPO / PB_SKILLS_REF (origem das skills) ·
# PB_PLANNOTATOR_INSTALL_URL (instalador oficial) · PB_ALLOW_WORKTREE=1 (rodado
# de um worktree LIGADO, o setup se re-executa a partir da cópia principal do
# repo — lançadores e skill globais não podem apontar para uma pasta que some no
# `git worktree remove`; a variável usa o worktree mesmo assim).
#
# Nunca usa sudo, nunca `npm -g`, nunca sobrescreve o que não escreveu.
# Exit codes: 0 ok · 1 operacional (detalhe no fim) · 2 uso inválido.

set -u

PROG=$(basename "$0")
BIN_MARK='# managed-by: prompt-builder agent-setup'
MARK='.installed-by-prompt-builder'
BIN_NAMES='prompt-builder pbuilder prompt-builder-cli'

PLANNOTATOR_REPO=${PB_PLANNOTATOR_REPO:-https://github.com/backnotprop/plannotator.git}
PLANNOTATOR_SKILL_PATH='apps/skills/extra/plannotator-visual-explainer'
VE_REPO=${PB_VE_REPO:-https://github.com/nicobailon/visual-explainer.git}
VE_SKILL_PATH='plugins/visual-explainer'
INSTALL_URL=${PB_PLANNOTATOR_INSTALL_URL:-https://plannotator.ai/install.sh}

info() { printf '%s\n' "$*"; }
passo() { printf '\n== %s\n' "$*"; }
erro() { printf 'ERRO: %s\n' "$*" >&2; }
aviso() { printf 'AVISO: %s\n' "$*" >&2; }

uso() {
  sed -n '2,/^# Exit codes/p' "$SCRIPT_FILE" | sed 's/^# \{0,1\}//'
}

uso_invalido() {
  erro "$1"
  printf 'Rode `bash %s help` para o uso.\n' "$PROG" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Onde estamos (checkout do repo OU pacote instalado)
# ---------------------------------------------------------------------------

resolve_script_file() {
  src=$0
  while [ -L "$src" ]; do
    dir=$(CDPATH='' cd -P -- "$(dirname -- "$src")" 2>/dev/null && pwd) || return 1
    link=$(readlink "$src") || return 1
    case $link in
      /*) src=$link ;;
      *) src=$dir/$link ;;
    esac
  done
  dir=$(CDPATH='' cd -P -- "$(dirname -- "$src")" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "$dir" "$(basename -- "$src")"
}

SCRIPT_FILE=$(resolve_script_file) || {
  erro "não consegui resolver a localização deste script."
  exit 1
}
SCRIPT_DIR=$(dirname -- "$SCRIPT_FILE")
ROOT=$(CDPATH='' cd -P -- "$SCRIPT_DIR/.." && pwd)
CLI_JS="$ROOT/dist/cli/index.js"
SKILL_INSTALLER="$SCRIPT_DIR/install-agent-skill.sh"
BIN_DIR=${PB_BIN_DIR:-${HOME:-}/.local/bin}
CANON=${HOME:-}/.agents/skills

# Raiz da cópia PRINCIPAL do repo quando <raiz> é um worktree LIGADO (`git
# worktree add`) do prompt-builder-cli; falha em checkout normal, pacote npm ou
# repo alheio. (Mesma regra no scripts/install-agent-skill.sh.)
raiz_principal() {
  command -v git >/dev/null 2>&1 || return 1
  topo=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ "$(CDPATH='' cd -P -- "$topo" 2>/dev/null && pwd)" = "$1" ] || return 1
  gitdir=$(git -C "$1" rev-parse --absolute-git-dir 2>/dev/null) || return 1
  comum=$(cd "$1" 2>/dev/null && CDPATH='' cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd) || return 1
  [ "$gitdir" != "$comum" ] || return 1
  case $comum in
    */.git) principal=${comum%/.git} ;;
    *) return 1 ;; # repo bare: não há cópia principal
  esac
  grep -q '"name"[[:space:]]*:[[:space:]]*"prompt-builder-cli"' "$principal/package.json" 2>/dev/null || return 1
  printf '%s\n' "$principal"
}

# Worktree ligado: lançadores e skill apontados para ELE quebram no `git worktree
# remove` (foi assim que a skill sumiu de todos os agentes em 2026-10). O setup
# global roda a partir da cópia principal; PB_ALLOW_WORKTREE=1 usa o worktree.
if [ "${PB_ALLOW_WORKTREE:-0}" != 1 ] && principal=$(raiz_principal "$ROOT") &&
  [ -f "$principal/scripts/agent-setup.sh" ]; then
  aviso "$ROOT é um worktree ligado (some no \`git worktree remove\`): o setup global roda a partir da cópia principal $principal (PB_ALLOW_WORKTREE=1 usa o worktree)."
  exec bash "$principal/scripts/agent-setup.sh" "$@"
fi

N_ERROS=0
falha() {
  erro "$*"
  N_ERROS=$((N_ERROS + 1))
}

# ---------------------------------------------------------------------------
# Argumentos
# ---------------------------------------------------------------------------

SUB=install
case ${1:-} in
  install | doctor | uninstall)
    SUB=$1
    shift
    ;;
  help | -h | --help)
    uso
    exit 0
    ;;
  '' | --*) ;;
  *) uso_invalido "subcomando desconhecido: $1" ;;
esac

DO_BUILD=1
DO_BIN=1
DO_PLANNOTATOR=1
TARGET_ARGS=''
NL='
'
while [ $# -gt 0 ]; do
  case $1 in
    --no-build) DO_BUILD=0 ;;
    --no-bin) DO_BIN=0 ;;
    --no-plannotator) DO_PLANNOTATOR=0 ;;
    --target)
      [ $# -ge 2 ] && [ -n "$2" ] || uso_invalido "--target exige um diretório"
      TARGET_ARGS="${TARGET_ARGS}${TARGET_ARGS:+$NL}$2"
      shift
      ;;
    -h | --help)
      uso
      exit 0
      ;;
    *) uso_invalido "opção desconhecida: $1" ;;
  esac
  shift
done

if [ -z "${HOME:-}" ]; then
  erro "HOME não definido — sem home não há diretórios de agente."
  exit 1
fi

# Repassa os --target ao instalador da skill (um por linha → argv).
skill_installer() {
  sub=$1
  if [ -n "$TARGET_ARGS" ]; then
    set -- "$sub"
    while IFS= read -r t; do
      [ -n "$t" ] && set -- "$@" --target "$t"
    done <<EOF
$TARGET_ARGS
EOF
    bash "$SKILL_INSTALLER" "$@"
  else
    bash "$SKILL_INSTALLER" "$sub"
  fi
}

# Diretórios de skills (fonte única: install-agent-skill.sh dirs).
agent_dirs() {
  skill_installer dirs 2>/dev/null
}

# ---------------------------------------------------------------------------
# 1. build
# ---------------------------------------------------------------------------

e_checkout() {
  [ -f "$ROOT/tsconfig.json" ] && [ -d "$ROOT/src" ] && [ -f "$ROOT/package.json" ]
}

dist_desatualizado() {
  [ -f "$CLI_JS" ] || return 0
  # Um .ts de src/ mais novo que o entrypoint compilado = dist/ velho.
  novo=$(find "$ROOT/src" -name '*.ts' -newer "$CLI_JS" -print 2>/dev/null | head -n 1)
  [ -n "$novo" ]
}

passo_build() {
  passo "1/4 build do CLI"
  if ! command -v node >/dev/null 2>&1; then
    falha "node não está no PATH (o prompt-builder exige Node >= 20.11)."
    return
  fi
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=11)?0:1)' 2>/dev/null; then
    falha "Node $(node -v) é antigo demais — o prompt-builder exige >= 20.11."
    return
  fi
  if ! e_checkout; then
    if [ -f "$CLI_JS" ]; then
      info "[ok]        pacote instalado: $CLI_JS"
    else
      falha "dist/cli/index.js não existe em $ROOT (pacote incompleto)."
    fi
    return
  fi
  if [ "$DO_BUILD" = 0 ]; then
    if [ -f "$CLI_JS" ]; then info "[pulado]    --no-build (usando o dist/ atual)"; else falha "--no-build sem dist/: rode npm run build"; fi
    return
  fi
  if ! dist_desatualizado; then
    info "[já ok]     dist/ em dia com src/"
    return
  fi
  if [ ! -d "$ROOT/node_modules" ]; then
    falha "node_modules ausente — rode \`npm install\` na raiz ($ROOT) e repita."
    return
  fi
  info "[compilando] npm run build (dist/ ausente ou mais velho que src/)…"
  if (cd "$ROOT" && npm run build --silent >&2); then
    info "[ok]        dist/ compilado"
  else
    falha "npm run build falhou — veja a saída acima."
  fi
}

# ---------------------------------------------------------------------------
# 2. lançadores em ~/.local/bin
# ---------------------------------------------------------------------------

bin_e_nosso() {
  [ -f "$1" ] && grep -qF "$BIN_MARK" "$1" 2>/dev/null
}

no_path() {
  case ":${PATH:-}:" in
    *":$1:"*) return 0 ;;
  esac
  return 1
}

passo_bins() {
  passo "2/4 lançadores do CLI (a API local da skill)"
  if [ "$DO_BIN" = 0 ]; then
    info "[pulado]    --no-bin"
    return
  fi
  if ! mkdir -p "$BIN_DIR" 2>/dev/null; then
    falha "não consegui criar $BIN_DIR"
    return
  fi
  for nome in $BIN_NAMES; do
    dest=$BIN_DIR/$nome
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      if ! bin_e_nosso "$dest"; then
        aviso "$dest já existe e não foi escrito por este setup — não tocado."
        continue
      fi
    fi
    conteudo="#!/usr/bin/env bash
$BIN_MARK
# origem: $ROOT — refaça com \`npm run agent-setup\` se o repo mudar de lugar.
exec node \"$CLI_JS\" \"\$@\""
    if [ -f "$dest" ] && [ "$(cat "$dest")" = "$conteudo" ]; then
      info "[já ok]     $dest"
      continue
    fi
    if printf '%s\n' "$conteudo" >"$dest" && chmod 755 "$dest"; then
      info "[escrito]   $dest -> node $CLI_JS"
    else
      falha "não consegui escrever $dest"
    fi
  done
  if ! no_path "$BIN_DIR"; then
    aviso "$BIN_DIR não está no PATH — acrescente \`export PATH=\"$BIN_DIR:\$PATH\"\` ao seu shell."
  else
    achado=$(command -v prompt-builder 2>/dev/null || true)
    if [ -n "$achado" ] && [ "$achado" != "$BIN_DIR/prompt-builder" ] && ! bin_e_nosso "$achado"; then
      aviso "o PATH resolve \`prompt-builder\` para $achado (outra instalação vence a deste checkout)."
    fi
  fi
}

# ---------------------------------------------------------------------------
# 3. skill prompt-builder por symlink
# ---------------------------------------------------------------------------

passo_skill() {
  passo "3/4 skill prompt-builder (symlink em todos os agentes)"
  if ! skill_installer install; then
    falha "install-agent-skill.sh install terminou com erro (detalhe acima)."
  fi
}

# ---------------------------------------------------------------------------
# 4. Plannotator + skills de relatório
# ---------------------------------------------------------------------------

PLANNOTATOR_BIN=''
resolve_plannotator() {
  PLANNOTATOR_BIN=$(command -v plannotator 2>/dev/null || true)
  if [ -z "$PLANNOTATOR_BIN" ] && [ -x "$HOME/.local/bin/plannotator" ]; then
    PLANNOTATOR_BIN=$HOME/.local/bin/plannotator
  fi
  [ -n "$PLANNOTATOR_BIN" ]
}

# `plannotator annotate` sem argumento imprime o usage e sai: prova que roda.
plannotator_roda() {
  saida=$("$PLANNOTATOR_BIN" annotate 2>&1 </dev/null)
  case $saida in
    *annotate*) return 0 ;;
  esac
  return 1
}

instala_plannotator() {
  if [ "${PB_PLANNOTATOR_INSTALL:-1}" = 0 ]; then
    aviso "Plannotator ausente e PB_PLANNOTATOR_INSTALL=0 — não instalado."
    return 1
  fi
  if [ "$(id -u)" = 0 ]; then
    aviso "recuso instalar o Plannotator como root."
    return 1
  fi
  command -v curl >/dev/null 2>&1 || {
    aviso "curl ausente — não dá para instalar o Plannotator."
    return 1
  }
  info "[instalando] Plannotator (modo --minimal: só o binário em ~/.local/bin)…"
  PLANNOTATOR_MINIMAL=1 curl -fsSL --max-time 600 "$INSTALL_URL" | bash -s -- --minimal --non-interactive >&2
}

# Primeira cópia íntegra (<dir>/<nome>/SKILL.md) entre os diretórios de agentes
# e o canônico; imprime o caminho REAL.
acha_skill() {
  nome=$1
  { printf '%s\n' "$CANON"; agent_dirs; } | while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -f "$d/$nome/SKILL.md" ]; then
      CDPATH='' cd -P -- "$d/$nome" 2>/dev/null && pwd
      break
    fi
  done
}

busca_skill() {
  repo=$1 caminho=$2 ref=$3 dest=$4
  command -v git >/dev/null 2>&1 || {
    aviso "git ausente — não dá para buscar $caminho."
    return 1
  }
  if [ -e "$dest" ] && [ ! -f "$dest/$MARK" ]; then
    aviso "$dest existe e não foi instalado por este setup — não tocado."
    return 1
  fi
  tmp=$(mktemp -d) || return 1
  if ! git clone --quiet --filter=blob:none --no-checkout --depth 1 --branch "$ref" "$repo" "$tmp/r" 2>/dev/null; then
    if ! git clone --quiet --filter=blob:none --no-checkout --depth 1 "$repo" "$tmp/r" 2>/dev/null; then
      rm -rf "$tmp"
      aviso "clone falhou: $repo"
      return 1
    fi
    aviso "ref '$ref' não existe em $repo — usei o branch padrão."
  fi
  git -C "$tmp/r" sparse-checkout init --cone >/dev/null 2>&1
  git -C "$tmp/r" sparse-checkout set "$caminho" >/dev/null 2>&1
  git -C "$tmp/r" checkout --quiet >/dev/null 2>&1
  if [ ! -f "$tmp/r/$caminho/SKILL.md" ]; then
    rm -rf "$tmp"
    aviso "$caminho/SKILL.md não veio no checkout de $repo"
    return 1
  fi
  mkdir -p "$(dirname -- "$dest")" && rm -rf "$dest" && cp -R "$tmp/r/$caminho" "$dest" || {
    rm -rf "$tmp"
    return 1
  }
  printf 'prompt-builder agent-setup\nrepo=%s\nref=%s\n' "$repo" "$ref" >"$dest/$MARK"
  rm -rf "$tmp"
  return 0
}

# A skill de render chega com `disable-model-invocation: true` (o Plannotator quer
# que a PESSOA peça). O relatório de ciclos é emitido pelo agente, então a nossa
# cópia é destravada; cópias alheias só recebem um aviso.
destrava() {
  dir=$1
  arq=$dir/SKILL.md
  grep -q '^disable-model-invocation: true$' "$arq" 2>/dev/null || return 0
  if [ -f "$dir/$MARK" ]; then
    tmpf=$(mktemp) && grep -v '^disable-model-invocation: true$' "$arq" >"$tmpf" && cat "$tmpf" >"$arq"
    rm -f "$tmpf"
    info "[destravado] $arq (o modelo pode invocar a skill)"
  else
    aviso "$arq tem disable-model-invocation: true — o agente não conseguirá invocá-la sozinho."
  fi
}

# O tema dark da skill (v0.27.x) nasce com fundo claro + texto quase preto nos
# diagramas Mermaid; corrige só a NOSSA cópia.
corrige_tema() {
  arq=$1/references/theme-override.md
  [ -f "$1/$MARK" ] && [ -f "$arq" ] || return 0
  if grep -q "primaryColor: '#9a9dff'" "$arq" && grep -q "primaryTextColor: '#070b14'" "$arq"; then
    sed -i.bak "s/primaryColor: '#9a9dff'/primaryColor: '#1e242e'/; s/primaryTextColor: '#070b14'/primaryTextColor: '#dadee5'/" "$arq" && rm -f "$arq.bak"
    info "[corrigido] tema dark legível em $arq"
  fi
}

# Liga <dir>/<nome> -> origem em todos os diretórios de agentes.
distribui() {
  nome=$1 origem=$2
  agent_dirs | while IFS= read -r d; do
    [ -n "$d" ] || continue
    dest=$d/$nome
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      real=$(CDPATH='' cd -P -- "$dest" 2>/dev/null && pwd)
      if [ "${real:-}" = "$origem" ]; then
        info "[já ok]     $dest"
      elif [ -f "$dest/SKILL.md" ]; then
        info "[mantido]   $dest (outra cópia íntegra — não tocada)"
      else
        aviso "$dest ocupado e sem SKILL.md — não tocado."
      fi
      continue
    fi
    mkdir -p "$d" 2>/dev/null || continue
    if ln -s "$origem" "$dest"; then
      info "[ligado]    $dest -> $origem"
    else
      aviso "não consegui ligar $dest"
    fi
  done
}

garante_skill() {
  nome=$1 repo=$2 caminho=$3 ref=$4
  origem=$(acha_skill "$nome")
  if [ -z "$origem" ]; then
    info "[buscando]  $nome ($repo @ $ref)…"
    if busca_skill "$repo" "$caminho" "$ref" "$CANON/$nome"; then
      origem=$(CDPATH='' cd -P -- "$CANON/$nome" && pwd)
    else
      falha "não consegui instalar a skill $nome."
      return 1
    fi
  else
    info "[encontrada] $nome em $origem"
  fi
  if [ "$nome" = plannotator-visual-explainer ]; then
    destrava "$origem"
    corrige_tema "$origem"
  fi
  distribui "$nome" "$origem"
}

passo_plannotator() {
  passo "4/4 relatório de ciclos (Plannotator + plannotator-visual-explainer)"
  if [ "$DO_PLANNOTATOR" = 0 ]; then
    info "[pulado]    --no-plannotator"
    return
  fi
  if resolve_plannotator && plannotator_roda; then
    info "[já ok]     plannotator: $PLANNOTATOR_BIN ($("$PLANNOTATOR_BIN" --version 2>/dev/null | head -n 1))"
  else
    if instala_plannotator && resolve_plannotator && plannotator_roda; then
      info "[instalado] plannotator: $PLANNOTATOR_BIN"
    else
      falha "Plannotator indisponível — o relatório HTML ainda sai (sessions report --html), mas sem a UI de anotação."
    fi
  fi
  versao=''
  if [ -n "$PLANNOTATOR_BIN" ]; then
    versao=$("$PLANNOTATOR_BIN" --version 2>/dev/null | tr -dc '0-9.' | head -c 32)
  fi
  ref=${PB_SKILLS_REF:-${versao:+v$versao}}
  garante_skill plannotator-visual-explainer "$PLANNOTATOR_REPO" "$PLANNOTATOR_SKILL_PATH" "${ref:-main}"
  garante_skill visual-explainer "$VE_REPO" "$VE_SKILL_PATH" main
}

# ---------------------------------------------------------------------------
# doctor / uninstall
# ---------------------------------------------------------------------------

cmd_doctor() {
  problemas=0
  info "prompt-builder agent-setup — doctor ($ROOT)"
  passo "CLI"
  if [ -f "$CLI_JS" ]; then
    info "[ok]        $CLI_JS ($(node "$CLI_JS" --version 2>/dev/null || echo 'não executa'))"
    if e_checkout && dist_desatualizado; then
      info "[PROBLEMA]  dist/ mais velho que src/ — rode npm run agent-setup (ou npm run build)"
      problemas=$((problemas + 1))
    fi
  else
    info "[PROBLEMA]  $CLI_JS ausente — rode npm run agent-setup"
    problemas=$((problemas + 1))
  fi
  for nome in $BIN_NAMES; do
    dest=$BIN_DIR/$nome
    if bin_e_nosso "$dest"; then
      info "[ok]        $dest"
    elif [ -e "$dest" ]; then
      info "[alheio]    $dest (não foi escrito por este setup)"
    else
      info "[ausente]   $dest"
      problemas=$((problemas + 1))
    fi
  done
  no_path "$BIN_DIR" || info "[aviso]     $BIN_DIR fora do PATH"
  passo "skill prompt-builder"
  skill_installer doctor || problemas=$((problemas + 1))
  passo "relatório (Plannotator)"
  if resolve_plannotator && plannotator_roda; then
    info "[ok]        plannotator: $PLANNOTATOR_BIN"
  else
    info "[PROBLEMA]  plannotator ausente — rode npm run agent-setup"
    problemas=$((problemas + 1))
  fi
  for nome in plannotator-visual-explainer visual-explainer; do
    origem=$(acha_skill "$nome")
    if [ -z "$origem" ]; then
      info "[PROBLEMA]  skill $nome ausente"
      problemas=$((problemas + 1))
      continue
    fi
    total=0 ligados=0
    while IFS= read -r d; do
      [ -n "$d" ] || continue
      total=$((total + 1))
      [ -f "$d/$nome/SKILL.md" ] && ligados=$((ligados + 1))
    done <<EOF
$(agent_dirs)
EOF
    info "[ok]        $nome em $origem — visível em $ligados de $total diretório(s) de agentes"
  done
  info ""
  if [ "$problemas" -gt 0 ]; then
    info "Resumo: $problemas problema(s)."
    exit 1
  fi
  info "Resumo: tudo pronto."
  exit 0
}

cmd_uninstall() {
  passo "lançadores"
  for nome in $BIN_NAMES; do
    dest=$BIN_DIR/$nome
    if bin_e_nosso "$dest"; then
      rm -f "$dest" && info "[removido]  $dest"
    fi
  done
  passo "skill prompt-builder"
  skill_installer uninstall || N_ERROS=$((N_ERROS + 1))
  passo "skills de relatório (só as que este setup instalou)"
  for nome in plannotator-visual-explainer visual-explainer; do
    nosso=$CANON/$nome
    [ -f "$nosso/$MARK" ] || {
      info "[mantido]   $nome (não foi instalada por este setup)"
      continue
    }
    real=$(CDPATH='' cd -P -- "$nosso" && pwd)
    agent_dirs | while IFS= read -r d; do
      link=$d/$nome
      [ -L "$link" ] || continue
      alvo=$(CDPATH='' cd -P -- "$link" 2>/dev/null && pwd)
      [ "${alvo:-}" = "$real" ] && rm -f "$link" && info "[removido]  $link"
    done
    rm -rf "$nosso" && info "[removido]  $nosso"
  done
  info ""
  info "O binário do Plannotator NÃO foi tocado (remova com \`plannotator uninstall\`)."
  [ "$N_ERROS" -eq 0 ] || exit 1
  exit 0
}

# ---------------------------------------------------------------------------
# Despacho
# ---------------------------------------------------------------------------

case $SUB in
  doctor) cmd_doctor ;;
  uninstall) cmd_uninstall ;;
esac

info "prompt-builder agent-setup — origem: $ROOT"
passo_build
passo_bins
passo_skill
passo_plannotator

info ""
if [ "$N_ERROS" -gt 0 ]; then
  erro "setup terminou com $N_ERROS problema(s) — veja acima. \`npm run agent-setup:doctor\` mostra o estado."
  exit 1
fi
info "Pronto. Agentes: \`prompt-builder docs quickstart\` · relatório: \`prompt-builder sessions report <id> --html <arq>\`."
exit 0
