// Orata — the "swearing protection" a server can switch on (Server Settings → Safety). Off by default.
// A word list plus the usual tricks people use to get around one: repeated letters (fuuuck), symbols between letters (f.u.c.k), look-alike
// characters (sh1t, a\$\$) and common endings. Whole words only, so "class" or "Scunthorpe" are never caught. The built-in list is stored ROT13
// so that this file isn't full of expletives; servers can add their own words (Safety → Blocked words).
const BUILTIN = 'shpx shpxre shpxva zbgureshpxre zbgureshpxvat fuvg fuvggl ohyyfuvg ubefrfuvg ovgpu ovgpurf nffubyr nefrubyr qhzonff wnpxnff onfgneq qvpx qvpxurnq pbpx pbpxfhpxre phag chffl gjng cevpx jnaxre obyybpxf cvff cvffrq juber fyhg qbhpur qbhpuront qnza tbqqnza penc gvgf obbof phz wvmm oybjwbo unaqwbo cbea avttre avttn snttbg snt ergneq ergneqrq genaal xvxr fcvp puvax tbbx pbba jrgonpx ornare cnxv qlxr enturnq gbjryurnq penpxre';
const rot13 = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const WORDS = rot13(BUILTIN).split(' ');

const LEET = { a: '[a@4]', b: '[b8]', e: '[e3]', g: '[g9]', i: '[i1!|]', l: '[l1|]', o: '[o0]', s: '[s\$5]', t: '[t7+]', z: '[z2]' };
const SEP = '[\\W_]{0,2}';   // a symbol or two between the letters
const ENDINGS = '(?:s|es|ed|er|ers|ing|in|y|ie|ies)?';
function pattern(word) {
  const chars = [...String(word).toLowerCase()].filter((c) => /[a-z0-9]/.test(c));
  if (!chars.length) return null;
  return `(?<![a-z0-9])${chars.map((c) => `${LEET[c] || c}+`).join(SEP)}${ENDINGS}(?![a-z0-9])`;
}
const cache = new Map();
function regexFor(extra) {
  const key = extra.join('|');
  let re = cache.get(key);
  if (!re) { re = new RegExp([...WORDS, ...extra].map(pattern).filter(Boolean).join('|'), 'giu'); if (cache.size > 50) cache.clear(); cache.set(key, re); }
  re.lastIndex = 0; return re;
}
/** Cleans a server's own list of blocked words: letters, numbers, spaces, dashes; at most 50 of up to 32 characters. */
export function cleanBlockedWords(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\n,]/);
  return [...new Set(arr.map((w) => String(w).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 32)).filter((w) => w.length >= 2))].slice(0, 50);
}
/** Does `text` contain a blocked word? */
export function hasProfanity(text, extra = []) { return regexFor(extra).test(String(text || '')); }
/** `text` with every blocked word hidden (first letter kept; the rest become ∗, which Markdown ignores). */
export function censor(text, extra = []) { return String(text || '').replace(regexFor(extra), (m) => m[0] + '∗'.repeat(Math.max(1, m.length - 1))); }
