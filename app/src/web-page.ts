import { ansiToHtml, ansiStyles, applyAnsiColors } from "./ansi.ts";
import { ACTIVITY_GRACE_MS, HEARTBEAT_INTERVAL_MS } from "./web-inactivity.ts";

const lightTheme = `
--pico-background-color:#e9e7e2;
--pico-color:#343d48;
--pico-muted-color:#626b74;
--pico-primary:#1679ad;
--pico-primary-background:#1679ad;
--pico-primary-border:#1679ad;
--pico-card-background-color:#f6f3ee;
--pico-card-border-color:#d7d5cf;
--pico-card-box-shadow:none;
--suite-mark-gradient:linear-gradient(to right,#b354a5,#7658bf,#367bc4);
`;

export const deploymentPage = {
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>SuiteCloud deployment</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/pico.css"><link rel="stylesheet" href="/page.css"><script src="/page.js" defer></script><script src="/alpine.js" defer></script></head>
<body><main class="container" x-data="deployment" x-cloak>
<label class="theme-toggle" for="theme-toggle"><input id="theme-toggle" type="checkbox" role="switch" aria-label="Dark theme" :disabled="view.theme_toggle.disabled" @change="changetheme_toggle"><span aria-hidden="true">☾</span></label>
<p id="theme-message" role="status" x-text="view.theme_message.text"></p>
<header><hgroup><h1><mark>SuiteContainer</mark></h1><p>Set your scrumbox address, your complete credentials, then deploy your SuiteApps.</p></hgroup></header>
<p id="connection-error" role="alert" hidden :hidden="view.connection_error.hidden" x-text="view.connection_error.text"></p>
<div class="setup-sections">
<article><details class="setup-section" id="credentials-section" open><summary><h2>Credentials</h2></summary><ol class="credential-steps" role="list"><li><h3>GitLab token</h3><blockquote class="status-message" id="token-state" x-text="view.token_state.text"></blockquote><button class="secondary outline" id="change-token" hidden :hidden="view.change_token.hidden" :disabled="view.change_token.disabled" @click="clickchange_token">Change GitLab token</button><div id="token-entry" :hidden="view.token_entry.hidden"><label for="token">GitLab token</label><input id="token" type="password" autocomplete="off" placeholder="Paste your token" :disabled="view.token.disabled" @input="inputtoken"></div></li>
<li><h3>Certificate paths</h3><details id="cert-details"><summary>View file paths</summary><p>Changing paths requires relaunching.</p><label for="public">Public certificate path</label><input id="public" :disabled="view.public.disabled" @input="inputpublic"><label for="private">Private key path</label><input id="private" :disabled="view.private.disabled" @input="inputprivate"></details>
<fieldset class="grid" aria-label="Certificate actions"><button class="secondary outline" id="generate" :disabled="view.generate.disabled" @click="clickgenerate">Generate new certificates</button>
<button class="secondary" id="download" hidden :hidden="view.download.hidden" :disabled="view.download.disabled" @click="clickdownload">Download public certificate</button></fieldset>
<p id="cert-message" x-text="view.cert_message.text"></p><div id="registration"><p>Register the public certificate on your scrumbox: open <strong>Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup</strong>, select SuiteCloud Development Integration and the appropriate entity and role, and upload <strong>public.pem</strong>. Copy the assigned certificate ID below. Keep the private key on this computer.</p><p><a id="scrumbox-link" hidden target="_blank" rel="noopener noreferrer" :hidden="view.scrumbox_link.hidden">Open scrumbox</a> <a href="https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0422011927.html" target="_blank" rel="noopener noreferrer">NetSuite setup guide</a></p></div>
</li><li><h3>Current VM</h3><label for="vm">Current VM (scrumbox domain)</label><input id="vm" aria-describedby="vm-help" placeholder="your-scrumbox.vm.eng.netsuite.com" :disabled="view.vm.disabled" @input="inputvm"><p id="vm-help"><small>Enter only the domain, without https://. Click Save credentials to update settings.</small></p>
<label for="id">Certificate ID assigned by NetSuite</label><input id="id" :disabled="view.id.disabled" @input="inputid"></li></ol><fieldset><button id="credentials" :disabled="view.credentials.disabled" @click="clickcredentials">Save credentials</button></fieldset><p id="credential-message" role="status" x-text="view.credential_message.text"></p></details></article>
<article><details class="setup-section" id="settings-section" open><summary><h2>Settings</h2></summary><p>Check the settings below. Additional scrumboxes may be entered under <code>vms</code>. Settings from the first scrumbox are used.</p>
<label for="config">Configuration JSON</label><textarea id="config" spellcheck="false" rows="22" :disabled="view.config.disabled" @input="inputconfig"></textarea><fieldset><button id="save" :disabled="view.save.disabled" @click="clicksave">Save settings</button></fieldset><p id="settings-message" role="status" x-text="view.settings_message.text"></p></details></article>
<article><details class="setup-section" id="sql-section"><summary><h2>SQL</h2></summary>
<div class="grid"><div><label for="sql-account">User</label><input id="sql-account" autocomplete="off" spellcheck="false" :disabled="view.sql_account.disabled" @input="inputsql_account"></div>
<div><label for="sql-database">Service Name</label><input id="sql-database" autocomplete="off" spellcheck="false" :disabled="view.sql_database.disabled" @input="inputsql_database"></div></div>
<div class="grid"><div><label for="sql-password">Password</label><input id="sql-password" type="password" autocomplete="off" :disabled="view.sql_password.disabled" @input="inputsql_password"></div>
<div><label for="sql-unlock">Answer to password hint</label><input id="sql-unlock" type="password" autocomplete="off" aria-describedby="sql-password-hint sql-unlock-availability" :disabled="view.sql_unlock.disabled" @input="inputsql_unlock"><p id="sql-password-hint" hidden :hidden="view.sql_password_hint.hidden" x-text="view.sql_password_hint.text"></p></div></div>
<p>Enter SQL password, or answer the hint to use the default password. Entering one clears the other.</p><p id="sql-unlock-availability" hidden :hidden="view.sql_unlock_availability.hidden" x-text="view.sql_unlock_availability.text"></p>
<label for="sql-statement">SQL statement</label><textarea id="sql-statement" rows="8" spellcheck="false" placeholder="SELECT * FROM your_table;" :disabled="view.sql_statement.disabled" @input="inputsql_statement"></textarea>
<fieldset><button id="sql-run" disabled :disabled="view.sql_run.disabled" @click="clicksql_run">Run SQL</button></fieldset><p id="sql-message" role="status" x-text="view.sql_message.text"></p><pre id="sql-output" tabindex="0" aria-label="SQL results"></pre></details></article>
<article><details class="setup-section" id="sftp-section"><summary><h2>SFTP</h2></summary>
<p id="sftp-description" x-text="view.sftp_description.text"></p>
<fieldset class="grid" aria-label="SFTP actions"><button id="sftp-start" disabled :disabled="view.sftp_start.disabled" @click="clicksftp_start">Start SFTP</button><button id="sftp-stop" class="secondary outline" disabled :disabled="view.sftp_stop.disabled" @click="clicksftp_stop">Stop SFTP</button><button id="sftp-save" class="secondary" disabled :disabled="view.sftp_save.disabled" @click="clicksftp_save">Save settings</button></fieldset>
<button id="sftp-recreate" hidden :hidden="view.sftp_recreate.hidden" :disabled="view.sftp_recreate.disabled" @click="clicksftp_recreate">Recreate SFTP</button>
<blockquote class="status-message" id="sftp-message" role="status" x-text="view.sftp_message.text"></blockquote>
<p id="sftp-upload" hidden :hidden="view.sftp_upload.hidden">Upload files directly to <strong id="sftp-upload-url"></strong>.</p>
<details><summary>SFTP settings</summary>
<p>These are your own machine settings.</p>
<div class="grid"><div><label for="sftp-user">User</label><input id="sftp-user" autocomplete="off" spellcheck="false" :disabled="view.sftp_user.disabled" @input="inputsftp_user"></div>
<div><label for="sftp-port">Port</label><input id="sftp-port" type="number" min="1" max="65535" step="1" :disabled="view.sftp_port.disabled" @input="inputsftp_port"></div></div>
<div class="grid"><div><label for="sftp-password">Password</label><input id="sftp-password" type="password" autocomplete="new-password" aria-describedby="sftp-password-help" :disabled="view.sftp_password.disabled" @input="inputsftp_password"><p id="sftp-password-help" x-text="view.sftp_password_help.text"></p></div>
<div id="sftp-folder" :hidden="view.sftp_folder.hidden"><label for="sftp-path">Absolute path to local folder</label><input id="sftp-path" spellcheck="false" aria-describedby="sftp-path-help" :disabled="view.sftp_path.disabled" @input="inputsftp_path"><p id="sftp-path-help">Leave blank to use the default folder <strong>sftp-files</strong>. Changing this value requires a restart.</p></div></div>
</details>
<details><summary>NetSuite connection fields</summary>
<p>Use these settings for the connectivity plugin in <strong>NetSuite > Format Profile</strong>. Note: Internal SFTP addresses must be allowed on the deployment scrumbox via <strong>AdminDocs Canary Tool</strong>.</p>
<div class="grid sftp-connection-grid">
<div><div class="sftp-value-heading"><span id="sftp-url-label">URL</span><button id="copy-sftp-url" type="button" class="secondary outline" aria-label="Copy URL" :disabled="view.copy_sftp_url.disabled" x-text="view.copy_sftp_url.text" @click="clickcopy_sftp_url">Copy</button></div><div id="sftp-netsuite-url" class="sftp-connection-value" tabindex="0" aria-labelledby="sftp-url-label">localhost</div></div>
<div class="sftp-connection-key"><div class="sftp-value-heading"><span id="sftp-key-label">Host key</span><button id="copy-sftp-key" type="button" class="secondary outline" aria-label="Copy host key" :disabled="view.copy_sftp_key.disabled" x-text="view.copy_sftp_key.text" @click="clickcopy_sftp_key">Copy</button></div><div id="sftp-host-key" class="sftp-connection-value" tabindex="0" aria-labelledby="sftp-key-label"></div></div>
<div class="sftp-connection-user"><div class="sftp-value-heading"><span id="sftp-user-label">Username</span><button id="copy-sftp-user" type="button" class="secondary outline" aria-label="Copy username" :disabled="view.copy_sftp_user.disabled" x-text="view.copy_sftp_user.text" @click="clickcopy_sftp_user">Copy</button></div><div id="sftp-netsuite-user" class="sftp-connection-value" tabindex="0" aria-labelledby="sftp-user-label"></div></div>
<div class="sftp-connection-port"><div class="sftp-value-heading"><span id="sftp-port-label">Port</span><button id="copy-sftp-port" type="button" class="secondary outline" aria-label="Copy port" :disabled="view.copy_sftp_port.disabled" x-text="view.copy_sftp_port.text" @click="clickcopy_sftp_port">Copy</button></div><div id="sftp-netsuite-port" class="sftp-connection-value" tabindex="0" aria-labelledby="sftp-port-label"></div></div>
<div class="sftp-connection-password"><div class="sftp-value-heading"><span id="sftp-password-label">Password</span></div><div id="sftp-netsuite-password" class="sftp-connection-value" tabindex="0" aria-labelledby="sftp-password-label">use the password saved above</div></div>
</div>
<p id="sftp-copy-message" role="status" x-text="view.sftp_copy_message.text"></p>
</details>
</details></article>
</div>
<article><h2>Deployment</h2><p id="validation" role="status" x-text="view.validation.text"></p><fieldset class="grid" aria-label="Deployment actions"><button id="deploy" disabled :disabled="view.deploy.disabled" @click="clickdeploy">Deploy</button>
<button class="contrast outline" id="stop" :disabled="view.stop.disabled" @click="clickstop">Stop app</button></fieldset><blockquote class="status-message" id="run-state" role="status" x-text="view.run_state.text">Loading…</blockquote><pre id="log" tabindex="0" aria-label="Deployment progress"></pre></article>
</main></body></html>`,
    style: `${ansiStyles}
@font-face{font-family:Ubuntu;src:url('/fonts/Ubuntu-Light.ttf') format('truetype');font-style:normal;font-weight:300;font-display:swap}
@font-face{font-family:Ubuntu;src:url('/fonts/Ubuntu-Regular.ttf') format('truetype');font-style:normal;font-weight:400;font-display:swap}
@font-face{font-family:Ubuntu;src:url('/fonts/Ubuntu-Medium.ttf') format('truetype');font-style:normal;font-weight:500;font-display:swap}
@font-face{font-family:Ubuntu;src:url('/fonts/Ubuntu-Bold.ttf') format('truetype');font-style:normal;font-weight:700;font-display:swap}
:root{--pico-font-family-sans-serif:Ubuntu,system-ui,Helvetica,sans-serif,var(--pico-font-family-emoji);--pico-font-weight:300}
:root[data-theme="light"]{${lightTheme}}
@media(prefers-color-scheme:light){:root:not([data-theme]){${lightTheme}}}
body{background:var(--pico-background-color)}
h1,h2,h3,h4,h5,h6{--pico-font-weight:400}
header>hgroup>h1::before{display:block;content:"";height:100px;width:100px;float:left;background-image:url(/favicon.png)}
mark{--pico-mark-gradient:var(--suite-mark-gradient,linear-gradient(to right,rgb(215.4,140.8,210.2),rgb(184.5,153,237.75),rgb(156.6,165.3,232.6),rgb(142.75,168.95,240.05)));background:var(--pico-mark-gradient);-webkit-background-clip:text;background-clip:text;color:transparent;font-weight:700;font-size:2.5rem;}
button{--pico-border-radius:2rem}
.theme-toggle{display:flex;align-items:center;gap:0.5rem;width:fit-content;margin-inline-start:auto;font-family:system-ui,"Segoe UI",sans-serif,var(--pico-font-family-emoji)}
.theme-toggle input{margin:0}
article{margin:2rem auto;padding:1.5rem}
.credential-steps{list-style:none;padding:0;counter-reset:credential-step}
.credential-steps>li{position:relative;counter-increment:credential-step;padding-inline-start:3rem;padding-block-end:1.5rem}
.credential-steps>li::before{content:counter(credential-step);position:absolute;inset-inline-start:0;inset-block-start:0;display:grid;place-items:center;width:2rem;height:2rem;border-radius:50%;background:var(--pico-secondary-background);color:var(--pico-secondary-inverse);font-weight:500}
.credential-steps>li:not(:last-child)::after{content:"";position:absolute;inset-inline-start:1rem;inset-block:2.25rem 0.25rem;width:0;border-inline-start:1px solid var(--pico-secondary-border)}
details>summary{--pico-primary:light-dark(#876400,#c79400);--pico-accordion-close-summary-color:var(--pico-primary);--pico-accordion-open-summary-color:var(--pico-primary);--pico-accordion-active-summary-color:var(--pico-primary);display:flex;align-items:center;gap:0.75rem;font-weight:500}
details>summary::after{display:none}
details>summary::before{content:"";flex:0 0 0.9rem;height:0.9rem;background:currentColor;clip-path:polygon(0 0,100% 50%,0 100%)}
details[open]>summary::before{transform:rotate(90deg)}
@media(min-width:768px){
.setup-sections:not(:has(>article>.setup-section[open])){display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1rem;margin-block:2rem}
.setup-sections:not(:has(>article>.setup-section[open]))>article{margin:0;padding:1.5rem;min-width:0}
}
.setup-section{margin-bottom:0}
.setup-section>summary h2{margin:0}
.setup-section[open]>summary{margin-bottom:1.5rem}
:is(input:not([type="checkbox"]),textarea):enabled{background-color:light-dark(#fff,#111)}
@media(max-width:575px){article{padding:1rem}.credential-steps>li{padding-inline-start:2.5rem}}
[x-cloak],[hidden]{display:none!important}
main :is(p,blockquote):empty{display:none}
.status-message{--pico-primary:light-dark(#9236a4,#cd68e0);color:var(--pico-primary)}
blockquote.status-message{--pico-primary:light-dark(#9236a4,#cd68e0);--pico-blockquote-border-color:var(--pico-primary);margin:0 0 var(--pico-typography-spacing-vertical);padding:0.25rem 1.5rem;color:var(--pico-primary);border-radius:0.25rem;background-color:color-mix(in srgb,var(--pico-primary) 8%,transparent)}
textarea{font-family:var(--pico-font-family-monospace)}
.sftp-connection-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.sftp-connection-grid>div{min-width:0}
.sftp-connection-key{grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column}
.sftp-value-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--pico-spacing);min-height:calc(var(--pico-spacing)*2);margin-bottom:calc(var(--pico-spacing)*0.375)}
.sftp-value-heading button{--pico-form-element-spacing-vertical:calc(var(--pico-spacing)*0.125);--pico-form-element-spacing-horizontal:calc(var(--pico-spacing)*0.75);margin:0;font-size:0.8em}
.sftp-connection-value{padding:var(--pico-form-element-spacing-vertical) var(--pico-form-element-spacing-horizontal);border:var(--pico-border-width) solid var(--pico-form-element-border-color);border-radius:var(--pico-border-radius);background:var(--pico-form-element-background-color);color:var(--pico-form-element-color);opacity:var(--pico-form-element-disabled-opacity);cursor:text;overflow-wrap:anywhere}
.sftp-connection-key .sftp-connection-value{flex:1;min-height:0;max-height:calc(var(--pico-spacing)*12);overflow:auto;font-family:var(--pico-font-family-monospace)}
.sftp-connection-user{grid-column:1;grid-row:2}
.sftp-connection-port{grid-column:2;grid-row:3}
.sftp-connection-password{grid-column:1;grid-row:3}
pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:1rem;max-height:32rem;overflow:auto;line-height:1.55;background-color:light-dark(#f0eee8,#000);color:light-dark(#343d48,#c8cdd6);color-scheme:inherit;border:1px solid light-dark(#d7d5cf,transparent)}
pre#log{min-height:24rem;}
pre :is(.ansi-fg-2,.ansi-fg-10){color:light-dark(#008447,#38d98a)}
pre :is(.ansi-fg-3,.ansi-fg-11){color:light-dark(#946200,#f1ca53)}
pre :is(.ansi-fg-4,.ansi-fg-12){color:light-dark(#1b65c9,#69a9ff)}
pre :is(.ansi-fg-5,.ansi-fg-13){color:light-dark(#8545b7,#ca91ff)}
pre :is(.ansi-fg-6,.ansi-fg-14){color:light-dark(#007f9b,#40d2ef)}
pre :is(.ansi-fg-7,.ansi-fg-15){color:light-dark(#343d48,#c8cdd6)}
`,
    script: `const ansiToHtml = ${ansiToHtml.toString()};
const applyAnsiColors = ${applyAnsiColors.toString()};
document.addEventListener('alpine:init', () => {
  Alpine.data('deployment', () => {
    const handlers = {};
    const listen = (id, event, handler) => { handlers[event + id.replaceAll('-', '_')] = handler; };
    return {
      // Pico styles semantic elements. Alpine owns control availability and status.
      view: Object.fromEntries([...document.querySelectorAll('main [id]')].map(element => [
        element.id.replaceAll('-', '_'),
        { hidden: element.hidden, disabled: !!element.disabled, text: ['P', 'BLOCKQUOTE'].includes(element.tagName) ? element.textContent : '' },
      ])),
      ...Object.fromEntries([
        ['change', 'theme-toggle'],
        ...['config','vm','public','private','id','token','sql-account','sql-database','sql-password','sql-unlock','sql-statement','sftp-user','sftp-port','sftp-password','sftp-path'].map(id => ['input', id]),
        ...['sql-run','change-token','save','credentials','generate','deploy','download','stop','sftp-start','sftp-stop','sftp-save','sftp-recreate','copy-sftp-url','copy-sftp-key','copy-sftp-user','copy-sftp-port'].map(id => ['click', id]),
      ].map(([event, id]) => {
        const name = event + id.replaceAll('-', '_');
        return [name, () => handlers[name]()];
      })),
      init() {
        const view = this.view;
        const $ = id => document.getElementById(id);
        const fragment = new URLSearchParams(location.hash.slice(1));
        const session = fragment.get('session') || sessionStorage.getItem('suitecloud-session') || '';
        sessionStorage.setItem('suitecloud-session', session);
        history.replaceState(null, '', location.pathname);
        let sectionsInitialized = false, lastDeploymentStarted;
        const collapseSetupSections = () => {
          for (const id of ['credentials-section','settings-section','sql-section','sftp-section']) $(id).open = false;
        };
        let state, editing = false, stopped = false, checking, credentialEditing = false, changingToken = false, sqlSubmitting = false, sqlDefaultsApplied = false, sqlDefaultsHost, sqlAccountEdited = false, sqlDatabaseEdited = false, sqlRequestError = '';
        let lastActivity = Date.now(), heartbeatPending = false, connectionFailed = false, idleCloseScheduled = false, actionError = '';
        let themeSaving = false;
        let sftpEditing = false, sftpSubmitting = false, sftpRequestError = '', sftpNotice = '', actionBusy = false;
        let sftpProbeTarget = '', sftpProbePending = false;
        const systemTheme = matchMedia('(prefers-color-scheme: dark)');
        function applyTheme(theme) {
          if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
          else delete document.documentElement.dataset.theme;
          $('theme-toggle').checked = theme === 'dark' || (theme !== 'light' && systemTheme.matches);
        }
        applyTheme();
        systemTheme.addEventListener('change', () => { if (!themeSaving && !state?.theme) applyTheme(); });
        const connectionMessage = 'Connection to the app was lost. It may have stopped automatically after inactivity. Start the launcher again to reconnect.';
        function connectionLost() {
          if (stopped) return;
          connectionFailed = true;
          view.connection_error.text = connectionMessage;
          view.connection_error.hidden = false;
          for (const control of document.querySelectorAll('button,input,textarea')) if (control.id) view[control.id.replaceAll('-', '_')].disabled = true;
          if (!idleCloseScheduled && Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS} && state?.run.state !== 'running' && state?.sql?.state !== 'running' && !state?.sql?.preparing && !sqlSubmitting && !['starting','running'].includes(state?.sftp?.state) && !sftpSubmitting) {
            idleCloseScheduled = true;
            setTimeout(() => {
              if (!connectionFailed || Date.now() - lastActivity < ${ACTIVITY_GRACE_MS}) { idleCloseScheduled = false; return; }
              try { window.close(); } catch { /* Browsers may refuse tab closure. */ }
            }, 5000);
          }
        }
        async function api(path, data) {
          let response, result;
          try {
            response = await fetch('/api/' + path, { signal:AbortSignal.timeout(path === 'sftp' ? 30000 : 10000), method: data === undefined ? 'GET' : 'POST', headers: {'X-Session-Token': session, ...(data === undefined ? {} : {'Content-Type':'application/json'})}, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
            result = await response.json();
          } catch { connectionLost(); throw new Error(connectionMessage); }
          if (response.status >= 500 || (!response.ok && result.error?.startsWith('The app is stopping'))) { connectionLost(); throw new Error(connectionMessage); }
          if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
          if (path !== 'heartbeat') { connectionFailed = false; view.connection_error.hidden = true; }
          return result;
        }
        function render(next) {
          if (stopped || connectionFailed) return;
          state = next;
          if (!themeSaving) applyTheme(next.theme);
          if (!sectionsInitialized) {
            sectionsInitialized = true;
            if (next.deploymentStarted) collapseSetupSections();
          }
          if (next.run.started && next.run.started !== lastDeploymentStarted) {
            lastDeploymentStarted = next.run.started;
            collapseSetupSections();
          }
          if (!editing) $('config').value = next.config;
          const busy = next.run.state === 'running' || next.sql?.state === 'running' || next.sql?.preparing || sqlSubmitting || sftpSubmitting;
          if (!credentialEditing) for (const key of ['public','private','id']) $(key).value = next.certificates[key] || '';
          view.token_state.text = next.tokenPresent ? 'GitLab token saved.' : 'No GitLab token is saved. Paste it below and click Save credentials. A token is needed for SuiteApps copied from GitLab.';
          view.token_entry.hidden = next.tokenPresent && !changingToken;
          view.change_token.hidden = !next.tokenPresent || changingToken;
          view.generate.disabled = busy;
          view.download.hidden = !next.certificates.canDownload;
          view.download.disabled = false;
          view.cert_message.text = next.certificates.error;
          view.validation.text = actionError || (busy
            ? next.sql?.preparing ? 'Unlocking the saved SQL password. Please wait.' : next.sql?.state === 'running' || sqlSubmitting ? 'SQL is running. Wait for it to finish before deploying or changing settings.' : 'Deployment is running. Wait for it to finish before changing settings or credentials.'
            : next.relaunch ? 'Relaunch required. Save your changes, stop this app, and start the launcher again.' : next.error || (credentialEditing ? 'Save your credential changes before deploying.' : editing ? 'Settings are ready.' : 'Ready to deploy.'));
          view.deploy.disabled = !next.ready || credentialEditing || busy;
          for (const key of ['save','credentials','stop','public','private','id','token','config','vm','change-token']) view[key.replaceAll('-', '_')].disabled = busy;
          view.run_state.text = ({idle:'No deployment started.',running:'Deployment in progress…',succeeded:'Deployment completed.',failed:'Deployment failed. Review the message below, correct settings or credentials, and retry.'})[next.run.state];
          const log = $('log'); const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
          log.innerHTML = ansiToHtml(next.run.log);
          applyAnsiColors(log);
          if (bottom) log.scrollTop = log.scrollHeight;
          try { $('vm').value = JSON.parse($('config').value).vms?.[0]?.url || ''; } catch { /* Keep the Current VM value until the JSON is valid. */ }
          const host = currentVmHost();
          view.scrumbox_link.hidden = !host;
          if (host) $('scrumbox-link').href = 'https://' + host + '/devhome';
          renderSql(next, busy);
          renderSftp(next, busy);
        }
        function renderSftp(next, busy) {
          if (connectionFailed) return;
          const sftp = next.sftp;
          const remote = sftp?.mode === 'remote';
          if (remote && sftp.target !== sftpProbeTarget && sftp.probe !== 'idle') sftpProbeTarget = sftp.target;
          const active = remote ? sftp.state === 'starting' || sftp.probe === 'checking' : ['starting','running'].includes(sftp?.state);
          const submitting = sftpSubmitting || actionBusy || sqlSubmitting || themeSaving;
          view.sftp_description.text = remote ? 'Run SFTP on the deployment target and upload files directly to it.' : 'Enable file sharing from your laptop.';
          view.sftp_folder.hidden = remote;
          view.sftp_recreate.hidden = !remote || !sftp.recreateAvailable;
          view.sftp_recreate.disabled = busy || active || submitting;
          view.sftp_upload.hidden = !remote || !sftp.uploadUrl;
          $('sftp-upload-url').textContent = sftp?.uploadUrl || '';
          if (remote && sftp.target && sftp.probe === 'idle' && !sftpProbePending && sftpProbeTarget !== sftp.target) {
            sftpProbeTarget = sftp.target; sftpProbePending = true;
            // Let the page render before starting any target network operation.
            setTimeout(async () => {
              try { render(await api('sftp', {action:'probe'})); }
              catch (error) { sftpRequestError = error.message; }
              finally { sftpProbePending = false; }
            }, 0);
          }
          if (!sftpEditing && sftp) {
            $('sftp-user').value = sftp.username;
            $('sftp-port').value = sftp.port;
            $('sftp-path').value = sftp.path || '';
          }
          for (const id of ['sftp-user','sftp-port','sftp-password','sftp-path']) view[id.replaceAll('-', '_')].disabled = !sftp || busy || active || submitting;
          view.sftp_start.disabled = !sftp || busy || active || submitting || sftp.relaunch || remote && !sftp.canStart;
          view.sftp_save.disabled = !sftp || busy || active || submitting;
          view.sftp_stop.disabled = !sftp || submitting || (remote ? !sftp.canStop : !active && !['starting','running'].includes(sftp.tunnel?.state));
          view.sftp_password_help.text = sftp?.passwordPresent ? 'A password is saved. Leave blank to use existing password.' : 'Enter a password before starting SFTP.';
          $('sftp-password-help').classList.toggle('status-message', !!sftp?.passwordPresent);
          const connection = remote ? sftp.connection : sftp;
          for (const [id, value] of [['sftp-netsuite-url',remote && !connection ? '' : 'localhost'],['sftp-netsuite-user',connection?.username || ''],['sftp-netsuite-port',connection ? String(connection.port) : ''],['sftp-host-key',connection?.hostKey || '']]) {
            if ($(id).textContent !== value) $(id).textContent = value;
          }
          for (const [key, target] of [['url','sftp-netsuite-url'],['key','sftp-host-key'],['user','sftp-netsuite-user'],['port','sftp-netsuite-port']]) {
            const button = view['copy_sftp_' + key];
            button.text ||= 'Copy'; button.disabled = !$(target).textContent;
          }
          const status = remote ? sftp.probe === 'checking' ? 'Checking target SSH access…' : sftp.state === 'starting' ? 'SFTP operation is in progress…' : sftp.connection ? 'SFTP access verified.' : sftp.probe === 'ready' && sftp.state !== 'failed' ? 'Target SSH access verified. Click Start SFTP to check SFTP access.' : sftp.probe === 'idle' ? 'Waiting to check target SSH access…' : 'SFTP access could not be verified.' : sftp ? ({stopped:'SFTP is stopped.',starting:'SFTP is starting…',running:'SFTP is running.',failed:'SFTP failed.'})[sftp.state] : 'Loading SFTP settings…';
          const tunnel = remote ? undefined : sftp?.tunnel;
          const tunnelMessage = remote ? '' : tunnel?.error || (tunnel?.state === 'starting' ? 'Connecting the scrumbox tunnel…' : sftp?.state === 'running' && tunnel?.state !== 'running' ? 'The scrumbox tunnel is not connected.' : '');
          view.sftp_message.text = [status, sftpRequestError || sftp?.error || sftpNotice || (sftpEditing ? 'SFTP settings changed. Save settings or click Start SFTP.' : ''), tunnelMessage, sftp?.relaunch ? 'Relaunch required. Stop the app and start the launcher again to mount the selected folder.' : ''].filter(Boolean).join(' ');
        }
        function currentVmHost() {
          try {
            const host = JSON.parse($('config').value).vms?.[0]?.url;
            return typeof host === 'string' && /^(?:[A-Za-z0-9-]+\\.)+[A-Za-z0-9-]+$/.test(host) && host.endsWith('.netsuite.com') ? host : '';
          } catch { return ''; }
        }
        function renderSql(next, busy) {
          if (connectionFailed) return;
          if (next.sql) {
            const host = currentVmHost();
            if (!sqlDefaultsApplied || sqlDefaultsHost !== host) { sqlAccountEdited = false; sqlDatabaseEdited = false; }
            if (!sqlAccountEdited) $('sql-account').value = next.sql.defaults.user;
            if (!sqlDatabaseEdited) $('sql-database').value = next.sql.defaults.service;
            view.sql_password_hint.text = next.sql.passwordHint;
            view.sql_password_hint.hidden = !next.sql.passwordHint;
            sqlDefaultsApplied = true;
            sqlDefaultsHost = host;
          }
          for (const id of ['sql-account','sql-database','sql-password','sql-statement']) view[id.replaceAll('-', '_')].disabled = busy;
          view.sql_unlock.disabled = busy || !next.sql?.hasDefaultPassword;
          view.sql_unlock_availability.hidden = !!next.sql?.hasDefaultPassword;
          view.sql_unlock_availability.text = 'No saved SQL password is available to unlock. Enter your SQL password above.';
          const passwordEntered = !!$('sql-password').value;
          const unlockEntered = !!$('sql-unlock').value && !!next.sql?.hasDefaultPassword;
          view.sql_run.disabled = busy || !currentVmHost() || !$('sql-account').value.trim() || !$('sql-database').value.trim() || passwordEntered === unlockEntered || !$('sql-statement').value.trim();
          if (next.sql) {
            const detail = next.sql.host ? ' (' + next.sql.host + '/' + next.sql.database + ')' : '';
            if (sqlRequestError) view.sql_message.text = sqlRequestError;
            else if (next.sql.preparing) view.sql_message.text = 'Unlocking SQL credentials…';
            else if (next.sql.state !== 'idle') view.sql_message.text = ({running:'SQL is running…',succeeded:'SQL completed.',failed:'SQL failed. Review the output and retry.'})[next.sql.state] + detail;
            $('sql-output').textContent = next.sql.output;
          }
        }
        async function refresh() { if (stopped) return; try { const next = editing ? await api('check', {config:$('config').value}) : await api('state'); render(next); } catch (error) { if (stopped) return; if (!connectionFailed) connectionLost(); view.validation.text = error.message; } }
        async function heartbeat() {
          if (stopped || heartbeatPending || Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS}) return;
          heartbeatPending = true;
          try { await api('heartbeat',{}); } catch { /* Connection errors are displayed by api(). */ }
          finally { heartbeatPending = false; }
        }
        for (const event of ['click','input','keydown','scroll']) document.addEventListener(event, event => {
          if (!event.isTrusted || stopped) return;
          const expired = Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS};
          lastActivity = Date.now();
          if (expired) void heartbeat();
        }, {capture:true,passive:true});
        function action(id, fn, messageId = 'validation') { listen(id, 'click', async () => { actionError = ''; actionBusy = true; if (state) renderSftp(state, state.run.state === 'running' || state.sql?.state === 'running' || state.sql?.preparing || sqlSubmitting); view[id.replaceAll('-', '_')].disabled = true; try { await fn(); } catch(error) { if (messageId === 'validation') actionError = error.message; view[messageId.replaceAll('-', '_')].text = error.message; } finally { actionBusy = false; if (!stopped) await refresh(); } }); }
        listen('theme-toggle', 'change', async () => {
          if (themeSaving || stopped || connectionFailed) return;
          const theme = $('theme-toggle').checked ? 'dark' : 'light';
          themeSaving = true;
          view.theme_toggle.disabled = true;
          view.theme_message.text = '';
          applyTheme(theme);
          try {
            const next = await api('theme', {theme});
            if (editing) {
              try {
                const config = JSON.parse($('config').value);
                if (config && typeof config === 'object' && !Array.isArray(config) &&
                    (config.status === undefined || (config.status && typeof config.status === 'object' && !Array.isArray(config.status)))) {
                  config.status = {...config.status, theme};
                  $('config').value = JSON.stringify(config, null, 4);
                }
              } catch { /* Keep unfinished JSON edits intact. */ }
            }
            themeSaving = false;
            render(next);
          } catch (error) {
            view.theme_message.text = error.message;
            applyTheme(state?.theme);
          } finally {
            themeSaving = false;
            view.theme_toggle.disabled = connectionFailed || stopped;
          }
        });
        listen('config', 'input', () => { actionError = ''; editing = true; view.settings_message.text = 'Settings changed. Save settings, or click Deploy to save and deploy.'; view.deploy.disabled = true; clearTimeout(checking); checking = setTimeout(refresh, 350); });
        listen('vm', 'input', () => {
          actionError = '';
          try {
            const config = JSON.parse($('config').value);
            if (!config || typeof config !== 'object' || Array.isArray(config) || (config.vms !== undefined && !Array.isArray(config.vms))) throw new Error('Fix the configuration JSON in Settings before changing Current VM.');
            config.vms ??= [];
            config.vms[0] ??= {account:'000071',url:''};
            if (typeof config.vms[0] !== 'object' || Array.isArray(config.vms[0])) throw new Error('Fix the first VM in Settings before changing Current VM.');
            config.vms[0].url = $('vm').value.trim();
            $('config').value = JSON.stringify(config, null, 4);
            editing = true; view.deploy.disabled = true; clearTimeout(checking); checking = setTimeout(refresh, 350);
            view.settings_message.text = 'Settings changed. Save settings, or click Deploy to save and deploy.';
            view.credential_message.text = 'VM address changed. Save credentials or settings to keep it.';
          } catch { view.credential_message.text = 'Fix the configuration JSON in Settings before changing Current VM.'; view.deploy.disabled = true; }
        });
        for (const key of ['public','private','id','token']) listen(key, 'input', () => { actionError = ''; credentialEditing = true; view.credential_message.text = 'Credentials changed. Click Save credentials before deploying.'; view.deploy.disabled = true; });
        for (const [key, target] of [['url','sftp-netsuite-url'],['key','sftp-host-key'],['user','sftp-netsuite-user'],['port','sftp-netsuite-port']]) {
          let reset;
          listen('copy-sftp-' + key, 'click', async () => {
            view.sftp_copy_message.text = '';
            try {
              await navigator.clipboard.writeText($(target).textContent);
              const button = view['copy_sftp_' + key];
              button.text = 'Copied'; clearTimeout(reset);
              reset = setTimeout(() => { button.text = 'Copy'; }, 1500);
            } catch { view.sftp_copy_message.text = 'Could not copy. Select the value and copy it manually.'; }
          });
        }
        for (const key of ['sftp-user','sftp-port','sftp-password','sftp-path']) listen(key, 'input', () => {
          sftpEditing = true; sftpRequestError = ''; sftpNotice = '';
          if (state) renderSftp(state, state.run.state === 'running' || state.sql?.state === 'running' || state.sql?.preparing || sqlSubmitting);
        });
        for (const operation of ['start','stop','save','recreate']) listen('sftp-' + operation, 'click', async () => {
          if (sftpSubmitting || actionBusy || sqlSubmitting || themeSaving || !state?.sftp) return;
          if (operation === 'recreate' && !confirm('Recreate the target SFTP container with these credentials? This replaces the existing container named sftp and discards files inside it.')) return;
          sftpSubmitting = true; sftpRequestError = ''; sftpNotice = '';
          render(state);
          try {
            const data = operation === 'stop' ? {action:operation} : {action:operation,confirmReplace:operation === 'recreate',username:$('sftp-user').value.trim(),port:Number($('sftp-port').value),path:$('sftp-path').value.trim(),...($('sftp-password').value ? {password:$('sftp-password').value} : {})};
            const next = await api('sftp', data);
            if (operation !== 'stop') { sftpEditing = false; $('sftp-password').value = ''; }
            sftpNotice = operation === 'save' ? 'SFTP settings saved.' : '';
            render(next);
          } catch (error) { sftpRequestError = error.message; }
          finally { sftpSubmitting = false; if (!stopped) render(state); }
        });
        for (const key of ['sql-account','sql-database','sql-password','sql-unlock','sql-statement']) listen(key, 'input', () => {
          if (key === 'sql-account') sqlAccountEdited = true;
          if (key === 'sql-database') sqlDatabaseEdited = true;
          if (key === 'sql-password' && $('sql-password').value) $('sql-unlock').value = '';
          if (key === 'sql-unlock' && $('sql-unlock').value) $('sql-password').value = '';
          if (state) renderSql(state, state.run.state === 'running' || state.sql?.state === 'running' || state.sql?.preparing || sqlSubmitting);
        });
        listen('sql-run', 'click', async () => {
          if (sqlSubmitting || state?.run.state === 'running' || state?.sql?.state === 'running' || state?.sql?.preparing) return;
          actionError = '';
          sqlRequestError = '';
          sqlSubmitting = true;
          render(state);
          view.sql_message.text = 'Starting SQL…';
          try {
            const credentials = $('sql-password').value ? {password:$('sql-password').value} : {unlock:$('sql-unlock').value};
            const next = await api('sql', { config:$('config').value, account:$('sql-account').value, database:$('sql-database').value, ...credentials, sql:$('sql-statement').value });
            render(next);
          } catch (error) { sqlRequestError = error.message; view.sql_message.text = error.message; }
          finally { sqlSubmitting = false; if (!stopped) render(state); }
        });
        listen('change-token', 'click', () => { changingToken = true; view.token_entry.hidden = false; view.change_token.hidden = true; $('token').focus(); });
        action('save', async () => { render(await api('settings', {config:$('config').value})); editing = false; view.settings_message.text = 'Settings saved.'; }, 'settings-message');
        action('credentials', async () => { const data = Object.fromEntries(['public','private','id','token'].map(key => [key,$(key).value])); data.config = $('config').value; const next = await api('credentials',data); credentialEditing = false; editing = false; changingToken = false; $('token').value = ''; render(next); view.credential_message.text = 'Credentials and settings saved.'; view.settings_message.text = 'Settings saved.'; }, 'credential-message');
        action('generate', async () => { if ((state.certificates.hasExisting || credentialEditing) && !confirm('Generate new certificates? Old certificates saved by this app will not be preserved, and the saved certificate ID will be cleared. Files stored elsewhere are not changed. Register the new public certificate on your scrumbox before deploying.')) return; const next = await api('generate',{replace:true}); for (const key of ['public','private','id']) $(key).value = next.certificates[key] || ''; credentialEditing = !!$('token').value.trim(); render(next); $('cert-details').open = true; view.credential_message.text = 'New certificates saved. Download the public certificate, register it on your scrumbox, then enter the assigned certificate ID and click Save credentials.'; }, 'credential-message');
        action('deploy', async () => { render(await api('deploy',{config:$('config').value})); editing = false; });
        action('download', async () => { const response = await fetch('/api/certificate',{headers:{'X-Session-Token':session}}); if (!response.ok) throw new Error((await response.json()).error); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'public.pem'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }, 'credential-message');
        action('stop', async () => {
          await api('stop',{});
          stopped = true;
          view.theme_toggle.disabled = true;
          view.run_state.text = 'App stopped. Attempting to close this page…';
          for (const button of document.querySelectorAll('button')) if (button.id) view[button.id.replaceAll('-', '_')].disabled = true;
          setTimeout(() => {
            try { window.close(); } catch { /* The browser may refuse script-driven closure. */ }
            if (!window.closed) view.run_state.text = 'App stopped. Your browser kept this page open. You can close this tab.';
          }, 5000);
        });
        refresh(); setInterval(refresh, 2000);
        heartbeat(); setInterval(heartbeat, ${HEARTBEAT_INTERVAL_MS});
      },
    };
  });
});`,
};
