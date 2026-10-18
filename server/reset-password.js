// Reset a user's password from the command line:  npm run reset-password <username> [new-password]
import crypto from 'node:crypto';
import { db, byUsername, save, flush } from './core.js';

const [name, given] = process.argv.slice(2);
if (!name) { console.error('Usage: npm run reset-password <username> [new-password]'); process.exit(1); }
const id = byUsername.get(name.toLowerCase());
const user = id && db.users[id];
if (!user || user.bot) { console.error(`No such user: ${name}`); process.exit(1); }
const password = given || crypto.randomBytes(9).toString('base64url');
const salt = crypto.randomBytes(16).toString('hex');
user.salt = salt; user.hash = crypto.scryptSync(password, salt, 64).toString('hex');
for (const [k, s] of Object.entries(db.sessions)) if (s.userId === user.id) delete db.sessions[k];
save(); flush();
console.log(`Password for @${user.username} is now: ${password}\nAll existing sessions were signed out.`);
process.exit(0);
