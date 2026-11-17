#!/usr/bin/env node
'use strict';
/**
 * Pokemon Pet for the host app — injector.
 *
 * Usage:
 *   node inject.js               inject / refresh
 *   node inject.js --remove      remove skin from the page
 *   node inject.js --status      print what's currently live
 *
 * Runs on Node 18+ OR on the host app's own Electron via ELECTRON_RUN_AS_NODE=1
 * (no external deps, no Node >= 21 requirement).
 */

const fs = require('fs');
const path = require('path');
const { openSession, openSessionAt } = require('./cdp.js');
const P = require('./platform.js');

// NOTE: os.homedir() first, not process.env.HOME — Git Bash / MSYS2 set HOME to a
// POSIX-style path on Windows, which would point at a different RUN_DIR than the
// daemon uses (it writes bridge.port under os.homedir()).
const HOME = require('os').homedir();
const RUN_DIR = path.join(HOME, '.pokepet');
const CFG_FILE = path.join(RUN_DIR, 'config.json');
const PORT_FILE = path.join(RUN_DIR, 'bridge.port');
const THUMB_DIR = path.join(RUN_DIR, 'thumbs');

// --port <n>: inject into a SPECIFIC host's debug port. The multi-host daemon
// passes this so every reachable workspace gets its own injection; without it we
// fall back to the single auto-detected host (manual runs, older callers).
function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '';
}
const TARGET_PORT = parseInt(argValue('--port'), 10) || 0;
const TARGET_HOST_NAME = argValue('--host-name').trim();
const TARGET_HOST_KEY = argValue('--host-key').trim();

const REMOVE = process.argv.includes('--remove');
const STATUS = process.argv.includes('--status');

function log(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`[${ts}] [PokePet] ${msg}`);
}

function readJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return dflt; }
}

/** Official Chinese names for the pokeballs, so the picker isn't full of English ids. */
const BALL_ZH = {
  'poke-ball': '精灵球',      'great-ball': '超级球',   'ultra-ball': '高级球',
  'master-ball': '大师球',    'safari-ball': '狩猎球',  'net-ball': '捕网球',
  'dive-ball': '潜水球',      'nest-ball': '巢穴球',    'repeat-ball': '重复球',
  'timer-ball': '计时球',     'luxury-ball': '豪华球',  'premier-ball': '纪念球',
  'dusk-ball': '黑暗球',      'heal-ball': '治愈球',    'quick-ball': '先机球',
  'cherish-ball': '贵重球',   'fast-ball': '速度球',    'level-ball': '等级球',
  'lure-ball': '诱饵球',      'heavy-ball': '沉重球',   'love-ball': '甜蜜球',
  'friend-ball': '友友球',    'moon-ball': '月亮球',    'sport-ball': '竞赛球',
  'park-ball': '公园球',      'dream-ball': '梦境球',   'beast-ball': '究极球',
  /* Legends: Arceus (Hisui) 旧式木球 —— 造型与配色和现代球差异很大，
     所以单独一组，便于一眼分辨 */
  'lapoke-ball': '精灵球（洗翠）',  'lagreat-ball': '超级球（洗翠）',  'laultra-ball': '高级球（洗翠）',
  'laheavy-ball': '沉重球（洗翠）',  'lafeather-ball': '飞羽球（洗翠）',  'lawing-ball': '飞翼球（洗翠）',
  'lajet-ball': '飞梭球（洗翠）',  'laleaden-ball': '超重球（洗翠）',  'lagigaton-ball': '巨重球（洗翠）',
  'laorigin-ball': '起源球（洗翠）',  'lastrange-ball': '奇异球（洗翠）'
};

/** Locate the desktop-pet asset home (needs gif/ + backgrounds). */
function resolvePetHome(cfg) {
  const candidates = [];
  if (cfg.petHome) candidates.push(cfg.petHome);
  if (process.env.POKEPET_HOME) candidates.push(process.env.POKEPET_HOME);
  candidates.push(path.join(RUN_DIR, 'petapp'));       // where fetch-assets.js puts them
  candidates.push(path.join(__dirname, 'petapp'));     // bundled next to the scripts
  for (const c of candidates) {
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'gif'))) return c;
  }
  // shallow scan of workspace for a desktop_pet dir
  const ws = path.join(HOME, '.pokepet', 'workspace');
  try {
    for (const d of fs.readdirSync(ws)) {
      const guess = path.join(ws, d, 'outputs', 'desktop_pet');
      if (fs.existsSync(path.join(guess, 'gif'))) return guess;
    }
  } catch (e) {}
  return null;
}

function buildManifest(petHome) {
  const bgList = [];
  const bgJson = readJson(path.join(petHome, 'backgrounds.json'), []);
  const bgDir = path.join(petHome, 'backgrounds_tcgp');
  const seen = new Set();
  if (Array.isArray(bgJson) && fs.existsSync(bgDir)) {
    for (const b of bgJson) {
      if (!b || !b.file) continue;
      const abs = path.join(bgDir, b.file);
      if (!fs.existsSync(abs) || seen.has(abs)) continue;
      seen.add(abs);
      // thumbnails now ship from the CDN into petHome/thumbs (works on Windows
      // where local generation is blocked); fall back to the old RUN_DIR/thumbs
      const thumbNew = path.join(petHome, 'thumbs', b.file);
      const thumbOld = path.join(THUMB_DIR, b.file);
      const thumb = fs.existsSync(thumbNew) ? thumbNew
                  : (fs.existsSync(thumbOld) ? thumbOld : null);
      bgList.push({
        file: abs,
        thumb: thumb,
        label: b.label || '',
        type: b.type || ''
      });
    }
  }

  const names = readJson(path.join(petHome, 'names.json'), {});
  const pokeList = [];
  const femaleGifs = {};
  const trainerList = [];
  const cardList = [];
  const packList = [];
  let cardTotal = 0;
  let cardSets = [];
  const gifDir = path.join(petHome, 'gif');
  if (fs.existsSync(gifDir)) {
    const files = fs.readdirSync(gifDir).filter((f) => /^\d{4}\.gif$/.test(f)).sort();
    for (const f of files) {
      const no = f.slice(0, 4);
      const nm = names[no] || {};
      pokeList.push({ no, file: path.join(gifDir, f), zh: nm.zh || '', en: nm.en || '' });
    }
    /*
     * Mega Evolutions and Primal Reversions. Their files are '<dex>-<suffix>.gif'
     * so the plain 4-digit filter above skips them; they are listed here with the
     * names from forms.json, which is also what marks an id as a form elsewhere.
     * Only forms whose sprite is actually on disk get listed — an entry without an
     * image would render as an invisible pet that still walks around.
     */
    const formMap = (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'forms.json'), null);
        if (m && Object.keys(m).length) return m;
      }
      return {};
    })();
    for (const id of Object.keys(formMap).sort()) {
      const fp = path.join(gifDir, id + '.gif');
      if (!fs.existsSync(fp)) continue;
      const f = formMap[id];
      pokeList.push({ no: id, file: fp, zh: f.zh || '', en: f.en || '', form: f.kind || 'mega' });
    }
    /*
     * Regional forms (Alolan / Galarian / Hisuian / Paldean) and Gigantamax, same
     * rule: only what is actually on disk, so a form whose sprite was never
     * downloaded simply is not offered rather than showing an invisible pet.
     */
    const regionalMap = (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'regional-forms.json'), null);
        if (m && Object.keys(m).length) return m;
      }
      return {};
    })();
    for (const id of Object.keys(regionalMap).sort()) {
      const fp = path.join(gifDir, id + '.gif');
      if (!fs.existsSync(fp)) continue;
      const r = regionalMap[id];
      pokeList.push({ no: id, file: fp, zh: r.zh || '', en: r.en || '', form: r.kind || 'regional' });
    }
    // which female variants were downloaded — the runtime needs this to decide
    // between the local copy and the (slow) remote one
    for (const f of fs.readdirSync(gifDir)) {
      const m = /^(\d{4})-f\.gif$/.exec(f);
      if (m) femaleGifs[m[1]] = 1;
    }

    /* Tera forms — only specific pokemon have a tera crystal form with unique sprites. */
    const teraMap = (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'tera-forms.json'), null);
        if (m && Object.keys(m).length) return m;
      }
      return {};
    })();
    for (const id of Object.keys(teraMap).sort()) {
      const t = teraMap[id];
      if (!t || !t.base) continue;
      // tera form has its own unique sprite (XXXX-tera.png)
      const dex = t.base;
      const teraFile = path.join(gifDir, dex + '-tera.png');
      const teraGif = path.join(gifDir, dex + '-tera.gif');
      const fp = fs.existsSync(teraFile) ? teraFile : fs.existsSync(teraGif) ? teraGif : null;
      if (!fp) continue;  // 没有独立素材就不加入列表
      pokeList.push({ no: id, file: fp, zh: t.zh || '', en: t.en || '', form: 'tera', teraType: t.teraType || '' });
    }

    /* Sort: group all forms of the same base pokemon together.
       Order within a group: base → mega/primal → regional → gmax → tera */
    const FORM_ORDER = { undefined: 0, mega: 1, primal: 1, regional: 2, alola: 2, galar: 2, hisui: 2, paldea: 2, gmax: 3, tera: 4 };
    pokeList.sort(function (a, b) {
      const aBase = a.form ? (formMap[a.no] && formMap[a.no].base) || (regionalMap[a.no] && regionalMap[a.no].base) || (teraMap[a.no] && teraMap[a.no].base) || a.no.replace(/-.*$/, '') : a.no;
      const bBase = b.form ? (formMap[b.no] && formMap[b.no].base) || (regionalMap[b.no] && regionalMap[b.no].base) || (teraMap[b.no] && teraMap[b.no].base) || b.no.replace(/-.*$/, '') : b.no;
      if (aBase !== bBase) return aBase.localeCompare(bBase);
      // same base: base form first, then by form kind
      const aOrd = FORM_ORDER[a.form] || 0;
      const bOrd = FORM_ORDER[b.form] || 0;
      return aOrd - bOrd || a.no.localeCompare(b.no);
    });
  }

  /* Collectibles on disk (the album). The manifest is the catalog; this is what can
     actually be shown, so an album never renders a broken image. */
  const cardDir = path.join(petHome, 'cards');
  if (fs.existsSync(cardDir)) {
    const cman = (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'cards.json'), null);
        if (m && m.items) return m;
      }
      return null;
    })();
    const have = new Set(fs.readdirSync(cardDir));
    for (const it of ((cman && cman.items) || [])) {
      if (!it || !have.has(it.file)) continue;
      /* Carry the metadata through: the album's rarity / type / set filters and the
         "sort by number" order all read these, and the page cannot look them up. */
      cardList.push({ file: it.file, label: it.label || it.file, kind: 'card',
                      set: it.set || '', setZh: it.setZh || '', no: it.no || 0,
                      type: it.type || '', stage: it.stage || '',
                      rarity: it.rarity || '', rarityZh: it.rarityZh || '', tier: it.tier || 0,
                      zh: it.zh || '', lang: it.lang || 'en',
                      path: path.join(cardDir, it.file) });
    }
    // how many the manifest declares, so the album can show download progress
    cardTotal = ((cman && cman.items) || []).length;
    cardSets = (cman && cman.sets) || [];
  }

  /* Pack covers are the opening ritual's artwork, NOT collectibles — the user was
     explicit that they are 素材 and must stay out of the album. */
  const packDir = path.join(petHome, 'packs');
  if (fs.existsSync(packDir)) {
    for (const f of fs.readdirSync(packDir)) {
      if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) continue;
      // pack "_背" images are the plain sleeve back — never a cover candidate
      if (/_?背(?=\.[^.]+$)/.test(f)) continue;
      const label = f.replace(/^TCGP_/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ');
      let set = '';
      // Promo-A / Promo-B 映射到 cards.json 里的 P-A / P-B set id —— 之前只
      // 匹配 A\d/B\d/P-[AB]，"Promo-A" 三个字母开头都吃不到，导致 10 张
      // Promo 封面全部落到 set='' 里，最后被 packCoverFor 兜底成 A1 的封面。
      let m = label.match(/^Promo-([AB])\b/);
      if (m) set = 'P-' + m[1];
      else {
        m = label.match(/^(A\d[a-z]?|B\d[a-z]?|P-[AB])\b/);
        if (m) set = m[1];
      }
      packList.push({ file: f, label, set, path: path.join(packDir, f) });
    }
  }

  /* Trainer portraits: manifest × what is on disk. Same rule as pokemon forms —
     only offer a character whose image is actually downloaded. */
  const trainerDir = path.join(petHome, 'trainers');
  if (fs.existsSync(trainerDir)) {
    const tman = (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'trainers.json'), null);
        if (m && Object.keys(m).length) return m;
      }
      return {};
    })();
    for (const id of Object.keys(tman)) {
      const t = tman[id];
      if (!t || !t.styles) continue;
      const files = {};
      for (const style of Object.keys(t.styles)) {
        const fp = path.join(trainerDir, t.styles[style] + '.png');
        if (fs.existsSync(fp)) files[style] = fp;
      }
      if (Object.keys(files).length) {
        trainerList.push({ id, zh: t.zh || id, role: t.role || '', files });
      }
    }
  }

  // Feeding items: foods.json supplies display names, food/<id>.png the icons.
  const foodList = [];
  const foodDir = path.join(petHome, 'food');
  const foodJson = readJson(path.join(petHome, 'foods.json'), []);
  if (Array.isArray(foodJson) && fs.existsSync(foodDir)) {
    for (const f of foodJson) {
      if (!f || !f.id) continue;
      const abs = path.join(foodDir, f.id + '.png');
      if (!fs.existsSync(abs)) continue;
      foodList.push({ id: f.id, zh: f.zh || f.id, file: abs });
    }
  }

  // Pokeballs — used for the launcher icon.
  const ballList = [];
  const ballDir = path.join(petHome, 'balls');
  if (fs.existsSync(ballDir)) {
    for (const f of fs.readdirSync(ballDir).filter((x) => x.endsWith('.png')).sort()) {
      const id = f.replace(/\.png$/, '');
      ballList.push({ id, zh: BALL_ZH[id] || id, file: path.join(ballDir, f) });
    }
  }

  // TCGP avatars (types: 头像 / 勋章 / 宝可梦币) — can replace the host app's own avatar.
  const avatarList = [];
  const avDir = path.join(petHome, 'avatars_tcgp');
  const avJson = readJson(path.join(petHome, 'avatars.json'), []);
  if (Array.isArray(avJson) && fs.existsSync(avDir)) {
    for (const a of avJson) {
      if (!a || !a.file) continue;
      const abs = path.join(avDir, a.file);
      if (!fs.existsSync(abs)) continue;
      avatarList.push({ file: abs, label: a.label || '', type: a.type || '头像' });
    }
  }

  // TCGP battle particles. Keyed by shape so the picker offers one entry per shape.
  const fxList = [];
  const fxDir = path.join(petHome, 'effects_tcgp');
  const fxJson = readJson(path.join(petHome, 'effects.json'), []);
  if (Array.isArray(fxJson) && fs.existsSync(fxDir)) {
    for (const f of fxJson) {
      if (!f || !f.file) continue;
      const abs = path.join(fxDir, f.file);
      if (!fs.existsSync(abs)) continue;
      fxList.push({ file: abs, shape: f.shape || '', label: f.label || '' });
    }
  }

  // pokedex number -> showdown slug, needed for shiny sprites.
  const slugs = readJson(path.join(petHome, 'slug.json'), {}) || {};

  // Custom pets built from the user's own photos.
  const myList = [];
  const myIndex = readJson(path.join(RUN_DIR, 'mypets', 'index.json'), []);
  if (Array.isArray(myIndex)) {
    for (const m of myIndex) {
      if (m && m.id && m.file && fs.existsSync(m.file)) {
        myList.push({ id: m.id, name: m.name || '我的宠物', file: m.file });
      }
    }
  }

  return { bgList, pokeList, foodList, ballList, myList, avatarList, fxList, slugs, femaleGifs, trainerList, cardList, packList, cardTotal, cardSets };
}

async function main() {
  const cfg = readJson(CFG_FILE, {});

  const { session: s, target } = TARGET_PORT ? await openSessionAt(TARGET_PORT) : await openSession();

  if (STATUS) {
    const st = await s.eval(
      `(function(){ if(!window.__qwPoke) return 'not injected';
         var S = window.__qwPoke.settings();
         return JSON.stringify({counts: window.__qwPoke.counts, bgFile: S.bgFile, petNo: S.petNo,
           petEnabled: S.petEnabled, bgScope: S.bgScope, bgOpacity: S.bgOpacity}); })()`
    );
    log('status: ' + st);
    s.close();
    return;
  }

  if (REMOVE) {
    const r = await s.eval(
      `(function(){ if(window.__qwPoke){ window.__qwPoke.destroy(); return 'removed'; } return 'nothing to remove'; })()`
    );
    log('remove: ' + r);
    s.close();
    return;
  }

  const petHome = resolvePetHome(cfg);
  if (!petHome) {
    log('ERROR: could not locate desktop-pet assets (need a folder containing gif/).');
    log('       Set it explicitly:  POKEPET_HOME=/path/to/desktop_pet node inject.js');
    s.close();
    process.exit(2);
  }
  log('petHome: ' + petHome);

  const { bgList, pokeList, foodList, ballList, myList, avatarList, fxList, slugs, femaleGifs, trainerList, cardList, packList, cardTotal, cardSets } = buildManifest(petHome);
  log(`manifest: ${bgList.length} bg, ${pokeList.length} poke, ${foodList.length} food, ` +
      `${ballList.length} balls, ${avatarList.length} avatars, ${fxList.length} fx, ${myList.length} my-pets`);
  if (!pokeList.length) log('WARN: no pokemon gifs found; the pet will not show.');

  let bridge = '';
  let bridgePort = 0;
  try {
    const p = parseInt(fs.readFileSync(PORT_FILE, 'utf-8').trim(), 10);
    if (p > 0) { bridgePort = p; bridge = 'http://127.0.0.1:' + p; }
  } catch (e) {}
  log('bridge: ' + (bridge || '(none — desktop escape disabled)'));

  /*
   * Which asset transport works in THIS host? Probe by actually exercising each
   * one — never guess from the product name, since any client may or may not
   * register the custom scheme.
   *  - 'local': the host registered our `local-file://` scheme and lets it
   *    through CSP. Fast, synchronous <img src>.
   *  - 'http': CSP allows `img-src http:` and `frame-src http://127.0.0.1:*` but
   *    not ws:// or fetch() to 127.0.0.1 (measured in a strict code-workbench
   *    renderer using `default-src 'self'` with no connect-src). Sprites come from the
   *    daemon's /asset endpoint; bridge calls ride a hidden /relay iframe.
   *  - 'ws': CSP is `img-src 'self' data: blob: https:` + `connect-src 'self'
   *    https: ws:`. local-file, file:// and the http bridge all fail; only
   *    ws:// + blob: get through, so the runtime streams sprite bytes over the
   *    daemon's WebSocket.
   * ws must be probed with a real socket: an Image probe cannot tell a
   * connect-src denial from an img-src denial, and mistaking one for the other
   * is what leaves the UI present with every sprite blank.
   */
  let transport = 'local';
  const wsUrl = bridgePort ? 'ws://127.0.0.1:' + bridgePort : '';
  try {
    const probeSprite = (pokeList[0] && pokeList[0].file) || path.join(petHome, 'gif', '0025.gif');
    let u = String(probeSprite).replace(/\\/g, '/');
    if (u.charAt(0) !== '/') u = '/' + u;

    const imgLoads = (src) => s.eval(
      'new Promise(function(res){var i=new Image();i.onload=function(){res(true);};' +
      'i.onerror=function(){res(false);};i.src=' + JSON.stringify(src) + ';' +
      'setTimeout(function(){res(false);},2500);})',
      { awaitPromise: true }
    );

    if (!(await imgLoads('local-file://' + u))) {
      const httpOk = bridge
        ? await imgLoads(bridge + '/asset?path=' + encodeURIComponent(u))
        : false;
      if (httpOk) transport = 'http';
      else if (wsUrl) {
        const wsOk = await s.eval(
          'new Promise(function(res){var done=function(v){if(!done.d){done.d=true;res(v);}};' +
          'try{var w=new WebSocket(' + JSON.stringify(wsUrl) + ');' +
          'w.onopen=function(){try{w.close();}catch(e){}done(true);};' +
          'w.onerror=function(){done(false);};}catch(e){done(false);}' +
          'setTimeout(function(){done(false);},2500);})',
          { awaitPromise: true }
        );
        if (wsOk) transport = 'ws';
      }
    }
  } catch (e) { /* keep 'local'; the runtime still degrades gracefully */ }
  log('transport: ' + (transport === 'ws' ? 'ws ' + wsUrl + ' (strict CSP host)'
    : transport === 'http' ? 'http ' + bridge + '/asset (no-connect-src host)'
    : 'local-file://'));


  // Push config+manifest first (separate eval keeps the payload out of the runtime source).
  const payload = {
    petHome,
    /*
     * Which HD sprite styles are downloaded. The page cannot look at the disk,
     * and offering a style whose images are missing would just show broken
     * sprites. A partially finished download leaves a half-full directory, so
     * require a decent count rather than mere existence.
     */
    hdStyles: (function () {
      const out = {};
      for (const style of ['home', 'artwork']) {
        try {
          const dir = path.join(petHome, style);
          out[style] = fs.existsSync(dir) && fs.readdirSync(dir).length >= 900;
        } catch (e) { out[style] = false; }
      }
      return out;
    })(),
    // Can a desktop pet actually be launched here? Drives whether the UI offers
    // "jump to desktop" at all, so a missing one can no longer swallow a pokemon.
    desktopReady: (function () {
      try {
        /*
         * macOS: no. Any pet app we ship or build on the spot carries only an
         * ad-hoc signature — Gatekeeper reports it as rejected and endpoint
         * security kills it (measured: exit 137, SIGKILL, on a bundle that had
         * launched fine an hour earlier). Notarising would need an Apple
         * Developer ID, which a skill package cannot carry.
         * Advertising the entry anyway is the worst option: the bridge waits for
         * the pet to really appear before answering, so the user would watch
         * their pokemon grey out for 30s and then be told it failed.
         * The way forward is a window owned by the host (which IS notarised) —
         * see HANDOFF_desktop_pet.md — until then this stays off.
         */
        if (P.IS_MAC) return false;
        // Windows: restricted PowerShell (WDAC/__PSLockdownPolicy) can't load
        // WinForms, so the pet window never renders — install.ps1 leaves a flag
        if (fs.existsSync(path.join(RUN_DIR, 'desktop-blocked.flag'))) return false;
        // Windows has no such gate: PowerShell draws the window itself.
        return [__dirname, path.join(RUN_DIR, 'bin')]
          .some((d) => fs.existsSync(path.join(d, 'desktop-pet.ps1')));
      } catch (e) { return false; }
    })(),
    hostName: TARGET_HOST_NAME || P.hostName(),
    hostKey: TARGET_HOST_KEY || (function () {
      const h = P.detectHost();
      return h && h.userDataDir ? P.hostKey(h.userDataDir) : 'default';
    })(),
    /*
     * Why desktop mode is off, in the user's words, plus what (if anything) they
     * can do about it. Without this the window said "you haven't installed the
     * desktop pet program", which on macOS is simply untrue and sent people
     * looking for a download that would not have helped. Each reason carries its
     * own honest next step — including "nothing you can do here", which is a
     * better answer than a false lead.
     */
    desktopReason: (function () {
      try {
        if (P.IS_MAC) return 'mac-notarize';
        if (fs.existsSync(path.join(RUN_DIR, 'desktop-blocked.flag'))) return 'win-lockdown';
        const hasScript = [__dirname, path.join(RUN_DIR, 'bin')]
          .some((d) => fs.existsSync(path.join(d, 'desktop-pet.ps1')));
        return hasScript ? '' : 'missing-script';
      } catch (e) { return 'unknown'; }
    })(),
    desktopNote: P.IS_MAC
      ? 'macOS 不支持把宠物放到桌面：桌面窗口必须由经过 Apple 公证的程序来开，' +
        '而技能包里带的程序只有临时签名，系统会直接把它杀掉。这不是你的设置问题，' +
        '也没有能自己打开的开关——宠物留在窗口里同样能拖动、投喂、换背景板。'
      : '',
    // Version + changelog so the pet itself can announce what changed. Ships with
    // the package; updateFeed is empty by default (no network unless configured).
    skillInfo: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const v = readJson(path.join(dir, 'version.json'), null);
        if (v && v.version) return v;
      }
      return null;
    })(),          // UI copy adapts to whichever client this is
    assetScheme: 'local-file://',
    // Asset transport for this host (probed above). A 'ws' host also gets wsUrl,
    // over which the runtime streams assets and relays bridge calls, because its
    // CSP blocks both local-file:// images and http bridge fetches.
    transport,
    wsUrl,
    /*
     * Evolution graph keyed by pokedex number: { stage, next:[ids], from }.
     * `next` holds DIRECT successors only, as an array. The tempting shape — one
     * flat `chain:[a,b,c]` per species plus "next = chain[indexOf(me)+1]" — quietly
     * mis-evolves every branching family: Vaporeon would "evolve" into Jolteon and
     * Gardevoir into Gallade. Built by build-evolutions.js from PokeAPI; a missing
     * file simply disables evolution instead of guessing.
     */
    /* Mega / Primal form table: id -> { base, slug, api, kind, zh, en, hd }.
       The page needs `base` to know what a form reverts to, and the names because
       these ids are not in names.json. */
    forms: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const m = readJson(path.join(dir, 'forms.json'), null);
        if (m && Object.keys(m).length) return m;
      }
      return {};
    })(),
    evolutions: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const e = readJson(path.join(dir, 'evolutions.json'), null);
        if (e && Object.keys(e).length) return e;
      }
      return {};
    })(),
    // 4.4: new manifest data — types + sizes, genders, regional/gmax forms, stones, cards
    typesData: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'types.json'), null);
        if (d && Object.keys(d).length > 900) return d;
      }
      return {};
    })(),
    gendersData: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'genders.json'), null);
        if (d && Object.keys(d).length > 900) return d;
      }
      return {};
    })(),
    regionalForms: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'regional-forms.json'), null);
        if (d && Object.keys(d).length) return d;
      }
      return {};
    })(),
    stonesData: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'stones.json'), null);
        if (d && Object.keys(d).length) return d;
      }
      return {};
    })(),
    cardsManifest: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'cards.json'), null);
        if (d && d.sets) return d;
      }
      return { sets: [], total: 0 };
    })(),
    /* 太晶化图标：19 种属性皇冠 */
    teraIcons: (function () {
      const teraDir = path.join(petHome, 'tera');
      const map = {};
      const TERA_TYPES = {
        '一般': 'normal', '火': 'fire', '水': 'water', '电': 'electric',
        '草': 'grass', '冰': 'ice', '格斗': 'fighting', '毒': 'poison',
        '地面': 'ground', '飞行': 'flying', '超能力': 'psychic', '虫': 'bug',
        '岩石': 'rock', '幽灵': 'ghost', '龙': 'dragon', '恶': 'dark',
        '钢': 'steel', '妖精': 'fairy', '星晶': 'stellar'
      };
      try {
        if (fs.existsSync(teraDir)) {
          for (const [zh, en] of Object.entries(TERA_TYPES)) {
            const f = path.join(teraDir, '太晶_' + zh + '_icon.png');
            if (fs.existsSync(f)) map[en] = f;
          }
        }
      } catch (e) {}
      return map;
    })(),
    /* 太晶化形态列表：哪些宝可梦可以太晶化 */
    teraForms: (function () {
      for (const dir of [path.join(__dirname, 'manifests'), petHome, RUN_DIR]) {
        const d = readJson(path.join(dir, 'tera-forms.json'), null);
        if (d && Object.keys(d).length) return d;
      }
      return {};
    })(),
    bridge,
    bgList,
    pokeList,
    foodList,
    ballList,
    myList,
    avatarList,
    fxList,
    slugs,
    femaleGifs,
    trainerList,
    cardList,
    packList,
    cardTotal,
    cardSets,
    myIndex: path.join(RUN_DIR, 'mypets', 'index.json'),
    myPending: path.join(RUN_DIR, 'mypets', 'pending.json')
  };
  const pushed = await s.eval(
    `window.__QW_POKE_CFG__ = ${JSON.stringify(payload)}; 'cfg bg=' + window.__QW_POKE_CFG__.bgList.length + ' poke=' + window.__QW_POKE_CFG__.pokeList.length;`
  );
  log('config pushed: ' + pushed);

  /* Tear down any previous instance, then evaluate the runtime.
   * destroy() alone is not enough: a pet orphaned by an earlier interleaved
   * injection is no longer the one window.__qwPoke points at, so nothing tears it
   * down and the user sees two. Sweep the root nodes by id as well. */
  const swept = await s.eval(
    `(function(){ try { if (window.__qwPoke) window.__qwPoke.destroy(); } catch(e){}
       var n = 0;
       ['qwpoke-bg','qwpoke-layer','qwpoke-btn','qwpoke-picker','qwpoke-style','qwpoke-relay'].forEach(function(id){
         var e; while ((e = document.getElementById(id))) { e.remove(); n++; }
       });
       /* Relay frames from older builds carry no id, and one is left behind per
          injection — each still addressed to a daemon port that may be dead. */
       Array.prototype.forEach.call(
         document.querySelectorAll('iframe[src^="http://127.0.0.1:"]'),
         function(f){ if (/\\/relay$/.test(f.getAttribute('src') || '')) { f.remove(); n++; } });
       return n; })()`
  );
  if (Number(swept) > 0) log('swept ' + swept + ' leftover root node(s)');
  const runtimeSrc = fs.readFileSync(path.join(__dirname, 'runtime.js'), 'utf-8');
  const res = await s.eval(runtimeSrc);
  log('runtime: ' + res);

  s.close();
  log('done. Target: ' + (target.title || target.url || '').slice(0, 60));
}

main().catch((e) => {
  log('FAILED: ' + e.message);
  process.exit(1);
});
