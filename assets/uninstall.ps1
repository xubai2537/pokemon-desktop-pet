# Pokemon desktop pet - Windows uninstaller.
# Runtime files go to the Recycle Bin; state.json and mypets are preserved.

$ErrorActionPreference = "Continue"
Write-Host "==> Pokemon desktop pet - Windows uninstaller"
$RunDir   = Join-Path $env:USERPROFILE ".pokepet"
$BinDir   = Join-Path $RunDir "bin"
$TaskName = "PokePetDaemon"

function Send-ToRecycleBin([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  try {
    Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null
    if (Test-Path -LiteralPath $Path -PathType Container) {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($Path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    } else {
      [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($Path, 'OnlyErrorDialogs', 'SendToRecycleBin')
    }
    return $true
  } catch {
    Write-Host "    could not recycle $Path"
    return $false
  }
}

function Get-LiveHosts {
  Get-ChildItem -Path $env:APPDATA -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $pf = Join-Path $_.FullName "DevToolsActivePort"
    if (-not (Test-Path $pf)) { return }
    try {
      $port = [int]((Get-Content $pf -TotalCount 1).Trim())
      $reply = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri ("http://127.0.0.1:{0}/json/version" -f $port)
      if ($reply.StatusCode -eq 200 -and $reply.Content -match '"Browser"') {
        [pscustomobject]@{ Name = $_.Name; Dir = $_.FullName; Port = $port }
      }
    } catch { }
  }
}

# Remove the injected runtime from every reachable host before stopping services.
$inject = Join-Path $BinDir "inject.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node -and (Test-Path $inject)) {
  Write-Host "==> removing the skin from reachable workbenches"
  foreach ($h in @(Get-LiveHosts)) {
    try { & $node.Source $inject --remove --port $h.Port --host-name $h.Name --host-key $h.Dir 2>$null | Out-Null } catch { }
  }
}

Write-Host "==> removing scheduled task"
schtasks /End /TN $TaskName 2>$null | Out-Null
schtasks /Delete /TN $TaskName /F 2>$null | Out-Null

Write-Host "==> stopping the daemon"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*pokepet\bin\daemon.js*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (Test-Path $RunDir) {
  Write-Host "==> moving generated runtime files to the Recycle Bin"
  Get-ChildItem -LiteralPath $RunDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.Name -ne "state.json" -and $_.Name -ne "mypets") {
      [void](Send-ToRecycleBin $_.FullName)
    }
  }
}

Write-Host @"

Uninstalled.
  - state.json and mypets were preserved for reinstall.
  - Other runtime files were moved to the Recycle Bin.
  - Source assets outside ~/.pokepet were not touched.
"@
