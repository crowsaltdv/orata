// Orata — chat markdown → sanitized HTML (own parser; every user string is escaped before it is emitted).
import { state, getChannel, nameOf, memberOf, emojiById, allCustomEmojis, customToken } from '/js/store.js';
import { formatClock, relTime, formatFull } from '/js/lib.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const KW = new Set(('abstract as async await boolean break case catch char class const continue debugger default def del delete do double elif else enum except export extends false final finally float fn for from func function go if implements import in instanceof int interface is lambda let long match mod mut namespace new nil none None not null or package pass private protected pub public raise readonly return select self static struct super switch this throw throws true True False try type typeof undefined use using var void volatile while with yield println print echo').split(' '));
const HASH_COMMENT = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'rb', 'ruby', 'toml', 'ini', 'r', 'pl', 'perl', 'dockerfile', 'powershell', 'ps1']);

export function highlight(code, lang = '') {
  lang = lang.toLowerCase();
  if (['html', 'xml', 'svg', 'md', 'markdown', 'txt', 'text', 'plain', 'diff'].includes(lang)) {
    if (lang === 'diff') return esc(code).split('\n').map((l) => (l.startsWith('+') ? `<span class="hl-add">${l}</span>` : l.startsWith('-') ? `<span class="hl-del">${l}</span>` : l)).join('\n');
    return esc(code);
  }
  const hash = HASH_COMMENT.has(lang);
  const re = new RegExp(`(${hash ? '#[^\\n]*' : '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/'})|("(?:\\\\.|[^"\\\\\\n])*"|'(?:\\\\.|[^'\\\\\\n])*'|\`(?:\\\\.|[^\`\\\\])*\`)|\\b(\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?|0x[\\da-f]+)\\b|\\b([A-Za-z_$][\\w$]*)(?=\\()|\\b([A-Za-z_$][\\w$]*)\\b`, 'gi');
  let out = ''; let last = 0; let m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index)); last = m.index + m[0].length; const t = esc(m[0]);
    if (m[1] !== undefined) out += `<span class="hl-c">${t}</span>`;
    else if (m[2] !== undefined) out += `<span class="hl-s">${t}</span>`;
    else if (m[3] !== undefined) out += `<span class="hl-n">${t}</span>`;
    else if (m[4] !== undefined) out += KW.has(m[4]) ? `<span class="hl-k">${t}</span>` : `<span class="hl-f">${t}</span>`;
    else if (m[5] !== undefined && KW.has(m[5])) out += `<span class="hl-k">${t}</span>`;
    else out += t;
  }
  return out + esc(code.slice(last));
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|‍|️|⃣|\s)+$/u;
const CUSTOM_ONLY = /^(?:\s*<a?:[A-Za-z0-9_]{2,32}:\d{6,20}>\s*)+$/;
export function emojiOnlyCount(text) {
  const t = String(text || '').trim();
  if (t && t.length < 700 && CUSTOM_ONLY.test(t)) { const n = (t.match(/<a?:/g) || []).length; return n <= 12 ? n : 0; }   // only custom emoji: shown big
  if (!t || t.length > 120 || !EMOJI_ONLY.test(t)) return 0;
  return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(t.replace(/\s+/g, ''))].length;
}

function fmtTimestamp(unix, style) {
  const ms = Number(unix) * 1000; const d = new Date(ms);
  const o = { t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' }, f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' } }[style];
  if (style === 'R') return relTime(ms);
  return d.toLocaleString([], o || { dateStyle: 'long', timeStyle: 'short' });
}

/** @param {string} src @param {{serverId?: string|null, inline?: boolean}} opts */
export function renderMarkdown(src, opts = {}) {
  const stash = [];
  const put = (h) => { stash.push(h); return `\u0001${stash.length - 1}\u0002`; };
  let s = String(src || '').replace(/[\u0001\u0002]/g, '');

  // fenced + inline code first, so nothing inside is formatted
  s = s.replace(/```(?:([\w+#.-]+)[ \t]*\n)?([\s\S]*?)```/g, (_, lang, code) => {
    code = code.replace(/^\n+|\n+$/g, '');
    const l = (lang || '').toLowerCase();
    return put(`<div class="codeblock"><div class="codeblock-head"><span>${esc(l || 'code')}</span><button type="button" class="codeblock-copy" data-copy>Copy</button></div><pre><code>${highlight(code, l)}</code></pre></div>`);
  });
  s = s.replace(/(`{1,2})(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => put(`<code class="inline-code">${esc(code.trim() ? code : code)}</code>`));
  s = esc(s);

  const serverId = opts.serverId || null;
  const inline = (t) => {
    // masked links [label](url)
    t = t.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" title="${url}" class="link">${label}</a>`));
    // bare links
    t = t.replace(/(^|[\s(>])(https?:\/\/[^\s<>\u0001]+)/g, (_, pre, url) => {
      let trail = ''; const m = url.match(/[.,;:!?)'"\]]+$/); if (m) { trail = m[0]; url = url.slice(0, -trail.length); }
      if (/\)/.test(trail) && (url.match(/\(/g) || []).length > (url.match(/\)/g) || []).length) { url += ')'; trail = trail.slice(1); }
      return pre + put(`<a href="${url}" target="_blank" rel="noopener noreferrer nofollow" class="link">${url}</a>`) + trail;
    });
    // mentions
    t = t.replace(/&lt;@!?(\d{6,20})&gt;/g, (_, id) => put(`<span class="mention${id === state.me?.id ? ' me' : ''}" data-user="${id}" role="button" tabindex="0">@${esc(nameOf(id, serverId))}</span>`));
    t = t.replace(/&lt;@&amp;(\d{6,20})&gt;/g, (_, id) => {
      const role = state.servers[serverId]?.roles.find((r) => r.id === id);
      const c = role?.color; return put(`<span class="mention role" ${c ? `style="--mc:${c}"` : ''}>@${esc(role?.name || 'deleted-role')}</span>`);
    });
    t = t.replace(/&lt;#(\d{6,20})&gt;/g, (_, id) => { const ch = getChannel(id); return put(ch ? `<span class="mention channel" data-channel="${id}" data-server="${ch.serverId || ''}" role="button" tabindex="0">${ch.type === 'voice' ? '🔊' : ch.type === 'stage' ? '🎙️' : '#'}${esc(ch.name)}</span>` : '<span class="mention">#deleted-channel</span>'); });
    // custom emoji: the message carries their pictures (so people outside the server see them too)
    t = t.replace(/&lt;(a?):([A-Za-z0-9_]{2,32}):(\d{6,20})&gt;/g, (_, a, name, id) => {
      const e = (opts.emojis || []).find((x) => x.id === id) || emojiById(id);
      return put(e ? `<img class="emoji custom${e.animated ? ' animated' : ''}" src="${esc(e.url)}" alt=":${esc(name)}:" title=":${esc(name)}:" draggable="false">` : `<span class="emoji-missing">:${esc(name)}:</span>`);
    });
    t = t.replace(/(^|[\s(])@(everyone|here)\b/g, (_, pre, w) => `${pre}${put(`<span class="mention everyone">@${w}</span>`)}`);
    t = t.replace(/&lt;t:(\d{1,12})(?::([tTdDfFR]))?&gt;/g, (_, unix, st) => put(`<time class="timestamp" datetime="${new Date(unix * 1000).toISOString()}" title="${esc(formatFull(unix * 1000))}">${esc(fmtTimestamp(unix, st || 'f'))}</time>`));
    // spoilers, then emphasis
    t = t.replace(/\|\|(?=\S)([\s\S]*?\S)\|\|/g, '<span class="spoiler" data-spoiler tabindex="0"><span>$1</span></span>');
    t = t.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
    t = t.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)/g, '<strong>$1</strong>');
    t = t.replace(/__(?=\S)([\s\S]*?\S)__(?!_)/g, '<u>$1</u>');
    t = t.replace(/\*(?=[^\s*])([\s\S]*?[^\s*])\*(?!\*)/g, '<em>$1</em>');
    t = t.replace(/(^|[^\w])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\w])/g, '$1<em>$2</em>');
    t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<s>$1</s>');
    return t;
  };

  if (opts.inline) { let out = inline(s); out = out.replace(/\u0001(\d+)\u0002/g, (_, i) => stash[i]); return out; }

  // block level
  const lines = s.split('\n'); const out = []; let para = [];
  const flush = () => { if (para.length) { out.push(inline(para.join('\n'))); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; let m;
    if ((m = /^&gt;&gt;&gt; ?([\s\S]*)$/.exec(line))) { flush(); out.push(`<blockquote>${inline([m[1], ...lines.slice(i + 1)].join('\n'))}</blockquote>`); break; }
    if (/^&gt; ?/.test(line)) { flush(); const q = []; while (i < lines.length && /^&gt; ?/.test(lines[i])) { q.push(lines[i].replace(/^&gt; ?/, '')); i++; } i--; out.push(`<blockquote>${inline(q.join('\n'))}</blockquote>`); continue; }
    if ((m = /^(#{1,3}) +(.+)$/.exec(line))) { flush(); out.push(`<div class="md-h md-h${m[1].length}">${inline(m[2])}</div>`); continue; }
    if ((m = /^-# +(.+)$/.exec(line))) { flush(); out.push(`<div class="md-sub">${inline(m[1])}</div>`); continue; }
    if (/^ {0,3}([-*]) +\S/.test(line)) { flush(); const items = []; while (i < lines.length && /^ {0,3}([-*]) +\S/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^ {0,3}[-*] +/, ''))}</li>`); i++; } i--; out.push(`<ul>${items.join('')}</ul>`); continue; }
    if (/^ {0,3}\d{1,3}[.)] +\S/.test(line)) { flush(); const items = []; const start = parseInt(line, 10) || 1; while (i < lines.length && /^ {0,3}\d{1,3}[.)] +\S/.test(lines[i])) { items.push(`<li>${inline(lines[i].replace(/^ {0,3}\d{1,3}[.)] +/, ''))}</li>`); i++; } i--; out.push(`<ol start="${start}">${items.join('')}</ol>`); continue; }
    para.push(line);
  }
  flush();
  // paragraphs and blocks sit side by side; plain-text newlines are preserved by CSS (white-space: pre-wrap)
  let html = out.join('\n').replace(/(<\/(?:blockquote|ul|ol|div)>)\n(?=<(?:blockquote|ul|ol|div))/g, '$1');
  html = html.replace(/\u0001(\d+)\u0002/g, (_, i) => stash[i]);
  return html;
}

/** Compact one-line text for reply previews / notifications. */
export function plainPreview(text, serverId, max = 140) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' [code] ').replace(/<@!?(\d+)>/g, (_, id) => '@' + nameOf(id, serverId)).replace(/<@&(\d+)>/g, (_, id) => '@' + (state.servers[serverId]?.roles.find((r) => r.id === id)?.name || 'role'))
    .replace(/<#(\d+)>/g, (_, id) => '#' + (getChannel(id)?.name || 'channel')).replace(/<a?:([A-Za-z0-9_]{2,32}):\d{6,20}>/g, ':$1:').replace(/\|\|([\s\S]*?)\|\|/g, '▮▮▮').replace(/[*_~`>#]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Turn @username / @Role / #channel typed in the composer into wire-format tokens. */
export function encodeMentions(text, ch) {
  if (!ch || !text) return text;
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  const server = ch.serverId ? state.servers[ch.serverId] : null;
  const userByName = new Map();
  const ids = server ? server.members.map((m) => m.id) : (ch.recipients || []);
  for (const id of ids) { const u = state.users[id]; if (u) userByName.set(u.username.toLowerCase(), id); }
  const roles = server ? [...server.roles].filter((r) => r.id !== server.id).sort((a, b) => b.name.length - a.name.length) : [];
  const chans = server ? server.channels.filter((c) => c.type !== 'category') : [];
  return parts.map((p, i) => {
    if (i % 2) return p;
    let t = p;
    for (const r of roles) { const re = new RegExp(`@${r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'giu'); t = t.replace(re, `<@&${r.id}>`); }
    t = t.replace(/(^|[\s(])@([a-z0-9_.]{2,32})(?![a-z0-9_])/gi, (all, pre, name) => { const id = userByName.get(name.toLowerCase().replace(/\.+$/, '')); return id ? `${pre}<@${id}>${name.endsWith('.') ? '.' : ''}` : all; });
    if (allCustomEmojis().length) t = t.replace(/(^|[^<\w]):([A-Za-z0-9_]{2,32}):/g, (all, pre, name) => { const tok = customToken(name, ch.serverId); return tok ? pre + tok : all; });   // typed :name: → the custom emoji
    if (chans.length) t = t.replace(/(^|[\s(])#([\p{L}\p{N}_\-│·・\p{Extended_Pictographic}‍️]+)/gu, (all, pre, name) => { const c = chans.find((x) => x.name.toLowerCase() === name.toLowerCase()); return c ? `${pre}<#${c.id}>` : all; });
    return t;
  }).join('');
}
/** Inverse of encodeMentions — used when editing a message so tokens read as @name again. */
export function decodeMentions(text, ch) {
  const serverId = ch?.serverId;
  return String(text || '').replace(/<@!?(\d+)>/g, (all, id) => (state.users[id] ? '@' + state.users[id].username : all))
    .replace(/<@&(\d+)>/g, (all, id) => { const r = state.servers[serverId]?.roles.find((x) => x.id === id); return r ? '@' + r.name : all; })
    .replace(/<#(\d+)>/g, (all, id) => { const c = getChannel(id); return c ? '#' + c.name : all; })
    .replace(/<a?:([A-Za-z0-9_]{2,32}):\d{6,20}>/g, ':$1:');
}
void formatClock; void memberOf;
