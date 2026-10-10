#!/usr/bin/env bash
# where.sh — onde o prompt-builder está DE VERDADE e como rodá-lo daqui.
#
# A skill `prompt-builder` chega aos agentes por SYMLINK
# (<dir-de-skills>/prompt-builder -> <raiz>/skills/prompt-builder). Este script
# segue o link até a pasta real, acha a raiz — checkout do repo OU pacote npm
# instalado — e diz, de qualquer diretório: o comando do CLI a usar, o estado
# do build, da key e do diretório de dados, e o comando EXATO que corrige o que
# faltar. Numa cópia da skill (`prompt-builder init`), sem raiz por perto, ele
# cai no `prompt-builder` do PATH ou no `npx prompt-builder-cli`.
#
# Só LÊ: nunca compila, instala, grava nem imprime a key.
#
# Uso: bash where.sh [--cli]
#   (sem flag)  relatório legível
#   --cli       só o comando do CLI, numa linha (p.ex. para um script)
# Exit: 0 pronto para rodar · 1 falta algo (o relatório diz o quê) · 2 uso inválido.

set -u

MODO=relatorio
case ${1:-} in
  '') ;;
  --cli) MODO=cli ;;
  -h | --help | help)
    sed -n '2,/^# Exit:/p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    printf 'ERRO: opção desconhecida: %s — Solução: bash %s [--cli]\n' "$1" "$0" >&2
    exit 2
    ;;
esac

LAUNCHER_MARK='# managed-by: prompt-builder agent-setup'

# Caminho REAL de um arquivo, atravessando symlinks (sem readlink -f: portável).
caminho_real() {
  src=$1
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

# `<raiz>` é o prompt-builder-cli (checkout ou pacote)? Mesmo critério do instalador.
e_raiz() {
  grep -q '"name"[[:space:]]*:[[:space:]]*"prompt-builder-cli"' "$1/package.json" 2>/dev/null
}

# Aspas só quando o caminho precisa (espaço etc.), para o comando colar em qualquer shell.
cita() {
  case $1 in
    *[!A-Za-z0-9_./:@%+=-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# 1. A skill: o caminho pedido (às vezes um symlink) e a pasta real
# ---------------------------------------------------------------------------

PEDIDO=$(dirname -- "$0")
SKILL_REAL=$(CDPATH='' cd -P -- "$PEDIDO" 2>/dev/null && pwd) || {
  printf 'ERRO: não consegui resolver a pasta da skill a partir de %s\n' "$0" >&2
  exit 1
}
SKILL_LOGICO=$(CDPATH='' cd -- "$PEDIDO" 2>/dev/null && pwd)
LINK=''
[ -L "$SKILL_LOGICO" ] && LINK=$SKILL_LOGICO

# ---------------------------------------------------------------------------
# 2. A raiz: <skill>/../.. no checkout e no pacote; nada numa cópia
# ---------------------------------------------------------------------------

ROOT='' KIND='' CLI='' CLI_JS='' NOTA_CLI=''
PROBLEMAS='' CORRIGIR=''
problema() { PROBLEMAS="${PROBLEMAS}  - $1
"; }
corrigir() { CORRIGIR="${CORRIGIR}  $1
"; }

CAND=$(CDPATH='' cd -P -- "$SKILL_REAL/../.." 2>/dev/null && pwd)
if [ -n "$CAND" ] && e_raiz "$CAND"; then
  ROOT=$CAND
  if [ -f "$ROOT/tsconfig.json" ] && [ -d "$ROOT/src" ]; then KIND=checkout; else KIND=pacote; fi
fi

PATH_BIN=$(command -v prompt-builder 2>/dev/null || true)
PATH_REAL=''
[ -n "$PATH_BIN" ] && PATH_REAL=$(caminho_real "$PATH_BIN" 2>/dev/null || true)

# Raiz para onde o `prompt-builder` do PATH leva (lançador do agent-setup ou bin do npm).
raiz_do_path() {
  [ -n "$PATH_BIN" ] || return 1
  js=''
  if grep -qF "$LAUNCHER_MARK" "$PATH_BIN" 2>/dev/null; then
    js=$(sed -n 's/^exec node "\(.*\)" "\$@"$/\1/p' "$PATH_BIN" | head -n 1)
  else
    js=$PATH_REAL
  fi
  case $js in
    */dist/cli/index.js) ;;
    *) return 1 ;;
  esac
  r=${js%/dist/cli/index.js}
  e_raiz "$r" || return 1
  printf '%s\n' "$r"
}

if [ -z "$ROOT" ]; then
  # Cópia da skill (ex.: `prompt-builder init`): a raiz vem do PATH, se houver.
  KIND=copia
  if r=$(raiz_do_path); then
    ROOT=$(CDPATH='' cd -P -- "$r" && pwd)
    CLI=prompt-builder
    NOTA_CLI="PATH → $PATH_BIN"
  elif [ -n "$PATH_BIN" ]; then
    CLI=prompt-builder
    NOTA_CLI="PATH → $PATH_BIN (instalação não reconhecida)"
  else
    CLI='npx prompt-builder-cli'
    NOTA_CLI='versão PUBLICADA no npm (baixa na 1ª vez)'
  fi
fi

if [ -n "$ROOT" ]; then
  CLI_JS=$ROOT/dist/cli/index.js
fi

# ---------------------------------------------------------------------------
# 3. Git (checkout): qual versão roda e o worktree efêmero
# ---------------------------------------------------------------------------

GIT_INFO='' MAIN_ROOT=''
if [ "$KIND" = checkout ] && command -v git >/dev/null 2>&1 &&
  git -C "$ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  branch=$(git -C "$ROOT" symbolic-ref --short -q HEAD 2>/dev/null || echo 'HEAD solto')
  commit=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null)
  GIT_INFO="git $branch @ $commit"
  gitdir=$(git -C "$ROOT" rev-parse --absolute-git-dir 2>/dev/null)
  comum=$(cd "$ROOT" 2>/dev/null && CDPATH='' cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd)
  if [ -n "$gitdir" ] && [ -n "$comum" ] && [ "$gitdir" != "$comum" ]; then
    # Worktree LIGADO (`git worktree add`): some com `git worktree remove` e leva
    # junto todo symlink/lançador global que aponte para cá.
    case $comum in
      */.git) MAIN_ROOT=${comum%/.git} ;;
    esac
    GIT_INFO="$GIT_INFO · WORKTREE ligado (efêmero)"
  fi
fi

# ---------------------------------------------------------------------------
# 4. Node e build
# ---------------------------------------------------------------------------

NODE_V=''
if command -v node >/dev/null 2>&1; then
  NODE_V=$(node -v 2>/dev/null)
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=11)?0:1)' 2>/dev/null; then
    problema "Node $NODE_V é antigo demais (o prompt-builder exige >= 20.11)"
  fi
else
  problema 'node não está no PATH (o prompt-builder exige Node >= 20.11)'
fi

BUILD=''
if [ "$KIND" = checkout ]; then
  if [ ! -d "$ROOT/node_modules" ]; then
    BUILD='node_modules ausente'
    problema 'dependências não instaladas no checkout'
    corrigir "npm --prefix $(cita "$ROOT") install && npm --prefix $(cita "$ROOT") run build"
  elif [ ! -f "$CLI_JS" ]; then
    BUILD='dist/ ausente'
    problema 'CLI não compilado (dist/ ausente)'
    corrigir "npm --prefix $(cita "$ROOT") run build"
  elif [ -n "$(find "$ROOT/src" -name '*.ts' -newer "$CLI_JS" -print 2>/dev/null | head -n 1)" ]; then
    BUILD='dist/ mais velho que src/ (roda, mas sem as mudanças recentes)'
    corrigir "npm --prefix $(cita "$ROOT") run build"
  else
    BUILD='dist/ em dia com src/'
  fi
elif [ "$KIND" = pacote ]; then
  if [ -f "$CLI_JS" ]; then BUILD='pacote compilado'; else
    BUILD='dist/ ausente'
    problema "pacote incompleto: falta $CLI_JS — reinstale o prompt-builder-cli"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Qual comando usar: o `prompt-builder` do PATH só se ele leva a ESTA raiz
# ---------------------------------------------------------------------------

if [ "$KIND" != copia ]; then
  if [ -n "$PATH_BIN" ] && r=$(raiz_do_path) && [ "$(CDPATH='' cd -P -- "$r" && pwd)" = "$ROOT" ]; then
    CLI=prompt-builder
    NOTA_CLI="PATH → $PATH_BIN (leva a esta raiz)"
  else
    CLI="node $(cita "$CLI_JS")"
    if [ -n "$PATH_BIN" ]; then
      NOTA_CLI="o \`prompt-builder\` do PATH ($PATH_BIN) é OUTRA instalação — use o comando ao lado"
    else
      NOTA_CLI='`prompt-builder` fora do PATH — use o comando ao lado'
    fi
    corrigir "bash $(cita "${MAIN_ROOT:-$ROOT}/scripts/agent-setup.sh") install   # lançadores no PATH + skill em todos os agentes"
  fi
fi

if [ -n "$CLI_JS" ] && [ -f "$CLI_JS" ] && [ -n "$NODE_V" ]; then
  if ! node "$CLI_JS" --version >/dev/null 2>&1; then
    problema "o CLI não executa: node $CLI_JS --version falhou"
  fi
fi

# ---------------------------------------------------------------------------
# 6. Dados e key (só a presença — nunca o valor)
# ---------------------------------------------------------------------------

if [ -n "${PROMPT_BUILDER_HOME:-}" ]; then
  DATA_DIR=$PROMPT_BUILDER_HOME
elif [ -n "${XDG_STATE_HOME:-}" ]; then
  DATA_DIR=$XDG_STATE_HOME/prompt-builder
else
  DATA_DIR=${HOME:-}/.prompt-builder
fi

if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  KEY='OPENROUTER_API_KEY no ambiente'
elif [ -s "$DATA_DIR/key" ]; then
  KEY="arquivo $DATA_DIR/key (gravado por \`key set\`)"
else
  KEY="AUSENTE — o usuário grava uma vez: $CLI key set --stdin (key pela entrada padrão, nunca em argv). models/estimate/--dry-run rodam sem key"
fi

# ---------------------------------------------------------------------------
# Saída
# ---------------------------------------------------------------------------

if [ "$MODO" = cli ]; then
  printf '%s\n' "$CLI"
  if [ -n "$PROBLEMAS" ]; then
    printf '%s' "$PROBLEMAS" >&2
    exit 1
  fi
  exit 0
fi

VERSAO=''
if [ -n "$ROOT" ]; then
  VERSAO=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -n 1)
fi

printf 'prompt-builder — localização real (resolvida agora pelo where.sh)\n'
if [ -n "$LINK" ]; then
  printf '  skill    %s -> %s\n' "$LINK" "$SKILL_REAL"
else
  printf '  skill    %s\n' "$SKILL_REAL"
fi
case $KIND in
  checkout) printf '  raiz     %s  [checkout do repositório%s]\n' "$ROOT" "${GIT_INFO:+ · $GIT_INFO}" ;;
  pacote) printf '  raiz     %s  [pacote npm instalado]\n' "$ROOT" ;;
  copia)
    if [ -n "$ROOT" ]; then
      printf '  raiz     %s  [esta skill é uma CÓPIA; raiz achada pelo PATH]\n' "$ROOT"
    else
      printf '  raiz     (nenhuma — esta skill é uma CÓPIA e não há instalação reconhecida no PATH)\n'
    fi
    ;;
esac
if [ -n "$VERSAO" ]; then
  printf '  versão   prompt-builder-cli %s%s\n' "$VERSAO" "${NODE_V:+ · node $NODE_V}"
elif [ -n "$NODE_V" ]; then
  printf '  versão   node %s\n' "$NODE_V"
fi
printf '  CLI      %s   (%s)\n' "$CLI" "$NOTA_CLI"
[ -n "$BUILD" ] && printf '  build    %s\n' "$BUILD"
printf '  key      %s\n' "$KEY"
printf '  dados    %s (runs/, sessions/, jev-runs/, key)\n' "$DATA_DIR"
printf '  docs     %s docs --list · terminal.md (guia completo) e models.md na pasta real da skill\n' "$CLI"

if [ -n "$MAIN_ROOT" ] && [ "$MAIN_ROOT" != "$ROOT" ]; then
  printf '\nATENÇÃO: esta raiz é um worktree ligado — some com `git worktree remove` e quebra a skill\n'
  printf 'e os lançadores globais que apontarem para cá. Instalação global estável:\n'
  printf '  bash %s install\n' "$(cita "$MAIN_ROOT/scripts/agent-setup.sh")"
fi

if [ -n "$PROBLEMAS" ]; then
  printf '\nFALTA para rodar:\n%s' "$PROBLEMAS"
fi
if [ -n "$CORRIGIR" ]; then
  printf '\nCorrigir (rode na ordem):\n%s' "$CORRIGIR"
fi

if [ -n "$PROBLEMAS" ]; then
  exit 1
fi
if [ "$CLI" = prompt-builder ]; then
  printf '\nPronto: os comandos `prompt-builder …` da skill rodam como estão, de qualquer diretório.\n'
else
  printf '\nPronto: troque `prompt-builder` por `%s` nos comandos da skill (vale de qualquer diretório).\n' "$CLI"
fi
exit 0
