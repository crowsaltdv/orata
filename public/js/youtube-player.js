// Orata — plays one song at a time in YouTube's embedded player: the engine behind the Music page.
// YouTube Music's audio can't be fetched by Orata (see server/music.js), so a song is a YouTube video id played in an <iframe>, controlled over the
// same postMessage protocol YouTube's own iframe API uses. No script from YouTube is loaded (Orata's content security policy only allows its own).
// The iframe has to outlive the Music page, because the mini player keeps playing while you move around: it lives in its own element on <body>, parked in
// a corner of the window — on screen so the browser keeps the sound going, but invisible and click-through (see .yt-host in extras.css).
const ORIGIN = 'https://www.youtube-nocookie.com';
// player states YouTube reports: -1 not started, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued

/**
 * `on`: { onReady(), onState(code), onTime(seconds, duration, info), onError(code) } — all optional.
 * `opts.parent`: an element to show the player in (the watch-together tile); without it the player is parked out of sight on <body>, as the music page wants. `opts.title`: the frame's name.
 * `opts.insist`: a play that was asked for (load, play) is sent again until YouTube says it plays. Browsers may ignore the autoplay a song starts with, or a command
 * that arrives before the player is ready, and a click should not need a second click; the Watch Together tile keeps its own track of what it wants, so it leaves this off.
 */
export function createPlayer(on = {}, opts = {}) {
  let host = null; let frame = null; let ready = false; let shake = 0; let vol = 0.7; let last = -1; let listening = false;
  let wanted = 0; let nudged = 0; let nudge = 0;   // insist: when a play was asked for, when it was last sent again, and the timer that does it
  let asked = 0;   // songs asked for so far: a player warmed up with none is told by YouTube that it has no video (api.invalidparam), which is not a fault to report
  const queue = [];   // commands sent before the player said it is ready
  const post = (obj) => { try { frame?.contentWindow?.postMessage(JSON.stringify({ ...obj, id: 1, channel: 'widget' }), ORIGIN); } catch { /* the frame went away */ } };
  const send = (func, args = []) => { if (frame && ready) post({ event: 'command', func, args }); else queue.push([func, args]); };

  const unwant = () => { wanted = 0; clearInterval(nudge); };
  const want = () => { if (!opts.insist) return; wanted = nudged = Date.now(); clearInterval(nudge); nudge = setInterval(insist, 250); };
  function insist() {   // not playing 0.6 s after it was asked for, and again every 0.6 s, for 8 s at most (while it buffers, asking again is harmless)
    const now = Date.now();
    if (!wanted || !frame || now - wanted > 8000) return unwant();
    if (!ready || last === 1 || now - nudged < 600) return;
    nudged = now; post({ event: 'command', func: 'playVideo', args: [] });
  }

  function onMessage(e) {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let m; try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.event === 'readyToListen') { post({ event: 'listening' }); return; }   // it is up: answer at once instead of at the next beat of the loop below
    if (!ready && (m.event === 'onReady' || m.event === 'initialDelivery' || m.event === 'infoDelivery')) {
      ready = true; clearInterval(shake);
      post({ event: 'command', func: 'setVolume', args: [Math.round(vol * 100)] });
      for (const [func, args] of queue.splice(0)) post({ event: 'command', func, args });
      on.onReady?.();
    }
    if (m.event === 'onStateChange') changed(Number(m.info));
    else if (m.event === 'onError') fault(Number(m.info));
    else if ((m.event === 'infoDelivery' || m.event === 'initialDelivery') && m.info && typeof m.info === 'object') {
      const { currentTime, duration, playerState, videoData } = m.info;
      if (typeof playerState === 'number') changed(playerState);   // the state also arrives inside these deliveries (and sometimes only there)
      if (videoData?.errorCode && videoData.errorCode !== 'api.invalidparam') fault(videoData.errorCode === 'auth' ? 150 : 5);   // "auth": YouTube wants a sign-in for this one, so it can't play here
      if (typeof currentTime === 'number') on.onTime?.(currentTime, typeof duration === 'number' ? duration : 0, m.info);
    }
  }
  const fault = (code) => { if (!asked) return; unwant(); on.onError?.(code); };
  const changed = (code) => { if (code === 1 || code === 0) unwant(); if (code === last) return; last = code; on.onState?.(code); };
  /** Opens the frame: with a song (it starts by itself), or with none, so the player has loaded by the time one is asked for. */
  function open(id, start = 0) {
    if (!opts.parent && !host) { host = document.createElement('div'); host.className = 'yt-host'; document.body.appendChild(host); }
    if (!listening) { window.addEventListener('message', onMessage); listening = true; }
    ready = false; last = -1;
    frame = document.createElement('iframe');
    frame.title = opts.title || 'Music player'; frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';   // YouTube refuses to play embeds that arrive without a referrer, and Orata's own policy sends none
    frame.src = `${ORIGIN}/embed/${id ? encodeURIComponent(id) : ''}?enablejsapi=1&widgetid=1${id ? '&autoplay=1' : ''}&controls=0&disablekb=1&fs=0&iv_load_policy=3&rel=0&playsinline=1${start >= 1 ? `&start=${Math.floor(start)}` : ''}&origin=${encodeURIComponent(location.origin)}`;
    frame.addEventListener('load', () => {   // say hello until the player answers (the iframe API does the same)
      clearInterval(shake); let tries = 0;
      shake = setInterval(() => { if (ready || ++tries > 60) return clearInterval(shake); post({ event: 'listening' }); }, 250);
    });
    (opts.parent || host).replaceChildren(frame);
  }

  return {
    /** Gets the player loaded before there is a song for it (a page that is about to play one calls this), so `load` has only a command to send. */
    warm() { if (!frame) open(null); },
    /** Starts a song. It has to come from a click or key press (or after one on the page), so the browser lets the sound start. */
    load(id, start = 0) {
      asked++; want();
      if (!frame) return open(id, start);
      last = -1;   // (what the last song ended on says nothing about this one)
      send('loadVideoById', [id, Math.max(0, start)]);
    },
    play() { want(); send('playVideo'); },
    pause() { unwant(); send('pauseVideo'); },
    seek: (sec) => send('seekTo', [Math.max(0, sec), true]),
    volume(v) { vol = v; send('setVolume', [Math.round(v * 100)]); },
    stop() { unwant(); send('stopVideo'); },
    state: () => last,
    rate: (r) => send('setPlaybackRate', [r]),
    mute: () => send('mute'),
    unmute: () => send('unMute'),
    /** Takes the player away (the frame, and the listener for its messages). */
    destroy() { clearInterval(shake); unwant(); if (listening) window.removeEventListener('message', onMessage); listening = false; frame?.remove(); host?.remove(); frame = null; host = null; ready = false; asked = 0; queue.length = 0; },
  };
}
