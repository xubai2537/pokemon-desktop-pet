#!/usr/bin/env node
'use strict';
/**
 * Pokemon desktop pet — native bridge daemon (macOS + Windows).
 *
 * Two jobs:
 *  1. Keep the skin injected: re-inject whenever the host renderer reloads.
 *  2. Serve a loopback HTTP endpoint for what the page cannot do itself —
 *     launching/quitting the standalone desktop pet, opening a native file
 *     picker, running the subject cutout, and writing files.
 *
 * Page requests are fire-and-forget (fetch mode:'no-cors'), so results are
 * published as small JSON files the page reads back over local-file:// instead
 * of being returned in the response body.
 *
 * All OS-specific behaviour lives in platform.js. Runs on Node 18+ or on
 * the host app's own Electron via ELECTRON_RUN_AS_NODE=1 — no external deps.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const P = require('./platform.js');
const { getDebugPort, openSession, openSessionAt, CdpSession } = require('./cdp.js');

const HOME = os.homedir();
const RUN_DIR = path.join(HOME, '.pokepet');
const CFG_FILE = path.join(RUN_DIR, 'config.json');
const PORT_FILE = path.join(RUN_DIR, 'bridge.port');
const MYPETS_DIR = path.join(RUN_DIR, 'mypets');
const MYPETS_INDEX = path.join(MYPETS_DIR, 'index.json');
const PENDING_FILE = path.join(MYPETS_DIR, 'pending.json');
const INJECT = path.join(__dirname, 'inject.js');

const log = (m) => P.log('daemon', m);

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return d; }
}
function writeJson(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

fs.mkdirSync(RUN_DIR, { recursive: true });
fs.mkdirSync(MYPETS_DIR, { recursive: true });

/* ---------- standalone desktop pet ---------- */
/*
 * The pet that lives on the desktop is driven by a script built on whatever the
 * OS already ships: AppKit through `osascript` on macOS, WinForms through
 * PowerShell on Windows. That means no Electron runtime to bundle (too big for
 * a skill package) and nothing to download — it works the moment the skill is
 * installed, on both platforms.
 */
const DESKTOP_DIR = path.join(RUN_DIR, 'desktop');
const RECALL_FLAG = path.join(DESKTOP_DIR, 'recall.flag');
const PET_PID_FILE = path.join(DESKTOP_DIR, 'pet.pid');
const HANDOFF_FILE = path.join(DESKTOP_DIR, 'handoff.json');
let petProc = null;
let myPort = 0;          // set once the bridge is listening; see bye()

/*
 * The desktop pet writes recall.flag when the user picks "back to the window".
 * It cannot call us directly (it is a plain system script), so poll for it and
 * forward the recall into the page.
 */
function watchRecallFlag() {
  setInterval(() => {
    try {
      if (!fs.existsSync(RECALL_FLAG)) return;
      fs.unlinkSync(RECALL_FLAG);
      stopDesktopPet();
      recallIntoApp().catch(() => {});
    } catch (e) {}
  }, 1000);
}

/*
 * The daemon runs on the host's Electron as a Node process, which leaves two
 * kinds of poison in the environment for anything GUI we spawn:
 *
 *   ELECTRON_RUN_AS_NODE  a child Electron would start headless
 *   __CFBundleIdentifier  set by macOS to the HOST app's bundle id; a child
 *                         .app that inherits it is registered under the wrong
 *                         identity and LaunchServices quietly refuses to bring
 *                         it up — the process is created, exits immediately,
 *                         writes nothing, and spawn() still reports success.
 *                         This one cost hours: the pet "launched" every time
 *                         and never appeared.
 */
function guiSafeEnv() {
  const env = Object.assign({}, process.env);
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', '__CFBundleIdentifier',
                   'XPC_SERVICE_NAME', 'CFFIXED_USER_HOME']) {
    delete env[k];
  }
  return env;
}

function petScript() {
  const name = P.IS_MAC ? 'desktop-pet.jxa' : 'desktop-pet.ps1';
  // daemon.js and the pet script are installed side by side in <run>/bin
  for (const dir of [__dirname, path.join(RUN_DIR, 'bin')]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return '';
}

/*
 * macOS: the desktop pet runs as a real application, not as a script.
 *
 * Running desktop-pet.jxa with `osascript` looks like it works — the window
 * appears, the sprite animates — but the window server never delivers a single
 * mouse event to a bare osascript process, because it is not a registered GUI
 * application. Right-click does nothing, the pet cannot be dragged, and
 * "back to the window" is unreachable. Measured: 0 events dequeued in 20s while
 * clicking straight on the sprite.
 *
 * So the script is compiled into PokePet.app when the skill is packaged, and
 * that bundle ships with it. We deliberately do NOT build it here: `osacompile`
 * ad-hoc signs whatever it produces, and the Info.plist edit that used to hide
 * the Dock icon invalidated that signature, after which macOS refused to launch
 * the app and said nothing — spawn() still reported success. The Dock icon is
 * hidden at runtime instead, via setActivationPolicy in the script itself.
 */
const PET_APP = path.join(RUN_DIR, 'bin', 'PokePet.app');

function petApp() {
  // the bundle sits next to daemon.js; the run-dir copy is the installed one
  for (const dir of [__dirname, path.join(RUN_DIR, 'bin')]) {
    const app = path.join(dir, 'PokePet.app');
    if (fs.existsSync(path.join(app, 'Contents', 'MacOS', 'applet'))) return app;
  }
  return '';
}

function desktopAvailable() { return P.IS_MAC ? !!petApp() : !!petScript(); }

function petRunning() {
  return !!(petProc && petProc.exitCode === null && !petProc.killed);
}

/** Start the desktop pet, handing over which pokemon it should be. */
async function startDesktopPet(payload, cfg, resolved) {
  // each platform needs a different artefact: a bundle on macOS, a script on Windows
  const app = P.IS_MAC ? petApp() : '';
  const script = P.IS_MAC ? '' : petScript();
  if (P.IS_MAC ? !app : !script) return false;
  fs.mkdirSync(DESKTOP_DIR, { recursive: true });
  try { fs.unlinkSync(RECALL_FLAG); } catch (e) {}
  const hand = Object.assign({}, payload || {}, {
    sprite: (resolved && resolved.sprite) || '',
    label: (payload && payload.label) || (resolved && resolved.label) || '',
    petHome: cfg.petHome || '',
    at: Date.now()
  });
  try { fs.writeFileSync(HANDOFF_FILE, JSON.stringify(hand)); } catch (e) {}

  stopDesktopPet();
  /*
   * Keep the pet's own output: with stdio ignored a pet that dies during
   * startup leaves nothing behind and the daemon still sees spawn() succeed,
   * which is indistinguishable from a pet that launched fine and is simply
   * off-screen. Never let the log itself block the launch.
   */
  let petOut = 'ignore';
  try { petOut = fs.openSync(path.join(DESKTOP_DIR, 'pet.log'), 'a'); } catch (e) {}
  const petStdio = ['ignore', petOut, petOut];
  try {
    if (P.IS_MAC) {
      petProc = spawn(path.join(app, 'Contents', 'MacOS', 'applet'), [],
        { detached: true, stdio: petStdio, env: guiSafeEnv() });
    } else {
      petProc = spawn('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
         '-File', script, RUN_DIR, cfg.petHome || ''],
        { detached: true, stdio: petStdio, windowsHide: true, env: guiSafeEnv() });
    }
    petProc.unref();
  } catch (e) {
    log('desktop pet failed to start: ' + e.message);
    petProc = null;
    return false;
  }

  /*
   * Wait until the pet is really on screen before calling this a success.
   * spawn() returning proves nothing: on first launch macOS assesses the
   * freshly installed bundle and the window can take 10-20s to appear. Report
   * success that early and the caller pulls the pokemon out of the team
   * immediately, so for those seconds it is gone from the window and not yet
   * on the desktop — which reads as "I clicked and it vanished".
   * The pet writes its pid file right after ordering the window front, and
   * stopDesktopPet() removed the old one above, so its reappearance is the
   * signal we want.
   */
  const startedAt = Date.now();
  for (let i = 0; i < 60; i++) {
    if (fs.existsSync(PET_PID_FILE)) {
      log('desktop pet up in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's');
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  log('desktop pet did not come up within 30s');
  return false;
}

function stopDesktopPet() {
  if (petProc) {
    try { process.kill(-petProc.pid, 'SIGTERM'); } catch (e) {
      try { petProc.kill('SIGTERM'); } catch (e2) {}
    }
    petProc = null;
  }
  /*
   * The pet outlives us (it is detached), so after a daemon restart petProc is
   * null while a pet is still on screen — recall would then silently do nothing
   * and the user would see the same pokemon in the window and on the desktop.
   * The pet records its own pid on startup; signal that exact process. Broad
   * command-line matching is unsafe because unrelated arguments may mention it.
   */
  try {
    const pid = parseInt(fs.readFileSync(PET_PID_FILE, 'utf8').trim(), 10);
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch (e) {} }
    fs.unlinkSync(PET_PID_FILE);
  } catch (e) {}
}

/**
 * Reuse whatever runtime is running us for child node scripts.
 *
 * Detect Electron by capability, not by product name — this skill runs inside
 * several different AI workspaces, and matching on a client name would silently
 * fail to set ELECTRON_RUN_AS_NODE on the others (child scripts would then try
 * to boot a GUI instead of running as Node).
 */
function selfRuntime() {
  const exec = process.execPath;
  const isElectron = !!(process.versions && process.versions.electron) ||
                     /electron/i.test(exec) ||
                     process.env.ELECTRON_RUN_AS_NODE === '1';
  return {
    exec,
    env: isElectron ? Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }) : process.env
  };
}

/* Injection destroys the old runtime and then installs the new one, and that pair
 * is not atomic inside the page: two runs at once interleave and the loser's
 * teardown lands after the winner's install, leaving a second orphaned pet with no
 * marker to clean it up. Callers are spread across the tick loop, the extras
 * callback and the http handlers, so serialize here instead of at each call site. */
let injectChain = Promise.resolve();

function runInject(args = []) {
  const run = () => new Promise((resolve) => {
    const { exec, env } = selfRuntime();
    execFile(exec, [INJECT].concat(args), { env, timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        if (stdout) process.stdout.write(stdout);
        if (stderr) process.stderr.write(stderr);
        resolve(!err);
      });
  });
  const next = injectChain.then(run, run);
  injectChain = next.then(() => {}, () => {});
  return next;
}

// ---------- custom pets ----------

function readIndex() {
  const l = readJson(MYPETS_INDEX, []);
  return Array.isArray(l) ? l : [];
}

/** Friendly default name: photo filenames are often hashes or IMG_1234. */
function defaultName(srcPath, n) {
  const base = path.basename(srcPath).replace(/\.[^.]+$/, '');
  const meaningless = /^[0-9a-f]{12,}$/i.test(base) || /^(img|image|photo|dsc)[-_ ]?\d+$/i.test(base);
  if (!base || meaningless) return '我的宠物' + (n > 0 ? ' ' + (n + 1) : '');
  return base.slice(0, 24);
}

/**
 * Step 1 of adding a pet: pick a photo, then cut the subject out.
 * The outcome goes to pending.json; the renderer picks it up, pixelates it on
 * canvas (so no image library has to be installed) and posts the sprite back.
 */
async function pickPhoto(payload = {}) {
  writeJson(PENDING_FILE, { state: 'picking', at: Date.now() });
  let src = payload.path || '';
  if (!src) src = await P.choosePhoto();
  if (!src || !fs.existsSync(src)) {
    writeJson(PENDING_FILE, { state: 'cancelled', at: Date.now() });
    log('addpet: cancelled');
    return { ok: false, error: 'cancelled' };
  }

  writeJson(PENDING_FILE, { state: 'cutting', src, at: Date.now() });
  const id = 'my' + Date.now().toString(36);
  const cutPath = path.join(MYPETS_DIR, id + '.cut.png');
  const res = await P.cutout(src, cutPath, __dirname);

  const pending = {
    state: 'ready',
    id,
    src,
    image: res.cutPath || src,       // whichever image the renderer should process
    needsFloodFill: !res.cutPath,    // no native cutout: strip background on canvas
    tier: res.tier,
    name: payload.name || defaultName(src, readIndex().length),
    at: Date.now()
  };
  writeJson(PENDING_FILE, pending);
  log(`addpet: ready (${res.tier}) ${pending.name}`);
  return { ok: true, id };
}

/** Step 2: store the sprite the renderer produced. */
async function savePet(payload = {}) {
  const m = /^data:image\/png;base64,([\s\S]+)$/.exec(payload.dataUrl || '');
  if (!m) return { ok: false, error: 'bad dataUrl' };
  const id = payload.id || ('my' + Date.now().toString(36));
  const outPath = path.join(MYPETS_DIR, id + '.png');
  fs.writeFileSync(outPath, Buffer.from(m[1], 'base64'));

  const list = readIndex();
  list.push({
    id: 'my:' + id,
    name: payload.name || '我的宠物',
    file: outPath,
    cut: payload.cut || '',
    src: payload.src || '',
    tier: payload.tier || '',
    created: new Date().toISOString()
  });
  writeJson(MYPETS_INDEX, list);
  writeJson(PENDING_FILE, { state: 'saved', id: 'my:' + id, at: Date.now() });
  log('savepet: ' + id + ' (' + list.length + ' custom pets)');
  return { ok: true, id: 'my:' + id };
}


/** Rename a custom pet. Renames the real entry, not a display-only overlay. */
async function renamePet(payload = {}) {
  const id = payload.id;
  const name = (payload.name || '').trim();
  if (!id) return { ok: false, error: 'no id' };
  if (!name) return { ok: false, error: 'empty name' };
  const list = readIndex();
  let hit = null;
  for (const e of list) if (e.id === id) hit = e;
  if (!hit) return { ok: false, error: 'not found' };
  hit.name = name.slice(0, 24);
  writeJson(MYPETS_INDEX, list);
  log('renamepet: ' + id + ' -> ' + hit.name);
  return { ok: true, name: hit.name };
}

/** Remove a custom pet; sprites go to the Trash / Recycle Bin, never deleted. */
async function delPet(payload = {}) {
  const id = payload.id;
  if (!id) return { ok: false, error: 'no id' };
  const list = readIndex();
  const keep = [];
  let removed = null;
  for (const e of list) { if (e.id === id) removed = e; else keep.push(e); }
  if (!removed) return { ok: false, error: 'not found' };
  for (const p of [removed.file, removed.cut]) {
    if (p && fs.existsSync(p)) await P.moveToTrash(p);
  }
  writeJson(MYPETS_INDEX, keep);
  log('delpet: ' + id);
  return { ok: true };
}


/**
 * Resolve a team slot to an actual image on disk.
 * '0025' -> the pokemon gif; 'my:xxx' -> the sprite built from a photo.
 */
function spriteFor(id) {
  const cfg = readJson(CFG_FILE, {});
  if (/^my:/.test(id)) {
    for (const e of readIndex()) {
      if (e.id === id && e.file && fs.existsSync(e.file)) return { sprite: e.file, label: e.name || '' };
    }
    return null;
  }
  if (/^\d{4}$/.test(id) && cfg.petHome) {
    const gif = path.join(cfg.petHome, 'gif', id + '.gif');
    if (fs.existsSync(gif)) {
      let label = '';
      const names = readJson(path.join(cfg.petHome, 'names.json'), {});
      if (names && names[id]) label = names[id].zh || names[id].en || '';
      return { sprite: gif, label };
    }
  }
  return null;
}

/**
 * Open the skin's own picker inside the host window.
 *
 * The standalone pet is one feature of the host app, not a second app: its
 * settings action calls this instead of opening its own window, so there is a
 * single place to change背景板 / 队伍 / 喂食 etc.
 */
async function openInApp(tab, from) {
  const t = /^[a-z]+$/.test(String(tab || '')) ? tab : 'set';
  // only a fixed vocabulary crosses into the page — it is string-interpolated
  const f = from === 'desktop' ? 'desktop' : '';
  P.focusHost();
  const tryOpen = async () => {
    let s = null;
    try {
      const opened = await openSession({ retries: 2, waitMs: 400 });
      s = opened.session;
      const ok = await s.eval(
        "(function(){ if(!window.__qwPoke) return 'missing'; __qwPoke.open('" + t + "'" +
        (f ? ", '" + f + "'" : "") + "); return 'ok'; })()"
      );
      s.close();
      return ok;
    } catch (e) {
      if (s) { try { s.close(); } catch (_) {} }
      return 'error: ' + e.message;
    }
  };
  let r = await tryOpen();
  if (r !== 'ok') {
    // page reloaded and lost the skin — put it back, then open again
    await runInject();
    r = await tryOpen();
  }
  log('opensettings(' + t + '): ' + r);
  return r === 'ok';
}

/**
 * Command inbox for the standalone pet.
 *
 * The desktop pet deliberately has no 喂食 / 换个动作 menu of its own — those are
 * driven from the host window so the two surfaces never drift apart. The page posts a command
 * here and the pet app picks it up (it polls this file).
 */
const PET_CMD_FILE = path.join(RUN_DIR, 'pet_cmd.json');

function writePetCmd(payload = {}) {
  const cmd = String(payload.cmd || '');
  if (!/^(feed|action|sprite)$/.test(cmd)) return false;
  try {
    writeJson(PET_CMD_FILE, {
      cmd,
      item: payload.item || '',
      name: payload.name || '',
      at: Date.now()
    });
    log('petcmd: ' + cmd + (payload.item ? ' ' + payload.item : ''));
    return true;
  } catch (e) {
    log('petcmd failed: ' + e.message);
    return false;
  }
}

/**
 * Recall triggered from the pet's own menu: run the page's own recall so the
 * team, the escapedTo list and the running app all end up consistent — the same
 * path as the in-app recall button.
 */
async function recallIntoApp() {
  P.focusHost();
  let s = null;
  try {
    const opened = await openSession({ retries: 2, waitMs: 400 });
    s = opened.session;
    const r = await s.eval("(function(){ if(!window.__qwPoke) return 'missing'; __qwPoke.recall(); return 'ok'; })()");
    s.close();
    log('recall into app: ' + r);
    return r === 'ok';
  } catch (e) {
    if (s) { try { s.close(); } catch (_) {} }
    log('recall into app failed: ' + e.message);
    return false;
  }
}

/*
 * Relay a reminder into the page as a pet bubble.
 *
 * The pet is only a sink. It cannot fetch reminders itself and neither can this
 * daemon: `dws` (the DingTalk CLI) only executes for real inside the host's own
 * shell tool — a background process gets a `pending-post-tool-use` placeholder
 * string instead of data, measured on both the wrapper and the raw shim binary.
 * So whoever wants a reminder (e.g. a scheduled host task that read the user's
 * todos) does the reading and POSTs the finished line to /notify.
 *
 * Nothing is trusted from the caller beyond a short string: the text is length
 * capped here and again in the page, and it is passed as a JSON argument rather
 * than spliced into the evaluated source, so it cannot inject code.
 */
const NOTIFY_MAX = 200;
let lastNotifyAt = 0;

/*
 * State of an in-flight HD sprite download, shared between /fetchstyle (starts
 * it) and /stylestatus (reports progress). One at a time: the two HD sets are
 * ~78MB and ~124MB, and running both at once only makes each slower.
 */
const STYLE_TOTAL = 1025;      // pokedex entries in the HD sets
const STYLE_READY_MIN = 900;   // same bar inject.js uses before offering a style
let styleJob = { running: false, style: '', error: '' };
/* Card faces are an opt-in download (3700+ files), so they get their own job slot
   and their own on-disk counter — same "count the files, resuming is honest"
   approach as the HD sprite styles. */
let cardJob = { running: false, error: '' };
function cardCount(home) {
  try { return fs.readdirSync(path.join(home, 'cards')).filter((f) => /\.(webp|png|jpg|jpeg)$/i.test(f)).length; }
  catch (e) { return 0; }
}

/* Extras = backgrounds + avatars + pack covers. Moved out of the install phase
   in v4.5.3 (install now downloads essentials only), so a fresh installed pet
   shows an empty 背景板 / 头像 / 抽卡 tab until this fetch fills them. The
   daemon starts it automatically after the pet is up, and the UI can poll
   /extrasstatus to show progress. */
let extrasJob = { running: false, error: '' };
function countIn(home, dir) {
  try { return fs.readdirSync(path.join(home, dir)).filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f)).length; }
  catch (e) { return 0; }
}
function extrasCount(home) {
  return countIn(home, 'backgrounds_tcgp') + countIn(home, 'avatars_tcgp') + countIn(home, 'packs');
}
const EXTRAS_TOTAL = 162 + 164 + 43;    // matches art.json (backgrounds + avatars + packs)

function styleCount(home, style) {
  try { return fs.readdirSync(path.join(home, style)).length; } catch (e) { return 0; }
}

async function pushNotice(payload) {
  const text = String((payload && payload.text) || '').trim().slice(0, NOTIFY_MAX);
  if (!text) return { ok: false, error: 'empty text' };
  // A stuck scheduler must not be able to machine-gun bubbles at the user.
  const now = Date.now();
  if (now - lastNotifyAt < 3000) return { ok: false, error: 'rate limited' };
  lastNotifyAt = now;

  const opts = {};
  if (payload && payload.key) opts.key = String(payload.key).slice(0, 80);
  if (payload && payload.ms) opts.ms = Math.max(1500, Math.min(20000, Number(payload.ms) || 0));
  if (payload && payload.gapMs) opts.gapMs = Math.max(0, Math.min(86400000, Number(payload.gapMs) || 0));
  if (payload && payload.act) opts.act = String(payload.act).slice(0, 16);

  let s = null;
  try {
    const opened = await openSession({ retries: 2, waitMs: 400 });
    s = opened.session;
    const expr = '(function(t,o){ if(!window.__qwPoke || !__qwPoke.notify) return "missing";' +
                 ' return __qwPoke.notify(t,o); })(' +
                 JSON.stringify(text) + ',' + JSON.stringify(opts) + ')';
    const r = await s.eval(expr);
    s.close();
    log('notify: ' + r + ' — ' + text.slice(0, 40));
    return { ok: r === 'shown', state: r };
  } catch (e) {
    if (s) { try { s.close(); } catch (_) {} }
    log('notify failed: ' + e.message);
    return { ok: false, error: e.message };
  }
}


/* ---------- growth state (affection etc.) ----------
 *
 * Affection used to live only in each host's localStorage. Two ways that lost a
 * user's progress: opening the pet in another workspace showed a fresh profile
 * with 0 affection, and anything that cleared site data (or the uninstall note
 * telling people to clear it) wiped months of feeding for good.
 *
 * So the growth data also lives here, on disk, host-independent. The merge is
 * deliberately asymmetric: affection is combined with MAX, so no host and no
 * reinstall can ever lower it — the one thing the user asked for is that it
 * never disappears. Flags (everstone/evolved/nicknames) fill in missing keys
 * only, which errs toward keeping an everstone rather than silently dropping one.
 */
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const GROWTH_KEYS = ['affection', 'everstone', 'evolved', 'nicknames',
  'cards', 'packLog', 'unlocked', 'cardFav', 'appearance', 'appearanceByHost'];

function readState() {
  const s = readJson(STATE_FILE, {}) || {};
  for (const k of GROWTH_KEYS) {
    if (!s[k] || typeof s[k] !== 'object' || Array.isArray(s[k])) s[k] = {};
  }
  return s;
}

function mergeState(incoming) {
  const cur = readState();
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  const out = { affection: {}, everstone: {}, evolved: {}, nicknames: {},
    cards: {}, packLog: {}, unlocked: {}, cardFav: {}, appearance: {} };

  // affection: max, clamped. Monotone by design — see the comment above.
  const seen = Object.assign({}, cur.affection, inc.affection || {});
  for (const id of Object.keys(seen)) {
    const a = Number((cur.affection || {})[id]) || 0;
    const b = Number(((inc.affection) || {})[id]) || 0;
    const v = Math.max(a, b);
    if (v > 0) out.affection[id] = Math.max(0, Math.min(100, v));
  }
  // flags + card economy: union, incoming wins on conflict
  for (const k of ['everstone', 'evolved', 'nicknames',
    'cards', 'packLog', 'unlocked', 'cardFav']) {
    out[k] = Object.assign({}, cur[k] || {}, (inc[k] && typeof inc[k] === 'object') ? inc[k] : {});
  }
  /*
   * Background appearance is PER HOST, unlike everything above.
   *
   * It used to be one global bundle kept by newest timestamp, which meant
   * picking a board in the code IDE silently repainted the chat client too —
   * and worse, the density that suits a dark theme washes out a light one, so
   * the shared value was wrong for at least one host by construction. Growth
   * data (affection, cards) is genuinely one account and stays merged; a board
   * is a per-window look and is now stored under appearanceByHost[hostKey].
   *
   * `appearance` (no host) is kept as the legacy/global fallback so an existing
   * install still shows its board on first read, and so a host that reports no
   * name has somewhere to write. Within one host the bundle is still
   * newest-timestamp-wins, for the same reason as before: a fresh localStorage
   * carries no timestamp and must not erase a deliberate choice.
   */
  const pickBundle = (a, b) => {
    const A = (a && typeof a === 'object') ? a : {};
    const B = (b && typeof b === 'object') ? b : {};
    const aTs = Number(A._ts) || 0;
    const bTs = Number(B._ts) || 0;
    return (bTs >= aTs && bTs > 0) ? Object.assign({}, B) : Object.assign({}, A);
  };

  const curByHost = (cur.appearanceByHost && typeof cur.appearanceByHost === 'object')
    ? cur.appearanceByHost : {};
  out.appearanceByHost = Object.assign({}, curByHost);

  const incHostKey = typeof inc.hostKey === 'string' && inc.hostKey.trim()
    ? inc.hostKey.trim() : '';
  if (incHostKey) {
    // Only this host's slot is touched; every other workspace keeps its own look.
    out.appearanceByHost[incHostKey] = pickBundle(curByHost[incHostKey], inc.appearance);
    // Leave the legacy global bundle as-is so older runtimes keep working.
    out.appearance = Object.assign({}, (cur.appearance && typeof cur.appearance === 'object') ? cur.appearance : {});
  } else {
    // No host reported (older runtime): fall back to the old global behaviour.
    out.appearance = pickBundle(cur.appearance, inc.appearance);
  }
  out.updatedAt = Date.now();
  try { writeJson(STATE_FILE, out); } catch (e) { log('state save failed: ' + e.message); }
  return out;
}

// ---------- WebSocket asset + bridge (for strict-CSP hosts) ----------
/*
 * A VS Code based IDE enforces `img-src 'self' data: blob: https:`
 * and `connect-src 'self' https: ws:`, so the page can neither load
 * local-file:// sprites nor fetch the http bridge. Only ws:// + blob: get
 * through. This minimal RFC6455 server (no deps) streams sprite bytes to the
 * page — which wraps them in blob: URLs — and relays bridge calls, so a
 * CSP-locked host gets the same features as a local-file host.
 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAllowedRoots() {
  const cfg = readJson(CFG_FILE, {});
  const roots = [];
  const add = (p) => { if (p) { try { roots.push(fs.realpathSync(p)); } catch (e) { roots.push(path.resolve(p)); } } };
  add(cfg.petHome);
  add(path.join(RUN_DIR, 'petapp'));
  add(path.join(RUN_DIR, 'thumbs'));
  add(MYPETS_DIR);
  return roots;
}

// Only serve files that really live under an asset root — never let a page turn
// this into an arbitrary local-file reader.
function wsResolveAsset(reqPath) {
  let real;
  try { real = fs.realpathSync(reqPath); } catch (e) { return null; }
  const roots = wsAllowedRoots();
  if (!roots.some((r) => real === r || real.startsWith(r + path.sep))) return null;
  return real;
}

function wsFrame(buf, opcode) {
  const len = buf.length;
  let hdr;
  if (len < 126) { hdr = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = 127; hdr.writeUInt32BE(Math.floor(len / 4294967296), 2); hdr.writeUInt32BE(len >>> 0, 6); }
  return Buffer.concat([hdr, buf]);
}

// POST a bridge action to our own HTTP server, so the ws relay reuses every
// existing endpoint instead of duplicating the switch.
function bridgeLoopback(action, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload || {});
    const req = http.request(
      { host: '127.0.0.1', port: myPort, path: '/' + action, method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(null); } }); }
    );
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function wsHandleConnection(socket) {
  let buf = Buffer.alloc(0);
  const sendText = (obj) => { try { socket.write(wsFrame(Buffer.from(JSON.stringify(obj)), 0x1)); } catch (e) {} };
  const sendBin = (bytes) => { try { socket.write(wsFrame(bytes, 0x2)); } catch (e) {} };

  async function dispatch(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'asset') {
      const real = wsResolveAsset(String(msg.path || ''));
      if (!real) { sendText({ kind: 'asset', id: msg.id, ok: false }); return; }
      let bytes;
      try { bytes = fs.readFileSync(real); } catch (e) { sendText({ kind: 'asset', id: msg.id, ok: false }); return; }
      sendText({ kind: 'asset', id: msg.id, ok: true, len: bytes.length });
      sendBin(bytes);
      return;
    }
    if (msg.kind === 'bridge') {
      const result = await bridgeLoopback(String(msg.action || ''), msg.payload || {});
      sendText({ kind: 'bridge', id: msg.id, result: result });
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {                                   // drain every complete frame
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = buf.readUInt32BE(6); off = 10; }
      let mask = null;
      if (masked) { if (buf.length < off + 4) return; mask = buf.slice(off, off + 4); off += 4; }
      if (buf.length < off + len) return;
      const payload = buf.slice(off, off + len);
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.slice(off + len);
      if (opcode === 0x8) { try { socket.end(); } catch (e) {} return; }                    // close
      if (opcode === 0x9) { try { socket.write(wsFrame(payload, 0xA)); } catch (e) {} continue; }  // ping -> pong
      if (opcode === 0x1 && fin) { try { dispatch(JSON.parse(payload.toString('utf8'))); } catch (e) {} }
    }
  });
  socket.on('error', () => { try { socket.destroy(); } catch (e) {} });
}

// ---------- HTTP bridge ----------

const server = http.createServer((req, res) => {
  const done = (code, body) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'POST,GET,OPTIONS'
    });
    res.end(JSON.stringify(body || { ok: true }));
  };
  if (req.method === 'OPTIONS') return done(204, {});

  /*
   * http asset transport. Some code-workbench hosts use a renderer CSP of
   * `default-src 'self'` with no connect-src, which blocks ws:// AND fetch() to
   * 127.0.0.1 but still allows `img-src http:` and `frame-src http://127.0.0.1:*`.
   * So sprites arrive as plain <img> from /asset, and bridge calls go through a
   * hidden /relay iframe that is same-origin with this server and can fetch for
   * the page. runtime.js has always spoken this protocol; the routes were missing.
   */
  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/asset') {
    let want = '';
    try { want = decodeURIComponent(((req.url || '').split('?')[1] || '').replace(/^path=/, '')); } catch (e) {}
    const real = wsResolveAsset(want);
    if (!real) { res.writeHead(404); return res.end(); }
    let bytes;
    try { bytes = fs.readFileSync(real); } catch (e) { res.writeHead(404); return res.end(); }
    const ext = path.extname(real).toLowerCase();
    const type = ext === '.gif' ? 'image/gif' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.webp' ? 'image/webp' : ext === '.svg' ? 'image/svg+xml' : 'image/png';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': bytes.length,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    });
    return res.end(bytes);
  }

  if (req.method === 'GET' && (req.url || '').split('?')[0] === '/relay') {
    const page = '<!doctype html><meta charset="utf-8"><title>pokepet relay</title><script>\n'
      + 'function reply(src, id, result) {\n'
      + '  try { src.postMessage({ __pokepet: true, id: id, result: result }, "*"); } catch (e) {}\n'
      + '}\n'
      + 'window.addEventListener("message", function (ev) {\n'
      + '  var d = ev.data;\n'
      + '  if (!d || d.__pokepet !== true || !d.id || !ev.source) return;\n'
      + '  if (d.kind === "bridge") {\n'
      + '    var action = String(d.action || "").replace(/[^a-z0-9_-]/gi, "");\n'
      + '    if (!action) return reply(ev.source, d.id, null);\n'
      + '    fetch(location.origin + "/" + action, {\n'
      + '      method: "POST", headers: { "Content-Type": "text/plain" },\n'
      + '      body: JSON.stringify(d.payload || {})\n'
      + '    }).then(function (r) { return r.text(); })\n'
      + '     .then(function (t) { var v = null; try { v = JSON.parse(t); } catch (e) {} reply(ev.source, d.id, v); })\n'
      + '     .catch(function () { reply(ev.source, d.id, null); });\n'
      + '    return;\n'
      + '  }\n'
      + '  if (d.kind === "text") {\n'
      + '    fetch(location.origin + "/asset?path=" + encodeURIComponent(String(d.path || "")), { cache: "no-store" })\n'
      + '      .then(function (r) { return r.ok ? r.text() : null; })\n'
      + '      .then(function (t) { reply(ev.source, d.id, t); })\n'
      + '      .catch(function () { reply(ev.source, d.id, null); });\n'
      + '  }\n'
      + '});\n'
      + '</script>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(page);
  }

  const action = (req.url || '/').split('?')[0].replace(/^\//, '');
  let raw = '';
  req.on('data', (c) => {
    raw += c;
    if (raw.length > 24 * 1024 * 1024) req.destroy();   // sprites arrive as data URLs
  });
  req.on('end', () => {
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch (e) {}
    const cfg = readJson(CFG_FILE, {});
    switch (action) {
      case 'ping':
        return done(200, { ok: true, pid: process.pid, platform: process.platform });
      /*
       * Let an upgrade retire the running daemon politely. Without this the
       * installer has to hunt the process down and kill it from the outside,
       * which risks matching something unrelated. Reply first, exit on the
       * next tick, or the caller gets a dropped connection instead of an ack.
       */
      case 'shutdown':
        stopDesktopPet();
        done(200, { ok: true, pid: process.pid });
        setTimeout(bye, 50);
        return;
      case 'escape':
      case 'launch': {
        // Tell the pet which pokemon it should become, then start the script.
        try { fs.unlinkSync(PET_CMD_FILE); } catch (e) {}   // no stale command replay
        /*
         * Resolve the sprite HERE and hand over an absolute path. Letting the
         * pet script guess means two path conventions have to stay in sync
         * (petHome/gif for pokemon vs runDir/mypets for photo pets), and a miss
         * produces a transparent window that looks exactly like a crash.
         */
        const resolved = spriteFor(payload.no || payload.id || '');
        if (!resolved) {
          log('escape: cannot resolve sprite for "' + (payload.no || payload.id) + '"');
          return done(200, { ok: false, error: 'sprite-not-found' });
        }
        startDesktopPet(payload, cfg, resolved)
          .then((ok) => done(200, ok ? { ok: true, handed: true }
                                     : { ok: false, error: 'pet-did-not-start' }))
          .catch((e) => done(200, { ok: false, error: e.message }));
        return;
      }
      case 'petcmd':
        return done(200, { ok: writePetCmd(payload) });
      case 'stopdesktop':
        stopDesktopPet();
        return done(200, { ok: true });
      case 'recallapp':
        recallIntoApp().then((ok) => done(200, { ok }))
          .catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'recall': {
        // Drop any pending handoff so a later manual launch starts normally.
        try { fs.unlinkSync(HANDOFF_FILE); } catch (e) {}
        stopDesktopPet();
        return done(200, { ok: true });
      }
      case 'addpet':
        pickPhoto(payload).then((r) => done(200, r)).catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'savepet':
        savePet(payload).then((r) => done(200, r)).catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'renamepet':
        renamePet(payload).then((r) => done(200, r)).catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'delpet':
        delPet(payload).then((r) => done(200, r)).catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'opensettings':
      case 'opentab':
        openInApp(payload.tab || 'set', payload.from).then((ok) => done(200, { ok }))
          .catch((e) => done(200, { ok: false, error: e.message }));
        return;
      case 'desktopstatus':
        return done(200, { ok: true, available: desktopAvailable(), running: petRunning(),
                           // whatever actually gets launched on this platform
                           target: P.IS_MAC ? petApp() : petScript() });
      /*
       * Download one of the optional HD sprite sets. Only the two known names
       * are accepted, so a crafted request cannot steer the fetcher outside its
       * own directories. This takes minutes and the reply waits for all of it:
       * the page keeps the current style until we confirm, because switching to
       * a half-downloaded set just shows broken sprites.
       */
      case 'fetchstyle': {
        const style = String((payload && payload.style) || '');
        if (style !== 'home' && style !== 'artwork') {
          return done(200, { ok: false, error: 'unknown style' });
        }
        const home = cfg.petHome || '';
        if (!home) return done(200, { ok: false, error: 'no pet home' });
        if (styleJob.running) {
          return done(200, { ok: true, started: false, running: true, style: styleJob.style });
        }
        /*
         * Answer immediately rather than holding the response for the whole
         * download. This used to reply only when the child process exited, so the
         * page sat on a single fetch for up to 30 minutes with no way to show
         * progress — indistinguishable from "clicking did nothing". The page now
         * polls /stylestatus while this runs.
         */
        log('fetching sprite style: ' + style);
        styleJob = { running: true, style: style, error: '' };
        const rt = selfRuntime();
        execFile(rt.exec, [path.join(__dirname, 'fetch-assets.js'),
                           '--pet-home', home, '--only', style, '--quiet'],
          { env: rt.env, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
          (err) => {
            const n = styleCount(home, style);
            styleJob = { running: false, style: style, error: err ? err.message : '' };
            log('sprite style ' + style + ': ' + n + ' files, ' +
                (n >= STYLE_READY_MIN ? 'ready' : 'incomplete') +
                (err ? ' (' + err.message + ')' : ''));
          });
        return done(200, { ok: true, started: true, style: style });
      }
      /*
       * Progress for the download started above. Counting files on disk is the
       * honest measure: fetch-assets resumes, so a restarted download reports the
       * work already banked instead of appearing to start from zero.
       */
      case 'stylestatus': {
        const style = String((payload && payload.style) || styleJob.style || '');
        const home = cfg.petHome || '';
        const n = (style && home) ? styleCount(home, style) : 0;
        return done(200, {
          ok: true, style: style, files: n, total: STYLE_TOTAL,
          running: !!styleJob.running && styleJob.style === style,
          ready: n >= STYLE_READY_MIN,
          error: styleJob.style === style ? (styleJob.error || '') : ''
        });
      }
      /* Start the card-face download. Answers at once and the album polls
         /cardstatus, for the same reason fetchstyle does: a 3700-file download
         cannot be held open on one request. */
      case 'fetchcards': {
        const home = cfg.petHome || '';
        if (!home) return done(200, { ok: false, error: 'no pet home' });
        if (cardJob.running) return done(200, { ok: true, started: false, running: true });
        log('fetching card faces');
        cardJob = { running: true, error: '' };
        const rtc = selfRuntime();
        execFile(rtc.exec, [path.join(__dirname, 'fetch-assets.js'),
                            '--pet-home', home, '--only', 'cards', '--quiet'],
          { env: rtc.env, timeout: 60 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
          (err) => {
            const n = cardCount(home);
            cardJob = { running: false, error: err ? err.message : '' };
            log('card faces: ' + n + ' files' + (err ? ' (' + err.message + ')' : ''));
            if (n > 0) runInject();          // re-inject so the album sees them
          });
        return done(200, { ok: true, started: true });
      }
      case 'cardstatus': {
        const home = cfg.petHome || '';
        return done(200, { ok: true, files: home ? cardCount(home) : 0,
                           running: !!cardJob.running, error: cardJob.error || '' });
      }
      /* Backgrounds + avatars + pack covers — the "pretty stuff". Same shape as
         fetchcards: reply at once so a 5-minute download does not sit on one
         request, page polls /extrasstatus. */
      case 'fetchextras': {
        const home = cfg.petHome || '';
        if (!home) return done(200, { ok: false, error: 'no pet home' });
        if (extrasJob.running) return done(200, { ok: true, started: false, running: true });
        log('fetching extras (bg + avatar + packs)');
        extrasJob = { running: true, error: '' };
        const rtx = selfRuntime();
        execFile(rtx.exec, [path.join(__dirname, 'fetch-assets.js'),
                            '--pet-home', home, '--only', 'extras', '--quiet'],
          { env: rtx.env, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
          (err) => {
            const n = extrasCount(home);
            extrasJob = { running: false, error: err ? err.message : '' };
            log('extras: ' + n + ' files' + (err ? ' (' + err.message + ')' : ''));
            if (n > 0) runInject();      // re-inject so bg/avatar/pack tabs see the new files
          });
        return done(200, { ok: true, started: true });
      }
      case 'extrasstatus': {
        const home = cfg.petHome || '';
        return done(200, { ok: true, files: home ? extrasCount(home) : 0,
                           total: EXTRAS_TOTAL,
                           running: !!extrasJob.running, error: extrasJob.error || '' });
      }
      case 'reinject':
        runInject();
        return done(200, { ok: true });
      /*
       * Relay one reminder line into the page. Deliberately generic: any local
       * program can be the source (a scheduled DingTalk read, a build script,
       * a long backup finishing). The listener is bound to 127.0.0.1 only.
       */
      /*
       * Growth data shared across every host and across updates. `get` is used at
       * boot to top up whatever that host has locally; `save` merges (affection by
       * max) so two open workspaces cannot clobber each other.
       */
      case 'state':
        if (payload && payload.op === 'save') return done(200, { ok: true, state: mergeState(payload.state) });
        return done(200, { ok: true, state: readState() });
      case 'notify':
        pushNotice(payload).then((r) => done(200, r))
          .catch((e) => done(200, { ok: false, error: e.message }));
        return;
      default:
        return done(404, { ok: false, error: 'unknown action: ' + action });
    }
  });
});

server.on('error', (e) => log('server error: ' + e.message));

// Same port as the http bridge: a strict-CSP host opens ws://127.0.0.1:<port>
// (its CSP allows ws:) and streams sprites / relays bridge calls over it.
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { try { socket.destroy(); } catch (e) {} return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  wsHandleConnection(socket);
});

watchRecallFlag();

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  myPort = port;                       // so bye() can tell if the port file is still ours
  fs.writeFileSync(PORT_FILE, String(port));
  log(`bridge listening on 127.0.0.1:${port} (${process.platform})`);

  /* Backfill extras (bg + avatar + packs) if the install was the new lightweight
     essentials-only one. The daemon starts them silently right after listening;
     failure is not fatal — the user can retry from the picker. Runs once per
     daemon boot. Cards are user-initiated and unchanged. */
  try {
    const bootCfg = readJson(CFG_FILE, {});
    const home = bootCfg.petHome || '';
    if (home && extrasCount(home) < EXTRAS_TOTAL * 0.9 && !extrasJob.running) {
      log('extras look incomplete (' + extrasCount(home) + '/' + EXTRAS_TOTAL +
          '); starting background fetch');
      extrasJob = { running: true, error: '' };
      const rtx = selfRuntime();
      execFile(rtx.exec, [path.join(__dirname, 'fetch-assets.js'),
                          '--pet-home', home, '--only', 'extras', '--quiet'],
        { env: rtx.env, timeout: 30 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 },
        (err) => {
          const n = extrasCount(home);
          extrasJob = { running: false, error: err ? err.message : '' };
          log('extras: ' + n + '/' + EXTRAS_TOTAL + ' files' + (err ? ' (' + err.message + ')' : ''));
          if (n > 0) runInject();
        });
    }
  } catch (e) { log('extras kickoff failed: ' + e.message); }

  /*
   * Multi-host: decorate EVERY workspace that is running, not one chosen winner.
   * People keep a chat client and an IDE open side by side and expect the pet in
   * both; pinning one host also meant that opening the other app moved the pet
   * out of the app it was installed for. Per-host state lives in this map, so one
   * host closing, reloading or refusing a connection cannot disturb another.
   */
  const hostState = new Map();   // name -> { port, fails, misses }

  /* Consecutive scans a known host must be absent from before it counts as gone. */
  const HOST_GONE_MISSES = 3;

  /* "Has a pet" is not the same as "has a working pet". This daemon takes a fresh
   * random bridge port on every boot, and a page injected by the previous daemon
   * keeps posting to the old one: the sprite still draws from its cached <img>, so
   * it looks fine while every click silently resolves null. Health therefore means
   * the marker is there AND the page is wired to the bridge that is answering now.
   * Returns { reachable, marker, bridge } — an unreachable page is never treated
   * as an empty one, or the next tick would inject on top of a live pet. */
  async function pageHealth(cdpPort) {
    let s = null;
    try {
      const opened = await openSessionAt(cdpPort);
      s = opened.session;
      const raw = await s.eval(
        '(function(){var c=window.__QW_POKE_CFG__||{};' +
        'return JSON.stringify({m:!!window.__qwPoke,b:String(c.bridge||"")});})()'
      );
      s.close(); s = null;
      const v = JSON.parse(raw);
      return { reachable: true, marker: !!v.m, bridge: v.b || '' };
    } catch (e) {
      if (s) { try { s.close(); } catch (_) {} }
      return { reachable: false, marker: false, bridge: '' };
    }
  }

  const myBridge = () => 'http://127.0.0.1:' + myPort;

  const injectArgsFor = (h) => ['--port', String(h.port), '--host-name', h.name,
    '--host-key', h.key || P.hostKey(h.userDataDir)];

  async function serviceHost(h) {
    const prev = hostState.get(h.key || h.userDataDir);
    const first = !prev;
    if (first) {
      log('host up: ' + h.name + ' (port ' + h.port + (h.ide ? ', strict-CSP IDE' : '') + ')');
      hostState.set(h.key || h.userDataDir, { port: h.port, fails: 0, misses: 0, name: h.name });
    } else if (prev.port !== h.port) {
      log('CDP port changed for ' + h.name + ' -> ' + h.port);
      prev.port = h.port;
      await runInject(injectArgsFor(h));
      return;
    }

    const st = await pageHealth(h.port);
    if (!st.reachable) {
      /* Cannot see the page: say nothing about the pet. Injecting blind here is
       * how a host that was merely busy for one tick ended up with two pets. */
      if (!first) prev.fails++;
      return;
    }
    if (!st.marker) {
      log((first ? 'no runtime in ' : 'runtime missing in ') + h.name + ' -> injecting');
      await runInject(injectArgsFor(h));
    } else if (st.bridge && st.bridge !== myBridge()) {
      log('runtime in ' + h.name + ' still points at ' + st.bridge
        + ' but the bridge is ' + myBridge() + ' -> re-injecting');
      await runInject(injectArgsFor(h));
    } else if (first) {
      log('runtime already present and current in ' + h.name + '; not re-injecting');
    }
    if (!first) prev.fails = 0;

    /* Keep shared growth state converged even while this renderer is backgrounded.
     * Chromium throttles page timers aggressively, so the runtime's own 30s poll
     * can stop firing until focus returns. The daemon watchdog is native and keeps
     * running; ask the page to pull at most once every 10s. */
    const current = hostState.get(h.key || h.userDataDir);
    const now = Date.now();
    if (current && now - (current.lastSyncAt || 0) >= 10000) {
      let syncSession = null;
      try {
        const opened = await openSessionAt(h.port);
        syncSession = opened.session;
        await syncSession.eval(
          '(window.__qwPoke&&window.__qwPoke.sync)?window.__qwPoke.sync():false',
          { awaitPromise: true }
        );
        current.lastSyncAt = now;
      } catch (e) {
        // A busy page can miss one pull; the next watchdog retries.
      } finally {
        if (syncSession) { try { syncSession.close(); } catch (e) {} }
      }
    }
    try { await cleanSecondaryWindows(h.port); } catch (e) {}
  }

  /**
   * Self-healing: auto-updaters sometimes delete LaunchAgent plists that
   * reference the host binary. Every tick we scan for running Electron hosts
   * whose arm-agent plist is missing and recreate + bootstrap it, so the
   * next normal exit is still caught.
   */
  function ensureArmAgents() {
    if (!P.IS_MAC) return;
    // Only maintain the arm agent for the host the skill was installed from.
    // This prevents the daemon from creating arm agents for every running
    // Electron app (Qoder, AliLang, etc.) that the user never installed into.
    let installedFrom = '';
    try { installedFrom = fs.readFileSync(path.join(RUN_DIR, 'host'), 'utf-8').trim(); } catch (e) { return; }
    if (!installedFrom) return;
    const root = P.userDataRoot();
    const dir = path.join(root, installedFrom);
    const lockFile = path.join(dir, 'SingletonLock');
    let target;
    try { target = fs.readlinkSync(lockFile); } catch (e) { return; }
    const pid = parseInt(String(target).split('-').pop(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return;
    try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return; }
    let exe = '';
    try {
      const out = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 4000 });
      const m = out.match(/^(\/[^\s]*\.app\/Contents\/MacOS\/[^\s]+)/);
      if (m) exe = m[1];
    } catch (e) { return; }
    if (!exe || !fs.existsSync(exe)) return;
    const hash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 12);
    const label = 'com.pokepet.host-cdp.' + hash;
    const plistPath = path.join(HOME, 'Library', 'LaunchAgents', label + '.plist');
    if (fs.existsSync(plistPath)) return;
    const armScript = path.join(RUN_DIR, 'bin', 'host-arm.js');
    if (!fs.existsSync(armScript)) return;
    const armLog = path.join(RUN_DIR, 'host-cdp-' + hash + '.log');
    const armOut = path.join(RUN_DIR, 'host-cdp-' + hash + '.out');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const plist =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict>\n' +
      '  <key>Label</key><string>' + esc(label) + '</string>\n' +
      '  <key>ProgramArguments</key><array><string>' + esc(exe) + '</string><string>' + esc(armScript) + '</string></array>\n' +
      '  <key>EnvironmentVariables</key><dict>\n' +
      '    <key>POKEPET_ARM_APP_BIN</key><string>' + esc(exe) + '</string>\n' +
      '    <key>POKEPET_ARM_USER_DATA</key><string>' + esc(dir) + '</string>\n' +
      '    <key>POKEPET_ARM_LOG</key><string>' + esc(armLog) + '</string>\n' +
      '    <key>ELECTRON_RUN_AS_NODE</key><string>1</string>\n' +
      '  </dict>\n' +
      '  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n' +
      '  <key>StandardOutPath</key><string>' + esc(armOut) + '</string>\n' +
      '  <key>StandardErrorPath</key><string>' + esc(armOut) + '</string>\n' +
      '</dict></plist>\n';
    try {
      fs.writeFileSync(plistPath, plist);
      try {
        execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), plistPath], { timeout: 4000, stdio: 'pipe' });
      } catch (e) {
        try { execFileSync('launchctl', ['load', plistPath], { timeout: 4000, stdio: 'pipe' }); }
        catch (e2) { log('failed to bootstrap restored arm agent for ' + installedFrom + ': ' + (e2.message || e2)); }
      }
      log('restored arm agent for ' + installedFrom + ' (pid ' + pid + ')');
    } catch (e) {
      log('failed to write arm plist for ' + installedFrom + ': ' + (e.message || e));
    }
  }

  async function tick() {
    let hosts = [];
    try { hosts = P.detectHosts(); } catch (e) { hosts = []; }
    /* Serve the app the user installed FROM first. install.sh can see that app in
       its own process tree and records the name, and on a fresh install it is the
       window the user is actually staring at — it should not wait behind another
       workspace. */
    let installedFrom = '';
    try { installedFrom = fs.readFileSync(path.join(RUN_DIR, 'host'), 'utf-8').trim(); } catch (e) {}
    if (installedFrom) {
      hosts.sort((a, b) => (b.name === installedFrom ? 1 : 0) - (a.name === installedFrom ? 1 : 0));
    }
    /* Forget hosts that went away, so coming back re-injects instead of idling —
     * but only after several consecutive misses. A single scan can miss a live
     * host (a busy machine, a slow probe), and a forget/re-add pair costs a whole
     * extra pet, so absence has to be sustained before it counts. */
    const seen = new Set(hosts.map((h) => h.key || h.userDataDir));
    for (const [key, st] of Array.from(hostState.entries())) {
      if (seen.has(key)) { st.misses = 0; continue; }
      st.misses = (st.misses || 0) + 1;
      if (st.misses >= HOST_GONE_MISSES) {
        hostState.delete(key);
        log('host gone: ' + (st.name || key));
      }
    }
    for (const h of hosts) {
      try { await serviceHost(h); } catch (e) { /* one bad host must not stop the rest */ }
    }
    if (!hosts.length) {
      // Nothing enumerable (unreadable userData dir, no port file): fall back to
      // the legacy single-host path so such a client still gets a pet.
      let s = null;
      try {
        const opened = await openSession({ retries: 1, waitMs: 0 });
        s = opened.session;
        const alive = await s.eval('!!window.__qwPoke');
        s.close(); s = null;
        if (!alive) await runInject();
      } catch (e) { if (s) { try { s.close(); } catch (_) {} } }
    }
    ensureArmAgents();
  }

  /* A tick can outlive its 5s slot: an injection takes 7-9s, and two ticks running
   * at once inject the same page twice. Skip rather than queue — the next slot is
   * five seconds away and the work is idempotent. */
  let ticking = false;
  const safeTick = async () => {
    if (ticking) return;
    ticking = true;
    try { await tick(); } catch (e) { log('tick failed: ' + e.message); } finally { ticking = false; }
  };

  await safeTick();
  setInterval(safeTick, 5000);

  /* A host that starts without a debugging port is handled by its generic
   * startup agent. The daemon never closes a workbench; the agent waits for the
   * user to exit normally and then reopens that same host with the flag. */
});

/*
 * Strip the skin out of windows it has no business being in.
 *
 * The host's document preview, voice overlay and quick pick are all served from
 * file:// exactly like the main window, so an older build's target picker could
 * land an injection in one of them. A board painted inside the document preview
 * sits directly over the text and makes it unreadable, and such a window never
 * cleans itself up — so sweep for it. findTarget now avoids them, this handles
 * the ones already poisoned.
 */
async function cleanSecondaryWindows(port) {
  const TEARDOWN =
    "(function(){var had=!!document.getElementById('qwpoke-bg')||!!window.__qwPoke;" +
    "if(!had)return 0;" +
    "try{if(window.__qwPoke&&window.__qwPoke.destroy)window.__qwPoke.destroy();}catch(e){}" +
    "['qwpoke-bg','qwpoke-layer','qwpoke-btn','qwpoke-picker','qwpoke-style']" +
    ".forEach(function(id){var e=document.getElementById(id);if(e)e.remove();});return 1;})()";
  try {
    const list = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let b = ''; res.on('data', (c) => (b += c));
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    for (const t of list) {
      if (t.type !== 'page' || !t.webSocketDebuggerUrl) continue;
      if (!/^(Preview|Voice Input|QuickPick)$/i.test(t.title || '')) continue;
      const sess = new CdpSession(t.webSocketDebuggerUrl);
      try {
        await sess.connect();
        if (await sess.eval(TEARDOWN)) log('removed skin from "' + t.title + '" window');
      } catch (e) { /* window may be closing */ }
      finally { try { sess.close(); } catch (e) {} }
    }
  } catch (e) { /* never let housekeeping break the watchdog */ }
}

/*
 * Only clear the port file if it is still ours. Several daemons can overlap
 * during an upgrade, and an older one exiting used to delete the port of the
 * daemon that is actually serving — the page then finds no bridge and every
 * button quietly stops working.
 */
const bye = () => {
  try {
    if (fs.readFileSync(PORT_FILE, 'utf8').trim() === String(myPort)) fs.unlinkSync(PORT_FILE);
  } catch (e) {}
  process.exit(0);
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
