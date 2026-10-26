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
 */
export function createPlayer(on = {}, opts = {}) {
  let host = null; let frame = null; let ready = false; let shake = 0; let vol = 0.7; let last = -1; let listening = false;
  const queue = [];   // commands sent before the player said it is ready
  const post = (obj) => { try { frame?.contentWindow?.postMessage(JSON.stringify({ ...obj, id: 1, channel: 'widget' }), ORIGIN); } catch { /* the frame went away */ } };
  const send = (func, args = []) => { if (frame && ready) post({ event: 'command', func, args }); else queue.push([func, args]); };

  function onMessage(e) {
    if (e.origin !== ORIGIN || !frame || e.source !== frame.contentWindow) return;
    let m; try { m = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!ready && (m.event === 'onReady' || m.event === 'initialDelivery' || m.event === 'infoDelivery')) {
      ready = true; clearInterval(shake);
      post({ event: 'command', func: 'setVolume', args: [Math.round(vol * 100)] });
      for (const [func, args] of queue.splice(0)) post({ event: 'command', func, args });
      on.onReady?.();
    }
    if (m.event === 'onStateChange') changed(Number(m.info));
    else if (m.event === 'onError') on.onError?.(Number(m.info));
    else if ((m.event === 'infoDelivery' || m.event === 'initialDelivery') && m.info && typeof m.info === 'object') {
      const { currentTime, duration, playerState, videoData } = m.info;
      if (typeof playerState === 'number') changed(playerState);   // the state also arrives inside these deliveries (and sometimes only there)
      if (videoData?.errorCode) on.onError?.(videoData.errorCode === 'auth' ? 150 : 5);   // "auth": YouTube wants a sign-in for this one, so it can't play here
      if (typeof currentTime === 'number') on.onTime?.(currentTime, typeof duration === 'number' ? duration : 0, m.info);
    }
  }
  const changed = (code) => { if (code === last) return; last = code; on.onState?.(code); };
  function open(id, start = 0) {
    if (!opts.parent && !host) { host = document.createElement('div'); host.className = 'yt-host'; document.body.appendChild(host); }
    if (!listening) { window.addEventListener('message', onMessage); listening = true; }
    ready = false; last = -1;
    frame = document.createElement('iframe');
    frame.title = opts.title || 'Music player'; frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.referrerPolicy = 'strict-origin-when-cross-origin';   // YouTube refuses to play embeds that arrive without a referrer, and Orata's own policy sends none
    frame.src = `${ORIGIN}/embed/${encodeURIComponent(id)}?enablejsapi=1&widgetid=1&autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3&rel=0&playsinline=1${start >= 1 ? `&start=${Math.floor(start)}` : ''}&origin=${encodeURIComponent(location.origin)}`;
    frame.addEventListener('load', () => {   // say hello until the player answers (the iframe API does the same)
      clearInterval(shake); let tries = 0;
      shake = setInterval(() => { if (ready || ++tries > 60) return clearInterval(shake); post({ event: 'listening' }); }, 250);
    });
    (opts.parent || host).replaceChildren(frame);
  }

  return {
    /** Starts a song. The first call must come from a click or key press, so the browser lets the sound start. */
    load(id, start = 0) { if (!frame) open(id, start); else send('loadVideoById', [id, Math.max(0, start)]); },
    play: () => send('playVideo'),
    pause: () => send('pauseVideo'),
    seek: (sec) => send('seekTo', [Math.max(0, sec), true]),
    volume(v) { vol = v; send('setVolume', [Math.round(v * 100)]); },
    stop: () => send('stopVideo'),
    state: () => last,
    rate: (r) => send('setPlaybackRate', [r]),
    mute: () => send('mute'),
    unmute: () => send('unMute'),
    /** Takes the player away (the frame, and the listener for its messages). */
    destroy() { clearInterval(shake); if (listening) window.removeEventListener('message', onMessage); listening = false; frame?.remove(); host?.remove(); frame = null; host = null; ready = false; queue.length = 0; },
  };
}
