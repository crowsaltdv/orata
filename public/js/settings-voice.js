// Orate — Settings → Voice & Video.
import { html, useState, useEffect, useRef, cx } from '/js/lib.js';
import { state, useSel, updateLocal, toast } from '/js/store.js';
import { Icon } from '/js/icons.js';
import { Btn, Slider, Toggle, SettingRow, Section, Dropdown, Segmented } from '/js/ui.js';
import { listDevices, micConstraints, cameraConstraints, createMeter, refreshOutputs } from '/js/voice.js';
import { playSound } from '/js/sound.js';
import { t } from '/js/i18n.js';

const setV = (patch) => { updateLocal({ voice: patch }); setTimeout(refreshOutputs, 0); };
const keyLabel = (code) => (code || '').replace(/^Key/, '').replace(/^Digit/, '').replace('Backquote', '`').replace('Space', 'Space');

export function VoicePage() {
  const v = useSel((s) => s.local.voice);
  const [dev, setDev] = useState({ inputs: [], outputs: [], cameras: [] }); const [granted, setGranted] = useState(false);
  const [testing, setTesting] = useState(false); const [lvl, setLvl] = useState(0); const [camOn, setCamOn] = useState(false); const [rec, setRec] = useState(false);
  const meter = useRef(null); const micStream = useRef(null); const camRef = useRef(null); const camStream = useRef(null);
  const refresh = async () => { const d = await listDevices(); setDev(d); setGranted(d.inputs.some((x) => x.label) || d.cameras.some((x) => x.label)); };
  useEffect(() => { refresh(); navigator.mediaDevices?.addEventListener?.('devicechange', refresh); return () => { navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); stopTest(); stopCam(); }; }, []);
  const allow = async () => { try { const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); s.getTracks().forEach((x) => x.stop()); } catch { toast('Permission was denied. Allow access in your browser’s site settings.', 'error', 5000); } refresh(); };
  const startTest = async () => {
    try { stopTest(); micStream.current = await navigator.mediaDevices.getUserMedia(micConstraints(v)); meter.current = createMeter(micStream.current, setLvl); setTesting(true); refresh(); } catch { toast('Couldn’t open that microphone', 'error'); }
  };
  const stopTest = () => { meter.current?.stop(); meter.current = null; micStream.current?.getTracks().forEach((x) => x.stop()); micStream.current = null; setTesting(false); setLvl(0); };
  useEffect(() => { if (testing) startTest(); }, [v.inputDevice, v.noiseSuppression, v.echoCancellation, v.autoGain]);
  const startCam = async () => { try { stopCam(); camStream.current = await navigator.mediaDevices.getUserMedia(cameraConstraints(v)); setCamOn(true); setTimeout(() => { if (camRef.current) camRef.current.srcObject = camStream.current; }, 30); refresh(); } catch { toast('Couldn’t open that camera', 'error'); } };
  const stopCam = () => { camStream.current?.getTracks().forEach((x) => x.stop()); camStream.current = null; setCamOn(false); };
  useEffect(() => { if (camOn) startCam(); }, [v.cameraDevice, v.videoQuality]);
  useEffect(() => {
    if (!rec) return undefined;
    const h = (e) => { e.preventDefault(); if (e.code !== 'Escape') setV({ pttKey: e.code }); setRec(false); };
    window.addEventListener('keydown', h, true); return () => window.removeEventListener('keydown', h, true);
  }, [rec]);
  const opts = (list, fallback) => [{ value: 'default', label: t('Default') }, ...list.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))];
  const testOutput = async () => {
    playSound('test', { force: true });
    if (v.outputDevice !== 'default') toast('Playing on your system default — per-device routing applies in calls', 'info', 2500);
  };
  const thr = v.autoSensitivity ? 0.1 : v.sensitivity / 100;
  return html`<div class="s-page">
    ${!granted ? html`<div class="perm-banner"><${Icon} name="mic" size=${22} /><div><b>${t('Allow microphone & camera access')}</b><small>${t('Your browser hides device names until you grant permission.')}</small></div><${Btn} variant="primary" onClick=${allow}>${t('Allow access')}<//></div>` : null}
    <div class=${cx('note-chip', state.turn && 'ok')}><${Icon} name=${state.turn ? 'check-circle' : 'info'} size=${15} /> ${state.turn ? 'A TURN relay is configured, so calls can connect even through strict firewalls and NATs.' : 'No TURN relay is configured: calls use direct connections (STUN) only. Add TURN_URLS to .env if friends can’t hear each other — see the README.'}</div>
    <${Section} title=${t('Voice')}>
      <div class="two-col-set"><div><h5 class="s-label">${t('Input device')}</h5><${Dropdown} value=${v.inputDevice} options=${opts(dev.inputs, 'Microphone')} onChange=${(x) => setV({ inputDevice: x })} /></div>
        <div><h5 class="s-label">${t('Output device')}</h5><${Dropdown} value=${v.outputDevice} options=${opts(dev.outputs, 'Speaker')} onChange=${(x) => setV({ outputDevice: x })} /></div></div>
      <div class="two-col-set"><div><h5 class="s-label">${t('Input volume')}</h5><${Slider} value=${v.inputVolume} min=${0} max=${200} onChange=${(x) => setV({ inputVolume: x })} format=${(x) => x + '%'} /></div>
        <div><h5 class="s-label">${t('Output volume')}</h5><${Slider} value=${v.outputVolume} min=${0} max=${100} onChange=${(x) => setV({ outputVolume: x })} format=${(x) => x + '%'} /></div></div>
      <div class="mic-test"><div class="mt-head"><b>${t('Mic test')}</b><span>${t('Say something — the bar should move.')}</span><${Btn} size="sm" variant=${testing ? 'danger' : 'primary'} icon=${testing ? 'x' : 'mic'} onClick=${testing ? stopTest : startTest}>${testing ? t('Stop') : t("Let's Check")}<//><${Btn} size="sm" icon="volume" onClick=${testOutput}>${t('Test sound')}<//></div>
        <div class="meter"><i style=${{ width: lvl * 100 + '%' }}></i><span class="meter-th" style=${{ left: Math.min(100, thr * 100 * 3) + '%' }}></span></div></div>
    <//>
    <${Section} title=${t('Input sensitivity')}>
      <${SettingRow} title=${t('Automatically determine input sensitivity')}><${Toggle} checked=${v.autoSensitivity} onChange=${(x) => setV({ autoSensitivity: x })} /><//>
      <div class=${cx(v.autoSensitivity && 'dim')}><${Slider} value=${v.sensitivity} min=${0} max=${100} onChange=${(x) => setV({ sensitivity: x })} disabled=${v.autoSensitivity} format=${(x) => x + '%'} label=${t('Threshold')} /></div>
    <//>
    <${Section} title=${t('Processing')}>
      <${SettingRow} title=${t('Noise suppression')} desc=${t('Reduces keyboard clicks and background hiss.')}><${Toggle} checked=${v.noiseSuppression} onChange=${(x) => setV({ noiseSuppression: x })} /><//>
      <${SettingRow} title=${t('Echo cancellation')} desc=${t('Prevents others hearing themselves through your speakers.')}><${Toggle} checked=${v.echoCancellation} onChange=${(x) => setV({ echoCancellation: x })} /><//>
      <${SettingRow} title=${t('Automatic gain control')}><${Toggle} checked=${v.autoGain} onChange=${(x) => setV({ autoGain: x })} /><//>
    <//>
    <${Section} title=${t('Push to talk')}>
      <${SettingRow} title=${t('Use push to talk')} desc=${t('Your microphone is muted unless you hold the key (while Orate is focused).')}><${Toggle} checked=${v.pushToTalk} onChange=${(x) => setV({ pushToTalk: x })} /><//>
      ${v.pushToTalk ? html`<${SettingRow} title=${t('Shortcut')}><button type="button" class=${cx('keybind', rec && 'rec')} onClick=${() => setRec(true)}>${rec ? t('Press a key…') : keyLabel(v.pttKey)}</button><//>` : null}
      <${SettingRow} title=${t('Join voice channels muted')}><${Toggle} checked=${v.joinMuted} onChange=${(x) => setV({ joinMuted: x })} /><//>
    <//>
    <${Section} title=${t('Camera')}>
      <div class="two-col-set"><div><h5 class="s-label">${t('Camera')}</h5><${Dropdown} value=${v.cameraDevice} options=${opts(dev.cameras, 'Camera')} onChange=${(x) => setV({ cameraDevice: x })} /></div>
        <div><h5 class="s-label">${t('Video quality')}</h5><${Segmented} size="sm" options=${[{ value: '360', label: '360p' }, { value: '720', label: '720p' }, { value: '1080', label: '1080p' }]} value=${String(v.videoQuality)} onChange=${(x) => setV({ videoQuality: x })} /></div></div>
      <${SettingRow} title=${t('Mirror my video')}><${Toggle} checked=${v.mirrorVideo} onChange=${(x) => setV({ mirrorVideo: x })} /><//>
      <div class=${cx('cam-preview', camOn && 'on')}>${camOn ? html`<video ref=${camRef} autoplay muted playsinline class=${v.mirrorVideo ? 'mirror' : ''}></video>` : html`<div class="cam-off"><${Icon} name="video-off" size=${34} sw=${1.6} /><span>${t('Test your camera')}</span></div>`}
        <${Btn} class="cam-btn" variant=${camOn ? 'danger' : 'primary'} icon=${camOn ? 'x' : 'video'} onClick=${camOn ? stopCam : startCam}>${camOn ? t('Stop') : t('Test Video')}<//></div>
    <//>
  </div>`;
}
void state;
