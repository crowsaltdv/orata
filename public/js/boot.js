// Orata — entry point.
import '/js/lite.js';   // first: Lite mode decides what the rest loads and shows
import { html, render, ls } from '/js/lib.js';
import { state, set, parseRoute } from '/js/store.js';
import { initTheme } from '/js/theme.js';
import { gateway } from '/js/api.js';
import '/js/events.js';
import { initTooltips } from '/js/ui.js';
import { App } from '/js/app.js';
import { startPerfWatchdog } from '/js/perf.js';
import { initFx } from '/js/fx.js';
import { initCloak } from '/js/cloak.js';

initCloak();   // a saved tab cloak (title + icon) applies before anything else shows
initTheme();
initTooltips();
initFx();
startPerfWatchdog();
const route = parseRoute(location.pathname);
set({ route: { ...state.route, ...route } });
if (state.token) { set({ phase: 'loading' }); gateway.connect(); } else {
  set({ phase: 'auth' });
  // a first visit (nobody has ever signed in on this browser) opens the sign-up screen; anyone who has, or who asked for /login itself, gets the login screen
  const first = !ls('returning', false) && !ls('lastLogin', '') && !state.accounts.length;
  const auth = (view, param) => { history.replaceState({}, '', '/' + view); set({ route: { view, serverId: '@me', channelId: null, ...(param ? { param } : {}) } }); };
  if (route.view === 'invite') { ls('pendingInvite', null, route.param); auth(first ? 'register' : 'login', route.param); }
  else if (route.view !== 'register' && route.view !== 'verify') auth(route.view !== 'login' && first ? 'register' : 'login');
}
render(html`<${App} />`, document.getElementById('app'));
window.__orate = { state };
