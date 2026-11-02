#!/usr/bin/env bash
# skillhub-linux.sh - WSL side of skillhub.
#
# Runs inside the WSL distro and keeps the Ubuntu agent roots pointing at the
# ONE canonical skill store (/mnt/c/Users/ADMIN/.agents/skills) with symlinks.
#
# Usage:  bash skillhub-linux.sh <status|repair|verify|list>
#
# Output is TAB separated so the Windows side can parse it:
#   CANONICAL <path> <skillCount>
#   TARGET    <path> <kind> <OK|BROKEN> <skills> <detail>
#   REPAIR    <path> <action> <detail>
#   VERIFY    <path> <OK|FAIL> <detail>
#   VERIFY_SUMMARY <okCount> <failCount>
#
# Configuration (canonical path + the ubuntu target list) is read from
# config.json next to this script, so there is a single source of truth.

set -uo pipefail

CONFIG_FILE="${SKILLHUB_CONFIG:-/mnt/c/Users/ADMIN/.skillhub/config.json}"
DEFAULT_CANONICAL="/mnt/c/Users/ADMIN/.agents/skills"
DEFAULT_TARGETS="/home/aswath/.agents/skills
/home/aswath/.gemini/antigravity-cli/skills
/home/aswath/.gemini/skills
/home/aswath/.gemini/antigravity/skills
/home/aswath/.gemini/config/skills
/home/aswath/.claude/skills
/home/aswath/.codex/skills"

CANONICAL=""
TARGETS=""

read_config() {
  CANONICAL="$DEFAULT_CANONICAL"
  TARGETS=""
  if [ -r "$CONFIG_FILE" ]; then
    c=$(sed -n 's/.*"canonicalLinux"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONFIG_FILE" | head -n 1)
    if [ -n "$c" ]; then CANONICAL="$c"; fi
    t=$(sed -n '/"ubuntuTargets"[[:space:]]*:[[:space:]]*\[/,/\]/p' "$CONFIG_FILE" \
          | sed '1d' | tr ',' '\n' \
          | sed -n 's/^[[:space:]]*"\([^"]*\)".*/\1/p')
    if [ -n "$t" ]; then TARGETS="$t"; fi
  fi
  if [ -z "$TARGETS" ]; then TARGETS="$DEFAULT_TARGETS"; fi
}

# physical path of the canonical store
canon_real() {
  local r
  r=$(readlink -f "$CANONICAL" 2>/dev/null)
  [ -n "$r" ] && printf '%s' "$r" || printf '%s' "$CANONICAL"
}

# names of the sub folders of $1 that contain a SKILL.md
skill_names() {
  local d="$1" n
  [ -d "$d" ] || return 0
  for n in "$d"/*/; do
    [ -d "$n" ] || continue
    [ -f "${n}SKILL.md" ] || continue
    basename "$n"
  done
}

count_skills() {
  skill_names "$1" | wc -l | tr -d ' '
}

cmd_status() {
  local canon creal count t kind state skills detail tgt
  canon="$CANONICAL"
  creal=$(canon_real)
  count=$(count_skills "$canon")
  printf 'CANONICAL\t%s\t%s\n' "$canon" "$count"
  for t in $TARGETS; do
    if [ -L "$t" ]; then
      kind=symlink
      tgt=$(readlink "$t" 2>/dev/null)
      if [ "$(readlink -f "$t" 2>/dev/null)" = "$creal" ]; then state=OK; else state=BROKEN; fi
      skills=$(count_skills "$t")
      if [ "$state" = "OK" ]; then detail="-> $tgt"; else detail="symlink points elsewhere: $tgt"; fi
    elif [ -d "$t" ]; then
      kind=dir
      state=BROKEN
      skills=$(count_skills "$t")
      detail="plain directory - should be a symlink to the canonical store"
    else
      kind=missing
      state=BROKEN
      skills=0
      detail="missing"
    fi
    printf 'TARGET\t%s\t%s\t%s\t%s\t%s\n' "$t" "$kind" "$state" "$skills" "$detail"
  done
}

cmd_list() {
  skill_names "$CANONICAL"
}

cmd_repair() {
  local canon creal t name unique parent base backup
  canon="$CANONICAL"
  creal=$(canon_real)
  mkdir -p "$canon" 2>/dev/null

  for t in $TARGETS; do
    if [ -L "$t" ]; then
      if [ "$(readlink -f "$t" 2>/dev/null)" = "$creal" ]; then
        printf 'REPAIR\t%s\tok\tsymlink already points at the canonical store\n' "$t"
      else
        printf 'REPAIR\t%s\twarn\tsymlink points elsewhere (%s) - left untouched\n' "$t" "$(readlink "$t" 2>/dev/null)"
      fi
      continue
    fi

    if [ -d "$t" ]; then
      # collect the skill folders that are NOT in the canonical store
      unique=""
      while IFS= read -r name; do
        [ -n "$name" ] || continue
        if [ ! -e "$canon/$name" ]; then unique="$unique $name"; fi
      done < <(skill_names "$t")
      # copy them into the canonical store - never delete them
      for name in $unique; do
        if cp -r "$t/$name" "$canon/$name" 2>/dev/null; then
          chmod -R u+rwX "$canon/$name" 2>/dev/null || true
          printf 'REPAIR\t%s\tcopied\tunique skill folder %s copied into the canonical store\n' "$t" "$name"
        else
          printf 'REPAIR\t%s\terror\tcould not copy the unique skill folder %s\n' "$t" "$name"
        fi
      done
      # every skill folder of $t now exists in the canonical store -> safe to replace
      parent=$(dirname "$t")
      base=$(basename "$t")
      backup="$parent/.${base}.skillhub-backup-$(date +%s)"
      if mv "$t" "$backup" 2>/dev/null; then
        if ln -s "$canon" "$t" 2>/dev/null; then
          rm -rf "$backup"
          printf 'REPAIR\t%s\tfixed\tplain directory replaced by a symlink to the canonical store\n' "$t"
        else
          mv "$backup" "$t" 2>/dev/null
          printf 'REPAIR\t%s\terror\tcould not create the symlink - the original directory was restored\n' "$t"
        fi
      else
        printf 'REPAIR\t%s\terror\tcould not move the plain directory aside\n' "$t"
      fi
      continue
    fi

    # missing -> create the symlink
    mkdir -p "$(dirname "$t")" 2>/dev/null
    if ln -s "$canon" "$t" 2>/dev/null; then
      printf 'REPAIR\t%s\tfixed\tmissing target created as a symlink to the canonical store\n' "$t"
    else
      printf 'REPAIR\t%s\terror\tcould not create the symlink\n' "$t"
    fi
  done
}

cmd_verify() {
  local creal t ok=0 fail=0 detail state
  creal=$(canon_real)
  for t in $TARGETS; do
    if [ -L "$t" ] && [ "$(readlink -f "$t" 2>/dev/null)" = "$creal" ]; then
      state=OK
      detail="resolves to $creal"
      ok=$((ok + 1))
    else
      state=FAIL
      if [ -L "$t" ]; then
        detail="symlink points elsewhere: $(readlink "$t" 2>/dev/null)"
      elif [ -d "$t" ]; then
        detail="plain directory, expected a symlink"
      else
        detail="missing"
      fi
      fail=$((fail + 1))
    fi
    printf 'VERIFY\t%s\t%s\t%s\n' "$t" "$state" "$detail"
  done
  printf 'VERIFY_SUMMARY\t%d\t%d\n' "$ok" "$fail"
  [ "$fail" -eq 0 ]
}

read_config

case "${1:-status}" in
  status)  cmd_status ;;
  list)    cmd_list ;;
  repair)  cmd_repair ;;
  verify)  cmd_verify ;;
  *)
    echo "usage: skillhub-linux.sh {status|list|repair|verify}" >&2
    exit 2
    ;;
esac
