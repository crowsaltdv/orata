// Orata — ads (Google AdSense), in a few quiet spots only: one on the home screen (under Active Now), the empty side of Settings, the bottom of a server's
// member list, and the end of Discovery and Music. Never in chats, DMs, calls, menus or the sign-in screens. The AdSense script, its publisher id
// (<meta name="google-adsense-account">) and ads.txt come from server/index.js.
import { html, useEffect, useRef, cx } from '/js/lib.js';
import { useSel } from '/js/store.js';
import { t } from '/js/i18n.js';

const CLIENT = document.querySelector('meta[name="google-adsense-account"]')?.content || null;
/** The ad unit made in AdSense (Ads → By ad unit) for each spot. An empty one shows nothing, except to Orata staff, who see where it will be. */
const SLOTS = { home: '9803896804', settings: '7772007714', rail: '9496775045', page: '6490629913' };   // Orata Home, Orata Settings, Orata Member list, Orata End of page
const NAME = { home: 'Home', settings: 'Settings', rail: 'Member list', page: 'End of page' };

export function Ad({ spot }) {
  const slot = SLOTS[spot]; const ref = useRef(null);
  const staff = useSel((s) => !!s.me?.founder || !!s.me?.badges?.some((b) => b.id === 'staff' || b.id === 'dev'));
  useEffect(() => { if (CLIENT && slot && ref.current && !ref.current.dataset.adsbygoogleStatus) try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* blocked */ } }, [slot]);
  if (!CLIENT || !slot) return staff ? html`<div class=${cx('ad', `ad-${spot}`, 'ad-preview')}><b>${t('Ad spot')}: ${t(NAME[spot])}</b><small>${t('Only Orata staff see this box until its ad unit is set (public/js/ads.js).')}</small></div>` : null;
  return html`<div class=${cx('ad', `ad-${spot}`)}><span class="ad-label">${t('Ad')}</span>
    <ins class="adsbygoogle" ref=${ref} style="display:block" data-ad-client=${CLIENT} data-ad-slot=${slot} data-ad-format="auto" data-full-width-responsive="true"></ins></div>`;
}
