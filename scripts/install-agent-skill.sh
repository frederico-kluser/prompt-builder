#!/usr/bin/env bash
# install-agent-skill.sh — instala a skill `prompt-builder` (skills/prompt-builder)
# GLOBALMENTE, por SYMLINK, nos diretórios de skills dos agentes de código.
#
# Complemento GLOBAL do `prompt-builder init --agent <nome>` (que copia a skill
# para o REPOSITÓRIO corrente: .claude/skills, .agents/skills, …). Aqui o link
# aponta sempre para a pasta real da skill — checkout do repo OU pacote instalado
# em node_modules/prompt-builder-cli — resolvida a partir da localização deste
# próprio script: atualizar o repo/pacote atualiza a skill em todos os agentes.
#
# Zero dependências para além de bash + utilitários POSIX (mkdir/ln/rm/readlink).
# Uso:
#   bash scripts/install-agent-skill.sh install   [--target <dir>]...
#   bash scripts/install-agent-skill.sh uninstall [--target <dir>]...
#   bash scripts/install-agent-skill.sh doctor    [--target <dir>]...
#   bash scripts/install-agent-skill.sh help
#
# Sem `--target`, o `install` vai para TODOS os diretórios de skills de agentes
# conhecidos que existirem na máquina — e cria o diretório se faltar, desde que o
# agente correspondente esteja instalado (detetado pelo diretório de config dele):
#
#   agente          marcador (config)        diretório de skills
#   Claude Code     ~/.claude                ~/.claude/skills
#   Claude (perfil) $CLAUDE_CONFIG_DIR       $CLAUDE_CONFIG_DIR/skills
#   Claude (perfis) ~/.claude-<nome>         ~/.claude-<nome>/skills  (só perfis
#                                            reais: com skills/, settings.json
#                                            ou projects/ — backups ficam fora)
#   Codex CLI       ~/.codex                 ~/.codex/skills
#   Copilot CLI     ~/.copilot               ~/.copilot/skills
#   Cursor          ~/.cursor                ~/.cursor/skills
#   Kiro            ~/.kiro                  ~/.kiro/skills
#   DSH             ~/.dsh                   ~/.dsh/skills
#   jcode           ~/.jcode                 ~/.jcode/skills
#   pi              ~/.pi/agent              ~/.pi/agent/skills
#   Gemini CLI      ~/.gemini                ~/.gemini/skills
#   OpenCode        ~/.config/opencode       ~/.config/opencode/skills
#   OpenCode (leg.) ~/.config/opencode/skill (só se já existir — convenção antiga)
#   genérico        ~/.agents                ~/.agents/skills   (agentskills.io)
#
# Diretórios repetidos (ex.: CLAUDE_CONFIG_DIR=~/.claude) contam uma vez só.
# PB_EXTRA_AGENT_DIRS="dir1:dir2" acrescenta alvos à descoberta (criados sempre).
#
# `--target <dir>` (repetível) substitui a descoberta: instala sempre nesses
# diretórios, criando-os se necessário — vale para qualquer agente fora da lista.
#
# `dirs` imprime, um por linha, os diretórios de skills que o `install` usaria
# (é a FONTE ÚNICA da descoberta — o scripts/agent-setup.sh lê daqui).
#
# `install` é idempotente: link já apontado = "já ok"; link antigo DESTA skill
# (caminho `.../skills/prompt-builder`, ex.: repo mudou de lugar) = re-apontado;
# ficheiro/diretório/link alheio nunca é tocado (conta como erro, exit 1).
#
# `uninstall` remove APENAS symlinks `<alvo>/prompt-builder` que apontam para esta
# skill (esta origem ou outra `.../skills/prompt-builder`); cópias locais, links
# de outras skills e ficheiros alheios nunca são tocados.
#
# `doctor` diz onde está instalado, se o link está íntegro (não quebrado) e se o
# SKILL.md está visível através dele.
#
# Saída em PT-BR. Exit codes: 0 ok · 2 uso inválido · 1 operacional (skill em
# falta, alvo ocupado por ficheiro alheio, falha de mkdir/ln, link quebrado ou
# nada instalado no `doctor`, nada instalado no `install`).

set -u

SKILL_NAME="prompt-builder"
PROG=$(basename "$0")

# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

info() { printf '%s\n' "$*"; }
erro() { printf 'ERRO: %s\n' "$*" >&2; }

uso() {
  cat <<EOF
Uso: bash $PROG <install|uninstall|doctor|dirs|help> [--target <dir>]...

  install    cria <alvo>/prompt-builder -> <origem>/skills/prompt-builder (symlink)
  uninstall  remove só os symlinks que apontam para esta skill
  doctor     lista onde está instalado, se o link está íntegro e o SKILL.md visível
  dirs       imprime os diretórios de skills que o install usaria (um por linha)

  --target <dir>   diretório de skills a usar (repetível; substitui a descoberta
                   e é sempre criado se faltar). Sem ele, o install cobre os
                   diretórios de agentes conhecidos que existirem na máquina,
                   todos relativos ao home do usuário:
                   .claude/skills · \$CLAUDE_CONFIG_DIR/skills · .claude-<perfil>/skills ·
                   .codex/skills · .copilot/skills · .cursor/skills · .kiro/skills ·
                   .dsh/skills · .jcode/skills · .pi/agent/skills · .gemini/skills ·
                   .config/opencode/skills (+ .config/opencode/skill legado) ·
                   .agents/skills  (+ PB_EXTRA_AGENT_DIRS="d1:d2")

Exit codes: 0 ok · 2 uso inválido · 1 operacional (detalhe no fim da saída).
Este instalador liga a skill GLOBALMENTE (symlink, acompanha o repo/pacote);
para uma cópia POR PROJETO use \`prompt-builder init --agent <nome|all>\`
(vem no CLI, copia para .claude/skills, .agents/skills, … do projeto).
EOF
}

# Sai por uso inválido (exit 2), com o motivo no stderr.
uso_invalido() {
  erro "$1"
  printf 'Rode \`bash %s help\` para o uso.\n' "$PROG" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Resolução da origem (checkout OU pacote instalado) a partir do próprio script
# ---------------------------------------------------------------------------

# Diretório REAL do script, atravessando symlinks (sem readlink -f: portável).
resolve_script_dir() {
  src=$0
  while [ -L "$src" ]; do
    dir=$(CDPATH='' cd -P -- "$(dirname -- "$src")" 2>/dev/null && pwd) || return 1
    link=$(readlink "$src") || return 1
    case $link in
      /*) src=$link ;;
      *) src=$dir/$link ;;
    esac
  done
  CDPATH='' cd -P -- "$(dirname -- "$src")" 2>/dev/null && pwd
}

SCRIPT_DIR=$(resolve_script_dir) || {
  erro "não consegui resolver a pasta deste script."
  exit 1
}

# Origem da skill: <raiz do repo ou do pacote>/skills/prompt-builder
SKILL_SRC=$(CDPATH='' cd -P -- "$SCRIPT_DIR/../skills/$SKILL_NAME" 2>/dev/null && pwd)

checa_origem() {
  if [ -z "${SKILL_SRC:-}" ] || [ ! -f "$SKILL_SRC/SKILL.md" ]; then
    erro "SKILL.md não encontrado em $SCRIPT_DIR/../skills/$SKILL_NAME (origem da skill em falta)."
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Alvos
# ---------------------------------------------------------------------------

# Linhas "nome|marcador|dir"; o modo é derivado do nome (opencode-legado = só se
# o diretório já existir; extra = sempre; os restantes = criar se o marcador
# existir). Um mesmo diretório aparece UMA vez (o primeiro nome vence).
alvos_conhecidos() {
  xdg=${XDG_CONFIG_HOME:-$HOME/.config}
  {
    printf 'claude-code|%s|%s\n' "$HOME/.claude" "$HOME/.claude/skills"
    if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
      printf 'claude-config|%s|%s\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_CONFIG_DIR/skills"
    fi
    # Perfis extras do Claude Code (o que CLAUDE_CONFIG_DIR aponta quando há mais
    # de uma conta na máquina). Só perfis REAIS: um ~/.claude-backups qualquer
    # não ganha uma pasta skills/ nova.
    for perfil in "$HOME"/.claude-*; do
      [ -d "$perfil" ] || continue
      if [ -d "$perfil/skills" ] || [ -f "$perfil/settings.json" ] || [ -d "$perfil/projects" ]; then
        printf 'claude-perfil:%s|%s|%s\n' "${perfil##*/}" "$perfil" "$perfil/skills"
      fi
    done
    printf 'codex|%s|%s\n' "$HOME/.codex" "$HOME/.codex/skills"
    printf 'copilot|%s|%s\n' "$HOME/.copilot" "$HOME/.copilot/skills"
    printf 'cursor|%s|%s\n' "$HOME/.cursor" "$HOME/.cursor/skills"
    printf 'kiro|%s|%s\n' "$HOME/.kiro" "$HOME/.kiro/skills"
    printf 'dsh|%s|%s\n' "$HOME/.dsh" "$HOME/.dsh/skills"
    printf 'jcode|%s|%s\n' "$HOME/.jcode" "$HOME/.jcode/skills"
    printf 'pi|%s|%s\n' "$HOME/.pi/agent" "$HOME/.pi/agent/skills"
    printf 'gemini-cli|%s|%s\n' "$HOME/.gemini" "$HOME/.gemini/skills"
    printf 'opencode|%s|%s\n' "$xdg/opencode" "$xdg/opencode/skills"
    printf 'opencode-legado|-|%s\n' "$xdg/opencode/skill"
    printf 'generico|%s|%s\n' "$HOME/.agents" "$HOME/.agents/skills"
    if [ -n "${PB_EXTRA_AGENT_DIRS:-}" ]; then
      printf '%s\n' "$PB_EXTRA_AGENT_DIRS" | tr ':' '\n' | while IFS= read -r d; do
        [ -n "$d" ] && printf 'extra|-|%s\n' "$d"
      done
    fi
  } | awk -F'|' '!visto[$3]++'
}

# Lista final "nome|marcador|dir" conforme o subcomando; ALVOS_EXPLICITOS (por
# linha) manda sobre a descoberta e vale sempre (instala mesmo sem agente).
lista_alvos() {
  sub=$1
  if [ -n "${ALVOS_EXPLICITOS:-}" ]; then
    printf '%s\n' "$ALVOS_EXPLICITOS" | while IFS= read -r d; do
      [ -n "$d" ] && printf 'custom|-|%s\n' "$d"
    done
    return 0
  fi
  alvos_conhecidos | while IFS='|' read -r nome marcador dir; do
    if [ "$nome" = "opencode-legado" ]; then
      [ -d "$dir" ] && printf '%s|%s|%s\n' "$nome" "$marcador" "$dir"
      continue
    fi
    if [ "$nome" = "extra" ]; then
      printf '%s|%s|%s\n' "$nome" "$marcador" "$dir"
      continue
    fi
    if [ -d "$dir" ] || [ -d "$marcador" ]; then
      printf '%s|%s|%s\n' "$nome" "$marcador" "$dir"
    elif [ "$sub" = "doctor" ]; then
      printf '%s|%s|%s\n' "$nome" "$marcador" "$dir" # o doctor explica o estado
    fi
  done
  return 0
}

# O link aponta para ESTA skill (esta origem ou outra pasta skills/prompt-builder)?
link_e_da_skill() {
  dest=$1
  alvo_link=$(readlink "$dest" 2>/dev/null) || return 1
  [ "$alvo_link" = "$SKILL_SRC" ] && return 0
  case $alvo_link in
    */skills/$SKILL_NAME) return 0 ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

cmd_install() {
  checa_origem
  info "Origem da skill: $SKILL_SRC"
  n_ok=0 n_ligados=0 n_repontados=0 n_erros=0

  while IFS='|' read -r nome marcador dir; do
    [ -n "${dir:-}" ] || continue
    dest=$dir/$SKILL_NAME
    if [ -L "$dest" ]; then
      resolvido=$(CDPATH='' cd -P -- "$dest" 2>/dev/null && pwd)
      if [ "${resolvido:-}" = "$SKILL_SRC" ]; then
        info "[já ok]     $nome: $dest -> $SKILL_SRC"
        n_ok=$((n_ok + 1))
        continue
      fi
      antes=$(readlink "$dest" 2>/dev/null)
      if link_e_da_skill "$dest"; then
        # instalação antiga DESTA skill (ex.: repo mudou de lugar): re-aponta
        if rm -f "$dest" && ln -s "$SKILL_SRC" "$dest"; then
          info "[re-apont.] $nome: $dest -> $SKILL_SRC (era: $antes)"
          n_repontados=$((n_repontados + 1))
        else
          erro "$nome: não consegui re-apontar $dest"
          n_erros=$((n_erros + 1))
        fi
      else
        erro "$nome: $dest é link de outra origem ($antes) — não tocado."
        n_erros=$((n_erros + 1))
      fi
      continue
    fi
    if [ -e "$dest" ]; then
      erro "$nome: $dest está ocupado por um ficheiro/diretório alheio — não tocado."
      n_erros=$((n_erros + 1))
      continue
    fi
    if [ ! -d "$dir" ]; then
      if mkdir -p "$dir" 2>/dev/null; then
        info "[criado]    $nome: diretório $dir"
      else
        erro "$nome: não consegui criar o diretório $dir"
        n_erros=$((n_erros + 1))
        continue
      fi
    fi
    if ln -s "$SKILL_SRC" "$dest"; then
      info "[ligado]    $nome: $dest -> $SKILL_SRC"
      n_ligados=$((n_ligados + 1))
    else
      erro "$nome: não consegui criar o symlink $dest"
      n_erros=$((n_erros + 1))
    fi
  done <<EOF
$(lista_alvos install)
EOF

  info ""
  info "Resumo: $n_ligados ligado(s), $n_repontados re-apontado(s), $n_ok já ok, $n_erros erro(s)."
  if [ $((n_ligados + n_repontados + n_ok)) -eq 0 ]; then
    if [ "$n_erros" -gt 0 ]; then
      erro "nada instalado — veja os erros acima."
    else
      erro "nada instalado — nenhum diretório de agente encontrado; use --target <dir>."
    fi
    exit 1
  fi
  [ "$n_erros" -eq 0 ] || exit 1
  exit 0
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------

cmd_uninstall() {
  checa_origem
  info "Origem da skill: $SKILL_SRC"
  n_removidos=0 n_mantidos=0 n_ausentes=0 n_erros=0

  while IFS='|' read -r nome marcador dir; do
    [ -n "${dir:-}" ] || continue
    dest=$dir/$SKILL_NAME
    if [ -L "$dest" ]; then
      if link_e_da_skill "$dest"; then
        if rm -f "$dest"; then
          info "[removido]  $nome: $dest"
          n_removidos=$((n_removidos + 1))
        else
          erro "$nome: não consegui remover $dest"
          n_erros=$((n_erros + 1))
        fi
      else
        info "[mantido]   $nome: $dest é link de outra origem ($(readlink "$dest" 2>/dev/null))"
        n_mantidos=$((n_mantidos + 1))
      fi
      continue
    fi
    if [ -e "$dest" ]; then
      info "[mantido]   $nome: $dest é cópia/ficheiro local (não é symlink desta skill)"
      n_mantidos=$((n_mantidos + 1))
    else
      n_ausentes=$((n_ausentes + 1))
    fi
  done <<EOF
$(lista_alvos uninstall)
EOF

  info ""
  info "Resumo: $n_removidos removido(s), $n_mantidos mantido(s), $n_ausentes sem nada, $n_erros erro(s)."
  [ "$n_erros" -eq 0 ] || exit 1
  exit 0
}

# ---------------------------------------------------------------------------
# doctor
# ---------------------------------------------------------------------------

cmd_doctor() {
  info "Skill: $SKILL_NAME"
  if [ -n "${SKILL_SRC:-}" ] && [ -f "$SKILL_SRC/SKILL.md" ]; then
    info "Origem: $SKILL_SRC (SKILL.md ok)"
  else
    info "Origem: $SCRIPT_DIR/../skills/$SKILL_NAME — EM FALTA (skill ilegível)"
  fi
  info ""
  n_ok=0 n_problemas=0 n_ausentes=0 n_sem_agente=0

  while IFS='|' read -r nome marcador dir; do
    [ -n "${dir:-}" ] || continue
    dest=$dir/$SKILL_NAME
    if [ -L "$dest" ]; then
      if [ -f "$dest/SKILL.md" ]; then
        info "[ok]        $nome: $dest -> $(readlink "$dest" 2>/dev/null) (SKILL.md visível)"
        n_ok=$((n_ok + 1))
      else
        info "[PROBLEMA]  $nome: $dest -> $(readlink "$dest" 2>/dev/null) LINK QUEBRADO (SKILL.md invisível)"
        n_problemas=$((n_problemas + 1))
      fi
    elif [ -d "$dest" ]; then
      if [ -f "$dest/SKILL.md" ]; then
        info "[cópia]     $nome: $dest (pasta local, não é symlink — o uninstall não a remove)"
        n_ok=$((n_ok + 1))
      else
        info "[PROBLEMA]  $nome: $dest existe mas não tem SKILL.md"
        n_problemas=$((n_problemas + 1))
      fi
    elif [ -e "$dest" ]; then
      info "[PROBLEMA]  $nome: $dest ocupado por um ficheiro alheio"
      n_problemas=$((n_problemas + 1))
    elif [ "$marcador" != "-" ] && [ ! -d "$marcador" ]; then
      info "[sem agente] $nome: $marcador não existe nesta máquina"
      n_sem_agente=$((n_sem_agente + 1))
    else
      info "[ausente]   $nome: $dest (use \`install\`)"
      n_ausentes=$((n_ausentes + 1))
    fi
  done <<EOF
$(lista_alvos doctor)
EOF

  info ""
  info "Resumo: $n_ok íntegro(s), $n_problemas problema(s), $n_ausentes ausente(s), $n_sem_agente sem agente."
  if [ "$n_ok" -eq 0 ]; then
    erro "nada instalado — rode \`bash $PROG install\`."
    exit 1
  fi
  [ "$n_problemas" -eq 0 ] || exit 1
  exit 0
}

# ---------------------------------------------------------------------------
# Despacho
# ---------------------------------------------------------------------------

[ $# -ge 1 ] || {
  uso >&2
  exit 2
}

SUB=$1
shift

case $SUB in
  install | uninstall | doctor | dirs) ;;
  help | -h | --help)
    uso
    exit 0
    ;;
  *)
    uso_invalido "subcomando desconhecido: $SUB"
    ;;
esac

if [ -z "${HOME:-}" ]; then
  erro "HOME não definido — sem home não há diretórios de agente."
  exit 1
fi

ALVOS_EXPLICITOS=''
NL='
'
while [ $# -gt 0 ]; do
  case $1 in
    --target)
      [ $# -ge 2 ] || uso_invalido "--target exige um diretório"
      case $2 in
        '') uso_invalido "--target exige um diretório não vazio" ;;
      esac
      ALVOS_EXPLICITOS="${ALVOS_EXPLICITOS}${ALVOS_EXPLICITOS:+$NL}$2"
      shift 2
      ;;
    -h | --help)
      uso
      exit 0
      ;;
    *)
      uso_invalido "opção desconhecida: $1"
      ;;
  esac
done

case $SUB in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  doctor) cmd_doctor ;;
  dirs)
    lista_alvos install | while IFS='|' read -r _nome _marcador dir; do
      [ -n "${dir:-}" ] && printf '%s\n' "$dir"
    done
    exit 0
    ;;
esac