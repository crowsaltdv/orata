// Orata — Song guess (like Songspot): name a song from a split second of it. Pick a genre, an era and an artist (or leave them open) and a difficulty,
// play 0.1 s of the song's highlight (the part people replay most), and each skip (or wrong guess) lets more of it play — 0.5 s, 2 s, 8 s, 15 s — until you name it or give up.
// The song plays in a player of its own, so the mini player never gives it away.
import { html, useState, useEffect, useRef, cx, ls } from '/js/lib.js';
import { useSel } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Spinner } from '/js/ui.js';
import { api } from '/js/api.js';
import { errMsg } from '/js/actions.js';
import { t } from '/js/i18n.js';
import { createPlayer } from '/js/youtube-player.js';

const STAGES = [0.1, 0.5, 2, 8, 15];   // seconds of the song each try lets you hear
const LEVELS = [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard'], ['expert', 'Expert'], ['impossible', 'Impossible']];
const secs = (s) => `${s}s`;
const norm = (s) => String(s || '').toLowerCase().replace(/\s*[([][^)\]]*[)\]]/g, '').replace(/\s+-\s+.*$/, '').replace(/[^\p{L}\p{N}]+/gu, '');
/** Is the song picked the one playing? The same track, or the same title by one of its artists (YouTube Music has many songs more than once). */
function same(g, s) {
  if (g.id === s.id) return true;
  if (norm(g.title) !== norm(s.title)) return false;
  const theirs = [s.artist, ...(s.artists || []).map((a) => a.name)].map(norm).filter(Boolean);
  return [g.artist, ...(g.artists || []).map((a) => a.name)].map(norm).filter(Boolean).some((a) => theirs.some((b) => b.includes(a) || a.includes(b)));
}

/** A row of choices with "Any" in the middle; the one picked slides to the centre, under a ▼. */
function Picker({ label, any, options, value, onChange }) {
  const row = useRef(null);
  const half = Math.ceil(options.length / 2); const items = [...options.slice(0, half), null, ...options.slice(half)];
  const first = useRef(true);
  useEffect(() => {   // (measured against the row itself; the first time without the slide)
    const id = requestAnimationFrame(() => {
      const r = row.current; const el = r?.querySelector('.gs-opt.on'); if (!el) return;
      const a = r.getBoundingClientRect(); const b = el.getBoundingClientRect();
      r.scrollTo({ left: r.scrollLeft + (b.left + b.width / 2) - (a.left + a.width / 2), behavior: first.current ? 'auto' : 'smooth' }); first.current = false;
    });
    return () => cancelAnimationFrame(id);
  }, [value, options.length]);
  return html`<div class="gs-pick"><b class="gs-pick-label">${t(label)}</b>
    <div class="gs-row" ref=${row}>${items.map((o) => html`<button type="button" key=${o || 'any'} class=${cx('gs-opt', value === o && 'on')} onClick=${() => onChange(o)}>${o || t(any)}</button>`)}</div></div>`;
}

/** The track of a round: 15 s long, a mark where each try ends, filled up to the try you're on, and what is playing right now. */
function StageBar({ stage, playing, at }) {
  const pct = (s) => `${(s / 15) * 100}%`;
  return html`<div class="gs-bar"><div class="gs-fill" style=${{ width: pct(STAGES[stage]) }}></div>
    ${playing ? html`<div class="gs-now" style=${{ width: pct(Math.min(at, STAGES[stage])) }}></div>` : null}
    ${STAGES.slice(0, -1).map((s) => html`<i class="gs-mark" key=${s} style=${{ left: pct(s) }}></i>`)}
    <span class="gs-at" style=${{ left: pct(STAGES[stage]) }}>${secs(STAGES[stage])}</span></div>`;
}

export function GuessView() {
  const [opts, setOpts] = useState(null); const [err, setErr] = useState(null);
  const [pick, setPick] = useState(() => ls('guessPick', { genre: null, era: null, artist: null, difficulty: 'easy' }));
  const [round, setRound] = useState(null);   // { song, stage, tries: [text], done: null | 'won' | 'lost' }
  const [status, setStatus] = useState('ready');   // ready | loading | playing
  const [at, setAt] = useState(0);
  const [q, setQ] = useState(''); const [found, setFound] = useState([]); const [chosen, setChosen] = useState(null); const [open, setOpen] = useState(false);
  const [score, setScore] = useState(() => ls('guessScore', { played: 0, won: 0, streak: 0 }));
  const player = useRef(null); const loadedId = useRef(null); const startAt = useRef(0); const want = useRef(null); const timer = useRef(0); const frame = useRef(0); const asked = useRef(0);
  const playingMusic = useSel((s) => s.music.playing);

  const stopClip = () => { clearTimeout(timer.current); cancelAnimationFrame(frame.current); want.current = null; if (player.current) { player.current.pause(); player.current.seek(startAt.current); } setStatus('ready'); setAt(0); };
  const startClip = () => {   // the player says it is playing: let it run for this try's length
    const len = want.current; if (len == null) return; want.current = null;
    const t0 = performance.now(); setStatus('playing');
    const tick = () => { setAt((performance.now() - t0) / 1000); frame.current = requestAnimationFrame(tick); }; tick();
    timer.current = setTimeout(stopClip, len * 1000);
  };
  useEffect(() => () => { clearTimeout(timer.current); cancelAnimationFrame(frame.current); player.current?.destroy(); }, []);
  useEffect(() => { if (playingMusic && status !== 'ready') stopClip(); }, [playingMusic]);   // the mini player started: this one stops

  useEffect(() => { api.get('/music/guess').then(setOpts, (e) => setErr(errMsg(e))); }, []);
  const newRound = async () => {
    stopClip(); setRound(null); setQ(''); setChosen(null); setFound([]); setErr(null);
    const mine = ++asked.current;
    try { const r = await api.post('/music/guess/round', pick); if (mine === asked.current) { startAt.current = r.start || 0; setRound({ song: r.song, stage: 0, tries: [], done: null }); } } catch (e) { if (mine === asked.current) setErr(errMsg(e)); }
  };
  useEffect(() => { ls('guessPick', null, pick); if (opts) newRound(); }, [opts, pick.genre, pick.era, pick.artist, pick.difficulty]);

  const play = async () => {
    if (!round) return;
    if (status !== 'ready') { stopClip(); return; }
    if (playingMusic) (await import('/js/music.js')).music.pause();
    const p = player.current ||= createPlayer({ onState: (c) => { if (c === 1) startClip(); }, onError: () => { setStatus('ready'); setErr(t('That song can’t play here. Skip to the next one.')); } }, { title: 'Song guess' });
    want.current = round.done ? 30 : STAGES[round.stage]; setStatus('loading');   // (once it's over, the song plays for 30 s)
    if (loadedId.current !== round.song.id) { loadedId.current = round.song.id; p.load(round.song.id, startAt.current); } else { p.seek(startAt.current); p.play(); }   // (from the highlight)
  };
  const finish = (won, tries) => {
    stopClip(); setRound((r) => ({ ...r, tries, done: won ? 'won' : 'lost' }));
    const s = { played: score.played + 1, won: score.won + (won ? 1 : 0), streak: won ? score.streak + 1 : 0 }; setScore(s); ls('guessScore', null, s);
  };
  const next = (text) => {   // a skip or a wrong guess: the next try, or the end
    stopClip(); const tries = [...round.tries, text];
    if (round.stage >= STAGES.length - 1) finish(false, tries); else setRound({ ...round, stage: round.stage + 1, tries });
  };
  const guess = () => {
    if (!chosen || !round || round.done) return;
    if (same(chosen, round.song)) finish(true, round.tries); else next(`${chosen.title} · ${chosen.artist}`);
    setQ(''); setChosen(null); setFound([]);
  };
  // the box you type the song in: songs that match, with their cover
  useEffect(() => {
    if (!q.trim() || chosen) { setFound([]); return undefined; }
    const id = setTimeout(() => api.get(`/music/search?q=${encodeURIComponent(q.trim())}&limit=8`).then((r) => setFound(r.tracks || []), () => setFound([])), 280);
    return () => clearTimeout(id);
  }, [q, chosen]);
  const choose = (tr) => { setChosen(tr); setQ(`${tr.title} — ${tr.artist}`); setOpen(false); };

  if (err && !opts) return html`<div class="m-empty"><${Icon} name="alert-circle" size=${30} /><b>${err}</b></div>`;
  if (!opts) return html`<div class="pk-center"><${Spinner} /></div>`;
  const last = round && round.stage === STAGES.length - 1;
  return html`<section class="gs">
    <div class="gs-head"><h2 class="gs-title">${t('Song guess')}</h2><span class="gs-score">${t('Played')} <b>${score.played}</b> · ${t('Won')} <b>${score.won}</b> · ${t('Streak')} <b>${score.streak}</b></span></div>
    <div class="gs-picks">
      <${Picker} label="Genres" any="Any genre" options=${opts.genres} value=${pick.genre} onChange=${(v) => setPick({ ...pick, genre: v })} />
      <${Picker} label="Eras" any="Any era" options=${opts.eras} value=${pick.era} onChange=${(v) => setPick({ ...pick, era: v })} />
      <${Picker} label="Artists" any="Any artist" options=${opts.artists} value=${pick.artist} onChange=${(v) => setPick({ ...pick, artist: v })} />
    </div>
    <div class="gs-levels">${LEVELS.map(([k, label]) => html`<button type="button" key=${k} class=${cx('gs-level', `lv-${k}`, pick.difficulty === k && 'on')} onClick=${() => setPick({ ...pick, difficulty: k })}>${t(label)}</button>`)}</div>
    ${err ? html`<p class="gs-err">${err}</p>` : null}
    ${!round ? html`<div class="pk-center gs-wait"><${Spinner} /></div>` : round.done ? html`
      <div class=${cx('gs-result', round.done)}>
        <img class="gs-art" src=${round.song.artwork} alt="" />
        <div class="gs-answer"><small>${round.done === 'won' ? `${t('You got it in')} ${secs(STAGES[round.stage])}!` : t('The song was')}</small><b>${round.song.title}</b><span>${round.song.artist}</span></div>
        <div class="gs-result-acts">
          <button type="button" class="gs-small" onClick=${play}><${Icon} name=${status === 'ready' ? 'play' : 'pause'} size=${16} />${status === 'ready' ? t('Hear it') : t('Stop')}</button>
          <button type="button" class="gs-small" onClick=${async () => { stopClip(); (await import('/js/music.js')).music.play(round.song); }}><${Icon} name="music" size=${16} />${t('Play in Orata')}</button>
          <button type="button" class="gs-next" onClick=${newRound}>${t('Next song')}<${Icon} name="arrow-right" size=${16} /></button>
        </div>
      </div>` : html`
      <${StageBar} stage=${round.stage} playing=${status === 'playing'} at=${at} />
      <div class="gs-play-row">
        <button type="button" class=${cx('gs-play', status !== 'ready' && 'on')} aria-label=${status === 'ready' ? t('Play') : t('Stop')} onClick=${play}>
          ${status === 'loading' ? html`<${Spinner} size=${34} />` : html`<${Icon} name=${status === 'playing' ? 'pause' : 'play'} size=${46} sw=${2.4} />`}</button>
        <span class="gs-len">${secs(STAGES[round.stage])}</span>
      </div>
      <div class="gs-state">${status === 'playing' ? t('Playing') : status === 'loading' ? t('Loading…') : t('Ready')}</div>
      <div class="gs-guess">
        <div class="gs-input"><${Icon} name="search" size=${17} />
          <input value=${q} placeholder=${t('Name that track')} onInput=${(e) => { setQ(e.target.value); setChosen(null); setOpen(true); }} onFocus=${() => setOpen(true)} onBlur=${() => setTimeout(() => setOpen(false), 150)}
            onKeyDown=${(e) => { if (e.key === 'Enter') { if (chosen) guess(); else if (found[0]) choose(found[0]); } }} />
          ${open && found.length ? html`<div class="gs-drop">${found.map((tr) => html`<button type="button" key=${tr.id} class="gs-hit" onMouseDown=${(e) => { e.preventDefault(); choose(tr); }}>
            <img src=${tr.artwork} alt="" /><span><b>${tr.title}</b><small>${tr.artist}</small></span></button>`)}</div>` : null}
        </div>
        ${chosen ? html`<button type="button" class="gs-btn go" onClick=${guess}>${t('Guess')}</button>`
          : html`<button type="button" class="gs-btn" onClick=${() => next(t('Skipped'))}><${Icon} name=${last ? 'flag' : 'skip-forward'} size=${16} />${last ? t('Give up') : `${t('Skip')} (+${secs(STAGES[round.stage + 1] - STAGES[round.stage])})`}</button>`}
      </div>
      ${round.tries.length ? html`<ol class="gs-tries">${round.tries.map((x, i) => html`<li key=${i}><${Icon} name="x" size=${14} sw=${3} />${x}</li>`)}</ol>` : null}`}
  </section>`;
}
