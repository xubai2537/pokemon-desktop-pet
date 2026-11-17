#!/usr/bin/env bash
# Pokemon desktop pet — macOS installer for a generic Electron workbench.

set -euo pipefail

echo "==> Pokemon desktop pet — installer"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Error: this installer requires macOS."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_DIR="$HOME/.pokepet"
BIN_DIR="$RUN_DIR/bin"
THUMB_DIR="$RUN_DIR/thumbs"
SUPPORT_ROOT="$HOME/Library/Application Support"
DAEMON_PLIST="$HOME/Library/LaunchAgents/com.pokepet.daemon.plist"

# Print: main-pid<TAB>absolute executable path. The installation source is an
# ancestor Electron GUI process; a pre-existing debugging port is not required.
detect_install_host() {
  local pid="${1:-$$}" i ppid exe
  for i in $(seq 1 16); do
    [[ -z "$pid" || "$pid" == "0" || "$pid" == "1" ]] && break
    exe="$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | perl -ne 'if (/^n(.*\.app\/Contents\/MacOS\/.*)$/) { print $1; exit }')"
    if [[ -n "$exe" && -x "$exe" && "$exe" != *" Helper"* ]]; then
      printf '%s\t%s\n' "$pid" "$exe"
      return 0
    fi
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    pid="$ppid"
  done
  return 1
}

# Explicit host selection is useful when one workspace installs the same skill
# for several running Electron hosts. The value is a userData directory name,
# never a product identifier. Resolve its singleton owner back to the real
# executable; if no override is supplied, use the caller's parent process tree.
HOST_RECORD=""
HOST_USER_DATA=""
if [[ -n "${POKEPET_HOST:-}" ]]; then
  HOST_USER_DATA="$SUPPORT_ROOT/$POKEPET_HOST"
  lock="$HOST_USER_DATA/SingletonLock"
  target="$(readlink "$lock" 2>/dev/null || true)"
  if [[ "$target" =~ -([0-9]+)$ ]]; then
    override_pid="${BASH_REMATCH[1]}"
    # Local patch: use comm= (bare executable path, no argv) and allow spaces in
    # the binary name, e.g. ".../MacOS/DeepSeek Harness". The upstream [^ ]+
    # truncates at the first space and -x then rejects the path.
    override_cmd="$(ps -o comm= -p "$override_pid" 2>/dev/null | head -1)"
    override_exe="$(printf '%s' "$override_cmd" | perl -ne 'if (/^(.*?\.app\/Contents\/MacOS\/.+)$/) { print $1; exit }')"
    if [[ -n "$override_exe" && -x "$override_exe" ]]; then
      HOST_RECORD="${override_pid}"$'\t'"${override_exe}"
    fi
  fi
  if [[ -z "$HOST_RECORD" ]]; then
    echo "Error: POKEPET_HOST=$POKEPET_HOST is not a running Electron host."
    exit 1
  fi
else
  HOST_RECORD="$(detect_install_host || true)"
fi
if [[ -z "$HOST_RECORD" ]]; then
  echo "Error: cannot identify the current host from the parent process tree."
  echo "       Run this installer from the current Electron workbench."
  exit 1
fi
HOST_PID="${HOST_RECORD%%$'\t'*}"
HOST_EXE="${HOST_RECORD#*$'\t'}"
HOST_LABEL="$(basename "$HOST_EXE")"

echo "==> current host: $HOST_LABEL"

# Associate the source process with its real userData directory. The singleton
# symlink is authoritative; basename matching is only a fallback when no lock is
# available yet. An explicit override already supplied the exact directory.
if [[ -z "$HOST_USER_DATA" ]]; then
  while IFS= read -r lock; do
    [[ -L "$lock" ]] || continue
    target="$(readlink "$lock" 2>/dev/null || true)"
    if [[ "$target" =~ -${HOST_PID}$ ]]; then
      HOST_USER_DATA="$(dirname "$lock")"
      break
    fi
  done < <(find "$SUPPORT_ROOT" -mindepth 2 -maxdepth 2 -name SingletonLock -print 2>/dev/null)
fi
if [[ -z "$HOST_USER_DATA" && -d "$SUPPORT_ROOT/$HOST_LABEL" ]]; then
  HOST_USER_DATA="$SUPPORT_ROOT/$HOST_LABEL"
fi
if [[ -z "$HOST_USER_DATA" ]]; then
  echo "Error: cannot associate the current host with an Application Support directory."
  exit 1
fi
# Local patch: keep the Application-Support-relative path (may be nested, e.g.
# "@deepseek-ai/dsh-desktop") instead of basename, which loses one directory
# level and points the daemon at a non-existent userData dir.
HOST_NAME="${POKEPET_HOST:-$(basename "$HOST_USER_DATA")}"
PORT_FILE="$HOST_USER_DATA/DevToolsActivePort"

PET_HOME=""
DESKTOP_APP=""
REFRESH_ASSETS=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pet-home) PET_HOME="${2:-}"; shift 2 ;;
    --refresh-assets) REFRESH_ASSETS=1; shift ;;
    --app) DESKTOP_APP="${2:-}"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

RT_EXEC=""
RT_IS_ELECTRON=0
if command -v node >/dev/null 2>&1; then
  RT_EXEC="$(command -v node)"
  echo "==> runtime: node $("$RT_EXEC" -v)"
else
  RT_EXEC="$HOST_EXE"
  RT_IS_ELECTRON=1
  echo "==> runtime: current host's bundled Electron"
fi
run_rt() {
  if [[ "$RT_IS_ELECTRON" == "1" ]]; then ELECTRON_RUN_AS_NODE=1 "$RT_EXEC" "$@"; else "$RT_EXEC" "$@"; fi
}
xml_escape() { printf '%s' "$1" | perl -pe 's/&/&amp;/g; s/</&lt;/g; s/>/&gt;/g; s/"/&quot;/g'; }

mkdir -p "$BIN_DIR" "$THUMB_DIR" "$HOME/Library/LaunchAgents"
echo "==> installing runtime files"
for f in cdp.js platform.js inject.js runtime.js daemon.js setup.js doctor.js shot.js pokecut.jxa \
         fetch-assets.js host-arm.js uninstall.sh desktop-pet.ps1; do
  [[ -f "$SCRIPT_DIR/$f" ]] && cp -f "$SCRIPT_DIR/$f" "$BIN_DIR/"
done
mkdir -p "$BIN_DIR/manifests"
for f in "$SCRIPT_DIR"/manifests/*.json; do [[ -f "$f" ]] && cp -f "$f" "$BIN_DIR/manifests/"; done

if [[ -z "$PET_HOME" ]]; then
  PET_HOME="$RUN_DIR/petapp"
  if [[ -d "$PET_HOME/gif" && -n "$(ls -A "$PET_HOME/gif" 2>/dev/null)" ]]; then
    echo "==> essential assets already present"
    [[ "$REFRESH_ASSETS" == "1" ]] && run_rt "$BIN_DIR/fetch-assets.js" --pet-home "$PET_HOME" --only essentials || true
  else
    echo "==> downloading essentials (~60MB); extras continue in the background"
    run_rt "$BIN_DIR/fetch-assets.js" --pet-home "$PET_HOME" --only essentials || {
      echo "Error: asset download failed; completed files were kept for resume."
      exit 2
    }
  fi
fi
SETUP_ARGS=()
[[ -n "$PET_HOME" ]] && SETUP_ARGS+=(--pet-home "$PET_HOME")
[[ -n "$DESKTOP_APP" ]] && SETUP_ARGS+=(--app "$DESKTOP_APP")
run_rt "$BIN_DIR/setup.js" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}" || exit 2

# The daemon discovers and injects every reachable host with an existing port.
launchctl bootout "gui/$(id -u)/com.pokepet.daemon" 2>/dev/null || true
RT_XML="$(xml_escape "$RT_EXEC")"
BIN_XML="$(xml_escape "$BIN_DIR/daemon.js")"
ENV_BLOCK=""
# Local patch: pin the daemon to the install-source host. detectHosts() only
# scans one level under Application Support, which misses scoped userData dirs
# like "@deepseek-ai/dsh-desktop".
if [[ -n "$HOST_NAME" ]]; then
  ENV_BLOCK="  <key>EnvironmentVariables</key><dict><key>POKEPET_HOST</key><string>$(xml_escape "$HOST_NAME")</string>"
else
  ENV_BLOCK="  <key>EnvironmentVariables</key><dict>"
fi
if [[ "$RT_IS_ELECTRON" == "1" ]]; then
  ENV_BLOCK="${ENV_BLOCK}<key>ELECTRON_RUN_AS_NODE</key><string>1</string>"
fi
ENV_BLOCK="${ENV_BLOCK}</dict>"
cat > "$DAEMON_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.pokepet.daemon</string>
  <key>ProgramArguments</key><array><string>$RT_XML</string><string>$BIN_XML</string></array>
$ENV_BLOCK
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$RUN_DIR/pokepet.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$RUN_DIR/pokepet.log")</string>
</dict></plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$DAEMON_PLIST" 2>/dev/null || launchctl load "$DAEMON_PLIST" 2>/dev/null || true
printf '%s\n' "$HOST_NAME" > "$RUN_DIR/host"

# Upgrade migration: early releases created product-specific CDP jobs. Leaving
# them installed means several watchers race for the singleton lock and an update
# can restart the host without the port. Identify those jobs by shape, not by any
# product name: every old job contains "cdp" but is not the generic host-cdp form.
# Stop each one and move its plist to Trash so only one watcher owns this host.
for legacy in "$HOME/Library/LaunchAgents"/com.pokepet.*cdp*.plist; do
  [[ -f "$legacy" ]] || continue
  legacy_label="$(basename "$legacy" .plist)"
  [[ "$legacy_label" == com.pokepet.host-cdp.* ]] && continue
  launchctl bootout "gui/$(id -u)/$legacy_label" 2>/dev/null || launchctl unload "$legacy" 2>/dev/null || true
  mv -n "$legacy" "$HOME/.Trash/$legacy_label.plist.migrated.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  echo "==> migrated an older startup agent to Trash"
done

# The installation-source host always receives a persistent arm agent. Even when
# a verified endpoint exists now, it may have been created by a manual launch or
# an older one-shot helper; without a resident watcher the next ordinary restart
# loses CDP and the pets silently disappear. A verified host simply leaves the
# agent idle until its singleton lock is released.
HASH="$(printf '%s' "$HOST_USER_DATA" | shasum -a 256 | cut -c1-12)"
ARM_LABEL="com.pokepet.host-cdp.$HASH"
ARM_PLIST="$HOME/Library/LaunchAgents/$ARM_LABEL.plist"
ARM_LOG="$RUN_DIR/host-cdp-$HASH.log"
if POKEPET_ARM_APP_BIN="$HOST_EXE" POKEPET_ARM_USER_DATA="$HOST_USER_DATA" \
   POKEPET_ARM_LOG="$ARM_LOG" run_rt "$BIN_DIR/host-arm.js" --check >/dev/null 2>&1; then
  echo "==> current host already exposes a verified debugging port"
fi
echo "==> registering a persistent startup agent for the current host"
cat > "$ARM_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$ARM_LABEL</string>
  <key>ProgramArguments</key><array><string>$RT_XML</string><string>$(xml_escape "$BIN_DIR/host-arm.js")</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>POKEPET_ARM_APP_BIN</key><string>$(xml_escape "$HOST_EXE")</string>
    <key>POKEPET_ARM_USER_DATA</key><string>$(xml_escape "$HOST_USER_DATA")</string>
    <key>POKEPET_ARM_LOG</key><string>$(xml_escape "$ARM_LOG")</string>
$(if [[ "$RT_IS_ELECTRON" == "1" ]]; then printf '    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n'; fi)  </dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$RUN_DIR/host-cdp-$HASH.out")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$RUN_DIR/host-cdp-$HASH.out")</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$ARM_LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$ARM_PLIST" 2>/dev/null || launchctl load "$ARM_PLIST" 2>/dev/null || true
echo "    启动代理已常驻；以后每次正常重启当前工作台都会保留调试端口。"

if [[ -f "$PORT_FILE" ]]; then
  echo "==> 当前宿主已可检测；守护进程会在数秒内注入。"
else
  echo "==> 当前宿主尚无调试端口；请在方便时正常退出工作台。"
fi
cat <<'DONE'

Done!
  · 精灵球入口位于工作台窗口右下角。
  · 守护进程会自动注入所有已有调试端口的 Electron 工作台。
  · Uninstall: bash uninstall.sh
DONE
