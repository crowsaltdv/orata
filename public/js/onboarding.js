// Orata — onboarding: a server's rules screen. Newcomers read the rules and pick roles before they can talk (POST /servers/:id/onboarding);
// anyone can come back to change their picks (server menu → Rules & roles). Set up in Server Settings → Onboarding.
import { html, useState, cx } from '/js/lib.js';
import { state, useSel, closeModal, hasPerm } from '/js/store.js';
import { Modal, Btn, Field, TextInput, Toggle, Section, SettingRow, MODALS, useSaveBar } from '/js/ui.js';
import { Icon } from '/js/icons.js';
import { api } from '/js/api.js';
import { act } from '/js/actions.js';
import { renderMarkdown } from '/js/markdown.js';
import { t } from '/js/i18n.js';

// the same list as server/core.js: members may only pick roles that grant nothing beyond what everyone already has
const DEFAULT_PERMS = ['VIEW_CHANNEL', 'CREATE_INVITE', 'SEND_MESSAGES', 'SEND_GIFS', 'ATTACH_FILES', 'ADD_REACTIONS', 'CONNECT', 'SPEAK', 'CHANGE_NICKNAME'];
const pickable = (server, r) => r.id !== server.id && r.permissions.every((p) => DEFAULT_PERMS.includes(p));

MODALS.onboarding = function Onboarding({ id, serverId }) {
  const server = useSel((s) => s.servers[serverId]); const me = server?.members.find((m) => m.id === state.me.id); const ob = server?.onboarding;
  const offered = (ob?.roles || []).map((x) => ({ ...x, role: server.roles.find((r) => r.id === x.roleId) })).filter((x) => x.role);
  const [picked, setPicked] = useState(() => new Set(offered.filter((x) => me?.roles.includes(x.roleId)).map((x) => x.roleId)));
  const hasRules = !!ob?.rules?.trim();
  const [agree, setAgree] = useState(!me?.pending || !hasRules); const [busy, setBusy] = useState(false);
  const close = () => closeModal(id);
  if (!server || !ob?.enabled) return null;
  const flip = (rid) => setPicked((p) => { const n = new Set(p); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  const finish = async () => { setBusy(true); const r = await act(api.post(`/servers/${serverId}/onboarding`, { roles: [...picked] }), { success: me?.pending ? t('Welcome in!') : t('Your roles are saved') }); setBusy(false); if (r) close(); };
  return html`<${Modal} title=${`${t('Welcome to')} ${server.name}`} subtitle=${me?.pending ? t('Read the rules and pick your roles to start chatting.') : t('The server’s rules, and the roles you picked.')} width=${540} onClose=${close}
    footer=${html`<${Btn} variant="ghost" onClick=${close}>${me?.pending ? t('Later') : t('Close')}<//><${Btn} variant="primary" loading=${busy} disabled=${!agree} onClick=${finish}>${me?.pending ? t('Finish') : t('Save')}<//>`}>
    ${hasRules ? html`<div class="ob-rules msg-content" dangerouslySetInnerHTML=${{ __html: renderMarkdown(ob.rules, { serverId }) }}></div>` : null}
    ${offered.length ? html`<div class="ob-roles"><h5>${t('Pick your roles')}</h5><div class="ob-grid">${offered.map((x) => html`<button type="button" key=${x.roleId} class=${cx('ob-role', picked.has(x.roleId) && 'on')} style=${{ '--rc': x.role.color || 'var(--accent)' }} aria-pressed=${picked.has(x.roleId)} onClick=${() => flip(x.roleId)}>
      <span class="ob-emoji">${x.emoji || '•'}</span><span class="ob-txt"><b>${x.role.name}</b>${x.desc ? html`<small>${x.desc}</small>` : null}</span><span class="ob-check"><${Icon} name="check" size=${14} sw=${3} /></span></button>`)}</div></div>` : null}
    ${me?.pending && hasRules ? html`<label class="orbit-check"><input type="checkbox" checked=${agree} onChange=${(e) => setAgree(e.target.checked)} /><span class="box"><${Icon} name="check" size=${14} sw=${3} /></span><span><b>${t('I have read and agree to the rules')}</b></span></label>` : null}
  <//>`;
};

/** Server Settings → Onboarding. */
export function OnboardingPage({ server }) {
  const can = hasPerm(server.id, 'MANAGE_SERVER');
  const orig = { enabled: !!server.onboarding?.enabled, rules: server.onboarding?.rules || '', roles: server.onboarding?.roles || [] };
  const [d, setD] = useState(orig); const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(d) !== JSON.stringify(orig);
  const save = async () => { setBusy(true); await act(api.patch(`/servers/${server.id}`, { onboarding: d }), { success: t('Onboarding saved') }); setBusy(false); };
  useSaveBar(dirty && can, { save, reset: () => setD(orig), busy });
  const roles = server.roles.filter((r) => r.id !== server.id).sort((a, b) => b.position - a.position);
  const entry = (rid) => d.roles.find((x) => x.roleId === rid);
  const setRole = (rid, on) => setD((p) => ({ ...p, roles: on ? [...p.roles, { roleId: rid, emoji: '', desc: '' }] : p.roles.filter((x) => x.roleId !== rid) }));
  const putRole = (rid, patch) => setD((p) => ({ ...p, roles: p.roles.map((x) => (x.roleId === rid ? { ...x, ...patch } : x)) }));
  return html`<div class="s-page">
    <${Section} title=${t('Rules screen')} desc=${t('New members read your rules and pick roles before they can talk. People already in the server aren’t asked.')}>
      <${SettingRow} title=${t('Turn it on')} desc=${t('Until they finish, newcomers can read channels but not send messages, react or join voice.')}><${Toggle} checked=${d.enabled} disabled=${!can} onChange=${(v) => setD({ ...d, enabled: v })} /><//>
      <${Field} label=${t('Rules')} hint=${t('Formatting works: **bold**, lists starting with -, and so on.')}><textarea class="textarea" rows="8" maxlength="4000" value=${d.rules} disabled=${!can} placeholder=${t('1. Be kind.\n2. No spam.\n3. Keep it school-friendly.')} onInput=${(e) => setD({ ...d, rules: e.target.value })}></textarea><//>
    <//>
    <${Section} title=${t('Roles members can pick')} desc=${t('Members can change their picks later from the server menu (Rules & roles). Only roles that don’t give extra permissions can be picked.')}>
      ${roles.length ? roles.map((r) => { const e = entry(r.id); const ok = pickable(server, r); return html`<div class="ob-set-row" key=${r.id}>
        <${Toggle} checked=${!!e} disabled=${!can || !ok} onChange=${(v) => setRole(r.id, v)} />
        <span class="ob-set-name"><i style=${{ background: r.color || 'var(--text-3)' }}></i>${r.name}${!ok ? html`<small>${t('gives extra permissions')}</small>` : null}</span>
        ${e ? html`<${TextInput} class="ob-set-emoji" value=${e.emoji || ''} onInput=${(v) => putRole(r.id, { emoji: v })} maxlength="16" placeholder="🎮" disabled=${!can} /><${TextInput} value=${e.desc || ''} onInput=${(v) => putRole(r.id, { desc: v })} maxlength="100" placeholder=${t('What is this role for?')} disabled=${!can} />` : null}</div>`; })
        : html`<p class="text-muted">${t('Make some roles first, on the Roles page.')}</p>`}
    <//>
  </div>`;
}
