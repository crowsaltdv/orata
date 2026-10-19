// Orate — polls: the "create poll" dialog and the poll shown inside a message.
import { html, useState, useEffect, cx } from '/js/lib.js';
import { state, useSel, closeModal, getChannel, hasChannelPerm } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Field, TextInput, Toggle, SettingRow, Dropdown, Modal, MODALS } from '/js/ui.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { t } from '/js/i18n.js';

const HOURS = [{ value: 1, label: '1 hour' }, { value: 4, label: '4 hours' }, { value: 8, label: '8 hours' }, { value: 24, label: '24 hours' }, { value: 72, label: '3 days' }, { value: 168, label: '1 week' }, { value: 336, label: '2 weeks' }];

MODALS['create-poll'] = function CreatePoll({ id, channelId }) {
  const ch = getChannel(channelId) || state.dms[channelId];
  const [question, setQuestion] = useState(''); const [answers, setAnswers] = useState(['', '']); const [multi, setMulti] = useState(false); const [hours, setHours] = useState(24);
  const [busy, setBusy] = useState(false);
  if (!ch) return null;
  const filled = answers.map((a) => a.trim()).filter(Boolean);
  const ok = question.trim() && filled.length >= 2;
  const setAns = (i, v) => setAnswers((cur) => cur.map((x, j) => (j === i ? v : x)));
  const create = async () => {
    setBusy(true);
    const r = await act(api.post(`/channels/${channelId}/messages`, { poll: { question: question.trim(), answers: filled.map((text) => ({ text })), multi, hours } }));
    setBusy(false); if (r) closeModal(id);
  };
  return html`<${Modal} title=${t('Create Poll')} subtitle=${ch.serverId ? `#${ch.name}` : null} width=${480} onClose=${() => closeModal(id)} footer=${html`<${Btn} variant="ghost" onClick=${() => closeModal(id)}>${t('Cancel')}<//><${Btn} variant="primary" loading=${busy} disabled=${!ok} onClick=${create}>${t('Post Poll')}<//>`}>
    <${Field} label=${t('Question')}><${TextInput} value=${question} onInput=${setQuestion} maxlength="300" autofocus placeholder=${t('What do you want to ask?')} /><//>
    <${Field} label=${t('Answers')}><div class="poll-answers-edit">
      ${answers.map((a, i) => html`<div class="pae-row" key=${i}><${TextInput} value=${a} onInput=${(v) => setAns(i, v)} maxlength="55" placeholder=${`${t('Answer')} ${i + 1}`} />${answers.length > 2 ? html`<button type="button" class="icon-btn" aria-label=${t('Remove')} onClick=${() => setAnswers((c) => c.filter((_, j) => j !== i))}><${Icon} name="x" size=${16} /></button>` : null}</div>`)}
      <${Btn} size="sm" icon="plus" disabled=${answers.length >= 10} onClick=${() => setAnswers((c) => [...c, ''])}>${t('Add answer')}<//></div><//>
    <${Field} label=${t('Duration')}><${Dropdown} value=${hours} options=${HOURS.map((h) => ({ ...h, label: t(h.label) }))} onChange=${setHours} /><//>
    <${SettingRow} title=${t('Allow multiple answers')} desc=${t('People can pick more than one.')}><${Toggle} checked=${multi} onChange=${setMulti} /><//>
  <//>`;
};

const timeLeft = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); if (m < 1) return t('less than a minute'); if (m < 60) return `${m} ${t('min')}`; const h = Math.round(m / 60); return h < 48 ? `${h} ${h === 1 ? t('hour') : t('hours')}` : `${Math.round(h / 24)} ${t('days')}`; };

/** The poll inside a message: vote by clicking, see the results as bars, close it early if it's yours (or you moderate). */
export function PollView({ m, ch }) {
  const p = m.poll; const me = state.me.id;
  const [now, setNow] = useState(Date.now()); const users = useSel((s) => s.users);
  useEffect(() => { if (p.closed || !p.expiresAt) return undefined; const id = setInterval(() => setNow(Date.now()), 20000); return () => clearInterval(id); }, [p.closed, p.expiresAt]);
  const closed = p.closed || (p.expiresAt && p.expiresAt <= now);
  const mine = p.answers.filter((a) => a.voters.includes(me)).map((a) => a.id);
  const top = Math.max(0, ...p.answers.map((a) => a.voters.length));
  const vote = (answers) => act(api.put(`/channels/${ch.id}/messages/${m.id}/poll/votes`, { answers }));
  const pick = (id) => { if (closed) return; vote(p.multi ? (mine.includes(id) ? mine.filter((x) => x !== id) : [...mine, id]) : (mine[0] === id ? [] : [id])); };
  const canClose = !closed && (m.authorId === me || (ch.serverId && hasChannelPerm(ch, 'MANAGE_MESSAGES')));
  return html`<div class=${cx('poll', closed && 'closed')}>
    <div class="poll-q">${p.question}</div>
    <div class="poll-hint">${closed ? t('Final results') : p.multi ? t('Select one or more answers') : t('Select one answer')}</div>
    <div class="poll-answers">${p.answers.map((a) => {
      const n = a.voters.length; const pct = p.total ? Math.round((n / p.total) * 100) : 0; const on = mine.includes(a.id);
      const names = a.voters.slice(0, 12).map((id) => users[id]?.displayName || '…').join(', ') + (n > 12 ? ` +${n - 12}` : '');
      return html`<button type="button" key=${a.id} class=${cx('poll-ans', on && 'mine', closed && n && n === top && 'win')} disabled=${closed} onClick=${() => pick(a.id)} title=${n ? names : ''}>
        <span class="pa-bar" style=${{ width: `${pct}%` }}></span>
        <span class="pa-check">${on ? html`<${Icon} name="check" size=${13} sw=${3.5} />` : null}</span>
        <span class="pa-text">${a.text}</span><span class="pa-num">${n}${p.total ? ` · ${pct}%` : ''}</span></button>`;
    })}</div>
    <div class="poll-foot"><span>${p.total} ${p.total === 1 ? t('vote') : t('votes')}</span><span>·</span><span>${closed ? t('Poll closed') : p.expiresAt ? `${t('Ends in')} ${timeLeft(p.expiresAt - now)}` : ''}</span>
      ${canClose ? html`<button type="button" class="link-btn" onClick=${() => act(api.post(`/channels/${ch.id}/messages/${m.id}/poll/close`))}>${t('End poll')}</button>` : null}</div>
  </div>`;
}
