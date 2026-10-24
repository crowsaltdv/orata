// Orata — the desktop app's installer: which one this server hands out. It is the newest "Orata Setup x.y.z.exe" in the downloads folder, or else an outside link.
// The file itself stays out of git (GitHub refuses files over 100 MB): put it in downloads/ on the server, or point DESKTOP_APP_URL at a release page's direct link.
import fs from 'node:fs';
import path from 'node:path';
import { ENV, ROOT } from './core.js';

const dir = () => path.resolve(ENV.DESKTOP_DIR || path.join(ROOT, 'downloads'));
const NAME = /^Orata[ -]Setup[ -](\d{1,3})\.(\d{1,3})\.(\d{1,3})\.exe$/i;
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
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
  seen = { at: Date.now(), file: best && { name: best.name, path: best.path, version: best.version, size: best.size } };
  return seen.file;
}

/** What the website needs to offer the download: { version, size, url }, or null when there is nothing to offer. A file on this server wins over DESKTOP_APP_URL. */
export function desktopInfo() {
  const f = desktopFile();
  if (f) return { version: f.version, size: f.size, url: '/api/download/desktop' };
  const link = String(ENV.DESKTOP_APP_URL || '').trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(link)) return { version: String(ENV.DESKTOP_APP_VERSION || '').trim().slice(0, 20) || null, size: null, url: link };
  return null;
}
