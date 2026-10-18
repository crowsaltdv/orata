// Orate — configuration from .env (plus real environment variables, which win). Shared by the server and the command-line tools.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const env = {};
  try {
    const raw = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !line.trim().startsWith('#')) {
        let v = m[2];
        const q = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(v);   // "quoted value" (may contain #), optionally followed by a comment
        v = q ? q[2] : v.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');   // otherwise drop a trailing " # comment"
        env[m[1]] = v;
      }
    }
  } catch { /* no .env (e.g. on a host that sets real environment variables) */ }
  return { ...env, ...process.env };
}
export const ENV = loadEnv();
