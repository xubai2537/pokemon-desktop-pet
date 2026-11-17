# desktop-pet.ps1 — the standalone desktop pet on Windows, using WinForms.
#
# Same reasoning as the macOS build (desktop-pet.jxa): shipping or borrowing an
# Electron runtime is not possible from a ~130KB skill package, so the pet is
# built on what Windows already has. WinForms renders animated GIFs natively and
# supports a transparent, always-on-top, borderless window.
#
# Bridge files (identical to the macOS build):
#   <runDir>\desktop\handoff.json   which pokemon to become, and how big
#   <runDir>\pet_cmd.json           feed / action commands from the in-app panel
#   <runDir>\desktop\recall.flag    written on "back to the window"
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File desktop-pet.ps1 <runDir> <petHome>

param(
  [Parameter(Mandatory = $true)][string]$RunDir,
  [Parameter(Mandatory = $false)][string]$PetHome = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$handoffPath = Join-Path $RunDir "desktop\handoff.json"
$cmdPath     = Join-Path $RunDir "pet_cmd.json"
$recallPath  = Join-Path $RunDir "desktop\recall.flag"

function Read-JsonSafe($p) {
  try { if (Test-Path $p) { return Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json } } catch {}
  return $null
}

$hand = Read-JsonSafe $handoffPath
$no    = if ($hand -and $hand.no)   { [string]$hand.no }   else { "0025" }
$size  = if ($hand -and $hand.size) { [int]$hand.size }    else { 128 }
if ($size -lt 64)  { $size = 64 }
if ($size -gt 260) { $size = 260 }
if (-not $PetHome -and $hand -and $hand.petHome) { $PetHome = [string]$hand.petHome }

# Same two-homes problem as the macOS build: pokemon GIFs live under petHome,
# user-made sprites live under the run dir. Check both, in that order.
$bare = $no -replace '^my:', ''
$cands = @()
# the daemon already resolved this; the candidates below are only a safety net
if ($hand -and $hand.sprite) { $cands += [string]$hand.sprite }
if ($PetHome) { $cands += (Join-Path $PetHome ("gif\{0}.gif" -f $no)) }
$cands += (Join-Path $RunDir ("mypets\{0}.png" -f $bare))
if ($PetHome) { $cands += (Join-Path $PetHome ("mypets\{0}.png" -f $bare)) }
$gif = $null
foreach ($c in $cands) { if (Test-Path $c) { $gif = $c; break } }

# ---- window ----
$form                 = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.ShowInTaskbar   = $false
$form.TopMost         = $true
$form.StartPosition   = 'Manual'
$form.Width           = $size
$form.Height          = $size
# Magenta is the classic chroma key: any pixel of this colour becomes a hole in
# the window, which is how a borderless WinForms window gets a transparent
# background without per-pixel alpha.
$form.BackColor       = [System.Drawing.Color]::Magenta
$form.TransparencyKey = [System.Drawing.Color]::Magenta

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.Right - $size - 80
$form.Top  = $screen.Bottom - $size - 100

$pic            = New-Object System.Windows.Forms.PictureBox
$pic.Dock       = 'Fill'
$pic.SizeMode   = 'Zoom'
$pic.BackColor  = [System.Drawing.Color]::Transparent
if (-not $gif -and $PetHome) {
  $fb = Join-Path $PetHome "gif\0025.gif"
  if (Test-Path $fb) { $gif = $fb }
}
if ($gif) { try { $pic.Image = [System.Drawing.Image]::FromFile($gif) } catch {} }
$form.Controls.Add($pic)

# ---- drag anywhere on the sprite ----
$script:dragging = $false
$script:dragOff  = New-Object System.Drawing.Point 0, 0
$onDown = {
  param($s, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    $script:dragging = $true
    $script:dragOff  = New-Object System.Drawing.Point $e.X, $e.Y
  }
}
$onMove = {
  param($s, $e)
  if ($script:dragging) {
    $p = [System.Windows.Forms.Cursor]::Position
    $form.Left = $p.X - $script:dragOff.X
    $form.Top  = $p.Y - $script:dragOff.Y
  }
}
$onUp = { $script:dragging = $false }
$pic.Add_MouseDown($onDown); $pic.Add_MouseMove($onMove); $pic.Add_MouseUp($onUp)
$form.Add_MouseDown($onDown); $form.Add_MouseMove($onMove); $form.Add_MouseUp($onUp)

# ---- hop feedback (window geometry, same idea as the macOS build) ----
$script:hopUntil = [datetime]::MinValue
$script:hopBase  = 0
$script:hopMs    = 1200
$script:hopAmp   = 26
function Start-Hop([int]$ms, [int]$amp) {
  if ($script:hopUntil -lt [datetime]::Now) { $script:hopBase = $form.Top }
  $script:hopMs = $ms; $script:hopAmp = $amp
  $script:hopUntil = [datetime]::Now.AddMilliseconds($ms)
}

# ---- right-click menu ----
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miFeed   = $menu.Items.Add("喂食")
$miAction = $menu.Items.Add("换个动作")
$menu.Items.Add("-") | Out-Null
$miRecall = $menu.Items.Add("回到窗口")
$miQuit   = $menu.Items.Add("退出")
$miFeed.Add_Click({ Start-Hop 900 14 })
$miAction.Add_Click({ Start-Hop 1200 26 })
$miRecall.Add_Click({
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $recallPath) | Out-Null
    (@{ no = $no; at = [DateTimeOffset]::Now.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress) |
      Set-Content -LiteralPath $recallPath -Encoding UTF8
  } catch {}
  $form.Close()
})
$miQuit.Add_Click({ $form.Close() })
$pic.ContextMenuStrip  = $menu
$form.ContextMenuStrip = $menu

# ---- poll the bridge ----
$script:lastCmdAt = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()   # ignore stale commands
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$timer.Add_Tick({
  $now = [datetime]::Now
  if ($script:hopUntil -gt $now) {
    $left = ($script:hopUntil - $now).TotalMilliseconds
    $t    = ($script:hopMs - $left) / $script:hopMs
    $dy   = [math]::Abs([math]::Sin($t * [math]::PI * 3)) * $script:hopAmp
    $form.Top = $script:hopBase - [int]$dy
  } elseif ($script:hopBase -ne 0 -and $form.Top -ne $script:hopBase) {
    $form.Top = $script:hopBase
  }

  $cmd = Read-JsonSafe $cmdPath
  if ($cmd -and $cmd.at -and ([int64]$cmd.at) -gt $script:lastCmdAt) {
    $script:lastCmdAt = [int64]$cmd.at
    if ($cmd.cmd -eq 'feed')   { Start-Hop 900 14 }
    if ($cmd.cmd -eq 'action') { Start-Hop 1200 26 }
  }
})
$timer.Start()

Write-Output ("PET_READY no={0} size={1}" -f $no, $size)
# let the daemon reap us precisely; matching on the command line is not safe
[System.IO.File]::WriteAllText((Join-Path $RunDir 'desktop\pet.pid'), [string]$PID)
[System.Windows.Forms.Application]::Run($form)
