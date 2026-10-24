import type { SiteModule } from "../common/module.ts";

export const settings: SiteModule = {
    id: "settings", placement: "feature", slot: "settings",
    
    html: `<article><details class="setup-section" id="settings-section"><summary><h2>Advanced configuration</h2></summary><div  class="advanced-configuration-art"><img src="/advanced-configuration.png" alt="Three dragon heads labeled Auto-Deploy, Supporting Tools, and Configuration, with a playful Configuration head." width="1158" height="1338" loading="lazy"></div><div class="advanced-configuration-intro"><p>Edit local checkout paths, custom directories, and other options here. Additional scrumboxes may be entered under <code>vms</code>. SQL and SFTP use settings from the first entry.</p></div>
<label for="config">Configuration JSON</label><textarea id="config" spellcheck="false" rows="22" :disabled="view.config.disabled" @input="inputconfig"></textarea><fieldset><button id="save" :disabled="view.save.disabled" @click="clicksave">Save settings</button></fieldset><p id="settings-message" role="status" x-text="view.settings_message.text"></p></details></article>
`,
    style: `#settings-section{position:relative}
.advanced-configuration-art{display:none;height:auto}
#settings-section[open]>.advanced-configuration-art{display:block;position:absolute;inset-block-start:-0.5rem;inset-inline-end:0;width:14rem;max-width:100%;overflow:hidden;max-height:10rem}
#settings-section[open]>summary{padding-inline-end:16rem}
.advanced-configuration-intro{padding-inline-end:16rem;}
@media(max-width:575px){#settings-section[open]>summary{padding-inline-end:0}#settings-section[open]>.advanced-configuration-art{position:static;width:14rem;margin:0 auto 1.5rem}.advanced-configuration-intro{padding-inline-end:0;min-height:0}}
`,
    styleOrder: 5,
    script: `(context) => {
  const { $, api, refresh, render, listen, action } = context;
  let view;

  function markSettingsChanged() {
    context.actionError = '';
    context.settings.editing = true;
    view.settings_message.text =
      'Settings changed. Save settings, or click Deploy to save and deploy.';
    view.deploy.disabled = true;
    context.settings.scheduleRefresh();
  }
  function selectedTargetHost() {
    try {
      const host = JSON.parse($('config').value).vms?.[0]?.url;
      return typeof host === 'string' &&
        /^(?:[A-Za-z0-9-]+\\.)+[A-Za-z0-9-]+$/.test(host) &&
        host.endsWith('.netsuite.com')
        ? host
        : '';
    } catch {
      return '';
    }
  }

  context.settings = {
    editing: false,
    checking: undefined,
    scheduleRefresh() {
      context.clearTimeout(this.checking);
      this.checking = context.timeout(refresh, 350);
    },
    get text() {
      return $('config').value;
    },
    set text(value) {
      $('config').value = value;
    },
    parse() {
      return JSON.parse(this.text);
    },
    changed: markSettingsChanged,
    targetHost: selectedTargetHost,
    saved() {
      view.settings_message.text = 'Settings saved.';
    },
  };
  listen('config', 'input', () => {
    markSettingsChanged();
    context.settingsChanged();
  });
  action(
    'save',
    async () => {
      render(await api('settings', { config: $('config').value }));
      context.settings.editing = false;
      view.settings_message.text = 'Settings saved.';
    },
    'settings-message',
  );

  return {
    init(root) {
      view = root.view;
    },
    render: (next, busy) => {
      if (!context.settings.editing) $('config').value = next.config;
      view.config.disabled = busy;
      view.save.disabled = busy;
    },
    collapse() {
      $('settings-section').open = false;
    },
  };
}`,
};
