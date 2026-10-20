// Orbit — a tiny built-in helper bot that answers DMs so a fresh install never feels empty.
import { db, emitTo, ensureBot } from './core.js';
import { hooks, postMessage } from './messages.js';

export const JOKES = [
  'Why do programmers prefer dark mode? Because light attracts bugs. 🐛',
  'There are 10 kinds of people: those who understand binary and those who don’t.',
  'A SQL query walks into a bar, sees two tables and asks: “Can I join you?”',
  'Why did the developer go broke? Because he used up all his cache. 💸',
  'I would tell you a UDP joke, but you might not get it.',
];
export const BALL = ['It is certain.', 'Without a doubt.', 'Ask again later.', 'Don’t count on it.', 'My sources say no.', 'Signs point to yes.', 'Very doubtful.', 'Outlook good.'];

const HELP = [
  '**Hey, I’m Orbit!** Here’s what you can do in Orate:',
  '• Create or join a **server** with the **+** in the server rail',
  '• Press **Ctrl+K** to jump to any chat, **Ctrl+/** for shortcuts',
  '• Format with `**bold**`, `*italic*`, `~~strike~~`, `||spoiler||` and fenced code',
  '• Drop in **GIFs**, **stickers**, **emojis** and files — drag & drop works too',
  '• Make it yours in **User Settings → Appearance**: wallpapers, rain, glass buttons, fonts & colors',
  '',
  'Try messaging me: `ping`, `roll 2d6`, `flip`, `joke`, `8ball will it rain?`, `time`',
].join('\n');

/** "2d6", "d20", "3" … → "🎲 4 + 2 = **6**" (at most 20 dice of up to 9999 sides). */
export function rollDice(spec) {
  const m = String(spec || '').toLowerCase().match(/^\s*(\d{1,2})?d?(\d{1,4})?/);
  const n = Math.min(20, Number(m?.[1]) || 1); const sides = Math.max(2, Number(m?.[2]) || 6);
  const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
  return `🎲 ${rolls.join(' + ')}${n > 1 ? ` = **${rolls.reduce((a, b) => a + b, 0)}**` : ''}`;
}

function reply(ch, text) {
  const bot = ensureBot();
  emitTo(ch.recipients || [], 'typing', { channelId: ch.id, userId: bot.id, timestamp: Date.now() });
  setTimeout(() => postMessage(ch, bot.id, { content: text }), 500 + Math.random() * 700);
}

hooks.onMessage.push((ch, msg) => {
  const bot = ensureBot();
  if (ch.serverId || ch.type !== 'dm' || !ch.recipients?.includes(bot.id) || msg.authorId === bot.id || msg.type !== 'default') return;
  const text = (msg.content || '').trim();
  const lower = text.toLowerCase();
  if (!text && (msg.attachments?.length || msg.gif || msg.sticker)) return reply(ch, 'Nice one! 😎');
  if (/^(help|\/help|commands|\?)$/.test(lower)) return reply(ch, HELP);
  if (/^(hi|hello|hey|yo|sup)\b/.test(lower)) return reply(ch, `Hey ${db.users[msg.authorId]?.displayName || 'there'}! 👋 Say \`help\` to see what I can do.`);
  if (/^ping\b/.test(lower)) return reply(ch, 'Pong! 🏓');
  if (/^(flip|coin)\b/.test(lower)) return reply(ch, Math.random() < 0.5 ? 'It’s **heads**! 🪙' : 'It’s **tails**! 🪙');
  if (/^joke\b/.test(lower)) return reply(ch, JOKES[Math.floor(Math.random() * JOKES.length)]);
  if (/^time\b/.test(lower)) return reply(ch, `Server time is **${new Date().toUTCString()}**`);
  if (/^8ball\b/.test(lower)) return reply(ch, `🎱 ${BALL[Math.floor(Math.random() * BALL.length)]}`);
  if (/^roll\b/.test(lower)) return reply(ch, rollDice(lower.slice(4)));
  return reply(ch, 'I’m just a small bot, but I’m learning! Say `help` to see what I can do. ✨');
});
