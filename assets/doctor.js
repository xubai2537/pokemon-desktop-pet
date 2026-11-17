#!/usr/bin/env node
'use strict';
/**
 * Environment self-check — run this first when something doesn't work, and use it
 * to validate a fresh platform (e.g. after installing on Windows).
 *
 * Usage: doctor.js
 * Exits 0 when the essentials are fine, 1 when something is blocking.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./platform.js');

// Legacy Windows conhost is cp936/cp437 and would garble the ✓/✗ marks and the
// Chinese hints, i.e. break this self-check exactly when it is needed most.
if (process.platform === 'win32') {
  try { require('child_process').execFileSync('chcp.com', ['65001'], { stdio: 'ignore' }); } catch (e) {}
}

const HOME = os.homedir();
const RUN_DIR = path.join(HOME, '.pokepet');
const CFG_FILE = path.join(RUN_DIR, 'config.json');
const PORT_FILE = path.join(RUN_DIR, 'bridge.port');

let bad = 0;
const ok = (label, detail) => console.log('  ✓ ' + label + (detail ? '  — ' + detail : ''));
const warn = (label, detail) => console.log('  ! ' + label + (detail ? '  — ' + detail : ''));
const fail = (label, detail) => { bad++; console.log('  ✗ ' + label + (detail ? '  — ' + detail : '')); };

function readJson(p, d) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return d; }
}

(async () => {
  console.log('\nPokemon desktop pet — self-check  (host: ' + P.hostName() + ')\n');

  console.log('platform');
  ok(process.platform + ' ' + os.release(), 'arch ' + process.arch);
  ok('js runtime', process.execPath + ' (node ' + process.versions.node + ')');

  console.log('\nhost app  [' + P.hostName() + ']');
  const pf = P.devToolsPortFile();
  if (fs.existsSync(pf)) {
    const port = parseInt(fs.readFileSync(pf, 'utf-8').trim().split('\n')[0], 10);
    ok('DevToolsActivePort', pf + ' -> ' + port);
    try {
      const { openSession } = require('./cdp.js');
      const { session, target } = await openSession({ retries: 1, waitMs: 0 });
      const live = await session.eval('!!window.__qwPoke');
      const origin = await session.eval('location.origin');
      session.close();
      ok('CDP reachable', 'target "' + (target.title || '?') + '", origin ' + origin);
      if (live) ok('skin injected', 'window.__qwPoke present');
      else warn('skin not injected yet', 'the daemon re-injects within ~5s');
    } catch (e) {
      fail('CDP not reachable', e.message);
    }
  } else {
    fail('DevToolsActivePort missing', pf);
    if (P.IS_WIN) {
      console.log('      Start your AI workspace once with remote debugging so the file appears');
      console.log('      in its userData dir; set POKEPET_HOST=<dirname> to pick a specific client.');
      console.log('      If it still never appears, launch it with --remote-debugging-port=9222.');
    }
  }
  const exe = P.hostAppExe();
  if (exe) ok('host app executable', exe);
  else warn('host app executable not found', 'only needed as a node fallback');

  console.log('\nassets');
  const cfg = readJson(CFG_FILE, null);
  if (!cfg) {
    fail('config.json missing', CFG_FILE + '  (run the installer)');
  } else {
    const petHome = cfg.petHome || '';
    const has = (sub) => fs.existsSync(path.join(petHome, sub));
    const count = (sub, re) => {
      try { return fs.readdirSync(path.join(petHome, sub)).filter((f) => re.test(f)).length; }
      catch (e) { return 0; }
    };
    if (has('gif')) ok('pokemon sprites', count('gif', /\.gif$/i) + ' in ' + petHome + '/gif');
    else fail('pokemon sprites missing', petHome + '/gif');
    if (has('backgrounds_tcgp')) ok('background boards', count('backgrounds_tcgp', /\.png$/i) + ' images');
    else warn('no background boards', 'the 背景板 tab will be empty');
    if (has('food')) ok('feeding items', count('food', /\.png$/i) + ' icons');
    else warn('no feeding items', 'the 喂食 tab will be empty');
    if (has('balls')) ok('pokeballs', count('balls', /\.png$/i) + ' icons');
    else warn('no pokeballs', 'the launcher falls back to an emoji');
    if (has('avatars_tcgp')) ok('avatars', count('avatars_tcgp', /\.png$/i) + ' images');
    else warn('no avatars', 'the 头像 tab will be empty');

    const thumbs = path.join(RUN_DIR, 'thumbs');
    const tn = fs.existsSync(thumbs) ? fs.readdirSync(thumbs).filter((f) => /\.png$/i.test(f)).length : 0;
    if (tn) ok('board thumbnails', tn + ' cached');
    else warn('no thumbnails', 'picker will lazy-load full images (slower but fine)');

    if (cfg.desktopApp && fs.existsSync(cfg.desktopApp)) ok('standalone pet app', cfg.desktopApp);
    else warn('no standalone pet app', '"jump to desktop" will do nothing');
  }

  console.log('\ncustom pets (photo -> sprite)');
  if (P.IS_MAC) {
    const jxa = path.join(__dirname, 'pokecut.jxa');
    if (fs.existsSync(jxa)) {
      const r = await P.osa(['-l', 'JavaScript', '-e',
        'ObjC.import("Vision"); $.VNGenerateForegroundInstanceMaskRequest.alloc.init ? "ok" : "no"']);
      if (r.ok && r.out.indexOf('ok') >= 0) ok('cutout: macOS Vision', 'best quality — handles cluttered backgrounds');
      else warn('Vision unavailable', 'will fall back to in-page edge removal');
    } else {
      warn('pokecut.jxa missing', 'will fall back to in-page edge removal');
    }
  } else {
    const py = await P.findRembg();
    if (py) ok('cutout: rembg', 'via ' + py + ' — quality comparable to macOS');
    else warn('cutout: in-page edge removal', 'fine for plain backgrounds; install rembg (pip install rembg) for cluttered photos');
  }
  ok('pixelation', 'in-page canvas — no Pillow/ImageMagick needed');

  console.log('\nbridge');
  if (fs.existsSync(PORT_FILE)) {
    const bp = fs.readFileSync(PORT_FILE, 'utf-8').trim();
    const res = await new Promise((resolve) => {
      const req = require('http').request(
        { host: '127.0.0.1', port: Number(bp), path: '/ping', method: 'POST', timeout: 4000 },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => resolve(d));
        });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.end();
    });
    if (res) ok('daemon responding', 'port ' + bp + ' ' + res.trim());
    else fail('daemon not responding', 'port ' + bp + ' — is it running?');
  } else {
    fail('bridge.port missing', 'the daemon has not started');
  }

  console.log('\n' + (bad ? bad + ' blocking problem(s) — see ✗ above' : 'All good.') + '\n');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('doctor crashed: ' + e.message); process.exit(1); });
