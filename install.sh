#!/usr/bin/env bash
# Install figma-make-cli for Claude Code: skill, /mupdate command, `figma-make` on PATH,
# bridge config, and (with --service) the bridge as a macOS login service.
#
#   ./install.sh             link everything into ~/.claude and ~/.local/bin
#   ./install.sh --service   also run `figma-make bridge` at login (macOS LaunchAgent)
#   ./install.sh --uninstall remove the links and the service (keeps your config)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$REPO/skill/figma-make-cli"
SKILL_DST="$HOME/.claude/skills/figma-make-cli"
CMD_DST="$HOME/.claude/commands/mupdate.md"
BIN_DST="$HOME/.local/bin/figma-make"
CONF="$HOME/.config/figma-make/bridge.json"
LABEL="com.figma-make.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

link() { # link <src> <dst>: replace an existing link, refuse to clobber a real file/dir
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ]; then rm "$dst"
  elif [ -e "$dst" ]; then echo "  ! $dst exists and is not a symlink; move it away and re-run" >&2; return 1
  fi
  ln -s "$src" "$dst"
  echo "  linked $dst → $src"
}

unload_service() {
  if [ -f "$PLIST" ]; then
    launchctl unload "$PLIST" 2>/dev/null || true
    rm "$PLIST"
    echo "  removed service $LABEL"
  fi
}

if [ "${1:-}" = "--uninstall" ]; then
  unload_service
  for p in "$SKILL_DST" "$CMD_DST" "$BIN_DST"; do [ -L "$p" ] && rm "$p" && echo "  removed $p"; done
  echo "Uninstalled (config left at $CONF)."
  exit 0
fi

command -v node >/dev/null || { echo "Node.js 22+ is required (node not found)" >&2; exit 1; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 22 ? 0 : 1)' || { echo "Node.js 22+ is required" >&2; exit 1; }

echo "Installing figma-make-cli from $REPO"
chmod +x "$SKILL_SRC/scripts/"*.mjs
link "$SKILL_SRC" "$SKILL_DST"
link "$REPO/commands/mupdate.md" "$CMD_DST"
link "$SKILL_SRC/scripts/figma-make.mjs" "$BIN_DST"

mkdir -p "$(dirname "$CONF")"
[ -f "$CONF" ] || { echo '{ "files": {} }' > "$CONF"; echo "  created $CONF"; }

case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "  note: add ~/.local/bin to your PATH" ;; esac

if [ "${1:-}" = "--service" ]; then
  [ "$(uname)" = "Darwin" ] || { echo "--service is macOS only; run \`figma-make bridge\` yourself elsewhere" >&2; exit 1; }
  unload_service
  # launchd starts with a bare environment: give it a PATH that finds node + claude, and USER/LOGNAME
  # so `claude` can read its login from the keychain.
  SVC_PATH="$HOME/.local/bin:$(dirname "$(command -v node)")"
  command -v claude >/dev/null && SVC_PATH="$SVC_PATH:$(dirname "$(readlink -f "$(command -v claude)")")"
  SVC_PATH="$SVC_PATH:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  sed -e "s|__NODE__|$(command -v node)|" -e "s|__SCRIPT__|$SKILL_SRC/scripts/figma-make.mjs|" \
      -e "s|__PATH__|$SVC_PATH|" -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER|g" -e "s|__LABEL__|$LABEL|" \
      "$REPO/launchd/bridge.plist.template" > "$PLIST"
  plutil -lint "$PLIST" >/dev/null
  launchctl load "$PLIST"
  echo "  service $LABEL running (log: ~/Library/Logs/figma-make-bridge.log)"
fi

cat <<EOF

Done. Next:
  1. Load the extension: chrome://extensions → Developer mode → Load unpacked → $SKILL_SRC/extension
  2. Map a Make file to a local folder:  figma-make link <make-file-key> ~/make-apps/my-app
  3. Start the bridge (unless installed with --service):  figma-make bridge
  4. Open https://www.figma.com/make/<make-file-key>/… — the Claude panel replaces Make's chat.
See docs/setup.md for details.
EOF
