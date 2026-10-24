import type { SiteModule } from "../common/module.ts";

export const suiteapps: SiteModule = {
    id: "suiteapps", placement: "feature", slot: "suiteapps",
    navigation: {"target":"suiteapps-section","label":"SuiteApps"},
    html: `<h2 id="suiteapps-heading">SuiteApps</h2><article class="suiteapps-card"><div id="suiteapp-blocks"><template x-for="app in suiteapps" :key="app.index"><div class="suiteapp-block"><div class="suiteapp-fields"><label><span x-text="app.title"></span><input :aria-label="app.urlLabel" type="text" inputmode="url" spellcheck="false" autocomplete="off" placeholder="https://gitlab.eng.netsuite.com/team/suiteapp.git" :data-index="app.index" data-field="url" :value="app.url" :disabled="suiteappsDisabled" @input="inputsuiteapp"></label><label>Branch<input type="text" spellcheck="false" autocomplete="off" placeholder="Default branch" :data-index="app.index" data-field="branch" :value="app.branch" :disabled="suiteappsDisabled" @input="inputsuiteapp"></label><button type="button" class="suiteapp-remove secondary outline" :data-index="app.index" :aria-label="app.removeLabel" :title="app.removeLabel" :disabled="suiteappsDisabled" @click="removesuiteapp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6"/></svg></button></div><small class="suiteapp-local" x-text="app.localNote"></small></div></template><p class="suiteapps-empty" x-show="suiteapps.length === 0">No SuiteApps added yet. Add one to get started.</p></div><div class="suiteapps-footer"><button type="button" class="secondary outline" id="add-suiteapp" disabled :disabled="view.add_suiteapp.disabled" @click="clickadd_suiteapp">+ Add SuiteApp</button><button type="button" id="save-suiteapps" disabled :disabled="view.save_suiteapps.disabled" @click="clicksave_suiteapps">Save SuiteApps</button></div><p id="suiteapps-message" role="status" x-text="view.suiteapps_message.text"></p></article>
`,
    style: `.suiteapp-block{padding:1.5rem;border-bottom:1px solid var(--pico-muted-border-color)}
.suiteapps-footer{display:flex;align-items:center;justify-content:space-between;gap:1rem;flex-wrap:wrap}
.suiteapp-fields{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) 2.75rem;align-items:end;gap:1.25rem}
.suiteapp-fields label{min-width:0;margin-bottom:0}
.suiteapp-fields input{margin-bottom:0}
.suiteapp-remove{display:inline-flex;align-items:center;justify-content:center;width:2.75rem;height:3.25rem;padding:0;margin:0;border:0;border-radius:0.25rem;box-shadow:none;color:var(--pico-secondary);background:transparent}
.suiteapp-remove svg{width:1.25rem;height:1.25rem;pointer-events:none}
.suiteapp-remove:enabled:hover{color:var(--pico-del-color);background:color-mix(in srgb,var(--pico-del-color) 10%,transparent)}
.suiteapp-remove:focus-visible{outline:2px solid var(--pico-primary);outline-offset:2px}
.suiteapp-local{display:block;margin-top:0.5rem;color:var(--pico-muted-color);overflow-wrap:anywhere}
.suiteapp-local:empty{display:none}
.suiteapps-empty{padding:1.5rem;margin:0;color:var(--pico-muted-color)}
.suiteapps-footer button{margin:0}
#suiteapps-message{padding:0 1.5rem 1.25rem}
`,
    styleOrder: 3,
    script: `(context) => {
  const { $, api, render, listen, action } = context;
  let component, view;
  let suiteappsText,
    suiteappsError = false;
  function suiteappConfig() {
    const config = JSON.parse(context.settings.text);
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      !Array.isArray(config.suiteapps) ||
      config.suiteapps.some(
        (app) => !app || typeof app !== 'object' || Array.isArray(app),
      )
    ) {
      throw new Error(
        'Fix the SuiteApps list in Advanced configuration before editing SuiteApps.',
      );
    }
    return config;
  }
  function directoryFromUrl(value) {
    // Accept both HTTPS and GitLab's existing git@host:path SSH syntax.
    return value
      .trim()
      .split(/[?#]/)[0]
      .replace(/\\/+$/, '')
      .split(/[/:]/)
      .pop()
      .replace(/\\.git$/i, '');
  }
  function suiteappView(app, index) {
    const url = typeof app.url === 'string' ? app.url : '';
    const directory = typeof app.directory === 'string' ? app.directory : '';
    return {
      index,
      url,
      branch: typeof app.branch === 'string' ? app.branch : '',
      title: directory || 'New SuiteApp',
      urlLabel: (directory || 'New SuiteApp') + ' GitLab URL',
      directory: directory || 'determined from the GitLab URL',
      directoryNote:
        directory && directory !== directoryFromUrl(url)
          ? ' · configured in Advanced configuration'
          : ' · automatic',
      localNote: app.localPath
        ? 'Local checkout: ' +
          app.localPath +
          '. Manage it in Advanced configuration.'
        : '',
      removeLabel: 'Remove SuiteApp ' + (index + 1),
    };
  }
  function renderSuiteapps(busy) {
    try {
      const config = suiteappConfig();
      if (suiteappsText !== context.settings.text) {
        component.suiteapps = config.suiteapps.map(suiteappView);
        suiteappsText = context.settings.text;
      }
      component.suiteappsDisabled = busy;
      view.add_suiteapp.disabled = busy;
      view.save_suiteapps.disabled = busy;
      if (suiteappsError) view.suiteapps_message.text = '';
      suiteappsError = false;
    } catch {
      component.suiteappsDisabled = true;
      view.add_suiteapp.disabled = true;
      view.save_suiteapps.disabled = true;
      suiteappsError = true;
      view.suiteapps_message.text =
        'Fix the configuration JSON in Advanced configuration to edit SuiteApps. Your JSON edits are preserved.';
    }
  }
  function writeSuiteapps(config) {
    context.settings.text = JSON.stringify(config, null, 4);
    context.settings.changed();
    view.suiteapps_message.text =
      'SuiteApps changed. Save SuiteApps, or click Deploy to save and deploy.';
  }
  listen('suiteapp', 'input', (event) => {
    if (component.suiteappsDisabled) return;
    const input = event.currentTarget;
    const index = Number(input.dataset.index);
    const config = suiteappConfig();
    const app = config.suiteapps[index];
    if (input.dataset.field === 'url') {
      const url = input.value.trim();
      if (url) {
        app.url = url;
        app.directory = directoryFromUrl(url);
      } else {
        delete app.url;
        if (!app.localPath) app.directory = '';
      }
    } else {
      const branch = input.value.trim();
      if (branch) app.branch = branch;
      else delete app.branch;
    }
    writeSuiteapps(config);
    // Keep the active input mounted while typing and while state polls arrive.
    const item = suiteappView(app, index);
    item[input.dataset.field] = input.value;
    Object.assign(component.suiteapps[index], item);
    suiteappsText = context.settings.text;
  });
  listen('removesuiteapp', '', (event) => {
    if (component.suiteappsDisabled) return;
    const config = suiteappConfig();
    config.suiteapps.splice(Number(event.currentTarget.dataset.index), 1);
    writeSuiteapps(config);
    renderSuiteapps(false);
  });
  listen('add-suiteapp', 'click', () => {
    if (component.suiteappsDisabled) return;
    const config = suiteappConfig();
    config.suiteapps.push({ url: '', directory: '' });
    writeSuiteapps(config);
    renderSuiteapps(false);
    component.$nextTick(() =>
      $('suiteapp-blocks')
        .querySelector('.suiteapp-block:last-of-type input')
        ?.focus(),
    );
  });
  action(
    'save-suiteapps',
    async () => {
      const next = await api('settings', { config: context.settings.text });
      context.settings.editing = false;
      render(next);
      view.suiteapps_message.text = 'SuiteApps saved.';
      context.settings.saved();
    },
    'suiteapps-message',
  );

  return {
    init(root) {
      component = root;
      view = root.view;
    },
    render: (_next, busy) => renderSuiteapps(busy),
    controller: { suiteapps: [], suiteappsDisabled: true },
    settingsChanged() {
      renderSuiteapps(context.busy);
    },
    connectionLost() {
      component.suiteappsDisabled = true;
    },
  };
}`,
};
