// This adapter is imported by source-executed Node helpers as well as Hono.
// Keep the browser component graph behind the module entry served at /page.js.
export const deploymentPage = {
	html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>SuiteCloud deployment</title><link rel="icon" type="image/png" href="/favicon.png"><link rel="stylesheet" href="/pico.css"><link rel="stylesheet" href="/page.css"><link rel="stylesheet" href="/styles.css"><link id="brand-theme-stylesheet" rel="stylesheet" href="/themes/netsuite-2026.css"><script type="module" src="/page.js"></script></head>
<body><div id="app"><main class="container"><header><hgroup><h1><mark>SuiteContainer</mark></h1><p>Set your scrumbox address, complete your credentials, then deploy your SuiteApps.</p></hgroup></header><p role="status">Loading…</p></main></div></body></html>`,
};
