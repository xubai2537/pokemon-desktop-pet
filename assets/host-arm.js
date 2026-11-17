#!/usr/bin/env node
'use strict';

/* Keep the current Electron host launchable with a CDP port.
 *
 * The debugging switch is available only at process start. This agent never
 * closes the host: it waits for the existing singleton owner to exit, then
 * starts the same executable with a dynamic debugging port. Success requires
 * the listener PID, surviving main-process PID, and SingletonLock owner to be
 * identical, which rejects a short-lived losing second instance.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HOME = process.env.HOME || '';
const RUN_DIR = path.join(HOME, '.pokepet');
const APP_BIN = (process.env.POKEPET_ARM_APP_BIN || '').trim();
const USER_DATA = (process.env.POKEPET_ARM_USER_DATA || '').trim();
const LOG = (process.env.POKEPET_ARM_LOG || '').trim();

if (!APP_BIN || !USER_DATA || !LOG) {
  console.error('host-arm: POKEPET_ARM_APP_BIN, POKEPET_ARM_USER_DATA and POKEPET_ARM_LOG are required');
  process.exit(2);
}

const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LOCK_FILE = path.join(USER_DATA, 'SingletonLock');
const ARM_TAG = path.basename(LOG).replace(/\.log$/i, '') || 'host-cdp';
const DISABLE = path.join(RUN_DIR, ARM_TAG + '.disable');
const STAMP = path.join(RUN_DIR, ARM_TAG + '.armed-at');
const STATE_FILE = path.join(RUN_DIR, 'state.json');
const HOST_LABEL = path.basename(APP_BIN);
const VERIFY_SECS = 60;

function teamIsEmpty() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return Array.isArray(s.team) && s.team.length === 0;
  } catch (e) { return false; }
}

function say(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  try { fs.appendFileSync(LOG, t + ' ' + msg + '\n'); } catch (e) {}
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
  } catch (e) {
    return (e && e.stdout) || '';
  }
}

function mainPids() {
  const out = sh('/bin/ps', ['-Ao', 'pid=,command=']);
  const pids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const argv = m[2].trim();
    if (argv !== APP_BIN && !argv.startsWith(APP_BIN + ' ')) continue;
    const rest = argv.slice(APP_BIN.length).trim();
    if (rest && !rest.split(/\s+/).every((a) => a.startsWith('-'))) continue;
    if (rest.includes('--type=')) continue;
    pids.push(Number(m[1]));
  }
  return pids;
}

function lockOwnerPid() {
  let target;
  try { target = fs.readlinkSync(LOCK_FILE); } catch (e) { return null; }
  const m = String(target).match(/-(\d+)$/);
  return m ? Number(m[1]) : null;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function cdpPort() {
  let raw;
  try { raw = fs.readFileSync(PORT_FILE, 'utf8'); } catch (e) { return 0; }
  const port = parseInt(String(raw).split('\n')[0].trim(), 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}

function listenerPid(port) {
  const out = sh('/usr/sbin/lsof', ['-nP', '-tiTCP:' + port, '-sTCP:LISTEN']);
  const pid = parseInt(String(out).trim().split('\n')[0], 10);
  return Number.isInteger(pid) ? pid : 0;
}

function verify() {
  const port = cdpPort();
  if (!port) return { ok: false, why: 'no port file' };
  const lpid = listenerPid(port);
  if (!lpid) return { ok: false, why: 'port ' + port + ' has no listener' };
  const mains = mainPids();
  if (!mains.includes(lpid)) {
    return { ok: false, why: 'port ' + port + ' listener pid ' + lpid + ' is not the ' + HOST_LABEL + ' main process' };
  }
  const owner = lockOwnerPid();
  if (owner !== lpid) {
    return { ok: false, why: 'lock owner pid ' + owner + ' differs from listener pid ' + lpid };
  }
  return { ok: true, port, pid: lpid };
}

function disabled() {
  try { fs.accessSync(DISABLE); return true; } catch (e) { return false; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function launch() {
  const env = Object.assign({}, process.env);
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const extra = (process.env.POKEPET_ARM_APP_ARGS || '').trim();
  const args = ['--remote-debugging-port=0'].concat(extra ? extra.split(/\s+/) : []);
  const child = spawn(APP_BIN, args, { detached: true, stdio: 'ignore', env });
  child.unref();
  return child.pid;
}

async function main() {
  if (process.argv.includes('--check')) {
    const v = verify();
    console.log(JSON.stringify(v));
    process.exit(v.ok ? 0 : 1);
  }
  if (disabled()) { say('disabled (' + DISABLE + ' exists); exiting'); return; }

  const pre = verify();
  if (pre.ok) say(HOST_LABEL + ' has verified CDP on port ' + pre.port + '; staying armed');
  else say('armed for ' + HOST_LABEL + ' (current state: ' + pre.why + ')');
  try { fs.writeFileSync(STAMP, new Date().toISOString() + '\n'); } catch (e) {}

  let launching = false;
  let lastOwnerPid = 0;
  const attempt = async () => {
    if (launching) return;
    const owner = lockOwnerPid();

    if (owner !== null && pidAlive(owner)) {
      // App is running. Check if it has CDP.
      const v = verify();
      if (v.ok) { lastOwnerPid = owner; return; } // CDP working, all good

      // App running without CDP — user reopened it (or updater restart).
      // Only handle if this is a NEW instance (different PID from last CDP).
      if (owner === lastOwnerPid) return;
      if (teamIsEmpty()) { lastOwnerPid = owner; return; }
      if (disabled()) { say('disabled; exiting'); process.exit(0); }

      // User reopened the app without CDP. Wait 3s for full startup,
      // then kill and relaunch with --remote-debugging-port.
      // SIGKILL is used instead of SIGTERM because Electron's before-quit
      // handler shows a confirmation dialog on SIGTERM. SIGKILL has no
      // handlers — the process exits immediately with no dialog.
      launching = true;
      say(HOST_LABEL + ' reopened without CDP (pid ' + owner + ') -> waiting 3s');
      await sleep(3000);
      const owner2 = lockOwnerPid();
      if (owner2 === null || !pidAlive(owner2)) {
        say(HOST_LABEL + ' exited during wait; staying armed');
        launching = false;
        return;
      }
      // SIGKILL: no dialog, immediate exit
      try { process.kill(owner2, 'SIGKILL'); } catch (e) {}
      let waited = 0;
      while (pidAlive(owner2) && waited < 5000) { await sleep(200); waited += 200; }
      // Relaunch with CDP
      const pid = launch();
      say(HOST_LABEL + ' relaunched with CDP (pid ' + pid + '); verifying');
      const deadline = Date.now() + VERIFY_SECS * 1000;
      let pass = 0;
      let last = '';
      while (Date.now() < deadline) {
        await sleep(1500);
        if (!pidAlive(pid)) {
          const winner = lockOwnerPid();
          if (winner !== null && pidAlive(winner)) {
            say('spawn pid ' + pid + ' lost race to pid ' + winner + '; staying armed');
            const stale = cdpPort();
            if (stale && !listenerPid(stale)) {
              try { fs.unlinkSync(PORT_FILE); } catch (e) {}
            }
            lastOwnerPid = winner; // don't retry this instance
          } else {
            say('spawn pid ' + pid + ' exited before verification; staying armed');
          }
          launching = false;
          return;
        }
        const v2 = verify();
        if (v2.ok) {
          pass += 1;
          if (pass >= 2) {
            lastOwnerPid = pid;
            say('VERIFIED: port ' + v2.port + ', pid ' + v2.pid + '; staying armed');
            launching = false;
            return;
          }
        } else {
          pass = 0;
          if (v2.why !== last) { say('  ...' + v2.why); last = v2.why; }
        }
      }
      say('verification timed out; staying armed');
      launching = false;
      return;
    }

    // App is not running. Don't auto-restart — stay armed and wait.
    if (disabled()) { say('disabled; exiting'); process.exit(0); }
  };

  /* Updaters and Dock relaunches can compete within a few dozen milliseconds of
   * singleton-lock release. Poll at 20ms so the flagged launch usually enters
   * first; the hot path is one readlink plus kill(pid, 0), with no process scan. */
  setInterval(() => { attempt().catch(() => {}); }, 20);
}

main().catch((e) => { say('fatal: ' + (e && e.message)); process.exit(1); });
