#!/usr/bin/env node
'use strict';
/**
 * Shared installer work for both platforms.
 *
 * install.sh (macOS) and install.ps1 (Windows) only do the parts that must be
 * native — registering a login service — and delegate everything else here, so
 * asset discovery and config generation can't drift between the two scripts.
 *
 * Usage: setup.js [--pet-home <dir>] [--app <path>] [--no-thumbs]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const P = require('./platform.js');

const HOME = os.homedir();
const RUN_DIR = path.join(HOME, '.pokepet');
const BIN_DIR = path.join(RUN_DIR, 'bin');
const THUMB_DIR = path.join(RUN_DIR, 'thumbs');
const CFG_FILE = path.join(RUN_DIR, 'config.json');

const log = (m) => P.log('setup', m);

function arg(name, dflt) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const noThumbs = process.argv.includes('--no-thumbs');

/** A pokemon asset folder is anything containing gif/. */
function findPetHome(explicit) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.POKEPET_HOME) cands.push(process.env.POKEPET_HOME);
  cands.push(path.join(__dirname, 'petapp'));      // bundled with the skill
  cands.push(path.join(RUN_DIR, 'petapp'));
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'gif'))) return c;
  }
  // scan the host app workspaces for a desktop_pet folder
  const ws = path.join(HOME, '.pokepet', 'workspace');
  try {
    for (const d of fs.readdirSync(ws)) {
      const guess = path.join(ws, d, 'outputs', 'desktop_pet');
      if (fs.existsSync(path.join(guess, 'gif'))) return guess;
    }
  } catch (e) {}
  return null;
}

/** The standalone pet app, if the user built one (optional). */
function findDesktopApp(explicit, petHome) {
  const cands = [];
  if (explicit) cands.push(explicit);
  if (petHome) {
    const up = path.dirname(petHome);
    cands.push(path.join(up, P.IS_MAC ? 'Pokemon桌宠.app' : 'Pokemon桌宠.exe'));
  }
  if (P.IS_MAC) {
    cands.push('/Applications/Pokemon桌宠.app');
  } else {
    cands.push(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Pokemon桌宠', 'Pokemon桌宠.exe'));
  }
  try {
    const ws = path.join(HOME, '.pokepet', 'workspace');
    for (const d of fs.readdirSync(ws)) {
      const out = path.join(ws, d, 'outputs');
      cands.push(path.join(out, P.IS_MAC ? 'Pokemon桌宠.app' : 'Pokemon桌宠.exe'));
    }
  } catch (e) {}
  for (const c of cands) if (c && fs.existsSync(c)) return c;
  return '';
}

(async () => {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });

  const petHome = findPetHome(arg('pet-home', ''));
  if (!petHome) {
    log('ERROR: no pokemon assets found (need a folder containing gif/).');
    log('       Pass one explicitly:  --pet-home <dir>');
    process.exit(2);
  }
  const desktopApp = findDesktopApp(arg('app', ''), petHome);

  const gifs = fs.existsSync(path.join(petHome, 'gif'))
    ? fs.readdirSync(path.join(petHome, 'gif')).filter((f) => /\.gif$/i.test(f)).length : 0;
  const bgDir = path.join(petHome, 'backgrounds_tcgp');
  const bgs = fs.existsSync(bgDir) ? fs.readdirSync(bgDir).filter((f) => /\.png$/i.test(f)).length : 0;
  log(`assets: ${petHome}`);
  log(`        ${gifs} pokemon, ${bgs} background images`);
  log(`standalone app: ${desktopApp || '(not found — "jump to desktop" will be inert)'}`);

  fs.writeFileSync(CFG_FILE, JSON.stringify({
    petHome,
    desktopApp,
    runtime: process.execPath,
    // capability, not product name — this runs inside several different clients
    runtimeIsElectron: !!(process.versions && process.versions.electron) ||
                       /electron/i.test(process.execPath) ||
                       process.env.ELECTRON_RUN_AS_NODE === '1',
    platform: process.platform,
    installedAt: new Date().toISOString()
  }, null, 2));
  log('config.json written');

  // Thumbnails are a nicety: the picker lazy-loads full images if they're absent.
  if (!noThumbs && bgs) {
    log('generating background thumbnails (one-off, keeps the picker snappy)…');
    try {
      const made = await P.makeThumbs(bgDir, THUMB_DIR, 320);
      const total = fs.readdirSync(THUMB_DIR).filter((f) => /\.png$/i.test(f)).length;
      log(`thumbnails: ${made} new, ${total} total`);
    } catch (e) {
      log('thumbnails skipped (' + e.message + ') — the picker will use full images');
    }
  }

  log('done');
})().catch((e) => { log('FAILED: ' + e.message); process.exit(1); });
