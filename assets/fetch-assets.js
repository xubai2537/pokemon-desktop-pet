#!/usr/bin/env node
'use strict';
/**
 * fetch-assets.js — download the pet's sprite assets on first install.
 *
 * The skill package ships scripts + small manifests only (~200 KB). The 1025
 * pokemon animations and the 125 item icons are pulled from their public
 * upstreams at install time, so the package stays small and no third-party
 * artwork is redistributed.
 *
 * Sources (exactly two hosts, both declared in SKILL.md `permissions.network`):
 *   play.pokemonshowdown.com   1025 animated sprites, keyed by slug
 *   raw.githubusercontent.com  38 poke balls + 87 food items (PokeAPI/sprites)
 *
 * Safety properties (集团 Skill 安全规范 · 网络/文件/资源):
 *   - HTTPS only, certificate verification left ON, no redirects to other hosts
 *   - host allowlist enforced per request; anything else throws
 *   - every filename comes from our own bundled manifest, never from the
 *     response — no path traversal is possible
 *   - writes stay inside <petHome>, which is created under the app's own dir
 *   - bounded work: fixed manifest, MAX_RETRY per file, per-request timeout,
 *     capped concurrency, and a per-file size ceiling
 *   - resumable: an existing non-empty file is skipped, so a re-run costs
 *     nothing and a partial download self-heals
 *
 * Usage:
 *   fetch-assets.js --pet-home <dir> [--only gif|items|art] [--concurrency 8] [--quiet]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

/* Download hosts are allowlisted on purpose: a manifest is data, and data must not
   be able to point the downloader at an arbitrary server. mmbiz.qpic.cn is the
   WeChat image CDN that serves the PTCG Pocket card faces. */
const ALLOWED_HOSTS = new Set(['play.pokemonshowdown.com', 'raw.githubusercontent.com', 'media.52poke.com',
                               's1.52poke.wiki', 'tw.portal-pokemon.com', 'mmbiz.qpic.cn',
                               'limitlesstcg.nyc3.cdn.digitaloceanspaces.com']);
const SHOWDOWN = 'https://play.pokemonshowdown.com/sprites/ani/';
const POKEAPI_ITEMS = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/';
/*
 * Optional high-definition sprite styles. The pixel animations stay the default
 * because they are the only ones that move; these are for people who run the
 * pets large, where the pixel art starts showing its jaggies.
 *   home    — Pokemon HOME model renders, 512px, addressed straight by dex number
 *   artwork — Sugimori-style official artwork, 630px, filenames are hashes, so
 *             the id->file map has to come from the prebuilt artwork.json
 */
const POKEAPI_HOME = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/';
const TW_ARTWORK = 'https://tw.portal-pokemon.com/play/resources/pokedex/img/pm/';
// Board and avatar art comes from the public wiki CDN. art.json ships
// with the package and already points at server-side thumbnails (1600px boards,
// 512px avatars) — ~86% smaller than the originals with no visible difference
// once the board is toned down by bgOpacity/blur.

/*
 * Turn a 52poke wiki media URL into its server-side thumbnail URL.
 * MediaWiki exposes thumbnails by inserting /thumb/ after /wiki/ and appending
 * /<width>px-<filename>. Fetching a 320px thumb this way (≈10KB vs ≈1.4MB) means
 * the picker grid stays snappy WITHOUT any local image processing — which is the
 * whole point: Windows under constrained PowerShell cannot run System.Drawing,
 * and macOS no longer needs sips either. Returns null for URLs we can't rewrite.
 */
function thumbUrl(url, width) {
  const m = String(url).match(/^(https?:\/\/[^/]+\/wiki\/)(.*\/)?([^/]+)$/);
  if (!m) return null;
  return m[1] + 'thumb/' + (m[2] || '') + m[3] + '/' + width + 'px-' + m[3];
}

const THUMB_WIDTH = 320;

const REQ_TIMEOUT_MS = 20000;
const MAX_RETRY = 3;
const MAX_BYTES = 3 * 1024 * 1024;   // a sprite is ~30 KB; 3 MB is a generous ceiling
const MIN_BYTES = 200;               // smaller than this means an error page, not an image

function parseArgs(argv) {
  /*
   * Default concurrency is deliberately low. Writing 1476 new files as fast as
   * the network allows makes endpoint security scan them just as fast: on a
   * managed Mac that pushed two scanner processes past 80% CPU between them and
   * stalled the whole desktop — the host app looked like it had hung. Three at a
   * time still saturates a normal connection for files this size. Raise it with
   * --concurrency on an unmanaged machine if you want.
   */
  const out = { concurrency: 3, only: 'all', quiet: false, petHome: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pet-home') out.petHome = argv[++i] || '';
    else if (a === '--only') out.only = argv[++i] || 'all';
    else if (a === '--concurrency') out.concurrency = Math.max(1, Math.min(16, parseInt(argv[++i], 10) || 3));
    else if (a === '--quiet') out.quiet = true;
  }
  return out;
}

/** GET one URL into a buffer. Host is checked here, not by the caller. */
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url')); }
    if (u.protocol !== 'https:') return reject(new Error('refusing non-https: ' + u.protocol));
    if (!ALLOWED_HOSTS.has(u.hostname)) return reject(new Error('host not allowed: ' + u.hostname));

    // Local patch: media.52poke.com / s1.52poke.wiki hotlink-protect their CDN —
    // requests without a wiki referer get HTTP 403 from Cloudflare. Send the
    // wiki referer plus a browser UA for those two hosts.
    const reqHeaders = {};
    if (u.hostname === 'media.52poke.com' || u.hostname === 's1.52poke.wiki') {
      reqHeaders['referer'] = 'https://wiki.52poke.com/';
      reqHeaders['user-agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    }
    const req = https.get(u, { timeout: REQ_TIMEOUT_MS, headers: reqHeaders }, (res) => {
      // Follow a redirect only when it stays on an allowed host.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u); } catch (e) { return reject(new Error('bad redirect')); }
        if (!ALLOWED_HOSTS.has(next.hostname)) return reject(new Error('redirect off-allowlist: ' + next.hostname));
        return fetchBuffer(next.href).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }

      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > MAX_BYTES) { req.destroy(); return reject(new Error('response too large')); }
        chunks.push(c);
      });
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < MIN_BYTES) return reject(new Error('response too small (' + buf.length + 'B)'));
        resolve(buf);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** Download with bounded retries and exponential backoff. */
async function fetchWithRetry(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try { return await fetchBuffer(url); }
    catch (e) { lastErr = e; if (attempt < MAX_RETRY) await sleep(400 * attempt); }
  }
  /*
   * Wiki thumbnails 404 when the source image is narrower than the requested
   * width. Fall back to the original file in that case:
   *   /wiki/thumb/a/ab/N.png/1600px-N.png  ->  /wiki/a/ab/N.png
   */
  const m = url.match(/^(https:\/\/[^/]+)\/wiki\/thumb\/([0-9a-f])\/([0-9a-f]{2})\/(.+?)\/\d+px-.+$/);
  if (m) {
    try { return await fetchBuffer(`${m[1]}/wiki/${m[2]}/${m[3]}/${m[4]}`); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

/**
 * Run jobs with a fixed worker pool. Jobs are pre-built from our own manifest,
 * so the total amount of work is known and finite (no unbounded loop).
 */
async function runPool(jobs, concurrency, onDone) {
  let idx = 0;
  const stats = { ok: 0, skipped: 0, failed: 0, optionalFailed: 0, failures: [] };
  const worker = async () => {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      /* job.replace means "the bytes behind this name changed" — cards kept their
         filenames when the source switched from the English faces to the Chinese
         ones, so without this the resume shortcut would pin everyone to English. */
      if (!job.replace && fs.existsSync(job.dest) && fs.statSync(job.dest).size >= MIN_BYTES) {
        stats.skipped++; onDone(stats, jobs.length); continue;
      }
      try {
        const buf = await fetchWithRetry(job.url);
        // write to a temp name then rename, so an interrupted run never leaves
        // a half-written file that a later run would treat as complete
        const tmp = job.dest + '.part';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, job.dest);
        stats.ok++;
      } catch (e) {
        // optional jobs (e.g. picker thumbnails) must never fail the install —
        // the UI falls back to the full image if a thumb is missing
        if (job.optional) stats.optionalFailed++;
        else {
          stats.failed++;
          if (stats.failures.length < 20) stats.failures.push(job.name + ': ' + e.message);
        }
      }
      onDone(stats, jobs.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return stats;
}

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return fallback; }
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const petHome = args.petHome || path.join(__dirname, 'petapp');
  const log = (m) => { if (!args.quiet) console.log(m); };

  /*
   * Manifests ship with the package — they are the only source of filenames.
   *
   * Resolve each one independently instead of choosing a single directory. The
   * old code picked petHome as "the" manifest dir whenever it found slug.json
   * there, but a completed download copies only slug/names/foods into petHome
   * (see the copy step near the end). So on any install that had already
   * fetched its assets, petHome won a lookup it could not satisfy and every
   * later run died with "manifests missing" — which is why switching to an HD
   * sprite style silently never worked once the pet was set up.
   */
  const MANIFEST_DIRS = [petHome, path.join(__dirname, 'manifests')];
  const manifestPath = (name) => {
    for (const d of MANIFEST_DIRS) {
      const p = path.join(d, name);
      try { if (fs.existsSync(p)) return p; } catch (e) {}
    }
    return path.join(MANIFEST_DIRS[MANIFEST_DIRS.length - 1], name);
  };
  const readManifest = (name, dflt) => readJson(manifestPath(name), dflt);

  const slugs = readManifest('slug.json', null);
  /* Mega Evolutions / Primal Reversions. Keyed by our own ids ('0006-mx'), which
     carry both the Showdown slug for the animated sprite and the PokeAPI pokemon
     id for the HD one — the two sources number these forms differently. Missing
     file just means no mega forms, which is a fine degraded state. */
  const forms = readManifest('forms.json', {}) || {};
  const foods = readManifest('foods.json', null);
  const balls = readManifest('balls.json', null);

  if (!slugs || !foods || !balls) {
    console.error('ERROR: manifests missing (need slug.json / foods.json / balls.json / art.json).');
    console.error('       looked in: ' + MANIFEST_DIRS.join('  and  '));
    process.exit(2);
  }

  ensureDir(petHome);
  ensureDir(path.join(petHome, 'gif'));
  ensureDir(path.join(petHome, 'food'));
  ensureDir(path.join(petHome, 'balls'));

  const safeName = (s) => /^[A-Za-z0-9_-]+$/.test(String(s));      // manifest ids are ASCII-safe by contract
  // art filenames are '<hex>.png' — still no separators, so no traversal
  const safeFileName = (s) => /^[A-Za-z0-9_-]+\.(png|jpg|jpeg|gif)$/i.test(String(s));
  /* Collectible names are Chinese wiki filenames, so an ASCII allowlist rejects all
     of them. Guard against traversal instead of guessing the alphabet: no path
     separators, no '..', no control chars, must end in an image extension. */
  const safeUnicodeFileName = (s) => {
    const v = String(s);
    if (v.length > 160) return false;
    if (/[\/\\:]/.test(v) || v.indexOf('..') >= 0) return false;
    if (/[\u0000-\u001f]/.test(v)) return false;
    return /\.(png|jpg|jpeg|gif|webp)$/i.test(v);
  };
  const jobs = [];
  /* Which language each downloaded card is in. Populated only in the cards-only
     branch, but declared here so the runner can persist it regardless. */
  let cardLangSidecar = null;

  /* PokeAPI sprite repo — the only source that actually has female variants.
     Showdown has no ani-f/ directory at all (every such URL 404s), so relying on
     it silently fell back to the male sprite. */
  const SHOWDOWN_TRAINERS = 'https://play.pokemonshowdown.com/sprites/trainers/';
  const POKEAPI_F_ANI = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-v/black-white/animated/female/';
  const POKEAPI_F_HOME = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/home/female/';

  /* `--only essentials` == "all" minus "extras". Lets install.sh finish quickly
     (essentials are what makes the pet walk / eat / evolve; extras are the
     picker's pretty stuff) while the daemon backfills extras afterwards. */
  const ESSENTIALS = args.only === 'essentials';
  const ALL = args.only === 'all';

  if (ALL || ESSENTIALS || args.only === 'gif') {
    for (const no of Object.keys(slugs)) {
      const slug = slugs[no];
      if (!safeName(no) || !safeName(slug)) continue;
      jobs.push({ name: 'gif/' + no, url: SHOWDOWN + slug + '.gif', dest: path.join(petHome, 'gif', no + '.gif') });
    }
    for (const id of Object.keys(forms)) {
      const f = forms[id];
      if (!f || !safeName(id) || !safeName(f.slug)) continue;
      jobs.push({ name: 'gif/' + id, url: SHOWDOWN + f.slug + '.gif',
                  dest: path.join(petHome, 'gif', id + '.gif') });
    }
  }
  /*
   * The optional HD styles. Each lands in its own directory, so all three can
   * sit side by side and switching between them never re-downloads anything.
   * Neither is part of 'all' — they are only fetched when asked for by name,
   * because together they are five times the size of the pixel set.
   */
  if (args.only === 'home') {
    for (const no of Object.keys(slugs)) {
      if (!safeName(no)) continue;
      const dex = parseInt(no, 10);
      if (!dex) continue;
      jobs.push({ name: 'home/' + no, url: POKEAPI_HOME + dex + '.png',
                  dest: path.join(petHome, 'home', no + '.png') });
    }
    for (const id of Object.keys(forms)) {
      const f = forms[id];
      // f.api is the POKEMON id; the form id would point at a different sprite
      if (!f || !f.hd || !safeName(id) || !(f.api > 0)) continue;
      jobs.push({ name: 'home/' + id, url: POKEAPI_HOME + f.api + '.png',
                  dest: path.join(petHome, 'home', id + '.png') });
    }
  }
  if (args.only === 'artwork') {
    const map = readManifest('artwork.json', null);
    if (!map || !map.pokemon) {
      console.error('ERROR: artwork.json missing from the manifests directory.');
      console.error('       Official artwork is served under hashed filenames, so the');
      console.error('       id -> file map has to ship with the package; it cannot be');
      console.error('       derived at runtime.');
      process.exit(1);
    }
    for (const no of Object.keys(map.pokemon)) {
      const file = map.pokemon[no] && map.pokemon[no].file;
      if (!safeName(no) || !safeFileName(file)) continue;
      jobs.push({ name: 'artwork/' + no, url: (map.base || TW_ARTWORK) + file,
                  dest: path.join(petHome, 'artwork', no + '.png') });
    }
  }
  if (args.only === 'all' || args.only === 'art' || args.only === 'extras') {
    /*
     * "Extras": boards, avatars, and pack covers — the pretty stuff, not part
     * of what makes the pet WORK, so it can move out of install and land later
     * in the background. Filenames come from art.json (our own manifest), never
     * from the response, and each group also gets the plain manifest that
     * inject.js reads to build the picker lists.
     */
    const art = readManifest('art.json', null);
    if (!art) {
      console.error('ERROR: art.json missing in ' + MANIFEST_DIRS.join('  and  '));
      process.exit(2);
    }
    const groups = [
      ['backgrounds', 'backgrounds_tcgp', 'backgrounds.json', (x) => ({ file: x.file, label: x.label, type: x.type })],
      ['avatars',     'avatars_tcgp',     'avatars.json',     (x) => ({ file: x.file, label: x.label, type: x.type })],
      /* Pack covers were previously hand-placed and shipped inside the skill zip.
         Rolled into the same "extras" fetch here so a clean install still gets
         them, but only after essentials — the picker's pack tab reads the packs/
         directory as it exists on disk. */
      ['packs',       'packs',            'packs.json',       (x) => ({ file: x.file, label: x.label, set: x.set })]
      // no particle effects: the in-page picker has no fx tab and fxShape is
      // forced to null, so those 91 images would be downloaded for nothing
    ];
    for (const [key, dir, jsonName, strip] of groups) {
      const list = art[key] || [];
      if (!list.length) continue;
      ensureDir(path.join(petHome, dir));
      const wantThumbs = key === 'backgrounds';       // boards are the heavy ones
      if (wantThumbs) ensureDir(path.join(petHome, 'thumbs'));
      // pack cover filenames include Chinese ('TCGP_A1_卡包1.png'), so an ASCII-only
      // guard would silently drop every one of them
      const okName = (key === 'packs') ? safeUnicodeFileName : safeFileName;
      for (const x of list) {
        if (!okName(x.file)) continue;
        jobs.push({ name: dir + '/' + x.label, url: x.url, dest: path.join(petHome, dir, x.file), optional: key === 'packs' });
        // a small server-side thumbnail for the picker grid; optional so a miss
        // just falls back to the full image instead of failing the install
        if (wantThumbs) {
          const turl = thumbUrl(x.url, THUMB_WIDTH);
          if (turl) jobs.push({ name: 'thumbs/' + x.label, url: turl,
                                dest: path.join(petHome, 'thumbs', x.file), optional: true });
        }
      }
      // inject.js reads these; write them up front so a partial download still
      // shows whatever images did land instead of an empty tab
      const plain = list.filter((x) => okName(x.file)).map(strip);
      fs.writeFileSync(path.join(petHome, jsonName), JSON.stringify(plain, null, 1));
    }
  }

  /* Female sprites for the 102 dimorphic species — no longer used by runtime.
     v4.5.4 dropped in-place gender-triggered sprite swaps because Showdown's
     ani/ is Gen-6 style (60×60) while PokeAPI's female animated set is Gen-5
     (50×46, different pose): switching gender looked like "different pokemon".
     Kept as an opt-in job (`--only gender`) so a curator who wants them back
     can still fetch, but essentials/all no longer pull them. */
  if (args.only === 'gender') {
    const genders = readManifest('genders.json', {});
    for (const no of Object.keys(genders)) {
      if (!genders[no] || !genders[no].dimorphic || !safeName(no)) continue;
      const dex = parseInt(no, 10);
      if (!dex) continue;
      jobs.push({ name: 'gif/' + no + '-f', url: POKEAPI_F_ANI + dex + '.gif',
                  dest: path.join(petHome, 'gif', no + '-f.gif'), optional: true });
    }
  }

  /* Regional forms (Alolan / Galarian / Hisuian / Paldean) and Gigantamax.
     Both live in regional-forms.json; Showdown serves them under their own slug. */
  if (ALL || ESSENTIALS || args.only === 'regional' || args.only === 'gmax') {
    const regional = readManifest('regional-forms.json', {});
    for (const id of Object.keys(regional)) {
      const r = regional[id];
      if (!r || !safeName(id) || !safeName(r.slug)) continue;
      const isG = r.kind === 'gmax';
      if (args.only === 'regional' && isG) continue;
      if (args.only === 'gmax' && !isG) continue;
      jobs.push({ name: 'gif/' + id, url: SHOWDOWN + r.slug + '.gif',
                  dest: path.join(petHome, 'gif', id + '.gif'), optional: true });
    }
  }

  /* Trainer portraits. Two styles because Showdown really has two files per
     character (modern detailed vs retro pixel); only the ones the manifest
     recorded as present are fetched, so nothing 404s into a broken image. */
  if (ALL || ESSENTIALS || args.only === 'trainers') {
    const trainers = readManifest('trainers.json', {});
    ensureDir(path.join(petHome, 'trainers'));
    for (const id of Object.keys(trainers)) {
      const t = trainers[id];
      if (!t || !t.styles) continue;
      for (const style of Object.keys(t.styles)) {
        const file = t.styles[style];
        if (!safeName(file)) continue;
        jobs.push({ name: 'trainers/' + file, url: SHOWDOWN_TRAINERS + file + '.png',
                    dest: path.join(petHome, 'trainers', file + '.png'), optional: true });
      }
    }
  }

  /* Tera form sprites — unique crystallized renders from Pokemon Masters EX.
     Each entry in tera-forms.json carries its own download url (wiki CDN path). */
  if (ALL || ESSENTIALS || args.only === 'tera') {
    const teraForms = readManifest('tera-forms.json', {});
    for (const id of Object.keys(teraForms)) {
      const t = teraForms[id];
      if (!t || !t.url || !t.base) continue;
      const dest = path.join(petHome, 'gif', t.base + '-tera.png');
      jobs.push({ name: 'gif/' + t.base + '-tera.png', url: t.url,
                  dest, optional: true });
    }
  }

  /* Collectibles (PTCG Pocket 周边: 勋章 / 奖杯 / 币 / 卡包封面 / 对战特效).
     NOT part of 'all': the album downloads them on first open, so a fresh install
     stays fast. Each entry carries its own absolute URL from the manifest, because
     the wiki CDN path is a content hash rather than something derivable. */
  /* Card faces. NOT part of 'all' and never fetched at install time: 3700+ files is
     far too long a wait for a first run, and the album is opt-in anyway. The user
     triggers it from the album (daemon POST /fetchcards) once they want it. */
  if (args.only === 'cards') {
    const cm = readManifest('cards.json', {});
    const list = (cm && cm.items) || [];
    const cardDir = path.join(petHome, 'cards');
    ensureDir(cardDir);
    /* Which language is already on disk. Filenames are language-independent
       (A1_096.webp), which is what keeps a user's collection valid across a source
       change — but it also means the file alone cannot tell you what is inside it. */
    const langFile = path.join(petHome, 'cards-lang.json');
    const onDisk = readJson(langFile, {});
    const wanted = {};
    let zhN = 0, enN = 0;
    for (const it of list) {
      if (!it || !it.url || !safeUnicodeFileName(it.file)) continue;
      const lang = it.lang || 'en';
      wanted[it.file] = lang;
      if (lang === 'zh') zhN++; else enN++;
      jobs.push({ name: 'cards/' + it.file, url: it.url,
                  dest: path.join(cardDir, it.file), optional: true,
                  replace: onDisk[it.file] && onDisk[it.file] !== lang });
    }
    log('==> cards: ' + zhN + ' 中文卡面, ' + enN + ' 英文卡面（中文版未发行的扩充包）');
    cardLangSidecar = { file: langFile, data: wanted };
  }

  if (ALL || ESSENTIALS || args.only === 'items') {
    for (const f of foods) {
      if (!safeName(f.id)) continue;
      jobs.push({ name: 'food/' + f.id, url: POKEAPI_ITEMS + f.id + '.png', dest: path.join(petHome, 'food', f.id + '.png') });
    }
    for (const id of balls) {
      if (!safeName(id)) continue;
      jobs.push({ name: 'balls/' + id, url: POKEAPI_ITEMS + id + '.png', dest: path.join(petHome, 'balls', id + '.png') });
    }
  }

  /*
   * The manifests must also live in petHome: inject.js reads foods.json /
   * slug.json / names.json from there to build the picker lists. Downloading the
   * icons without copying the manifests leaves the 喂食 tab empty (count 0) even
   * though every PNG is on disk.
   */
  for (const mf of ['slug.json', 'names.json', 'foods.json', 'forms.json', 'evolutions.json']) {
    const src = manifestPath(mf);
    const dst = path.join(petHome, mf);
    if (src !== dst && fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      log('    manifest -> ' + mf);
    }
  }

  log('==> fetching ' + jobs.length + ' assets into ' + petHome);
  log('    sources: play.pokemonshowdown.com (sprites) · raw.githubusercontent.com/PokeAPI (items)');

  let lastPct = -1;
  const t0 = Date.now();
  /*
   * Create the destination directories from the jobs themselves. They used to
   * be a hardcoded list, so adding a new asset group meant every one of its
   * files failed with ENOENT — which is precisely what happened when the two HD
   * sprite styles were added. Deriving them here cannot fall out of date.
   */
  const dirs = new Set(jobs.map((j) => path.dirname(j.dest)));
  for (const d of dirs) ensureDir(d);
  const stats = await runPool(jobs, args.concurrency, (s, total) => {
    const done = s.ok + s.skipped + s.failed;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      log('    ' + pct + '%  (' + done + '/' + total + ', new ' + s.ok + ', cached ' + s.skipped + ', failed ' + s.failed + ')');
    }
  });

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  log('==> done in ' + secs + 's: ' + stats.ok + ' downloaded, ' + stats.skipped + ' already present, ' + stats.failed + ' failed');
  if (stats.failures.length) {
    log('    first failures:');
    for (const f of stats.failures) log('      - ' + f);
  }

  /* Persist the card language sidecar. Only files that ended this run in a good
     state (downloaded or already-cached) get their language rewritten; anything
     that failed keeps its previous mapping so a partial network drop-out does not
     erase the memory of what the local copies really are. */
  if (cardLangSidecar) {
    const merged = readJson(cardLangSidecar.file, {});
    const failedNames = new Set(stats.failures.map((f) => (f.split(':')[0] || '').replace(/^cards\//, '')));
    for (const [file, lang] of Object.entries(cardLangSidecar.data)) {
      if (!failedNames.has(file)) merged[file] = lang;
    }
    try {
      fs.writeFileSync(cardLangSidecar.file, JSON.stringify(merged));
    } catch (e) { log('    (warn) failed to save card lang sidecar: ' + e.message); }
  }

  // A handful of misses still leaves a usable pet; a large gap does not.
  const ratio = jobs.length ? stats.failed / jobs.length : 0;
  if (ratio > 0.1) {
    console.error('ERROR: too many downloads failed (' + stats.failed + '/' + jobs.length + ').');
    console.error('       Check your network / proxy, then re-run — finished files are kept.');
    process.exit(1);
  }
  if (stats.failed) log('    (a few misses are fine — those pokemon simply fall back to another sprite)');
})().catch((e) => { console.error('fetch-assets failed: ' + e.message); process.exit(1); });
