'use strict';
/**
 * Minimal dependency-free CDP client.
 *
 * Why hand-rolled: mario/QQ skins require Node >= 21 for the global `WebSocket`.
 * Many machines (including ones with no Node at all) can't satisfy that. This
 * implements just enough of RFC6455 over `net` to drive Chrome DevTools Protocol,
 * so it runs on Node 18/20/21+ AND on Electron-as-node
 * (ELECTRON_RUN_AS_NODE=1), which is always present because the host app itself
 * is an Electron app.
 */

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/*
 * Locate the host's DevToolsActivePort without knowing the product name: the
 * userData directory that contains that file is the injectable Electron host.
 * `POKEPET_HOST` overrides the choice when several clients are installed.
 * os.homedir() rather than process.env.HOME — on Windows HOME is usually unset,
 * and when a POSIX shell (Git Bash / MSYS2) sets it the value is not a Windows path.
 */
// A VS Code based IDE keeps these in its userData dir; a chat workspace does not.
// Such a host is still injectable in principle, but its main window is a code
// workbench, so it must never win over a running chat client by accident.
const IDE_MARKERS = ['code.lock', 'languagepacks.json', 'CachedExtensionVSIXs', 'argv.json'];

function looksLikeIde(dir) {
  return IDE_MARKERS.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch (e) { return false; } });
}

// Sync on purpose: portFile() is sync and called from sync code paths. curl is
// present on macOS and on Windows 10+; if it is missing the probe just returns
// null and reachability stops being part of the score.
function portAlive(pf) {
  let port = 0;
  try { port = parseInt(fs.readFileSync(pf, 'utf-8').trim().split('\n')[0], 10); } catch (e) { return null; }
  if (!(port > 0)) return false;
  try {
    const r = require('child_process').spawnSync('curl',
      ['-s', '-m', '2', `http://127.0.0.1:${port}/json/version`], { encoding: 'utf-8' });
    if (r.error) return null;
    return r.status === 0 && /"Browser"/.test(r.stdout || '');
  } catch (e) { return null; }
}

function portFile() {
  const home = require('os').homedir();
  const root = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support')
    : (process.env.APPDATA || path.join(home, 'AppData', 'Roaming'));

  const explicit = (process.env.POKEPET_HOST || '').trim();
  if (explicit) return path.join(root, explicit, 'DevToolsActivePort');

  // The installer pins its choice here, so a manually run script resolves the
  // same host as the launchd service instead of re-guessing.
  try {
    const pinned = fs.readFileSync(path.join(home, '.pokepet', 'host'), 'utf-8').trim();
    if (pinned) return path.join(root, pinned, 'DevToolsActivePort');
  } catch (e) {}

  let names = [];
  try { names = fs.readdirSync(root); } catch (e) { names = []; }
  const hits = [];
  for (const n of names) {
    if (n.startsWith('.') || n === 'pokemon-desktop-pet') continue;
    const pf = path.join(root, n, 'DevToolsActivePort');
    try { if (fs.existsSync(pf)) hits.push(pf); } catch (e) {}
  }
  if (!hits.length) return path.join(root, 'DevToolsActivePort');

  // mtime alone is wrong when two hosts coexist: a stale port file from the app
  // touched most recently outranks the client that is actually running.
  const score = (pf) => {
    const alive = portAlive(pf);
    let s = alive === true ? 100 : (alive === null ? 50 : 0);
    if (!looksLikeIde(path.dirname(pf))) s += 10;
    return s;
  };
  const ranked = hits.map((pf) => {
    let mt = 0; try { mt = fs.statSync(pf).mtimeMs; } catch (e) {}
    return { pf, s: score(pf), mt };
  });
  ranked.sort((a, b) => (b.s - a.s) || (b.mt - a.mt));
  return ranked[0].pf;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getDebugPort(retries = 10, waitMs = 1500) {
  const pf = portFile();
  for (let i = 0; i < retries; i++) {
    try {
      const port = parseInt(fs.readFileSync(pf, 'utf-8').trim().split('\n')[0], 10);
      if (port > 0) return port;
    } catch (_) {}
    if (i < retries - 1) await sleep(waitMs);
  }
  throw new Error('Cannot read DevToolsActivePort. Is the host app running? ' + pf);
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('CDP /json timeout')));
  });
}

/**
 * Pick the main renderer target (the visible app window).
 *
 * Deliberately not matched on window title: the title is the product name and
 * differs per client (and changes with the active document). Instead drop the
 * targets that are structurally not the app window — devtools, extensions,
 * about:/blank shells — and prefer a real app-page URL.
 */
async function findTarget(port) {
  const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('No CDP page target found');
  const isAux = (t) => {
    const u = t.url || '';
    return /^devtools:\/\//.test(u) || /^chrome-extension:\/\//.test(u) ||
           /^about:/.test(u) || u === '' || u === 'about:blank';
  };
  /*
   * Skip the host's secondary windows. They are served from file:// exactly like
   * the main window, so without this whichever one CDP happens to list first
   * wins — observed live: with a document open, the preview window came first
   * and the pets were installed into it while the main window got nothing.
   */
  const isSecondary = (t) => {
    const u = t.url || '';
    const title = t.title || '';
    return /\/(voice-overlay|quick-?pick|preview|artifact)[.\-]/i.test(u) ||
           /^(Preview|Voice Input|QuickPick)$/i.test(title);
  };
  const real = pages.filter((t) => !isAux(t) && !isSecondary(t));
  /*
   * Prefer the host's OWN shell window, not a document it happens to be showing.
   * A VS Code based IDE serves its AI/agents window from vscode-file://
   * while a board the user opened is a plain file:///Users/… page — the pet belongs
   * in the app shell. A chat-style app serves its main window from
   * file:///Applications/<App>.app/… . So the app's own bundle renderer ranks
   * highest, then a vscode-file shell, then a localhost app, then any other
   * file:// (a user document), with original order as the tie-break.
   */
  const score = (t) => {
    const u = t.url || '';
    if (/\/Applications\/[^/]+\.app\//.test(u) || /\.app\/Contents\//.test(u)) return 100;
    if (/^vscode-file:\/\//.test(u)) return 80;
    if (/^app:\/\//.test(u)) return 70;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u)) return 60;
    if (/^file:\/\//.test(u)) return 40;
    return 10;
  };
  const ranked = real.map((t, i) => ({ t, s: score(t), i })).sort((a, b) => (b.s - a.s) || (a.i - b.i));
  return ranked.length ? ranked[0].t : (pages.filter((t) => !isAux(t))[0] || pages[0]);
}

/**
 * One-shot WebSocket connection that can issue several CDP commands.
 * Minimal RFC6455 client: text frames, client-masked, handles server
 * continuation/close/ping. Sufficient for Runtime.evaluate / Page.reload.
 */
class CdpSession {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.sock = null;
    this.nextId = 1;
    this.pending = new Map();
    this.rx = Buffer.alloc(0);
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl);
      const key = crypto.randomBytes(16).toString('base64');
      const sock = net.connect(
        { host: u.hostname, port: Number(u.port || 80) },
        () => {
          const req =
            `GET ${u.pathname}${u.search} HTTP/1.1\r\n` +
            `Host: ${u.host}\r\n` +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Key: ${key}\r\n` +
            'Sec-WebSocket-Version: 13\r\n' +
            '\r\n';
          sock.write(req);
        }
      );
      sock.setNoDelay(true);
      this.sock = sock;

      let handshakeDone = false;
      let buf = Buffer.alloc(0);

      const onData = (chunk) => {
        if (!handshakeDone) {
          buf = Buffer.concat([buf, chunk]);
          const sep = buf.indexOf('\r\n\r\n');
          if (sep === -1) return;
          const head = buf.slice(0, sep).toString('latin1');
          if (!/^HTTP\/1\.1 101/i.test(head)) {
            sock.destroy();
            return reject(new Error('WebSocket upgrade failed: ' + head.split('\r\n')[0]));
          }
          const expect = crypto
            .createHash('sha1')
            .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
            .digest('base64');
          if (!new RegExp('sec-websocket-accept:\\s*' + expect.replace(/[+/=]/g, '\\$&'), 'i').test(head)) {
            sock.destroy();
            return reject(new Error('Bad Sec-WebSocket-Accept'));
          }
          handshakeDone = true;
          const rest = buf.slice(sep + 4);
          buf = Buffer.alloc(0);
          if (rest.length) this._onFrameData(rest);
          resolve();
          return;
        }
        this._onFrameData(chunk);
      };

      sock.on('data', onData);
      sock.on('error', (e) => {
        this.closed = true;
        this._failAll(e);
        reject(e);
      });
      sock.on('close', () => {
        this.closed = true;
        this._failAll(new Error('CDP socket closed'));
      });
      // Generous idle timeout: Page.captureScreenshot on an animating page can
      // stay quiet for a while, and a tight timeout kills the socket mid-command.
      sock.setTimeout(90000, () => sock.destroy(new Error('CDP socket timeout')));
    });
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _onFrameData(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    // Parse as many complete frames as available.
    for (;;) {
      if (this.rx.length < 2) return;
      const b0 = this.rx[0];
      const b1 = this.rx[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) === 0x80;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.rx.length < off + 2) return;
        len = this.rx.readUInt16BE(off);
        off += 2;
      } else if (len === 127) {
        if (this.rx.length < off + 8) return;
        const big = this.rx.readBigUInt64BE(off);
        len = Number(big);
        off += 8;
      }
      let maskKey = null;
      if (masked) {
        if (this.rx.length < off + 4) return;
        maskKey = this.rx.slice(off, off + 4);
        off += 4;
      }
      if (this.rx.length < off + len) return;
      let payload = this.rx.slice(off, off + len);
      this.rx = this.rx.slice(off + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(payload.length);
        for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ maskKey[i % 4];
        payload = out;
      }
      if (opcode === 0x8) {
        // close
        try { this.sock.end(); } catch (_) {}
        return;
      }
      if (opcode === 0x9) {
        this._sendFrame(payload, 0xa); // pong
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        // Accumulate text (CDP messages are complete JSON per frame in practice,
        // but tolerate fragmentation by buffering until JSON parses).
        this._textBuf = (this._textBuf || '') + payload.toString('utf8');
        const fin = (b0 & 0x80) === 0x80;
        if (!fin) continue;
        const text = this._textBuf;
        this._textBuf = '';
        let msg;
        try { msg = JSON.parse(text); } catch (_) { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
          else p.resolve(msg.result);
        }
      }
    }
  }

  _sendFrame(payloadBuf, opcode = 0x1) {
    const len = payloadBuf.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) masked[i] = payloadBuf[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([header, mask, masked]));
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP session closed'));
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }), 'utf8');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); }
      });
      try { this._sendFrame(payload, 0x1); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** Evaluate JS in the page; returns the unwrapped value. */
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: !!opts.awaitPromise,
      userGesture: true
    });
    if (r && r.exceptionDetails) {
      const ex = r.exceptionDetails;
      const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text;
      throw new Error('Page JS error: ' + msg);
    }
    return r && r.result ? r.result.value : undefined;
  }

  close() {
    this.closed = true;
    try { this._sendFrame(Buffer.alloc(0), 0x8); } catch (_) {}
    try { this.sock.end(); } catch (_) {}
    try { this.sock.destroy(); } catch (_) {}
  }
}

async function openSession(opts = {}) {
  const port = await getDebugPort(opts.retries ?? 10, opts.waitMs ?? 1500);
  const target = await findTarget(port);
  const s = new CdpSession(target.webSocketDebuggerUrl);
  await s.connect();
  return { session: s, target, port };
}

// Open a session on a SPECIFIC debug port — used for multi-host injection, where
// the daemon drives several hosts at once and cannot use the single-winner
// portFile() resolution.
async function openSessionAt(port) {
  const target = await findTarget(port);
  const s = new CdpSession(target.webSocketDebuggerUrl);
  await s.connect();
  return { session: s, target, port };
}

module.exports = { openSession, openSessionAt, getDebugPort, findTarget, CdpSession, portFile, sleep };
