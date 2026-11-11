import './selftest-env.js';   // first: tests never read the real .env (see that file)
// Orata self-test for custom cursors (public/js/cursor-data.js) and for the Google Fonts of profiles (public/js/profile-data.js): what a cursor is and how it is checked, the
// cursor as a kind of theme (and not part of a site theme), and the font a name or text can take. The server side (the library, Discovery, the files) is in selftest-themes.js and
// selftest-community.js. No server needed.  Runs with the other suites:  npm test
import { sanitizeCursor, cursorBox, cursorLookOf, sameCursor, DEFAULT_CURSOR, CURSOR_SIZES, CURSOR_MAX_PX } from '../public/js/cursor-data.js';
import { THEME_KINDS, sanitizeTheme, themeFiles, mapThemeFiles, sanitizeSiteLook, siteLookOf, SITE_SECTIONS } from '../public/js/theme-data.js';
import { sanitizeProfileStyle, fontFamily, fontId, PROFILE_FONTS } from '../public/js/profile-data.js';
import { DEFAULT_SETTINGS } from '../public/js/defaults.js';

let pass = 0; let fail = 0;
const ok = (c, name, extra = '') => { if (c) { pass++; console.log('  ✓', name); } else { fail++; console.log('  ✗', name, extra); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('What a cursor is');
ok(DEFAULT_SETTINGS.cursor && DEFAULT_SETTINGS.cursor.on === false && DEFAULT_SETTINGS.cursor.image === null && same(DEFAULT_SETTINGS.cursor, DEFAULT_CURSOR) && DEFAULT_SETTINGS.cursor !== DEFAULT_CURSOR, 'the normal cursor is the default: a custom one is off until you switch it on');
ok(sanitizeCursor(null) === null && sanitizeCursor('x') === null && sanitizeCursor([]) === null && sanitizeCursor({}) === null && sanitizeCursor({ size: 32 }) === null, 'anything without a picture is no cursor');
ok(sanitizeCursor({ image: 'https://evil.example/c.png' }) === null && sanitizeCursor({ image: '//evil.example/c.png' }) === null && sanitizeCursor({ image: 'javascript:alert(1)' }) === null && sanitizeCursor({ image: '/uploads/../secret' }) === null && sanitizeCursor({ image: '/uploads/a/b.png' }) === null && sanitizeCursor({ image: 'data:image/png;base64,AAAA' }) === null, 'only a picture on this server counts (a link elsewhere would show who has the cursor)');
const good = sanitizeCursor({ image: '/uploads/th_1.png', pointer: '/uploads/th_2.png', size: 48, hot: { x: 0.5, y: 0.25 }, hotPointer: { x: 1, y: 0 }, evil: 1, on: true });
ok(good && same(good, { image: '/uploads/th_1.png', pointer: '/uploads/th_2.png', size: 48, hot: { x: 0.5, y: 0.25 }, hotPointer: { x: 1, y: 0 } }), 'a cursor keeps its two pictures, size and tips, and nothing else (whether it is on is a setting, not part of it)');
const odd = sanitizeCursor({ image: '/uploads/a.png', pointer: 'https://x.example/p.png', size: 20, hot: { x: 7, y: -3 }, hotPointer: 'no' });
ok(odd.pointer === null && odd.size === DEFAULT_CURSOR.size && same(odd.hot, { x: 1, y: 0 }) && same(odd.hotPointer, DEFAULT_CURSOR.hotPointer), 'a pointer from elsewhere is dropped, an odd size becomes the usual one, tips are kept inside the picture');
ok(CURSOR_SIZES.every(([s]) => s <= CURSOR_MAX_PX) && CURSOR_MAX_PX <= 128, 'a cursor is never drawn bigger than browsers allow');
ok(cursorLookOf({ cursor: { on: false, image: '/uploads/a.png' } })?.image === '/uploads/a.png' && cursorLookOf({}) === null && cursorLookOf(undefined) === null, 'the cursor your settings make is read from them');
ok(sameCursor(good, sanitizeCursor(good)) && !sameCursor(good, odd) && !sameCursor(null, good), 'two cursors can be compared');

console.log('\nDrawing it');
let b = cursorBox(64, 64, 32, { x: 0, y: 0 }); ok(b.w === 32 && b.h === 32 && b.x === 0 && b.y === 0, 'the longer side is the size, the tip at the corner');
b = cursorBox(40, 20, 48, { x: 0.5, y: 0.5 }); ok(b.w === 48 && b.h === 24 && b.x === 24 && b.y === 12, 'a wide picture keeps its shape, the tip in the middle of it');
b = cursorBox(16, 16, 64, { x: 1, y: 1 }); ok(b.w === 64 && b.x === 63 && b.y === 63, 'the tip never falls outside the picture (it is the last pixel)');
b = cursorBox(0, 0, 32, null); ok(b.w >= 1 && b.h >= 1 && b.x === 0, 'an empty picture can’t break it');

console.log('\nA cursor as a theme');
ok(THEME_KINDS.includes('cursor') && THEME_KINDS.includes('site') && THEME_KINDS.includes('profile'), 'cursors are a third kind of theme, next to profile and site themes');
ok(same(sanitizeTheme('cursor', { image: '/uploads/th_9.png', size: 24 }), sanitizeCursor({ image: '/uploads/th_9.png', size: 24 })) && sanitizeTheme('cursor', {}) === null && sanitizeTheme('nothing', { image: '/uploads/a.png' }) === null, 'a cursor theme is checked as a cursor');
ok(same(themeFiles('cursor', { image: '/uploads/a.png', pointer: '/uploads/b.png' }), ['a.png', 'b.png']) && same(themeFiles('cursor', { image: '/uploads/a.png', pointer: null }), ['a.png']), 'its files are its two pictures');
const mapped = await mapThemeFiles('cursor', { image: '/uploads/a.png', pointer: '/uploads/b.png', size: 32 }, async (n) => `th_${n}`);
ok(mapped.image === '/uploads/th_a.png' && mapped.pointer === '/uploads/th_b.png' && mapped.size === 32, 'each picture can be swapped for the theme’s own copy');
ok(!SITE_SECTIONS.includes('cursor') && !('cursor' in (sanitizeSiteLook({ theme: { mode: 'dark' }, cursor: { on: true, image: '/uploads/a.png' } }) || {})) && !('cursor' in siteLookOf({ ...DEFAULT_SETTINGS, cursor: { on: true, image: '/uploads/a.png' } })), 'a site theme never carries your cursor: applying one leaves it alone');

console.log('\nGoogle Fonts on a profile');
ok(fontFamily('pacifico') === 'Pacifico' && fontFamily('g:Roboto Slab') === 'Roboto Slab' && fontFamily('g:Press Start 2P') === 'Press Start 2P' && fontFamily('g:Noto Sans JP') === 'Noto Sans JP', 'a short id and "g:" + a Google family both give their family');
ok(fontFamily('g:Evil";} body{display:none}') === null && fontFamily('g:') === null && fontFamily('g:' + 'A'.repeat(60)) === null && fontFamily('g:a/b') === null && fontFamily('g:a:b') === null && fontFamily('g:<script>') === null && fontFamily('nope') === null && fontFamily(null) === null && fontFamily(5) === null, 'anything that could break out of the CSS or the Google Fonts address is no font');
ok(fontFamily('g:Roboto   Slab ') === 'Roboto Slab', 'stray spaces are tidied');
ok(fontId('Pacifico') === 'pacifico' && fontId('Roboto Slab') === 'g:Roboto Slab' && fontId('Evil";') === null && fontId('') === null && fontId(null) === null && fontId('  Lora ') === 'lora' && fontId('Roboto   Slab') === 'g:Roboto Slab', 'the picker’s family becomes what is saved: the short id when there is one');
ok(PROFILE_FONTS.every(([id, fam]) => fontId(fam) === id && fontFamily(id) === fam), 'every font that profiles have always had keeps its id');
let st = sanitizeProfileStyle({ fonts: { name: 'g:Roboto Slab', text: 'pacifico' } });
ok(st.fonts.name === 'g:Roboto Slab' && st.fonts.text === 'pacifico', 'a profile saves a Google font next to an old id');
st = sanitizeProfileStyle({ fonts: { name: 'g:Bad";}', text: 'g:Lora ' }, colors: { mode: 'solid', a: '#ff0000' } });
ok(st.fonts.name === null && st.fonts.text === 'g:Lora', 'a bad one is dropped (the other stays), and spaces at the ends go');
st = sanitizeProfileStyle({ fonts: { name: 'g:x"', text: 'nope' }, colors: { mode: 'solid', a: '#ff0000' } });
ok(!('fonts' in st), 'when neither is usable there are no fonts at all');
ok(same(sanitizeProfileStyle(sanitizeProfileStyle({ fonts: { name: 'g:Roboto Slab' } })), sanitizeProfileStyle({ fonts: { name: 'g:Roboto Slab' } })), 'checking it twice changes nothing (the browser checks what the server sent)');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
