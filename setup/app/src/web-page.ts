export const deploymentPage = {
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SuiteCloud deployment</title><link rel="stylesheet" href="/page.css"><script src="/page.js" defer></script></head>
<body><main><h1>SuiteCloud deployment</h1><p>Set your runbox address, complete credentials, then deploy your SuiteApps.</p>
<section><h2>Settings</h2><p>On first run, replace the empty <code>vms[0].url</code> with your runbox domain, such as <code>your-runbox.vm.eng.netsuite.com</code>. Keep the account ID unless your runbox uses a different account.</p>
<label for="config">Configuration JSON</label><textarea id="config" spellcheck="false" rows="22"></textarea><button id="save">Save settings</button><p id="settings-message" role="status"></p></section>
<section><h2>Credentials</h2><p id="token-state"></p><button id="change-token" hidden>Change GitLab token</button><div id="token-entry"><label for="token">GitLab token</label><input id="token" type="password" autocomplete="off" placeholder="Paste your token"></div>
<details id="cert-details"><summary>Certificate paths</summary><p>Paths refer to files on the computer running the launcher. Changing external paths may require relaunching.</p><label for="public">Public certificate path</label><input id="public"><label for="private">Private key path</label><input id="private"></details>
<button id="generate" hidden>Generate certificates</button><button id="download" hidden>Download public certificate</button>
<p id="cert-message"></p><div id="registration"><p>Register the public certificate on your runbox: open <strong>Setup → Integration → Manage Authentication → OAuth 2.0 Client Credentials (M2M) Setup</strong>, select SuiteCloud Development Integration and the appropriate entity and role, and upload <strong>public.pem</strong>. Copy the assigned certificate ID below. Keep the private key on this computer.</p><a id="runbox-link" hidden target="_blank" rel="noopener noreferrer">Open runbox</a> <a href="https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0422011927.html" target="_blank" rel="noopener noreferrer">NetSuite setup guide</a></div>
<label for="id">Certificate ID assigned by NetSuite</label><input id="id"><button id="credentials">Save credentials</button><p id="credential-message" role="status"></p></section>
<section><h2>Deployment</h2><p id="validation" role="status"></p><button id="deploy" disabled>Deploy</button><button id="stop">Stop app</button><p id="run-state" role="status">Loading…</p><pre id="log" tabindex="0" aria-label="Deployment progress"></pre></section>
</main></body></html>`,
    style: `:root{font-family:system-ui,sans-serif;color:#203040;background:#f3f5f8}body{margin:0}main{max-width:960px;margin:32px auto;padding:0 24px 48px}h1{font-size:30px}h2{font-size:21px}section{background:white;border:1px solid #dde3eb;border-radius:12px;padding:24px;margin:20px 0}p{line-height:1.6}label{display:block;font-weight:600;margin:16px 0 6px}input,textarea{box-sizing:border-box;width:100%;padding:12px;border:1px solid #a8b4c2;border-radius:6px;font:inherit}textarea,pre{font-family:ui-monospace,monospace;font-size:14px}button{padding:11px 18px;margin:14px 10px 0 0;border:1px solid #496a91;border-radius:6px;background:#fff;color:#203040;font:inherit;cursor:pointer}#deploy{background:#235f9f;color:white}button:disabled{opacity:.45;cursor:default}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:440px;overflow:auto;background:#142333;color:#e8eef7;padding:18px;border-radius:6px;min-height:70px}[hidden]{display:none!important}#validation,#cert-message{color:#70421a}summary{cursor:pointer;padding-top:12px}a{color:#235f9f}`,
    script: `const $ = id => document.getElementById(id);
const fragment = new URLSearchParams(location.hash.slice(1));
const session = fragment.get('session') || sessionStorage.getItem('suitecloud-session') || '';
sessionStorage.setItem('suitecloud-session', session);
history.replaceState(null, '', location.pathname);
let state, editing = false, stopped = false, checking, credentialEditing = false, changingToken = false;
async function api(path, data) {
  const response = await fetch('/api/' + path, { method: data === undefined ? 'GET' : 'POST', headers: {'X-Session-Token': session, ...(data === undefined ? {} : {'Content-Type':'application/json'})}, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
  return result;
}
function render(next) {
  state = next;
  if (!editing) $('config').value = next.config;
  const busy = next.run.state === 'running';
  if (!credentialEditing) for (const key of ['public','private','id']) $(key).value = next.certificates[key] || '';
  $('token-state').textContent = next.tokenPresent ? 'GitLab token saved.' : 'No GitLab token was found. Paste it below and save credentials.';
  $('token-entry').hidden = next.tokenPresent && !changingToken;
  $('change-token').hidden = !next.tokenPresent || changingToken;
  $('generate').hidden = !next.certificates.canGenerate;
  $('generate').disabled = busy || credentialEditing;
  $('download').hidden = !next.certificates.canDownload;
  $('cert-message').textContent = next.certificates.error;
  $('validation').textContent = next.relaunch ? 'Relaunch required. Save your changes, stop this app, and start the launcher again.' : next.error || 'Ready to deploy.';
  $('deploy').disabled = !next.ready || credentialEditing;
  for (const key of ['save','credentials','stop','public','private','id','token','config','change-token']) $(key).disabled = busy;
  $('run-state').textContent = ({idle:'No deployment started.',running:'Deployment in progress…',succeeded:'Deployment completed.',failed:'Deployment failed. Review the message below, correct settings or credentials, and retry.'})[next.run.state];
  const log = $('log'); const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
  log.textContent = next.run.log;
  if (bottom) log.scrollTop = log.scrollHeight;
  try { const vm = JSON.parse($('config').value).vms?.[0]?.url; const safe = typeof vm === 'string' && /^(?:[A-Za-z0-9-]+\\.)+[A-Za-z0-9-]+$/.test(vm) && vm.endsWith('.netsuite.com'); $('runbox-link').hidden = !safe; if (safe) $('runbox-link').href = 'https://' + vm; } catch { $('runbox-link').hidden = true; }
}
async function refresh() { if (stopped) return; try { const next = editing ? await api('check', {config:$('config').value}) : await api('state'); render(next); } catch (error) { $('validation').textContent = error.message; $('deploy').disabled = true; } }
function action(id, fn, messageId = 'validation') { $(id).addEventListener('click', async () => { $(id).disabled = true; try { await fn(); } catch(error) { $(messageId).textContent = error.message; } finally { if (!stopped) await refresh(); } }); }
$('config').addEventListener('input', () => { editing = true; $('deploy').disabled = true; clearTimeout(checking); checking = setTimeout(refresh, 350); });
for (const key of ['public','private','id','token']) $(key).addEventListener('input', () => { credentialEditing = true; $('deploy').disabled = true; });
$('change-token').addEventListener('click', () => { changingToken = true; $('token-entry').hidden = false; $('change-token').hidden = true; $('token').focus(); });
action('save', async () => { render(await api('settings', {config:$('config').value})); editing = false; $('settings-message').textContent = 'Settings saved.'; }, 'settings-message');
action('credentials', async () => { const data = Object.fromEntries(['public','private','id','token'].map(key => [key,$(key).value])); const next = await api('credentials',data); credentialEditing = false; changingToken = false; $('token').value = ''; render(next); $('credential-message').textContent = 'Credentials saved.'; }, 'credential-message');
action('generate', async () => { if (credentialEditing) throw new Error('Save your credential changes first.'); render(await api('generate',{})); $('cert-details').open = true; }, 'credential-message');
action('deploy', async () => { render(await api('deploy',{config:$('config').value})); editing = false; });
action('download', async () => { const response = await fetch('/api/certificate',{headers:{'X-Session-Token':session}}); if (!response.ok) throw new Error((await response.json()).error); const url = URL.createObjectURL(await response.blob()); const a = document.createElement('a'); a.href = url; a.download = 'public.pem'; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }, 'credential-message');
action('stop', async () => { await api('stop',{}); stopped = true; $('run-state').textContent = 'App stopped. You can close this page.'; for (const button of document.querySelectorAll('button')) button.disabled = true; });
refresh(); setInterval(refresh, 2000);`,
};
