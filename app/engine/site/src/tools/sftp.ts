import type { SiteModule } from "../common/module.ts";

export const sftp: SiteModule = {
    id: "sftp", placement: "tool",
    navigation: {"target":"sftp-section","label":"SFTP"},
    html: `<article><details class="setup-section" id="sftp-section"><summary><h2>SFTP file sharing</h2></summary>
<p id="sftp-description" x-text="view.sftp_description.text"></p>
<fieldset class="grid" aria-label="SFTP actions"><button id="sftp-start" disabled :disabled="view.sftp_start.disabled" @click="clicksftp_start">Start SFTP</button><button id="sftp-stop" class="secondary outline" disabled :disabled="view.sftp_stop.disabled" @click="clicksftp_stop">Stop SFTP</button><button id="sftp-save" class="secondary" disabled :disabled="view.sftp_save.disabled" @click="clicksftp_save">Save settings</button></fieldset>
<button id="sftp-recreate" hidden :hidden="view.sftp_recreate.hidden" :disabled="view.sftp_recreate.disabled" @click="clicksftp_recreate">Recreate SFTP</button>
<blockquote class="status-message" id="sftp-message" role="status" x-text="view.sftp_message.text"></blockquote>
<p id="sftp-upload" hidden :hidden="view.sftp_upload.hidden">Upload files directly to <strong id="sftp-upload-url"></strong>.</p>
<details><summary>SFTP settings</summary>
<p>These are your own machine settings.</p>
<div class="grid"><div><label for="sftp-user">User</label><input id="sftp-user" autocomplete="off" spellcheck="false" :disabled="view.sftp_user.disabled" @input="inputsftp_user"></div>
<div><label for="sftp-port">Port</label><input id="sftp-port" type="number" min="1024" max="65535" step="1" :disabled="view.sftp_port.disabled" @input="inputsftp_port"></div></div>
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
`,
    style: `.sftp-connection-grid{grid-template-columns:repeat(2,minmax(0,1fr))}
.sftp-connection-grid>div{min-width:0}
.sftp-connection-key{grid-column:2;grid-row:1/span 2;display:flex;flex-direction:column}
.sftp-value-heading{display:flex;align-items:center;justify-content:space-between;gap:var(--pico-spacing);min-height:calc(var(--pico-spacing)*2);margin-bottom:calc(var(--pico-spacing)*0.375)}
.sftp-value-heading button{--pico-form-element-spacing-vertical:calc(var(--pico-spacing)*0.125);--pico-form-element-spacing-horizontal:calc(var(--pico-spacing)*0.75);margin:0;font-size:0.8em}
.sftp-connection-value{padding:var(--pico-form-element-spacing-vertical) var(--pico-form-element-spacing-horizontal);border:var(--pico-border-width) solid var(--pico-form-element-border-color);border-radius:var(--pico-border-radius);background:var(--pico-form-element-background-color);color:var(--pico-form-element-color);opacity:var(--pico-form-element-disabled-opacity);cursor:text;overflow-wrap:anywhere}
.sftp-connection-key .sftp-connection-value{flex:1;min-height:0;max-height:calc(var(--pico-spacing)*12);overflow:auto;font-family:var(--pico-font-family-monospace)}
.sftp-connection-user{grid-column:1;grid-row:2}
.sftp-connection-port{grid-column:2;grid-row:3}
.sftp-connection-password{grid-column:1;grid-row:3}
`,
    styleOrder: 7,
    script: `(context) => {
  const { $, api, render, listen } = context;
  let view;
  let sftpEditing = false, sftpSubmitting = false, sftpRequestError = '', sftpNotice = '';
  let sftpProbeTarget = '', sftpProbePending = false;
        function renderSftp(next) {
          if (context.connectionFailed) return;
          const sftp = next.sftp;
          const remote = sftp?.mode === 'remote';
          if (remote && sftp.target !== sftpProbeTarget && sftp.probe !== 'idle') sftpProbeTarget = sftp.target;
          const active = remote ? sftp.state === 'starting' || sftp.probe === 'checking' : ['starting','running'].includes(sftp?.state);
          const submitting = sftpSubmitting;
          view.sftp_description.text = remote ? 'Run SFTP on the deployment target and upload files directly to it.' : 'Enable file sharing from your laptop. 🌐 Requires SSH connectivity to scrumbox';
          view.sftp_folder.hidden = remote;
          view.sftp_recreate.hidden = !remote || !sftp.recreateAvailable;
          view.sftp_recreate.disabled = active || submitting;
          view.sftp_upload.hidden = !remote || !sftp.uploadUrl;
          $('sftp-upload-url').textContent = sftp?.uploadUrl || '';
          if (remote && sftp.target && sftp.probe === 'idle' && !sftpProbePending && sftpProbeTarget !== sftp.target) {
            sftpProbeTarget = sftp.target; sftpProbePending = true;
            // Let the page render before starting any target network operation.
            context.timeout(async () => {
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
          for (const id of ['sftp-user','sftp-port','sftp-password','sftp-path']) view[id.replaceAll('-', '_')].disabled = !sftp || active || submitting;
          view.sftp_start.disabled = !sftp || active || submitting || sftp.relaunch || remote && !sftp.canStart;
          view.sftp_save.disabled = !sftp || active || submitting;
          view.sftp_stop.disabled = !sftp || submitting || (remote ? !sftp.canStop : !active && !['starting','running'].includes(sftp.tunnel?.state));
          view.sftp_password_help.text = sftp?.passwordPresent ? 'A password is saved. Leave blank to use saved password.' : 'Enter a password before starting SFTP.';
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
        for (const [key, target] of [['url','sftp-netsuite-url'],['key','sftp-host-key'],['user','sftp-netsuite-user'],['port','sftp-netsuite-port']]) {
          let reset;
          listen('copy-sftp-' + key, 'click', async () => {
            view.sftp_copy_message.text = '';
            try {
              await navigator.clipboard.writeText($(target).textContent);
              const button = view['copy_sftp_' + key];
              button.text = 'Copied'; context.clearTimeout(reset);
              reset = context.timeout(() => { button.text = 'Copy'; }, 1500);
            } catch { view.sftp_copy_message.text = 'Could not copy. Select the value and copy it manually.'; }
          });
        }
        for (const key of ['sftp-user','sftp-port','sftp-password','sftp-path']) listen(key, 'input', () => {
          sftpEditing = true; sftpRequestError = ''; sftpNotice = '';
          if (context.state) renderSftp(context.state);
        });
        for (const operation of ['start','stop','save','recreate']) listen('sftp-' + operation, 'click', async () => {
          if (sftpSubmitting || !context.state?.sftp) return;
          if (operation === 'recreate' && !confirm('Recreate the target SFTP container with these credentials? This replaces the existing container named sftp and discards files inside it.')) return;
          sftpSubmitting = true; sftpRequestError = ''; sftpNotice = '';
          render(context.state);
          try {
            const data = operation === 'stop' ? {action:operation} : {action:operation,confirmReplace:operation === 'recreate',username:$('sftp-user').value.trim(),port:Number($('sftp-port').value),path:$('sftp-path').value.trim(),...($('sftp-password').value ? {password:$('sftp-password').value} : {})};
            const next = await api('sftp', data);
            if (operation !== 'stop') { sftpEditing = false; $('sftp-password').value = ''; }
            sftpNotice = operation === 'save' ? 'SFTP settings saved.' : '';
            render(next);
          } catch (error) { sftpRequestError = error.message; }
          finally { sftpSubmitting = false; if (!context.stopped) render(context.state); }
        });

  return {
    init(root) { view = root.view; },
    render: renderSftp,
    pending: () => sftpSubmitting,
    collapse() { $('sftp-section').open = false; },
  };
}`,
};
