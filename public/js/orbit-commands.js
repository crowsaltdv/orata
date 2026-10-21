// Orata — the commands Orbit answers in a server (shared by the server, which runs them, and the message box, which suggests them).
// `perm` is the permission a command needs by default; Orbit's /settings can narrow any command to chosen roles. `only` = the reply only shows to whoever used it.
// `discord` = only there when the Orata server has a Discord bot set up (DISCORD_BOT_TOKEN).
// No browser or server APIs in here on purpose.

export const ORBIT_COMMANDS = [
  { name: 'help', desc: 'Everything Orbit can do for you', only: true },
  { name: 'ping', desc: 'Check that Orbit is awake', only: true },
  { name: 'roll', desc: 'Roll dice', arg: '2d6' },
  { name: 'flip', desc: 'Flip a coin' },
  { name: '8ball', desc: 'Ask the magic 8-ball', arg: 'question' },
  { name: 'choose', desc: 'Let Orbit pick for you', arg: 'pizza | tacos | sushi' },
  { name: 'joke', desc: 'Hear a joke' },
  { name: 'remind', desc: 'Orbit pings you here later', arg: '10m stretch' },
  { name: 'say', desc: 'Make Orbit post a message', arg: 'message', perm: 'MANAGE_MESSAGES' },
  { name: 'kick', desc: 'Kick a member', arg: '@member or ID [reason]', perm: 'KICK_MEMBERS' },
  { name: 'ban', desc: 'Ban a member', arg: '@member or ID [reason]', perm: 'BAN_MEMBERS' },
  { name: 'timeout', desc: 'Time a member out', arg: '@member or ID 10m [reason]', perm: 'MODERATE_MEMBERS' },
  { name: 'reactionroles', desc: 'Post a message where reacting gives a role', perm: 'MANAGE_ROLES', only: true },
  { name: 'settings', desc: 'Change Orbit’s name, picture and who can use each command', perm: 'MANAGE_SERVER', only: true },
  { name: 'link', desc: 'Link this channel with a Discord channel', perm: 'MANAGE_SERVER', only: true, discord: true },
  { name: 'unlink', desc: 'Stop mirroring this channel with Discord', perm: 'MANAGE_SERVER', discord: true },
];
export const orbitCommand = (name) => ORBIT_COMMANDS.find((c) => c.name === String(name || '').toLowerCase()) || null;

/** "90s", "10m", "2h", "1d", "1w" (or a bare number of minutes) → milliseconds; null when it can't be read. */
export function parseDuration(s) {
  const m = /^(\d{1,5})\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)?$/i.exec(String(s || '').trim());
  if (!m) return null;
  const unit = (m[2] || 'm').toLowerCase()[0];
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3600_000, d: 86400_000, w: 604800_000 }[unit] || null;
}
/** 5400000 → "1 hour 30 minutes" (the two biggest parts). */
export function formatDuration(ms) {
  const parts = []; let left = Math.max(0, Math.floor(ms / 1000));   // rounded down: "6 days 23 hours" left, not "1 week"
  for (const [n, s] of [['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) {
    const k = Math.floor(left / s); if (k) { parts.push(`${k} ${n}${k === 1 ? '' : 's'}`); left -= k * s; }
  }
  return parts.slice(0, 2).join(' ') || '0 seconds';
}
