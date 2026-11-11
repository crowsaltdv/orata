// Move your data between local files (data/), PostgreSQL (DATABASE_URL) and Cloudflare R2 (R2_BUCKET, README → "Cloudflare R2 for uploaded files"):
//   npm run db:info                      what is stored in the database (and in R2) and how full it is
//   npm run db:import [-- --force]       copy data/db.json + data/uploads INTO the database (the uploads into R2 when R2 is set up); refuses to overwrite unless --force
//   npm run db:export [-- --force]       copy the database (and R2) back OUT to data/ (existing data/db.json is backed up first)
//   npm run db:files-to-r2 [-- --purge]  move the uploaded files kept in the database into the R2 bucket, then check every one is there; with --purge, and only when every
//                                        one is, empty the database's table of files (which gives its space back at once). [-- --from-disk] also copies data/uploads.
// (Starting Orata with DATABASE_URL against an empty database also imports local files automatically — this is for the other cases.)
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENV } from './env.js';
import { PgStore, isSafeFileName } from './storage.js';
import { R2Store, migrateFiles } from './r2.js';

const [cmd, ...flags] = process.argv.slice(2);
const force = flags.includes('--force'); const purge = flags.includes('--purge'); const fromDisk = flags.includes('--from-disk');
const DATA = process.env.ORATE_DATA || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json'); const UPLOADS = path.join(DATA, 'uploads');
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

class Stop extends Error {}                                  // a user-facing problem: print it, close the database, exit 1
const die = (msg) => { throw new Stop(msg); };
const usage = (msg) => { console.error(`\n  ✗ ${msg}\n`); process.exit(1); };

if (!['info', 'import', 'export', 'files-to-r2'].includes(cmd)) usage('Usage: npm run db:info | db:import | db:export | db:files-to-r2   (add "-- --force" to overwrite; "-- --purge" with db:files-to-r2 empties the database’s files afterwards)');
let r2 = null; try { r2 = R2Store.fromEnv(ENV); } catch (e) { usage(e.message); }
if (cmd === 'files-to-r2') {
  if (!r2) usage('R2 is not set up. Put R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY in .env (or the environment) first — see README → "Cloudflare R2 for uploaded files".');
} else if (!ENV.DATABASE_URL) usage('DATABASE_URL is not set. Put it in .env (or the environment) first — see README → "Free hosting with a free database".');
const pg = ENV.DATABASE_URL ? new PgStore(ENV.DATABASE_URL, ENV) : null;

const summarize = (json) => { const d = JSON.parse(json); const msgs = Object.values(d.messages || {}).reduce((n, l) => n + l.length, 0); return `${Object.values(d.users || {}).filter((u) => !u.bot).length} user(s), ${Object.keys(d.servers || {}).length} server(s), ${msgs} message(s)`; };
const sum = (files) => files.reduce((n, f) => n + f.size, 0);

let code = 0;
try {
  if (pg) await pg.init();
  if (r2) await r2.init();
  if (pg) console.log(`\n  Database: ${pg.host}`); else console.log('');
  if (r2) console.log(`  Uploaded files: ${r2.host}`);
  if (cmd === 'info') {
    if (pg) {
      const st = await pg.loadState();
      console.log(st ? `  State: version ${st.version} — ${summarize(st.json)}` : '  State: empty (nothing stored yet)');
      const files = await pg.listFiles();
      console.log(r2 ? `  Files still in the database: ${files.length} file(s), ${mb(sum(files))}${files.length ? ' — `npm run db:files-to-r2 -- --purge` moves them to R2 and gives the space back' : ''}`
        : `  Files: ${files.length} uploaded file(s), ${mb(sum(files))} of ${mb(pg.filesLimit)} allowed (DATABASE_FILES_MB)`);
    }
    if (r2) { const files = await r2.listFiles(); console.log(`  Files in R2: ${files.length} file(s), ${mb(sum(files))} of ${mb(r2.filesLimit)} allowed (R2_FILES_MB)`); }
    console.log('');
  } else if (cmd === 'import') {
    if (!fs.existsSync(DB_FILE)) die(`No local data found at ${DB_FILE}.`);
    const json = fs.readFileSync(DB_FILE, 'utf8');
    let info; try { info = summarize(json); } catch (e) { die(`data/db.json is not valid JSON: ${e.message}`); }
    const cur = await pg.loadState();
    if (cur && !force) die(`The database already holds data (${summarize(cur.json)}). Nothing was changed. Add "-- --force" to overwrite it with your local data.`);
    await pg.forceState(json);
    console.log(`  ✓ Imported data/db.json: ${info}`);
    const r = await (r2 || pg).importDir(UPLOADS, console.log);
    console.log(`  ✓ Uploaded files: ${r.added} copied to ${r2 ? 'R2' : 'the database'} (${mb(r.bytes)}), ${r.skipped} skipped (already there)\n`);
  } else if (cmd === 'export') {
    const cur = await pg.loadState();
    if (!cur) die('The database is empty, nothing to export.');
    if (fs.existsSync(DB_FILE)) {
      if (!force) die(`${DB_FILE} already exists. Nothing was changed. Add "-- --force" to replace it (a backup copy is kept).`);
      const bak = `${DB_FILE}.bak-${Date.now()}`; fs.copyFileSync(DB_FILE, bak); console.log(`  Backed up the old file to ${path.basename(bak)}`);
    }
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(DB_FILE, cur.json);
    console.log(`  ✓ Wrote data/db.json: ${summarize(cur.json)}`);
    if (r2) await r2.exportDir(UPLOADS, console.log);
    await pg.exportDir(UPLOADS, console.log);   // (with R2, the files not moved there yet)
    console.log(`  ✓ Wrote ${fs.readdirSync(UPLOADS).length} uploaded file(s) to data/uploads\n`);
  } else {
    const sources = [];
    if (pg) sources.push({ label: 'the database', list: () => pg.listFiles(), get: (name) => pg.getFile(name), purge: () => pg.purgeFiles() });
    if ((fromDisk || !pg) && fs.existsSync(UPLOADS)) sources.push({
      label: 'data/uploads', get: async (name) => ({ data: fs.readFileSync(path.join(UPLOADS, name)) }),
      list: async () => fs.readdirSync(UPLOADS).filter((n) => isSafeFileName(n) && fs.statSync(path.join(UPLOADS, n)).isFile()).map((name) => ({ name, size: fs.statSync(path.join(UPLOADS, name)).size })),
    });
    if (!sources.length) die('Nothing to move: there is no DATABASE_URL, and no data/uploads folder.');
    if (purge && !pg) die('--purge empties the database’s table of files, and there is no DATABASE_URL here.');
    const r = await migrateFiles({ sources, to: r2, purge, log: console.log });
    console.log(`  ✓ ${r.copied} file(s) copied to R2 (${mb(r.bytes)}), ${r.skipped} were there already`);
    if (r.missing.length) {
      console.log(`  ✗ ${r.missing.length} file(s) are not in R2 with the right size: ${r.missing.slice(0, 8).join(', ')}${r.missing.length > 8 ? ' …' : ''}`);
      console.log(`  Nothing was deleted${purge ? ', whatever --purge said' : ''}. Run the command again, or look at the message above.\n`); code = 1;
    } else {
      console.log('  ✓ Checked: every file is in the bucket, with the same size');
      if (r.purged.length) console.log(`  ✓ Emptied the files kept in ${r.purged.join(' and ')}: that space is free again`);
      else if (pg) console.log('  Run it again with -- --purge to empty the database’s copy of the files, which is what gives the space back.');
      console.log('');
    }
  }
} catch (e) {
  console.error(`\n  ✗ ${e.message}\n`); code = 1;
} finally {
  await pg?.close(); await r2?.close();
}
process.exit(code);
