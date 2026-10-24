// Orata — the desktop app's installer: which one this server hands out. It is the newest "Orata Setup x.y.z.exe" in the downloads folder.
// The file itself stays out of git (GitHub refuses files over 100 MB): put it in downloads/ on the server, or set DESKTOP_APP_URL to a direct link
// (e.g. a file attached to a GitHub release) and the server fetches it into downloads/ itself. Either way people only ever see Orata's own address.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ENV, ROOT } from './core.js';

const dir = () => path.resolve(ENV.DESKTOP_DIR || path.join(ROOT, 'downloads'));
const NAME = /^Orata[ -]Setup[ -](\d{1,3})\.(\d{1,3})\.(\d{1,3})\.exe$/i;
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const MAX_BYTES = 500 * 1024 * 1024;
let seen = { at: 0, file: null };

/** The newest installer in the downloads folder — { name, path, version, size } — or null. Looked at again every few seconds, so a new file needs no restart. */
export function desktopFile() {
  if (Date.now() - seen.at < 5000) return seen.file;
  let best = null;
  try {
    for (const name of fs.readdirSync(dir())) {
      const m = NAME.exec(name); if (!m) continue;
      const full = path.join(dir(), name); const st = fs.statSync(full); if (!st.isFile() || !st.size) continue;
      const v = m.slice(1).map(Number);
      if (!best || newer(v, best.v) > 0) best = { name, path: full, version: v.join('.'), size: st.size, v };
    }
  } catch { /* no downloads folder: nothing to hand out */ }
  seen = { at: Date.now(), file: best && { name: best.name, path: best.path, version: best.version, size: best.size, v: best.v } };
  return seen.file;
}

/** DESKTOP_APP_URL, when it is a direct https link (plain http only for this computer, so the installer can't be swapped on the way): { link, v: [x, y, z], known } or null. */
function remote() {
  const link = String(ENV.DESKTOP_APP_URL || '').trim();
  if (!/^(https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/)[^\s"'<>]+$/i.test(link)) return null;
  const guess = (s) => /(\d{1,3})\.(\d{1,3})\.(\d{1,3})/.exec(s);
  let m = guess(String(ENV.DESKTOP_APP_VERSION || '').trim());
  try { m ||= guess(decodeURIComponent(new URL(link).pathname).split('/').pop()); } catch { /* not a URL we can read a version from */ }
  return { link, v: m ? m.slice(1).map(Number) : [0, 0, 0], known: !!m };
}

const address = (v) => (v && v !== '0.0.0' ? { version: v, url: `/download/${v}` } : { version: null, url: '/download' });   // 0.0.0: a link whose version we couldn't tell

/** What the website needs to offer the download: { version, size, url }, or null when there is nothing to offer. The address is always Orata's own (/download/<version>). */
export function desktopInfo() {
  const f = desktopFile(); const r = remote();
  if (f) return { ...address(f.version), size: f.size };
  if (r) return { ...address(r.known && r.v.join('.')), size: null };
  return null;
}

let pulling = null;      // the fetch of DESKTOP_APP_URL in progress: everyone who asks meanwhile waits for this one
let failedAt = 0;        // when the last fetch failed (not retried for a minute, so a dead link isn't hammered)

/**
 * Makes sure the installer is in the downloads folder: when DESKTOP_APP_URL names a newer one than any file already there, fetches it (once; the .part file is renamed when complete).
 * Resolves to the newest installer — { name, path, version, size } — or null; never rejects.
 */
export function mirrorDesktop() {
  const r = remote(); const have = desktopFile();
  if (!r || (have && newer(have.v, r.v) >= 0)) return Promise.resolve(have);
  if (pulling) return pulling;
  if (Date.now() - failedAt < 60_000) return Promise.resolve(have);
  const run = async () => {
    const final = path.join(dir(), `Orata Setup ${r.v.join('.')}.exe`); const part = `${final}.part`;
    try {
      fs.mkdirSync(dir(), { recursive: true });
      const res = await fetch(r.link, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });   // a release link redirects to the file itself
      if (!res.ok || !res.body) throw new Error(`the link answered ${res.status}`);
      if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('the file is over 500 MB');
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
      const size = fs.statSync(part).size;
      if (size < 100_000) throw new Error(`that is only ${size} bytes, not an installer (is it the direct file link, not a web page?)`);
      fs.renameSync(part, final); seen.at = 0; failedAt = 0;
      console.log(`    Desktop app: fetched ${path.basename(final)} (${(size / 1048576).toFixed(0)} MB) from DESKTOP_APP_URL`);
    } catch (e) {
      fs.rmSync(part, { force: true }); failedAt = Date.now();
      console.error(`    Desktop app: couldn't fetch DESKTOP_APP_URL — ${e.message}`);
    }
    return desktopFile();
  };
  pulling = run().finally(() => { pulling = null; });
  return pulling;
}
