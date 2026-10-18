// Mark an account's email as verified from the command line:  npm run verify-email <username>
// Handy when REQUIRE_EMAIL_VERIFICATION is on and someone can't receive their email.
import { db, byUsername, save, flush } from './core.js';

const [name] = process.argv.slice(2);
if (!name) { console.error('Usage: npm run verify-email <username>'); process.exit(1); }
const id = byUsername.get(name.toLowerCase());
const user = id && db.users[id];
if (!user || user.bot) { console.error(`No such user: ${name}`); process.exit(1); }
user.emailVerified = true; user.emailVerifiedAt = Date.now();
for (const [k, t] of Object.entries(db.emailTokens || {})) if (t.uid === user.id) delete db.emailTokens[k];
save(); await flush();
console.log(`@${user.username} (${user.email}) is now marked as verified. If their server is running, restart it or ask them to reload.`);
process.exit(0);
