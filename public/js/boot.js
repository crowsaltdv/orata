// Orate — entry point.
import { html, render } from '/js/lib.js';
import { state, set, parseRoute } from '/js/store.js';
import { initTheme } from '/js/theme.js';
import { gateway } from '/js/api.js';
import '/js/events.js';
import { initTooltips } from '/js/ui.js';
import { App } from '/js/app.js';
import { startPerfWatchdog } from '/js/perf.js';
import { initFx } from '/js/fx.js';

initTheme();
initTooltips();
initFx();
startPerfWatchdog();
const route = parseRoute(location.pathname);
set({ route: { ...state.route, ...route } });
if (state.token) { set({ phase: 'loading' }); gateway.connect(); } else {
  set({ phase: 'auth' });
  if (route.view === 'invite') { import('/js/lib.js').then(({ ls }) => ls('pendingInvite', null, route.param)); history.replaceState({}, '', '/login'); set({ route: { view: 'login', serverId: '@me', channelId: null, param: route.param } }); }
  else if (route.view !== 'register') { history.replaceState({}, '', '/login'); set({ route: { view: 'login', serverId: '@me', channelId: null } }); }
}
render(html`<${App} />`, document.getElementById('app'));
window.__orate = { state };
