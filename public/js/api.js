// Orate — REST client + WebSocket gateway connection.
import { state, set } from '/js/store.js';

export class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const hooks = { unauthorized: () => {} };

async function req(method, url, body, extra = {}) {
  const headers = { ...(state.token ? { authorization: 'Bearer ' + state.token } : {}), ...(state.sessionId ? { 'x-conn': state.sessionId } : {}), ...extra.headers };
  let payload;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); } else payload = body;
  let res;
  try { res = await fetch('/api' + url, { method, headers, body: payload, signal: extra.signal }); } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Can’t reach the server. Check your connection.', 'network');
  }
  let data = null; try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    if (res.status === 401 && state.token && !url.startsWith('/auth/')) hooks.unauthorized();
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  }
  return data;
}
export const api = {
  get: (u, o) => req('GET', u, undefined, o), post: (u, b, o) => req('POST', u, b ?? {}, o), patch: (u, b) => req('PATCH', u, b ?? {}),
  put: (u, b) => req('PUT', u, b ?? {}), del: (u, b) => req('DELETE', u, b),
};

/** Upload a File/Blob. Returns {id,url,name,size,type}. onProgress(0..1). `handle.abort()` cancels. */
export function upload(file, onProgress, handle = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    handle.abort = () => xhr.abort();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('authorization', 'Bearer ' + state.token);
    xhr.setRequestHeader('x-filename', encodeURIComponent(file.name || 'file'));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded / e.total); };
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(d); else reject(new ApiError(xhr.status, d?.error || (xhr.status === 413 ? 'That file is too large' : 'Upload failed'), d?.code));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed — connection lost', 'network'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled', 'abort'));
    xhr.send(file);
  });
}

/* ------------------------------------------------------------ gateway */
const handlers = new Map();
let ws = null; let attempt = 0; let hb = null; let lastPong = 0; let reconnectTimer = null; let wantOpen = false;

export const gateway = {
  on(op, fn) { (handlers.get(op) || handlers.set(op, new Set()).get(op)).add(fn); return () => handlers.get(op)?.delete(fn); },
  send(op, d = {}) { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ op, d })); return true; } return false; },
  connect() {
    wantOpen = true; clearTimeout(reconnectTimer);
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    set({ connection: attempt ? 'connecting' : state.connection });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/gateway`);
    ws.onopen = () => { ws.send(JSON.stringify({ op: 'identify', d: { token: state.token } })); };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.op === 'ready') { attempt = 0; lastPong = Date.now(); startHeartbeat(); set({ connection: 'online' }); }
      if (m.op === 'pong') lastPong = Date.now();
      for (const fn of handlers.get(m.op) || []) { try { fn(m.d); } catch (err) { console.error('[gateway]', m.op, err); } }
    };
    ws.onclose = (e) => {
      clearInterval(hb); ws = null;
      if (e.code === 4004 || e.code === 4001) { wantOpen = false; hooks.unauthorized(); return; }
      set({ connection: 'offline' });
      if (wantOpen) { attempt++; reconnectTimer = setTimeout(() => gateway.connect(), Math.min(15000, 600 * 2 ** Math.min(attempt, 5)) + Math.random() * 400); }
    };
    ws.onerror = () => {};
  },
  disconnect() { wantOpen = false; clearTimeout(reconnectTimer); clearInterval(hb); if (ws) { ws.onclose = null; ws.close(); ws = null; } },
  isOpen: () => !!ws && ws.readyState === 1,
};
function startHeartbeat() {
  clearInterval(hb);
  hb = setInterval(() => {
    if (Date.now() - lastPong > 45000) { try { ws?.close(); } catch { /* ignore */ } return; }
    gateway.send('ping', { t: Date.now() });
  }, 20000);
}
window.addEventListener('online', () => { if (wantOpen && !gateway.isOpen()) { attempt = 0; gateway.connect(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden && wantOpen && !gateway.isOpen()) { attempt = 0; gateway.connect(); } });
