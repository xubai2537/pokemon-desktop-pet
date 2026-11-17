# Pokemon desktop pet — Windows installer.
#
# Zero external dependencies: if `node` is missing we run the scripts with
# the host app's own bundled Electron via ELECTRON_RUN_AS_NODE=1.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -PetHome "D:\pet" -App "D:\pet\Pokemon.exe"

param(
  [string]$PetHome = "",
  [string]$App = ""
)

$ErrorActionPreference = "Stop"

if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
  Write-Error "This installer is for Windows. On macOS run: bash install.sh"
  exit 1
}
Write-Host "==> Pokemon desktop pet - Windows installer"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunDir    = Join-Path $env:USERPROFILE ".pokepet"
$BinDir    = Join-Path $RunDir "bin"
$TaskName  = "PokePetDaemon"

function Test-CdpPort([string]$PortFile) {
  if (-not (Test-Path $PortFile)) { return $false }
  try {
    $port = [int]((Get-Content $PortFile -TotalCount 1).Trim())
    $reply = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ("http://127.0.0.1:{0}/json/version" -f $port)
    return ($reply.StatusCode -eq 200 -and $reply.Content -match '"Browser"')
  } catch { return $false }
}

# Prefer the current PowerShell ancestor chain. Associate that GUI executable
# with APPDATA using singleton-lock, active-port, and basename evidence rather
# than port-file recency. POKEPET_HOST remains an explicit userData override.
$HostExe = ""
$pidCursor = $PID
for ($i = 0; $i -lt 16 -and $pidCursor -gt 0; $i++) {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidCursor" -ErrorAction SilentlyContinue
  if (-not $p) { break }
  $candidate = $p.ExecutablePath
  if ($candidate -and $candidate -match '\.exe$' -and $p.Name -notmatch '(?i)helper|powershell|pwsh|cmd|conhost|node') {
    try {
      $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
      $hasGui = $gp -and $gp.MainWindowHandle -ne 0
      $hasElectronLayout = Test-Path (Join-Path (Split-Path -Parent $candidate) "resources")
      if ($hasGui -and $hasElectronLayout) { $HostExe = $candidate; break }
    } catch { }
  }
  $pidCursor = [int]$p.ParentProcessId
}

$HostDir = $null
if ($env:POKEPET_HOST) {
  $HostDir = Get-Item (Join-Path $env:APPDATA $env:POKEPET_HOST) -ErrorAction SilentlyContinue
}
if (-not $HostDir -and $HostExe) {
  $exeBase = [IO.Path]::GetFileNameWithoutExtension($HostExe)
  $HostDir = Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    ForEach-Object {
      $score = 0
      if (Test-Path (Join-Path $_.FullName "SingletonLock")) { $score += 100 }
      if (Test-CdpPort (Join-Path $_.FullName "DevToolsActivePort")) { $score += 40 }
      if ($_.Name -ieq $exeBase) { $score += 20 }
      if ($_.Name -like "*$exeBase*") { $score += 5 }
      [pscustomobject]@{ Dir = $_; Score = $score }
    } | Where-Object { $_.Score -gt 0 } | Sort-Object Score -Descending | Select-Object -First 1 -ExpandProperty Dir
}
if (-not $HostDir) {
  $HostDir = Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-CdpPort (Join-Path $_.FullName "DevToolsActivePort") } |
    Select-Object -First 1
}
if (-not $HostDir) {
  Write-Error "Cannot identify the current Electron workbench. Start it once or set POKEPET_HOST."
  exit 1
}
$HostName = $HostDir.Name
Write-Host "==> current host: $HostName"

# ---- desktop-mode capability probe ----------------------------------------
# On locked-down corporate Windows (__PSLockdownPolicy / WDAC) PowerShell runs
# in ConstrainedLanguage mode, where WinForms + System.Drawing cannot be loaded
# — so the desktop-pet window can never render. Leave a marker the page reads,
# so "jump to desktop" is hidden rather than swallowing a pokemon into a window
# that never appears. (Thumbnails no longer need System.Drawing — they come
# from the CDN — so only the desktop window is affected.)
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$blockFlag = Join-Path $RunDir "desktop-blocked.flag"
if ("$($ExecutionContext.SessionState.LanguageMode)" -ne "FullLanguage") {
  Set-Content -Path $blockFlag -Value "ConstrainedLanguage" -Encoding ASCII
  Write-Host "==> note: restricted PowerShell detected - desktop mode will be hidden (window UI unsupported here)"
} else {
  Remove-Item -Path $blockFlag -ErrorAction SilentlyContinue
}

# ---- 1) pick a JS runtime -------------------------------------------------
$RtExec = ""
$RtIsElectron = $false
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $RtExec = $node.Source
  Write-Host "==> runtime: node ($(& $RtExec -v))"
} else {
  if ($HostExe -and (Test-Path $HostExe)) { $RtExec = $HostExe; $RtIsElectron = $true }
  if (-not $RtExec) {
    $cands = @(
      (Join-Path $env:LOCALAPPDATA "Programs\$HostName\$HostName.exe"),
      (Join-Path $env:LOCALAPPDATA "$HostName\$HostName.exe"),
      (Join-Path ${env:ProgramFiles} "$HostName\$HostName.exe")
    )
    foreach ($c in $cands) { if (Test-Path $c) { $RtExec = $c; $RtIsElectron = $true; break } }
  }
  if (-not $RtExec) {
    Write-Error "No Node runtime or current host executable was found."
    exit 1
  }
  Write-Host "==> runtime: current host's bundled Electron"
}

function Invoke-Rt {
  param([string[]]$RtArgs)
  if ($RtIsElectron) { $env:ELECTRON_RUN_AS_NODE = "1" }
  try { & $RtExec @RtArgs }
  finally { if ($RtIsElectron) { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue } }
}

# ---- 2) copy scripts -----------------------------------------------------
Write-Host "==> installing to $BinDir"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
foreach ($f in @("cdp.js","platform.js","inject.js","runtime.js","daemon.js","setup.js","doctor.js","shot.js",
                    "fetch-assets.js","host-arm.js","uninstall.ps1","desktop-pet.ps1")) {
  $src = Join-Path $ScriptDir $f
  if (Test-Path $src) { Copy-Item -Force $src (Join-Path $BinDir $f) }
}

# Manifests drive fetch-assets.js and the picker lists; without them the tabs are empty.
$manifestDst = Join-Path $BinDir "manifests"
New-Item -ItemType Directory -Force -Path $manifestDst | Out-Null
Get-ChildItem -Path (Join-Path $ScriptDir "manifests") -Filter *.json -ErrorAction SilentlyContinue |
  ForEach-Object { Copy-Item -Force $_.FullName (Join-Path $manifestDst $_.Name) }

# ---- 2b) fetch the artwork (only when the user has no asset dir of their own) ----
# Without this the picker tabs come up empty: the package ships scripts and
# manifests only, so somebody has to actually download the images.
if (-not $PetHome) {
  $PetHome = Join-Path $RunDir "petapp"
  $gifDir = Join-Path $PetHome "gif"
  $hasGif = (Test-Path $gifDir) -and ((Get-ChildItem $gifDir -File -ErrorAction SilentlyContinue | Measure-Object).Count -gt 0)
  if ($hasGif) {
    Write-Host "==> assets already present in $PetHome"
  } else {
    Write-Host "==> downloading essential artwork to $PetHome"
    Write-Host "    ~60MB (1025 sprite gifs + 125 items + gender / regional / gmax / trainers)."
    Write-Host "    Boards, avatars and pack covers are opt-in extras - the daemon pulls those after first launch."
    Write-Host "    Interrupted downloads resume - finished files are skipped on re-run."
    try { Invoke-Rt -RtArgs @((Join-Path $BinDir "fetch-assets.js"), "--pet-home", $PetHome, "--only", "essentials") }
    catch { $global:LASTEXITCODE = 2 }
    if ($LASTEXITCODE -ne 0) {
      Write-Error "Asset download failed. Check your network/proxy and re-run install.ps1 (finished files are kept)."
      exit 2
    }
  }
}

# ---- 3) shared setup: locate assets, write config, build thumbnails ------
$setupArgs = @((Join-Path $BinDir "setup.js"))
if ($PetHome) { $setupArgs += @("--pet-home", $PetHome) }
if ($App)     { $setupArgs += @("--app", $App) }
try { Invoke-Rt -RtArgs $setupArgs } catch { $global:LASTEXITCODE = 2 }
if ($LASTEXITCODE -ne 0) {
  Write-Error "Setup failed. If your pokemon assets live elsewhere, pass -PetHome <dir>."
  exit $LASTEXITCODE
}

# ---- 4) register a logon task that keeps the daemon running --------------
Write-Host "==> registering scheduled task '$TaskName'"
# pwsh 7.4+ turns a non-zero native exit code into a terminating error under
# $ErrorActionPreference="Stop"; a first-time install has no task to delete.
try { schtasks /Delete /TN $TaskName /F 2>$null | Out-Null } catch {}
$global:LASTEXITCODE = 0

$daemon = Join-Path $BinDir "daemon.js"
# A tiny launcher keeps the env var and the hidden window handling in one place.
$launcher = Join-Path $BinDir "run-daemon.cmd"
$envLine = if ($RtIsElectron) { "set ELECTRON_RUN_AS_NODE=1" } else { "rem node runtime" }
@"
@echo off
$envLine
start "" /min "$RtExec" "$daemon"
"@ | Set-Content -Encoding UTF8 $launcher   # ASCII mangles non-ASCII paths (Chinese user names) into "?"

try {
  schtasks /Create /TN $TaskName /TR "`"$launcher`"" /SC ONLOGON /RL LIMITED /F | Out-Null
  if ($LASTEXITCODE -eq 0) { Write-Host "    task created (runs at logon)" }
  else { Write-Host "    WARN: could not register the logon task (exit $LASTEXITCODE)."; Write-Host "         The pet still works this session; start it manually next login." }
} catch {
  Write-Host "    WARN: could not register the logon task: $_"
}
$global:LASTEXITCODE = 0

# ---- 5) start it now ----------------------------------------------------
Write-Host "==> starting the daemon"
Start-Process -FilePath $launcher -WindowStyle Hidden
Start-Sleep -Seconds 3

$portFile = Join-Path $HostDir.FullName "DevToolsActivePort"
Write-Host ""
if (Test-CdpPort $portFile) {
  Write-Host "==> current host is reachable - the skin will appear within a few seconds."
} else {
  Write-Host "==> current host has no reachable debugging port yet."
  Write-Host "    Start the workbench with remote debugging enabled, then run the installer again."
}

Write-Host @"

Done!
  - Click the pokeball at the bottom-right of the app window to pick a background
    board, build a team, feed them, swap the avatar or add particle effects.
  - Drag a pokemon to a window edge and it jumps out to the desktop; the
    settings tab can recall it.
  - Uninstall:  powershell -ExecutionPolicy Bypass -File uninstall.ps1
"@
