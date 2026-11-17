'use strict';
/**
 * Cross-platform helpers for the Pokemon Pet skill.
 *
 * Everything OS-specific lives here so daemon.js stays readable and so adding a
 * platform later means touching one file. Design rule for this skill: never
 * depend on anything the user has to install. That means we only reach for tools
 * that ship with the OS (osascript/sips on macOS, PowerShell on Windows) and we
 * push all image processing that isn't segmentation into the renderer's canvas.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function log(tag, msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [PokePet:${tag}] ${msg}`);
}

/**
 * Environment for launching a *GUI* app.
 *
 * Critical: this daemon usually runs via ELECTRON_RUN_AS_NODE=1. Children inherit
 * it, and if it leaks into another Electron app's binary that app boots as a bare
 * node script (no window) and exits silently.
 */
function guiEnv() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, Object.assign({ env: guiEnv(), timeout: 120000, windowsHide: true }, opts),
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: (stdout || '').toString().trim(),
        err: (stderr || '').toString().trim()
      }));
  });
}

/** Run a PowerShell snippet (Windows only). */
function pwsh(script, opts = {}) {
  return run('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], opts);
}

/** Run an AppleScript / JXA snippet (macOS only). */
function osa(args, opts = {}) {
  return run('/usr/bin/osascript', args, opts);
}

// ---------- paths ----------

/*
 * Host application discovery.
 *
 * This skill decorates whichever Electron-based AI workspace it is installed
 * into, so nothing here may hardcode a product name. The host is found by
 * evidence instead: an Electron app that was started with remote debugging
 * leaves a `DevToolsActivePort` file in its own userData directory, so the
 * directory that contains that file *is* the injectable host. That works for
 * any client, current or future, and needs no name list.
 *
 * Override order: POKEPET_HOST env var -> cached config -> auto-detect.
 */

/** Root that holds one subdirectory per Electron app's userData. */
function userDataRoot() {
  if (IS_MAC) return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

/** Names we never treat as a host, to keep the scan cheap and predictable. */
const HOST_SCAN_SKIP = new Set(['pokemon-desktop-pet', 'Trash', 'CrashReporter']);

/**
 * A VS Code based IDE leaves these in its userData dir. Such a host is
 * technically injectable, but its main window is a code workbench, so it must
 * never outrank a running chat client — that mistake put the whole skin into
 * the IDE and the pets appeared nowhere the user was looking.
 */
const IDE_MARKERS = ['code.lock', 'languagepacks.json', 'CachedExtensionVSIXs', 'argv.json'];

function looksLikeIde(dir) {
  return IDE_MARKERS.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch (e) { return false; } });
}

/** Stable, non-display identity for per-host state buckets. */
function hostKey(userDataDir) {
  let canonical = path.resolve(userDataDir || '');
  try { canonical = fs.realpathSync(canonical); } catch (e) {}
  if (IS_WIN) canonical = canonical.toLowerCase();
  return 'host-' + crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Does the debug port in this file answer?
 *   true      - a Chromium debug endpoint replied
 *   false     - nothing is listening, or the listener is not Chromium: really gone
 *   'unknown' - the probe timed out; the host may well be alive but busy
 *   null      - the probe could not run at all (no curl)
 * Sync because detectHost() is sync and used from sync call sites.
 *
 * The false/'unknown' split matters more than it looks. A 2s deadline on a loaded
 * machine loses to a live host often enough that the daemon saw the host vanish
 * and come back every few ticks, and every "came back" injected another pet.
 * Only a refused connection proves absence, and that answer arrives immediately.
 */
function portAnswers(portFile) {
  let port = 0;
  try { port = parseInt(fs.readFileSync(portFile, 'utf-8').trim().split('\n')[0], 10); } catch (e) { return null; }
  if (!(port > 0)) return false;
  const probe = (secs) => {
    const r = require('child_process').spawnSync('curl',
      ['-s', '-m', String(secs), 'http://127.0.0.1:' + port + '/json/version'], { encoding: 'utf-8' });
    if (r.error) return null;
    if (r.status === 0) return /"Browser"/.test(r.stdout || '');
    if (r.status === 7) return false;   // connection refused: nobody is there
    return 'unknown';                   // 28 timeout and friends: probe failed, not the app
  };
  try {
    const first = probe(4);
    if (first !== 'unknown') return first;
    return probe(8);
  } catch (e) { return null; }
}

let _hostCache = null;

/**
 * Find the host app's userData directory by looking for DevToolsActivePort.
 * Returns { name, userDataDir, portFile } or null.
 */
function detectHost() {
  if (_hostCache) return _hostCache;

  const explicit = (process.env.POKEPET_HOST || '').trim();
  const root = userDataRoot();

  const consider = (name) => {
    const dir = path.join(root, name);
    const pf = path.join(dir, 'DevToolsActivePort');
    if (fs.existsSync(pf)) return { name, userDataDir: dir, portFile: pf };
    return null;
  };

  if (explicit) {
    const hit = consider(explicit);
    if (hit) { _hostCache = hit; return hit; }
    // an explicit name that has no port file yet is still the intended host
    _hostCache = { name: explicit, userDataDir: path.join(root, explicit),
                   portFile: path.join(root, explicit, 'DevToolsActivePort') };
    return _hostCache;
  }

  // The installer writes its choice here. Honouring it keeps hand-run scripts
  // (doctor, shot) on the same host the launchd daemon is driving, instead of
  // each one re-guessing and reporting on a different app.
  try {
    const pinned = fs.readFileSync(path.join(os.homedir(), '.pokepet', 'host'), 'utf-8').trim();
    if (pinned) {
      const hit = consider(pinned);
      if (hit) { _hostCache = hit; return hit; }
    }
  } catch (e) {}

  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { names = []; }
  const hits = [];
  for (const n of names) {
    if (n.startsWith('.') || HOST_SCAN_SKIP.has(n)) continue;
    const hit = consider(n);
    if (hit) hits.push(hit);
  }
  if (!hits.length) return null;
  // NOT "most recently touched port file wins": a closed app leaves its port
  // file behind, and it is often the newest one. Rank by evidence of being the
  // live chat client, and only break ties with mtime.
  for (const h of hits) {
    const alive = portAnswers(h.portFile);
    const inconclusive = alive === null || alive === 'unknown';
    h._score = (alive === true ? 100 : (inconclusive ? 50 : 0)) + (looksLikeIde(h.userDataDir) ? 0 : 10);
    try { h._mtime = fs.statSync(h.portFile).mtimeMs; } catch (e) { h._mtime = 0; }
  }
  hits.sort((a, b) => (b._score - a._score) || (b._mtime - a._mtime));
  _hostCache = hits[0];
  return _hostCache;
}

/** Human-readable host name for UI copy; never assume a specific product. */
function hostName() {
  const h = detectHost();
  return (h && h.name) || 'the app';
}

/**
 * ALL reachable Electron hosts, for multi-host injection: the daemon decorates
 * every running workspace at once, not just one. Returns
 * [{ name, userDataDir, portFile, port, ide }] and only for hosts whose debug
 * port actually answers — a closed app leaves its port file behind and must not
 * be counted. POKEPET_HOST, when set, pins the list to that single host.
 */
function detectHosts() {
  const root = userDataRoot();
  const explicit = (process.env.POKEPET_HOST || '').trim();
  let names;
  if (explicit) names = [explicit];
  else { try { names = fs.readdirSync(root); } catch (e) { names = []; } }
  const out = [];
  for (const n of names) {
    if (!explicit && (n.startsWith('.') || HOST_SCAN_SKIP.has(n))) continue;
    const dir = path.join(root, n);
    const pf = path.join(dir, 'DevToolsActivePort');
    let port = 0;
    try { port = parseInt(fs.readFileSync(pf, 'utf-8').trim().split('\n')[0], 10); } catch (e) { continue; }
    if (!(port > 0)) continue;
    const alive = portAnswers(pf);
    if (alive === false) continue;              // stale port file from a closed app
    if (alive === null && !explicit) continue;  // probe unavailable: trust only an explicit pin
    // 'unknown' (probe timed out) keeps the host: dropping a live host makes the
    // daemon treat it as gone and re-inject on its return, one extra pet each time.
    out.push({ name: n, key: hostKey(dir), userDataDir: dir, portFile: pf, port, ide: looksLikeIde(dir) });
  }
  return out;
}

function devToolsPortFile() {
  const h = detectHost();
  if (h) return h.portFile;
  // nothing detected yet (host never started with debugging): return the most
  // likely path so callers can print something actionable
  return path.join(userDataRoot(), 'DevToolsActivePort');
}

/**
 * The host executable, used only as a Node runtime fallback (ELECTRON_RUN_AS_NODE).
 * Resolved from the detected host name, then from any running process, so it
 * works regardless of what the product is called.
 */
function hostAppExe() {
  const h = detectHost();
  const nm = h && h.name;

  const cands = [];
  if (nm) {
    if (IS_MAC) {
      cands.push('/Applications/' + nm + '.app/Contents/MacOS/' + nm);
      cands.push(path.join(os.homedir(), 'Applications', nm + '.app', 'Contents', 'MacOS', nm));
    } else {
      cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', nm, nm + '.exe'));
      cands.push(path.join(process.env.LOCALAPPDATA || '', nm, nm + '.exe'));
      cands.push(path.join(process.env.ProgramFiles || '', nm, nm + '.exe'));
    }
  }
  for (const c of cands) if (c && fs.existsSync(c)) return c;

  // Fall back to whatever Electron host is running right now.
  if (IS_MAC) {
    try {
      const out = require('child_process')
        .execFileSync('/bin/ps', ['-Ao', 'command'], { encoding: 'utf-8', timeout: 8000 });
      for (const line of out.split('\n')) {
        const m = line.match(/(\/[^\s]*\.app\/Contents\/MacOS\/[^\s]+)/);
        if (m && fs.existsSync(m[1]) && !/Helper|Pokemon/.test(m[1])) return m[1];
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Turn a filesystem path into a URL the renderer can load.
 * the host app registers the `local-file` scheme as secure + CORS-enabled, and the
 * page origin is file://, so both work — but Windows paths need forward slashes
 * and a leading slash to be a valid URL.
 */
function toAssetUrl(p) {
  let u = p.replace(/\\/g, '/');
  if (!u.startsWith('/')) u = '/' + u;      // C:/x -> /C:/x
  return 'local-file://' + u;
}

// ---------- launching / quitting the standalone pet ----------

function launchApp(appPath) {
  if (!appPath || !fs.existsSync(appPath)) return false;
  if (IS_MAC) {
    spawn('open', ['-a', appPath], { detached: true, stdio: 'ignore', env: guiEnv() }).unref();
    return true;
  }
  // Windows: .exe directly, or a directory/.lnk through the shell
  if (/\.exe$/i.test(appPath)) {
    spawn(appPath, [], { detached: true, stdio: 'ignore', env: guiEnv(), windowsHide: false }).unref();
    return true;
  }
  spawn('cmd.exe', ['/c', 'start', '""', appPath],
    { detached: true, stdio: 'ignore', env: guiEnv(), windowsHide: true }).unref();
  return true;
}

/**
 * Bring the host app itself to the front.
 * Used when the standalone pet hands an action back to the skin (e.g. its
 * settings action opens the in-app picker) — that is pointless if the window
 * stays buried behind whatever the user is looking at.
 */
function focusHost() {
  const exe = hostAppExe();
  if (IS_MAC) {
    // .../<Host>.app/Contents/MacOS/<Host> -> .../<Host>.app
    if (!exe) return false;
    const bundle = exe.replace(/\/Contents\/MacOS\/[^/]+$/, '');
    spawn('open', ['-a', bundle], { detached: true, stdio: 'ignore', env: guiEnv() }).unref();
    return true;
  }
  if (!exe) return false;
  const name = path.basename(exe).replace(/\.exe$/i, '');
  /*
   * WScript.Shell AppActivate alone is not enough on Win10/11: the foreground
   * lock means a background caller (this daemon) is silently ignored, and the
   * COM call still reports success. Go through the Win32 API instead —
   * AllowSetForegroundWindow + SW_RESTORE + SetForegroundWindow — and keep
   * AppActivate only as a last-resort fallback. Returns a promise so callers
   * can actually tell whether the window came forward.
   */
  const ps = [
    '$sig = @\'',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n);',
    '[DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '\'@',
    'Add-Type -MemberDefinition $sig -Name Fg -Namespace QwPoke -ErrorAction SilentlyContinue',
    '$p = Get-Process -Name "' + name + '" -ErrorAction SilentlyContinue | ' +
      'Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    'if (-not $p) { Write-Output "nowindow"; exit 0 }',
    '$h = $p.MainWindowHandle',
    '[QwPoke.Fg]::AllowSetForegroundWindow($p.Id) | Out-Null',
    'if ([QwPoke.Fg]::IsIconic($h)) { [QwPoke.Fg]::ShowWindowAsync($h, 9) | Out-Null; Start-Sleep -Milliseconds 120 }',
    '$ok = [QwPoke.Fg]::SetForegroundWindow($h)',
    'if (-not $ok) { try { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null; $ok = $true } catch {} }',
    'Write-Output $(if ($ok) { "ok" } else { "failed" })'
  ].join('; ');
  return pwsh(ps).then((r) => r.ok && /ok/.test(r.out));
}

/**
 * Quit the standalone pet.
 * Matched on the app's own executable path/name so unrelated processes are safe.
 * A "nothing matched" exit code is success-with-nothing-to-do, not an error.
 */
async function quitApp(appPath) {
  if (!appPath) return false;
  if (IS_MAC) {
    const marker = appPath.replace(/\/Contents\/MacOS\/[^/]+$/, '.app/Contents/MacOS/');
    try {
      const out = require('child_process').execFileSync('/bin/ps', ['-Ao', 'pid=,command='],
        { encoding: 'utf-8', timeout: 8000 });
      let stopped = false;
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!m || !m[2].includes(marker)) continue;
        try { process.kill(Number(m[1]), 'SIGTERM'); stopped = true; } catch (e) {}
      }
      return stopped;
    } catch (e) { return false; }
  }
  /*
    * Security: killing by image name alone (the /IM form) would also kill
    * any unrelated process that happens to share the name. Resolve to PIDs whose
    * ExecutablePath is exactly ours, mirroring the mac branch's full-path match.
    */
  const target = /\.exe$/i.test(appPath) ? appPath : appPath + '.exe';
  const esc = target.replace(/'/g, "''");
  const r = await pwsh(
    "$p = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.ExecutablePath -eq '" + esc + "' }; " +
    "if ($p) { $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; " +
    "Write-Output 'done'"
  );
  return r.ok;
}

// ---------- native file picker ----------

async function choosePhoto() {
  if (IS_MAC) {
    const script =
      'try\n' +
      '  set f to choose file with prompt "选择一张宠物照片" of type {"public.image"}\n' +
      '  return POSIX path of f\n' +
      'on error\n' +
      '  return ""\n' +
      'end try';
    const r = await osa(['-e', script], { timeout: 300000 });
    return r.ok ? r.out : '';
  }
  // Windows: WinForms OpenFileDialog is part of .NET on every install
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$d = New-Object System.Windows.Forms.OpenFileDialog',
    '$d.Title = "选择一张宠物照片"',
    '$d.Filter = "图片|*.png;*.jpg;*.jpeg;*.bmp;*.gif;*.webp|所有文件|*.*"',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }'
  ].join('; ');
  const r = await pwsh(script, { timeout: 300000 });
  return r.ok ? r.out.split(/\r?\n/)[0].trim() : '';
}

// ---------- subject cutout (the only step that needs real smarts) ----------

/** Is python + rembg available? Used for good cutouts off macOS. */
async function findRembg() {
  const pys = IS_WIN ? ['py', 'python', 'python3'] : ['python3', 'python'];
  for (const py of pys) {
    const r = await run(py, ['-c', 'import rembg; print("ok")'], { timeout: 30000 });
    if (r.ok && r.out.indexOf('ok') >= 0) return py;
  }
  return null;
}

/**
 * Cut the subject out of a photo, writing a transparent PNG.
 *
 * Tiers, best first:
 *   1. macOS Vision subject mask — same engine as Preview's "Remove Background";
 *      handles cluttered rooms, sofas, headshots, pets lying down.
 *   2. rembg, if the user happens to have it — comparable quality anywhere.
 *   3. give up here and let the renderer do a canvas flood-fill instead, which is
 *      fine for plain/level backgrounds and is hidden further by pixelation.
 *
 * Returns { tier, cutPath } where cutPath is null when the caller should fall
 * back to the in-page path.
 */
async function cutout(srcPath, outPath, assetsDir) {
  if (IS_MAC) {
    const jxa = path.join(assetsDir, 'pokecut.jxa');
    if (fs.existsSync(jxa)) {
      const r = await osa(['-l', 'JavaScript', jxa, srcPath, outPath]);
      if (r.ok && /^ok /.test(r.out) && fs.existsSync(outPath)) {
        log('cut', 'vision ' + r.out);
        return { tier: 'vision', cutPath: outPath };
      }
      log('cut', 'vision unavailable: ' + (r.out || r.err));
    }
  }
  const py = await findRembg();
  if (py) {
    const code = [
      'import sys',
      'from rembg import remove',
      'data = open(sys.argv[1], "rb").read()',
      'open(sys.argv[2], "wb").write(remove(data))',
      'print("ok")'
    ].join('\n');
    const r = await run(py, ['-c', code, srcPath, outPath], { timeout: 300000 });
    if (r.ok && fs.existsSync(outPath)) {
      log('cut', 'rembg ok');
      return { tier: 'rembg', cutPath: outPath };
    }
    log('cut', 'rembg failed: ' + (r.err || r.out));
  }
  log('cut', 'no native cutout available — renderer will flood-fill');
  return { tier: 'canvas', cutPath: null };
}

// ---------- thumbnails (optional speed-up for the board picker) ----------

/**
 * Downscale every PNG in srcDir into dstDir.
 * macOS: sips. Windows: System.Drawing via PowerShell. Both ship with the OS,
 * so this never asks the user to install anything; if it fails we simply skip
 * thumbnails and the picker lazy-loads full images instead.
 */
async function makeThumbs(srcDir, dstDir, size = 320) {
  if (!fs.existsSync(srcDir)) return 0;
  fs.mkdirSync(dstDir, { recursive: true });
  const files = fs.readdirSync(srcDir).filter((f) => /\.png$/i.test(f));
  let made = 0;

  if (IS_MAC) {
    for (const f of files) {
      const dst = path.join(dstDir, f);
      if (fs.existsSync(dst)) continue;
      const r = await run('sips', ['-Z', String(size), path.join(srcDir, f), '--out', dst]);
      if (r.ok) made++;
    }
    return made;
  }

  // One PowerShell pass for the whole folder — far quicker than per-file spawns.
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing | Out-Null
$src = '${srcDir.replace(/'/g, "''")}'
$dst = '${dstDir.replace(/'/g, "''")}'
$max = ${size}
$n = 0
Get-ChildItem -Path $src -Filter *.png | ForEach-Object {
  $out = Join-Path $dst $_.Name
  if (Test-Path $out) { return }
  try {
    $img = [System.Drawing.Image]::FromFile($_.FullName)
    $scale = [Math]::Min($max / $img.Width, $max / $img.Height)
    if ($scale -gt 1) { $scale = 1 }
    $w = [int]($img.Width * $scale); $h = [int]($img.Height * $scale)
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $w, $h)
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $img.Dispose()
    $n++
  } catch { }
}
Write-Output $n`;
  const r = await pwsh(script, { timeout: 600000 });
  made = parseInt((r.out || '0').split(/\r?\n/).pop(), 10) || 0;
  return made;
}

// ---------- trash (never hard-delete a user file) ----------

async function moveToTrash(target) {
  if (!target || !fs.existsSync(target)) return false;
  if (IS_MAC) {
    const dest = path.join(os.homedir(), '.Trash', path.basename(target) + '.' + Date.now());
    try { fs.renameSync(target, dest); return true; } catch (e) { return false; }
  }
  // Windows: real Recycle Bin, so the user can restore it
  const p = target.replace(/'/g, "''");
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic | Out-Null',
    `$p = '${p}'`,
    'if (Test-Path -PathType Container $p) {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')",
    '} else {',
    "  [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')",
    '}'
  ].join(' ');
  const r = await pwsh(script);
  return r.ok;
}

module.exports = {
  IS_MAC, IS_WIN, log, guiEnv, run, pwsh, osa, HOST_SCAN_SKIP,
  devToolsPortFile, hostAppExe, detectHost, detectHosts, hostName, hostKey, userDataRoot, toAssetUrl,
  launchApp, quitApp, focusHost, choosePhoto, cutout, findRembg, makeThumbs, moveToTrash
};
