import { ansiToHtml, ansiStyles, applyAnsiColors } from "./ansi.ts";
import { ACTIVITY_GRACE_MS, HEARTBEAT_INTERVAL_MS } from "./web-inactivity.ts";

export const deploymentPage = {
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SuiteCloud deployment</title><link rel="stylesheet" href="/page.css"><script src="/page.js" defer></script></head>
<body><main><h1>SuiteCloud deployment</h1><p>Set your runbox address, complete credentials, then deploy your SuiteApps.</p>
<p id="connection-error" role="alert" hidden></p>
<section><h2>Credentials</h2><p id="token-state"></p><button id="change-token" hidden>Change GitLab token</button><div id="token-entry"><label for="token">GitLab token</label><input id="token" type="password" autocomplete="off" placeholder="Paste your token"></div>
<details id="cert-details"><summary>Certificate paths</summary><p>Paths refer to files on the computer running the launcher. Changing external paths may require relaunching.</p><label for="public">Public certificate path</label><input id="public"><label for="private">Private key path</label><input id="private"></details>
<p>Generating a new pair replaces the active certificates. Old certificates will not be preserved. Register the new public certificate on your runbox and enter its new certificate ID.</p>
<button id="generate">Generate certificates</button><button id="download" hidden>Download public certificate</button>
<p id="cert-message"></p><div id="registration"><p>Register the public certificate on your runbox: open <strong>Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup</strong>, select SuiteCloud Development Integration and the appropriate entity and role, and upload <strong>public.pem</strong>. Copy the assigned certificate ID below. Keep the private key on this computer.</p><a id="runbox-link" hidden target="_blank" rel="noopener noreferrer">Open runbox</a> <a href="https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0422011927.html" target="_blank" rel="noopener noreferrer">NetSuite setup guide</a></div>
<label for="vm">Current VM (runbox domain)</label><input id="vm" placeholder="your-runbox.vm.eng.netsuite.com"><p>This updates the first VM in Settings. Save credentials to save the VM address too.</p>
<label for="id">Certificate ID assigned by NetSuite</label><input id="id"><button id="credentials">Save credentials</button><p id="credential-message" role="status"></p></section>
<section><h2>Settings</h2><p>Use Current VM above to set your first runbox address. Keep the account ID unless your runbox uses a different account. Additional runboxes can be entered in <code>vms</code> below.</p>
<label for="config">Configuration JSON</label><textarea id="config" spellcheck="false" rows="22"></textarea><button id="save">Save settings</button><p id="settings-message" role="status"></p></section>
<section><details id="sql-details"><summary><h2>SQL</h2></summary>
<div class="sql-connection-row"><div><label for="sql-account">User</label><input id="sql-account" autocomplete="off" spellcheck="false"></div>
<div><label for="sql-database">Service Name</label><input id="sql-database" autocomplete="off" spellcheck="false"></div></div>
<div class="sql-connection-row"><div><label for="sql-password">Password</label><input id="sql-password" type="password" autocomplete="off"></div>
<div><label for="sql-unlock">Password hint</label><input id="sql-unlock" type="password" autocomplete="off" aria-describedby="sql-password-hint sql-unlock-availability"><p id="sql-password-hint" hidden></p></div></div>
<p>Enter either your SQL password or the password hint. Entering one clears the other.</p><p id="sql-unlock-availability" hidden></p>
<label for="sql-statement">SQL statement</label><textarea id="sql-statement" rows="8" spellcheck="false" placeholder="SELECT * FROM your_table;"></textarea>
<button id="sql-run" disabled>Run SQL</button><p id="sql-message" role="status"></p><pre id="sql-output" tabindex="0" aria-label="SQL results"></pre></details></section>
<section><h2>Deployment</h2><p id="validation" role="status"></p><button id="deploy" disabled>Deploy</button><button id="stop">Stop app</button><p id="run-state" role="status">Loading…</p><pre id="log" tabindex="0" aria-label="Deployment progress"></pre></section>
</main></body></html>`,
style: `${ansiStyles}:root{font-family:system-ui,sans-serif;color:#203040;background:#f3f5f8}body{margin:0}main{max-width:960px;margin:32px auto;padding:0 24px 48px}h1{font-size:30px}h2{font-size:21px}section{background:white;border:1px solid #dde3eb;border-radius:12px;padding:24px;margin:20px 0}p{line-height:1.6}label{display:block;font-weight:600;margin:16px 0 6px}input,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #a8b4c2;border-radius:6px;font:inherit}textarea,pre{font-family:ui-monospace,monospace;font-size:14px}button{padding:11px 18px;margin:14px 10px 0 0;border:1px solid #496a91;border-radius:6px;background:#fff;color:#203040;font:inherit;cursor:pointer}#deploy,#sql-run{background:#235f9f;color:white}button:disabled{opacity:.45;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;background:#142333;color:#e8eef7;padding:18px;border-radius:6px;min-height:70px}[hidden]{display:none!important}#validation,#cert-message{color:#70421a}summary{cursor:pointer;padding-top:12px}a{color:#235f9f}#sql-details>summary{padding-top:0}#sql-details>summary h2{display:inline;margin:0}.sql-connection-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}@media(max-width:600px){.sql-connection-row{grid-template-columns:1fr;gap:0}}`,
    script: `const ansiToHtml = ${ansiToHtml.toString()};
const applyAnsiColors = ${applyAnsiColors.toString()};
const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const session = fragment.get('session') || sessionStorage.getItem('suitecloud-session') || '';
sessionStorage.setItem('suitecloud-session', session);
history.replaceState(null, '', location.pathname);
let state, editing = false, stopped = false, checking, credentialEditing = false, changingToken = false, sqlSubmitting = false, sqlDefaultsApplied = false, sqlDefaultsHost, sqlAccountEdited = false, sqlDatabaseEdited = false, sqlRequestError = '';
let lastActivity = Date.now(), heartbeatPending = false, connectionFailed = false, idleCloseScheduled = false;
const connectionMessage = 'The app is no longer running or cannot be reached. Start the launcher again to reconnect.';
function connectionLost() {
  if (stopped) return;
  connectionFailed = true;
  $('connection-error').textContent = connectionMessage;
  $('connection-error').hidden = false;
  for (const control of document.querySelectorAll('button,input,textarea')) control.disabled = true;
  if (!idleCloseScheduled && Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS} && state?.run.state !== 'running' && state?.sql?.state !== 'running' && !state?.sql?.preparing && !sqlSubmitting) {
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
    response = await fetch('/api/' + path, { signal:AbortSignal.timeout(10000), method: data === undefined ? 'GET' : 'POST', headers: {'X-Session-Token': session, ...(data === undefined ? {} : {'Content-Type':'application/json'})}, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
    result = await response.json();
  } catch { connectionLost(); throw new Error(connectionMessage); }
  if (response.status >= 500 || (!response.ok && result.error?.startsWith('The app is stopping'))) { connectionLost(); throw new Error(connectionMessage); }
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  if (path !== 'heartbeat') { connectionFailed = false; $('connection-error').hidden = true; }
  return result;
}
function render(next) {
  if (stopped || connectionFailed) return;
  state = next;
  if (!editing) $('config').value = next.config;
  const busy = next.run.state === 'running' || next.sql?.state === 'running' || next.sql?.preparing || sqlSubmitting;
  if (!credentialEditing) for (const key of ['public','private','id']) $(key).value = next.certificates[key] || '';
  $('token-state').textContent = next.tokenPresent ? 'GitLab token saved.' : 'No GitLab token was found. Paste it below and save credentials.';
  $('token-entry').hidden = next.tokenPresent && !changingToken;
  $('change-token').hidden = !next.tokenPresent || changingToken;
  $('generate').disabled = busy;
  $('download').hidden = !next.certificates.canDownload;
  $('download').disabled = false;
  $('cert-message').textContent = next.certificates.error;
  $('validation').textContent = next.relaunch ? 'Relaunch required. Save your changes, stop this app, and start the launcher again.' : next.error || 'Ready to deploy.';
  $('deploy').disabled = !next.ready || credentialEditing || busy;
  for (const key of ['save','credentials','stop','public','private','id','token','config','vm','change-token']) $(key).disabled = busy;
  $('run-state').textContent = ({idle:'No deployment started.',running:'Deployment in progress…',succeeded:'Deployment completed.',failed:'Deployment failed. Review the message below, correct settings or credentials, and retry.'})[next.run.state];
  const log = $('log'); const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.innerHTML = ansiToHtml(next.run.log);
  applyAnsiColors(log);
  if (bottom) log.scrollTop = log.scrollHeight;
  try { const vm = JSON.parse($('config').value).vms?.[0]?.url; $('vm').value = vm || ''; const safe = typeof vm === 'string' && /^(?:[A-Za-z0-9-]+\\.)+[A-Za-z0-9-]+$/.test(vm) && vm.endsWith('.netsuite.com'); $('runbox-link').hidden = !safe; if (safe) $('runbox-link').href = 'https://' + vm + '/devhome'; } catch { $('runbox-link').hidden = true; }
  renderSql(next, busy);
}
function sqlTargetHost() {
  try {
    const host = JSON.parse($('config').value).vms?.[0]?.url;
    return typeof host === 'string' && /^(?:[A-Za-z0-9-]+\\.)+[A-Za-z0-9-]+$/.test(host) && host.endsWith('.netsuite.com') ? host : '';
  } catch { return ''; }
}
function renderSql(next, busy) {
  if (connectionFailed) return;
  if (next.sql) {
    const host = sqlTargetHost();
    if (!sqlDefaultsApplied || sqlDefaultsHost !== host) { sqlAccountEdited = false; sqlDatabaseEdited = false; }
    if (!sqlAccountEdited) $('sql-account').value = next.sql.defaults.user;
    if (!sqlDatabaseEdited) $('sql-database').value = next.sql.defaults.service;
    $('sql-password-hint').textContent = next.sql.passwordHint;
    $('sql-password-hint').hidden = !next.sql.passwordHint;
    sqlDefaultsApplied = true;
    sqlDefaultsHost = host;
  }
  for (const id of ['sql-account','sql-database','sql-password','sql-statement']) $(id).disabled = busy;
  $('sql-unlock').disabled = busy || !next.sql?.hasDefaultPassword;
  $('sql-unlock-availability').hidden = !!next.sql?.hasDefaultPassword;
  $('sql-unlock-availability').textContent = 'The default SQL password is unavailable. Enter your SQL password above.';
  const passwordEntered = !!$('sql-password').value;
  const unlockEntered = !!$('sql-unlock').value && !!next.sql?.hasDefaultPassword;
  $('sql-run').disabled = busy || !sqlTargetHost() || !$('sql-account').value.trim() || !$('sql-database').value.trim() || passwordEntered === unlockEntered || !$('sql-statement').value.trim();
  if (next.sql) {
    const detail = next.sql.host ? ' (' + next.sql.host + '/' + next.sql.database + ')' : '';
    if (sqlRequestError) $('sql-message').textContent = sqlRequestError;
    else if (next.sql.preparing) $('sql-message').textContent = 'Unlocking SQL credentials…';
    else if (next.sql.state !== 'idle') $('sql-message').textContent = ({running:'SQL is running…',succeeded:'SQL completed.',failed:'SQL failed. Review the output and retry.'})[next.sql.state] + detail;
    $('sql-output').textContent = next.sql.output;
  }
}
async function refresh() { if (stopped) return; try { const next = editing ? await api('check', {config:$('config').value}) : await api('state'); render(next); } catch (error) { if (stopped) return; if (!connectionFailed) connectionLost(); $('validation').textContent = error.message; } }
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
function action(id, fn, messageId = 'validation') { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch(error) { $(messageId).textContent = error.message; } finally { if (!stopped) await refresh(); } }); }
$('config').addEventListener('input', () => { editing = true; $('deploy').disabled = true; clearTimeout(checking); checking = setTimeout(refresh, 350); });
$('vm').addEventListener('input', () => {
  try {
    const config = JSON.parse($('config').value);
    if (!config || typeof config !== 'object' || Array.isArray(config) || (config.vms !== undefined && !Array.isArray(config.vms))) throw new Error('Fix the configuration JSON in Settings before changing Current VM.');
    config.vms ??= [];
    config.vms[0] ??= {account:'000071',url:''};
    if (typeof config.vms[0] !== 'object' || Array.isArray(config.vms[0])) throw new Error('Fix the first VM in Settings before changing Current VM.');
    config.vms[0].url = $('vm').value.trim();
    $('config').value = JSON.stringify(config, null, 4);
    editing = true; $('deploy').disabled = true; clearTimeout(checking); checking = setTimeout(refresh, 350);
    $('credential-message').textContent = 'VM address changed. Save credentials or settings to keep it.';
  } catch { $('credential-message').textContent = 'Fix the configuration JSON in Settings before changing Current VM.'; $('deploy').disabled = true; }
});
for (const key of ['public','private','id','token']) $(key).addEventListener('input', () => { credentialEditing = true; $('deploy').disabled = true; });
for (const key of ['sql-account','sql-database','sql-password','sql-unlock','sql-statement']) $(key).addEventListener('input', () => {
  if (key === 'sql-account') sqlAccountEdited = true;
  if (key === 'sql-database') sqlDatabaseEdited = true;
  if (key === 'sql-password' && $('sql-password').value) $('sql-unlock').value = '';
  if (key === 'sql-unlock' && $('sql-unlock').value) $('sql-password').value = '';
  if (state) renderSql(state, state.run.state === 'running' || state.sql?.state === 'running' || state.sql?.preparing || sqlSubmitting);
});
$('sql-run').addEventListener('click', async () => {
  if (sqlSubmitting || state?.run.state === 'running' || state?.sql?.state === 'running' || state?.sql?.preparing) return;
  sqlRequestError = '';
  sqlSubmitting = true;
  render(state);
  $('sql-message').textContent = 'Starting SQL…';
  try {
    const credentials = $('sql-password').value ? {password:$('sql-password').value} : {unlock:$('sql-unlock').value};
    const next = await api('sql', { config:$('config').value, account:$('sql-account').value, database:$('sql-database').value, ...credentials, sql:$('sql-statement').value });
    render(next);
  } catch (error) { sqlRequestError = error.message; $('sql-message').textContent = error.message; }
  finally { sqlSubmitting = false; if (!stopped) render(state); }
});
$('change-token').addEventListener('click', () => { changingToken = true; $('token-entry').hidden = false; $('change-token').hidden = true; $('token').focus(); });
action('save', async () => { render(await api('settings', {config:$('config').value})); editing = false; $('settings-message').textContent = 'Settings saved.'; }, 'settings-message');
action('credentials', async () => { const data = Object.fromEntries(['public','private','id','token'].map(key => [key,$(key).value])); data.config = $('config').value; const next = await api('credentials',data); credentialEditing = false; editing = false; changingToken = false; $('token').value = ''; render(next); $('credential-message').textContent = 'Credentials and settings saved.'; }, 'credential-message');
action('generate', async () => { if ((state.certificates.hasExisting || credentialEditing) && !confirm('Generate new certificates? Old certificates will not be preserved. Certificate paths will be replaced and the certificate ID cleared. Register the new public certificate on your runbox and enter its new certificate ID.')) return; const next = await api('generate',{replace:true}); for (const key of ['public','private','id']) $(key).value = next.certificates[key] || ''; credentialEditing = !!$('token').value.trim(); render(next); $('cert-details').open = true; $('credential-message').textContent = 'New certificates generated. Register the public certificate on your runbox and enter its new certificate ID.'; }, 'credential-message');
action('deploy', async () => { render(await api('deploy',{config:$('config').value})); editing = false; });
action('download', async () => { const response = await fetch('/api/certificate',{headers:{'X-Session-Token':session}}); if (!response.ok) throw new Error((await response.json()).error); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'public.pem'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }, 'credential-message');
action('stop', async () => {
  await api('stop',{});
  stopped = true;
  $('run-state').textContent = 'App stopped. This page will close in 5 seconds.';
  for (const button of document.querySelectorAll('button')) button.disabled = true;
  setTimeout(() => {
    try { window.close(); } catch { /* The browser may refuse script-driven closure. */ }
    if (!window.closed) $('run-state').textContent = 'App stopped. Your browser kept this page open. You can close this tab.';
  }, 5000);
});
refresh(); setInterval(refresh, 2000);
heartbeat(); setInterval(heartbeat, ${HEARTBEAT_INTERVAL_MS});`,
};
