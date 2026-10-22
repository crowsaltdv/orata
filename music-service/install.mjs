// Orata — installs what the Music page needs (the Python library ytmusicapi) into music-service/vendor.
// It runs by itself after `npm install` (package.json "postinstall"), so a host that only runs `npm install` — Render, a Droplet, your own PC — gets music
// without any extra step. It never fails the install: music is optional, and without it everything else in Orata works.
//
//   node music-service/install.mjs             installs ytmusicapi unless it is already there
//   node music-service/install.mjs --upgrade   updates it (npm run music:update) — worth doing if search stops working
//
// It needs a Python 3.10 or newer with pip. When the machine's own Python is missing or too old (Render's Node image has an old one), it downloads a
// private Python 3.12 with uv (about a minute, ~40 MB, kept in music-service/python). Environment: MUSIC_INSTALL=off skips all of this · MUSIC_PYTHON=/path/to/python
// picks the Python to use · MUSIC_INSTALL_MANAGED=1 always uses the private Python.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.join(DIR, 'vendor'); const TOOLS = path.join(DIR, 'tools'); const PRIVATE = path.join(DIR, 'python');
const MARK = path.join(DIR, '.python');   // which Python to run the helper with, as a JSON array (read by server/music.js)
const REQUIREMENTS = path.join(DIR, 'requirements.txt');
const UPGRADE = process.argv.includes('--upgrade');
const WANT = [3, 10];
const off = (v) => /^(off|false|0|no)$/i.test(String(v || '').trim());
const on = (v) => /^(on|true|1|yes)$/i.test(String(v || '').trim());
const log = (m) => console.log(`music: ${m}`);
const run = (cmd, args, env) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 900_000, windowsHide: true, env: env ? { ...process.env, ...env } : process.env });
const tail = (r) => String(r.stderr || r.error?.message || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 300);
const atLeast = (v, w) => v[0] > w[0] || (v[0] === w[0] && v[1] >= w[1]);

/** A working Python on this machine: { cmd: [program, ...args], version: [3, 12], exe } or null. */
function probe(cmd) {
  const r = run(cmd[0], [...cmd.slice(1), '-c', "import sys;print('%d.%d' % sys.version_info[:2]);print(sys.executable)"]);
  if (r.status !== 0) return null;
  const [v, exe] = String(r.stdout).trim().split(/\r?\n/);
  const version = (v || '').split('.').map(Number);
  return version.length === 2 && version.every(Number.isFinite) ? { cmd, version, exe: exe || cmd[0] } : null;
}
const hasPip = (py) => run(py.cmd[0], [...py.cmd.slice(1), '-m', 'pip', '--version']).status === 0;
function pythons() {
  const list = [];
  if (process.env.MUSIC_PYTHON) list.push([process.env.MUSIC_PYTHON]);
  for (const v of ['3.13', '3.12', '3.11', '3.10']) list.push([`python${v}`]);
  list.push(...(process.platform === 'win32' ? [['python'], ['py', '-3']] : [['python3'], ['python']]));
  return list.map(probe).filter(Boolean);
}

/** Is ytmusicapi already installed for the Python we recorded? */
function installed() {
  try {
    const cmd = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    if (!Array.isArray(cmd) || !fs.existsSync(path.join(VENDOR, 'ytmusicapi'))) return false;
    return run(cmd[0], [...cmd.slice(1), '-c', `import sys; sys.path.insert(0, ${JSON.stringify(VENDOR)}); import ytmusicapi`]).status === 0;
  } catch { return false; }
}
function finish(py) {
  fs.writeFileSync(MARK, JSON.stringify([py.exe]));
  log(`ytmusicapi is installed (Python ${py.version.join('.')}). The Music page is ready.`);
}
const pipArgs = ['--quiet', '--disable-pip-version-check', '--target', VENDOR, ...(UPGRADE ? ['--upgrade'] : []), '-r', REQUIREMENTS];

function withSystemPython(py) {
  log(`installing ytmusicapi with Python ${py.version.join('.')} …`);
  const base = [...py.cmd.slice(1), '-m', 'pip', 'install'];
  let r = run(py.cmd[0], [...base, ...pipArgs]);
  if (r.status !== 0 && /externally-managed/i.test(String(r.stderr))) r = run(py.cmd[0], [...base, '--break-system-packages', ...pipArgs]);   // Debian/Ubuntu's Python; this only writes into music-service/vendor
  if (r.status === 0) { finish(py); return true; }
  log(`pip could not install it: ${tail(r)}`);
  return false;
}

/** No usable Python: fetch uv (from PyPI, into music-service/tools), let it download Python 3.12 into music-service/python, and install into that. */
function withPrivatePython(base) {
  const env = { PYTHONPATH: TOOLS, UV_PYTHON_INSTALL_DIR: PRIVATE, UV_NO_PROGRESS: '1' };
  const uv = (...args) => run(base.cmd[0], [...base.cmd.slice(1), '-m', 'uv', ...args], env);
  let r = run(base.cmd[0], [...base.cmd.slice(1), '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--target', TOOLS, 'uv']);
  if (r.status !== 0 && /externally-managed/i.test(String(r.stderr))) r = run(base.cmd[0], [...base.cmd.slice(1), '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--break-system-packages', '--target', TOOLS, 'uv']);
  if (r.status !== 0) { log(`could not get uv: ${tail(r)}`); return false; }
  r = uv('python', 'install', '3.12'); if (r.status !== 0) { log(`could not download Python: ${tail(r)}`); return false; }
  r = uv('python', 'find', '3.12'); const exe = String(r.stdout || '').trim().split(/\r?\n/)[0];
  const py = r.status === 0 && exe ? probe([exe]) : null; if (!py) { log('the downloaded Python does not start'); return false; }
  r = uv('pip', 'install', '--quiet', '--python', py.exe, '--target', VENDOR, ...(UPGRADE ? ['--upgrade'] : []), '-r', REQUIREMENTS);
  if (r.status !== 0) { log(`could not install ytmusicapi: ${tail(r)}`); return false; }
  finish(py); return true;
}

function main() {
  if (off(process.env.MUSIC_INSTALL) || off(process.env.MUSIC)) return log('skipped (MUSIC_INSTALL / MUSIC is off).');
  if (!fs.existsSync(REQUIREMENTS)) return undefined;
  if (!UPGRADE && installed()) return log('ytmusicapi is already installed.');
  const found = pythons();
  if (!on(process.env.MUSIC_INSTALL_MANAGED)) {
    const py = found.find((p) => atLeast(p.version, WANT) && hasPip(p));
    if (py && withSystemPython(py)) return undefined;
  }
  const base = found.find((p) => atLeast(p.version, [3, 8]) && hasPip(p));
  if (!base) return log('skipped: this machine has no Python with pip. Install Python 3.10+ and run: npm run music:update   (everything except the Music page works without it)');
  log('no usable Python 3.10+ here, so a private Python 3.12 is downloaded with uv (about a minute) …');
  if (!withPrivatePython(base)) log('the Music page will say what is missing. Install Python 3.10+ and run: npm run music:update   (everything else works)');
  return undefined;
}
try { main(); } catch (e) { log(`skipped: ${e.message}`); }   // never fail `npm install` over music
process.exit(0);
