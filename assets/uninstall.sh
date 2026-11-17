#!/usr/bin/env bash
# Pokemon desktop pet — macOS uninstaller. Removed files go to Trash.
# Only uninstalls the current platform; use POKEPET_HOST=<name> to target another.

set -uo pipefail

echo "==> Pokemon desktop pet — uninstaller"
RUN_DIR="$HOME/.pokepet"
BIN_DIR="$RUN_DIR/bin"
AGENT_DIR="$HOME/Library/LaunchAgents"
TRASH="$HOME/.Trash"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$TRASH"

trash_move() {
  local src="$1" tag="$2"
  [[ -e "$src" || -L "$src" ]] || return 0
  mv -n "$src" "$TRASH/$tag.$STAMP" 2>/dev/null || true
}

# ---------- detect the current host (same logic as install.sh) ----------
HOST_NAME="${POKEPET_HOST:-}"
if [[ -z "$HOST_NAME" ]]; then
  PARENT_PID="$PPID"
  for _ in $(seq 1 8); do
    CMDLINE="$(ps -o command= -p "$PARENT_PID" 2>/dev/null || true)"
    [[ -z "$CMDLINE" ]] && break
    case "$CMDLINE" in
      *".app/Contents/MacOS/"*) ;;
      *) PARENT_PID="$(ps -o ppid= -p "$PARENT_PID" 2>/dev/null | tr -d ' ')" ; continue ;;
    esac
    EXE="$(printf '%s' "$CMDLINE" | perl -ne 'if (/^(.*?\.app\/Contents\/MacOS\/(\w+))/) { print $1 }')"
    HOST_NAME="$(printf '%s' "$CMDLINE" | perl -ne 'if (/\.app\/Contents\/MacOS\/(\S+)$/) { print $1 }')"
    # userData dir name = app name in most cases
    [[ -z "$HOST_NAME" ]] && HOST_NAME="$(basename "$EXE" 2>/dev/null)"
    break
  done
fi
if [[ -z "$HOST_NAME" ]]; then
  # fallback: read from ~/.pokepet/host
  HOST_NAME="$(cat "$RUN_DIR/host" 2>/dev/null || true)"
fi
if [[ -z "$HOST_NAME" ]]; then
  echo "Error: cannot determine which host to uninstall."
  echo "       Run: POKEPET_HOST=<name> bash uninstall.sh"
  echo "       Or run this from the Electron workbench you want to uninstall from."
  exit 1
fi
echo "==> host: $HOST_NAME"

USER_DATA="$HOME/Library/Application Support/$HOST_NAME"
HASH="$(printf '%s' "$USER_DATA" | shasum -a 256 | cut -c1-12)"
ARM_LABEL="com.pokepet.host-cdp.$HASH"
ARM_PLIST="$AGENT_DIR/$ARM_LABEL.plist"

# ---------- 1. remove injected runtime from this host only ----------
RT_EXEC=""
RT_ELECTRON=0
if command -v node >/dev/null 2>&1; then RT_EXEC="$(command -v node)"; fi
if [[ -z "$RT_EXEC" ]]; then
  if [[ -f "$ARM_PLIST" ]]; then
    candidate="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:POKEPET_ARM_APP_BIN' "$ARM_PLIST" 2>/dev/null || true)"
    if [[ -x "$candidate" ]]; then RT_EXEC="$candidate"; RT_ELECTRON=1; fi
  fi
fi
PORT_FILE="$USER_DATA/DevToolsActivePort"
if [[ -n "$RT_EXEC" && -f "$BIN_DIR/inject.js" && -f "$PORT_FILE" ]]; then
  port="$(perl -ne 'if (/^(\d+)/) { print $1; exit }' "$PORT_FILE" 2>/dev/null || true)"
  if [[ "$port" =~ ^[0-9]+$ ]]; then
    echo "==> removing skin from $HOST_NAME (port $port)"
    args=("$BIN_DIR/inject.js" --remove --port "$port" --host-name "$HOST_NAME" --host-key "$USER_DATA")
    if [[ "$RT_ELECTRON" == "1" ]]; then ELECTRON_RUN_AS_NODE=1 "$RT_EXEC" "${args[@]}" >/dev/null 2>&1 || true
    else "$RT_EXEC" "${args[@]}" >/dev/null 2>&1 || true; fi
  fi
fi

# ---------- 2. stop and remove only this host's arm agent ----------
if [[ -f "$ARM_PLIST" ]]; then
  echo "==> removing arm agent for $HOST_NAME"
  launchctl bootout "gui/$(id -u)/$ARM_LABEL" 2>/dev/null || launchctl unload "$ARM_PLIST" 2>/dev/null || true
  trash_move "$ARM_PLIST" "$ARM_LABEL.plist"
  # clean up arm-specific files
  trash_move "$RUN_DIR/host-cdp-$HASH.log" "host-cdp-$HASH.log"
  trash_move "$RUN_DIR/host-cdp-$HASH.out" "host-cdp-$HASH.out"
  trash_move "$RUN_DIR/host-cdp-$HASH.armed-at" "host-cdp-$HASH.armed-at"
  trash_move "$RUN_DIR/host-cdp-$HASH.disable" "host-cdp-$HASH.disable"
else
  echo "==> no arm agent found for $HOST_NAME (already removed?)"
fi

# ---------- 3. update installedFrom if needed ----------
CURRENT_HOST_FILE="$RUN_DIR/host"
if [[ -f "$CURRENT_HOST_FILE" ]] && [[ "$(cat "$CURRENT_HOST_FILE" 2>/dev/null)" == "$HOST_NAME" ]]; then
  # Find another host that still has an arm agent
  NEW_HOST=""
  for plist in "$AGENT_DIR"/com.pokepet.host-cdp.*.plist; do
    [[ -f "$plist" ]] || continue
    ud="$(/usr/libexec/PlistBuddy -c 'Print :EnvironmentVariables:POKEPET_ARM_USER_DATA' "$plist" 2>/dev/null || true)"
    if [[ -n "$ud" ]]; then
      NEW_HOST="$(basename "$ud")"
      break
    fi
  done
  if [[ -n "$NEW_HOST" ]]; then
    echo "$NEW_HOST" > "$CURRENT_HOST_FILE"
    echo "==> installedFrom switched to $NEW_HOST"
  else
    trash_move "$CURRENT_HOST_FILE" "host"
  fi
fi

# ---------- 4. full cleanup only if no arm agents remain ----------
REMAINING=0
for plist in "$AGENT_DIR"/com.pokepet.host-cdp.*.plist; do
  [[ -f "$plist" ]] && REMAINING=$((REMAINING + 1))
done

if [[ "$REMAINING" -eq 0 ]]; then
  echo "==> no remaining arm agents — full cleanup"
  # Stop daemon
  launchctl bootout "gui/$(id -u)/com.pokepet.daemon" 2>/dev/null || launchctl unload "$AGENT_DIR/com.pokepet.daemon.plist" 2>/dev/null || true
  if [[ -f "$RUN_DIR/daemon.pid" ]]; then
    daemon_pid="$(perl -ne 'if (/^(\d+)$/) { print $1; exit }' "$RUN_DIR/daemon.pid" 2>/dev/null || true)"
    [[ "$daemon_pid" =~ ^[0-9]+$ ]] && kill -TERM "$daemon_pid" 2>/dev/null || true
  fi
  trash_move "$AGENT_DIR/com.pokepet.daemon.plist" "com.pokepet.daemon.plist"
  # Move all runtime files except state.json and mypets
  if [[ -d "$RUN_DIR" ]]; then
    echo "==> moving generated runtime files to Trash"
    for entry in "$RUN_DIR"/* "$RUN_DIR"/.[!.]* "$RUN_DIR"/..?*; do
      [[ -e "$entry" || -L "$entry" ]] || continue
      base="$(basename "$entry")"
      [[ "$base" == "state.json" || "$base" == "mypets" ]] && continue
      trash_move "$entry" "pokepet-$base"
    done
  fi
  cat <<DONE

Uninstalled ($HOST_NAME — full cleanup, no other hosts remained).
  · state.json and mypets were preserved for reinstall.
  · Runtime files and daemon moved to Trash.
DONE
else
  cat <<DONE

Uninstalled ($HOST_NAME only — $REMAINING other host(s) still active).
  · Daemon and shared runtime kept for remaining hosts.
  · Only $HOST_NAME's arm agent and injection were removed.
DONE
fi
