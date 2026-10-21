// Orata — what people may be called (usernames and display names). Words that sound like authority — Orata itself, staff, admins, moderators,
// developers — are kept for the people who really are that (the two founders and anyone with the dev or staff badge), so nobody can pretend to
// be Orata; and no name may contain a swear word or slur (profanity.js's built-in list). Look-alike digits count: 0rata, st4ff, m0d.
import { hasProfanity } from './profanity.js';
import { byUsername, ORATE_DEV_ID } from './core.js';

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
const ANYWHERE = /orata|orat[ae](?:dev|staff|team|mod|admin|official|support|bot)|staff|moderator|administrator|official/;   // even inside a longer name
const WORDS = new Set(['orate', 'admin', 'admins', 'mod', 'mods', 'dev', 'devs', 'developer', 'developers', 'support', 'founder']);   // as a word of their own ("modern" is fine)

/** oratedev and Orate_dev: the only ones who can hand out the staff and dev badges. */
export const isFounder = (u) => !!u && (u.id === ORATE_DEV_ID || u.id === byUsername.get('oratedev'));
export const isStaff = (u) => isFounder(u) || !!u?.badges?.some((b) => b === 'dev' || b === 'staff');

/** Why `name` can't be used by `user` (null for a new account), or null when it's fine. */
export function nameProblem(name, user = null) {
  const plain = String(name || '').toLowerCase().replace(/[0-9@$]/g, (c) => LEET[c] || c);
  if (hasProfanity(name) || hasProfanity(plain)) return 'That name isn’t allowed.';
  if (isStaff(user)) return null;
  if (ANYWHERE.test(plain.replace(/[^a-z]/g, '')) || plain.split(/[^a-z]+/).some((w) => WORDS.has(w))) return 'That name is kept for Orata staff, so nobody can pretend to be them.';
  return null;
}
