// Orata — AutoMod: a server's automatic message rules (Server Settings → Safety), kept in server.automod = { links, invites, mentions, spam, timeout }.
// What happens when a rule is broken (the message is refused, logged in the audit log, maybe a timeout) is up to api.js; this only finds the rule.
// The owner, co-owners, admins and anyone who can manage messages are never checked.
import { can, isOwner } from './core.js';

const LINK = /\bhttps?:\/\/\S+|\bwww\.[a-z0-9-]+\.[a-z]{2,}\S*/i;
const INVITE = /\/invite\/[A-Za-z0-9-]{3,}|discord(?:app)?\.(?:gg|com\/invite)\/\S+/i;
const recent = new Map();   // `${serverId}:${userId}` -> [{ at, text }] for the last 30 seconds (spam)
setInterval(() => { const old = Date.now() - 30_000; for (const [k, list] of recent) if (!list.some((x) => x.at > old)) recent.delete(k); }, 300_000).unref();

/** The rule `text` breaks in server `s` ('links', 'invite links', 'that many mentions' or 'spam'), or null. Edits skip the spam rule. */
export function automodRule(s, userId, text, { edit = false } = {}) {
  const a = s?.automod;
  if (!a || isOwner(s, userId) || can(s, userId, 'ADMINISTRATOR') || can(s, userId, 'MANAGE_MESSAGES')) return null;
  const t = String(text || '');
  if (a.invites && INVITE.test(t)) return 'invite links';
  if (a.links && LINK.test(t)) return 'links';
  if (a.mentions) {
    const n = new Set(t.match(/<@[!&]?\d{6,20}>/g) || []).size + (/(^|\s)@(everyone|here)\b/.test(t) ? 1 : 0);
    if (n > a.mentions) return 'that many mentions';
  }
  if (a.spam && !edit) {   // 5 messages within 5 seconds, or the same message a third time within 30 seconds
    const key = `${s.id}:${userId}`; const now = Date.now(); const said = t.trim();
    const list = (recent.get(key) || []).filter((x) => now - x.at < 30_000);
    const burst = list.filter((x) => now - x.at < 5000).length >= 5; const again = !!said && list.filter((x) => x.text === said).length >= 2;
    list.push({ at: now, text: said }); recent.set(key, list.slice(-20));
    if (burst || again) return 'spam';
  }
  return null;
}
