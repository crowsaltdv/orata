// Orata — forwarding a message to another channel or DM (message menu → Forward), or sharing one of your playlists there (a playlist page → Share).
// The server makes the copy; see forwardCopy in server/api.js (and playlistCard in server/music.js).
import { html, useState, useMemo, cx, cmpId } from '/js/lib.js';
import { state, closeModal, toast, hasChannelPerm, dmName, dmUserId } from '/js/store.js';
import { Modal, Btn, TextInput, Avatar, MODALS } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { api } from '/js/api.js';
import { errMsg } from '/js/actions.js';
import { encodeMentions } from '/js/markdown.js';
import { t } from '/js/i18n.js';

/** Everywhere I can send a message: DMs first (most recent), then the text channels of my servers. */
function destinations() {
  const dms = Object.values(state.dms).sort((a, b) => cmpId(state.lastMsg[b.id] || '0', state.lastMsg[a.id] || '0'))
    .map((c) => ({ id: c.id, label: c.type === 'group' ? dmName(c) : (state.users[dmUserId(c)]?.displayName || dmName(c)), sub: c.type === 'group' ? t('Group chat') : t('Direct message'), user: c.type === 'dm' ? state.users[dmUserId(c)] : null }));
  const chans = Object.values(state.servers).flatMap((s) => s.channels.filter((c) => c.type === 'text' && hasChannelPerm(c, 'SEND_MESSAGES')).map((c) => ({ id: c.id, label: '#' + c.name, sub: s.name, icon: 'hash' })));
  return [...dms, ...chans];
}

MODALS.forward = function Forward({ id, channelId, messageId, playlist }) {
  const all = useMemo(destinations, []);
  const [q, setQ] = useState(''); const [to, setTo] = useState(null); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  const shown = all.filter((d) => !q.trim() || `${d.label} ${d.sub}`.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 60);
  const close = () => closeModal(id);
  const send = async () => {
    const ch = state.channelIndex[to]; if (!ch) return;
    setBusy(true);
    try { await api.post(`/channels/${to}/messages`, { content: note.trim() ? encodeMentions(note.trim(), ch) : '', ...(playlist ? { playlist: { id: playlist.id } } : { forward: { channelId, messageId } }) }); toast(playlist ? t('Playlist shared') : t('Forwarded'), 'success', 1800); close(); }
    catch (e) { toast(errMsg(e), 'error'); setBusy(false); }
  };
  return html`<${Modal} title=${playlist ? `${t('Share')} “${playlist.name}”` : t('Forward to')} subtitle=${t('Pick where it goes. You can add a message of your own.')} width=${460} onClose=${close}
    footer=${html`<${Btn} variant="ghost" onClick=${close}>${t('Cancel')}<//><${Btn} variant="primary" icon="send" loading=${busy} disabled=${!to} onClick=${send}>${playlist ? t('Share') : t('Forward')}<//>`}>
    <${TextInput} value=${q} onInput=${setQ} placeholder=${t('Search channels and DMs')} icon="search" autofocus />
    <div class="pick-list fwd-list">${shown.length ? shown.map((d) => html`<label class=${cx('pick-row', to === d.id && 'sel')} key=${d.id}>
      ${d.user ? html`<${Avatar} user=${d.user} size=${32} />` : html`<i class="fwd-ic"><${Icon} name=${d.icon || 'users'} size=${18} /></i>`}
      <span><b>${d.label}</b><small>${d.sub}</small></span>
      <input type="radio" name="fwd" checked=${to === d.id} onChange=${() => setTo(d.id)} /><span class="box"><${Icon} name="check" size=${14} sw=${3} /></span></label>`) : html`<p class="text-muted" style="padding:8px">${t('Nothing matches that.')}</p>`}</div>
    <${TextInput} value=${note} onInput=${setNote} maxlength="2000" placeholder=${t('Add a message (optional)')} onKeyDown=${(e) => e.key === 'Enter' && to && send()} />
  <//>`;
};
