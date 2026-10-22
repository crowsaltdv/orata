// A stand-in for music-service/service.py in the self-tests: the same line protocol, canned answers, and a log of what it was asked (FAKE_MUSIC_LOG).
// The server starts it through MUSIC_HELPER, so the tests need neither Python, ytmusicapi nor the internet.
import fs from 'node:fs';
import readline from 'node:readline';

const log = (o) => { if (process.env.FAKE_MUSIC_LOG) fs.appendFileSync(process.env.FAKE_MUSIC_LOG, `${JSON.stringify(o)}\n`); };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const song = (id, title, extra = {}) => ({ id, title, artist: 'Test Artist', album: 'Test Album', artwork: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: 215000, explicit: false, ...extra });

const CATEGORIES = [
  { key: 'top', name: 'Top Songs', group: 'chart' }, { key: 'trending', name: 'Trending', group: 'chart' },
  { key: 'g-pop', name: 'Pop', group: 'genre' }, { key: 'g-hip-hop', name: 'Hip-hop', group: 'genre' }, { key: 'm-chill', name: 'Chill', group: 'mood' },
  { key: 'BAD KEY!', name: 'Not a usable key', group: 'genre' },
];

out({ ready: true, version: 'test' });
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req; try { req = JSON.parse(line); } catch { return; }
  const reply = (result) => out({ id: req.id, ok: true, result });
  const refuse = (error, code) => out({ id: req.id, ok: false, error, code });
  log({ op: req.op, q: req.q, key: req.key, videoId: req.videoId, limit: req.limit });
  if (req.op === 'search') {
    if (req.q === 'crash') process.exit(1);                                   // the helper dying must not take Orata down
    if (req.q === 'broken') return refuse('YTMusicServerError: boom', 'upstream');
    if (req.q === 'empty') return reply([]);
    return reply([
      song('nightdrive1', 'Night Drive'),
      song('rainsounds2', 'Rain Sounds', { duration: 187000, explicit: true, artwork: 'https://yt3.googleusercontent.com/abc=w400-h400-l90-rj' }),
      song('short', 'Id too short'),
      song('evilartwork', 'Evil Artwork', { artwork: 'https://evil.example/pixel.gif' }),
      song('nospaces!!!', 'Bad characters in the id'),
    ]);
  }
  if (req.op === 'categories') return reply(CATEGORIES);
  if (req.op === 'category') return reply(req.key === 'g-pop' ? [song('popsong0001', 'Pop Hit')] : req.key === 'top' ? [song('overallhit0', 'Overall Hit')] : []);
  if (req.op === 'song') return req.videoId === 'deepcut0001' ? reply(song('deepcut0001', 'Deep Cut', { duration: 187000 })) : refuse('YouTube Music has no such track.', 'unavailable');
  if (req.op === 'ping') return reply('pong');
  return refuse('Unknown operation', 'bad_request');
});
