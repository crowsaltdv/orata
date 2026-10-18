// Move your data between local files (data/) and PostgreSQL (DATABASE_URL):
//   npm run db:info                      what is stored in the database and how full it is
//   npm run db:import [-- --force]       copy data/db.json + data/uploads INTO the database (refuses to overwrite unless --force)
//   npm run db:export [-- --force]       copy the database back OUT to data/ (existing data/db.json is backed up first)
// (Starting Orate with DATABASE_URL against an empty database also imports local files automatically — this is for the other cases.)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENV } from './env.js';
import { PgStore } from './storage.js';

const [cmd, ...flags] = process.argv.slice(2);
const force = flags.includes('--force');
const DATA = process.env.ORATE_DATA || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json'); const UPLOADS = path.join(DATA, 'uploads');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

class Stop extends Error {}                                  // a user-facing problem: print it, close the database, exit 1
const die = (msg) => { throw new Stop(msg); };
const usage = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };

if (!['info', 'import', 'export'].includes(cmd)) usage('Usage: npm run db:info | db:import | db:export   (add "-- --force" to overwrite)');
if (!ENV.DATABASE_URL) usage('DATABASE_URL is not set. Put it in .env (or the environment) first — see README → "Free hosting with a free database".');

const summarize = (json) => { const d = JSON.parse(json); const msgs = Object.values(d.messages || {}).reduce((n, l) => n + l.length, 0); return `${Object.values(d.users || {}).filter((u) => !u.bot).length} user(s), ${Object.keys(d.servers || {}).length} server(s), ${msgs} message(s)`; };

const pg = new PgStore(ENV.DATABASE_URL, ENV);
let code = 0;
try {
  await pg.init();
  console.log(`\n  Database: ${pg.host}`);
  if (cmd === 'info') {
    const st = await pg.loadState();
    console.log(st ? `  State: version ${st.version} — ${summarize(st.json)}` : '  State: empty (nothing stored yet)');
    const files = await pg.listFiles(); const bytes = files.reduce((n, f) => n + f.size, 0);
    console.log(`  Files: ${files.length} uploaded file(s), ${mb(bytes)} of ${mb(pg.filesLimit)} allowed (DATABASE_FILES_MB)\n`);
  } else if (cmd === 'import') {
    if (!fs.existsSync(DB_FILE)) die(`No local data found at ${DB_FILE}.`);
    const json = fs.readFileSync(DB_FILE, 'utf8');
    let info; try { info = summarize(json); } catch (e) { die(`data/db.json is not valid JSON: ${e.message}`); }
    const cur = await pg.loadState();
    if (cur && !force) die(`The database already holds data (${summarize(cur.json)}). Nothing was changed. Add "-- --force" to overwrite it with your local data.`);
    await pg.forceState(json);
    console.log(`  ✓ Imported data/db.json: ${info}`);
    const r = await pg.importDir(UPLOADS, console.log);
    console.log(`  ✓ Uploaded files: ${r.added} copied (${mb(r.bytes)}), ${r.skipped} skipped (already there)\n`);
  } else {
    const cur = await pg.loadState();
    if (!cur) die('The database is empty, nothing to export.');
    if (fs.existsSync(DB_FILE)) {
      if (!force) die(`${DB_FILE} already exists. Nothing was changed. Add "-- --force" to replace it (a backup copy is kept).`);
      const bak = `${DB_FILE}.bak-${Date.now()}`; fs.copyFileSync(DB_FILE, bak); console.log(`  Backed up the old file to ${path.basename(bak)}`);
    }
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(DB_FILE, cur.json);
    console.log(`  ✓ Wrote data/db.json: ${summarize(cur.json)}`);
    console.log(`  ✓ Wrote ${await pg.exportDir(UPLOADS, console.log)} uploaded file(s) to data/uploads\n`);
  }
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`); code = 1;
} finally {
  await pg.close();
}
process.exit(code);
