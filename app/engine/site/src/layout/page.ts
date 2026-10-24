import type { SiteModule } from "../common/module.ts";

export const layout: SiteModule = {
    id: "layout", placement: "feature",
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>SuiteCloud deployment</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/pico.css"><link rel="stylesheet" href="/page.css"><link id="brand-theme-stylesheet" rel="stylesheet" href="/themes/netsuite-2026.css"><script src="/page.js" defer></script><script src="/alpine.js" defer></script></head>
<body><main class="container" x-data="deployment" x-cloak>
<div class="theme-controls"><label class="brand-theme-picker" for="brand-theme-select"><select id="brand-theme-select" aria-label="Appearance" @change="changebrand_theme_select"><option value="default">Default</option><option value="netsuite-2026" selected>NetSuite 2026</option><option value="oracle-corporate-2026">Oracle Corporate 2026</option></select></label><label class="theme-toggle" for="theme-toggle"><input id="theme-toggle" type="checkbox" role="switch" aria-label="Dark theme" :disabled="view.theme_toggle.disabled" @change="changetheme_toggle"></label></div>
<p id="theme-message" role="status" x-text="view.theme_message.text"></p>
<header><hgroup><h1><mark>SuiteContainer</mark></h1><p>Set your scrumbox address, complete your credentials, then deploy your SuiteApps.</p></hgroup></header>
<nav class="section-nav" aria-label="Jump to a section" @click="jumpsection"><span>Jump to</span>{{navigation}}<button id="stop" :disabled="view.stop.disabled" @click="clickstop">Stop app</button></nav>

<p id="connection-error" role="alert" hidden :hidden="view.connection_error.hidden" x-text="view.connection_error.text"></p>
<div class="setup-sections">{{setup}}<section id="suiteapps-section" aria-labelledby="suiteapps-heading">{{suiteapps}}{{settings}}</section><section aria-labelledby="tools-heading"><h2 id="tools-heading">Tools</h2><div class="tool-sections">{{tools}}</div></section></div>{{deployment}}</main></body></html>`,
    script: `(context) => {
    const { $, api, refresh, render, listen, action } = context;
    let component, view;
    let selectedTheme, themeSave;
    const systemTheme = matchMedia('(prefers-color-scheme: dark)');
    const {session, requestId} = context;
            function applyTheme(theme) {
          if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
          else delete document.documentElement.dataset.theme;
          $('theme-toggle').checked = theme === 'dark' || (theme !== 'light' && systemTheme.matches);
        }
        listen('theme-toggle', 'change', async () => {
          if (context.stopped || context.connectionFailed) return;
          const theme = $('theme-toggle').checked ? 'dark' : 'light';
          selectedTheme = theme;
          applyTheme(theme);
          themeSave?.abort();
          const controller = new AbortController();
          themeSave = controller;
          view.theme_message.text = '';
          try {
            const config = JSON.parse(context.settings.text);
            if (config && typeof config === 'object' && !Array.isArray(config) &&
                (config.status === undefined || (config.status && typeof config.status === 'object' && !Array.isArray(config.status)))) {
              config.status = {...config.status, theme};
              context.settings.text = JSON.stringify(config, null, 4);
            }
          } catch { /* Keep unfinished JSON edits intact. */ }
          const timeout = context.timeout(() => controller.abort(), 10000);
          try {
            const response = await fetch('/api/theme', {signal:controller.signal, method:'POST',
              headers:{'X-Session-Token':session,'Content-Type':'application/json','Idempotency-Key':requestId()}, body:JSON.stringify({theme})});
            if (!response.ok) {
              const result = await response.json();
              throw new Error(result.error || 'The theme could not be saved.');
            }
          } catch (error) {
            if (themeSave === controller && !controller.signal.aborted) view.theme_message.text = error.message;
          } finally {
            context.clearTimeout(timeout);
            if (themeSave === controller) themeSave = undefined;
          }
        });
        listen('brand-theme-select', 'change', () => {
          const choice = $('brand-theme-select').value;
          const brand = choice === 'default' || choice === 'oracle-corporate-2026' ? choice : 'netsuite-2026';
          if (brand === 'default') $('brand-theme-stylesheet').media = 'not all';
          else {
            $('brand-theme-stylesheet').href = '/themes/' + brand + '.css';
            $('brand-theme-stylesheet').media = 'all';
          }
          sessionStorage.setItem('suitecontainer-brand-theme', brand);
        });
        action('stop', async () => {
          await api('stop',{});
          context.stopped = true;
          component.suiteappsDisabled = true;
          view.theme_toggle.disabled = true;
          view.run_state.text = 'App stopped. Attempting to close this page…';
          for (const button of document.querySelectorAll('button')) if (button.id) view[button.id.replaceAll('-', '_')].disabled = true;
          context.timeout(() => {
            try { window.close(); } catch { /* The browser may refuse script-driven closure. */ }
            if (!window.closed) view.run_state.text = 'App stopped. Your browser kept this page open. You can close this tab.';
          }, 5000);
        });

    return {
      init(root) { component = root; view = root.view;         const brandTheme = sessionStorage.getItem('suitecontainer-brand-theme');
        if (brandTheme === 'default') {
          $('brand-theme-select').value = brandTheme;
          $('brand-theme-stylesheet').media = 'not all';
        } else if (brandTheme === 'netsuite-2026' || brandTheme === 'oracle-corporate-2026') {
          $('brand-theme-select').value = brandTheme;
          $('brand-theme-stylesheet').href = '/themes/' + brandTheme + '.css';
        }

    applyTheme();
    context.on(systemTheme, 'change', () => { if (!selectedTheme && !context.state?.theme) applyTheme(); });
 },
      render: (next) => applyTheme(selectedTheme || next.theme),
      controller: {
      jumpsection(event) {
        const link = event.target.closest('a');
        if (!link) return;
        const target = document.getElementById(link.hash.slice(1));
        if (!target) return;
        event.preventDefault();
        if (target.tagName === 'DETAILS') target.open = true;
        if (target.id === 'credentials-section') document.getElementById('vm-section').open = true;
        target.style.scrollMarginTop = 'calc(' + event.currentTarget.offsetHeight + 'px + 1rem)';
        target.scrollIntoView({block:'start'});
      },

},
      cleanup() { themeSave?.abort(); },
    };
  }`,
};

export function pageHtml(features: readonly SiteModule[], tools: readonly SiteModule[]): string {
    const slots: Record<string, string> = {navigation:"", tools:tools.map(module => module.html).join("")};
    for (const module of features) {
        const slot = module.slot ?? "setup";
        slots[slot] = (slots[slot] ?? "") + module.html;
    }
    slots.navigation = [...features, ...tools].filter(module => module.navigation).map(module => '<a href="#' + module.navigation!.target + '">' + module.navigation!.label + '</a>').join("");
    return layout.html.replace(/\{\{(\w+)\}\}/g, (_match, slot: string) => slots[slot] ?? "");
}
