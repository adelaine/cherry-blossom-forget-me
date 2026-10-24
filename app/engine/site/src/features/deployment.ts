import type { SiteModule } from "../common/module.ts";

export const deployment: SiteModule = {
    id: "deployment", placement: "feature", slot: "deployment",
    navigation: {"target":"deployment-section","label":"Deploy"},
    html: `<article id="deployment-section"><h2>Deploy SuiteApps</h2><p id="validation" role="status" x-text="view.validation.text"></p><fieldset aria-label="Deployment actions"><button id="deploy" disabled :disabled="view.deploy.disabled" @click="clickdeploy">Deploy SuiteApps</button></fieldset><blockquote class="status-message" id="run-state" role="status" x-text="view.run_state.text">Loading…</blockquote><pre id="log" tabindex="0" aria-label="Deployment progress"></pre></article>
`,
    
    script: `(context) => {
  const { $, api, render, action } = context;
  let view;
  let sectionsInitialized = false,
    lastDeploymentStarted;

  // These application-wide conflicts remain in force for omitted tools too.
  context.activity = (next) => {
    const sql =
      next?.sql?.state === 'running' ||
      next?.sql?.preparing ||
      context.isPending('sql');
    const playwright =
      next?.playwright?.state === 'running' || context.isPending('playwright');
    const deployment = next?.run?.state === 'running';
    const busy = deployment || sql || playwright;
    return {
      busy,
      preventStop: deployment || sql,
      active:
        busy ||
        ['starting', 'running'].includes(next?.sftp?.state) ||
        context.isPending('sftp'),
    };
  };
  action('deploy', async () => {
    render(await api('deploy', { config: context.settings.text }));
    context.settings.editing = false;
  });

  return {
    init(root) {
      view = root.view;
    },
    render: (next, busy) => {
      if (!sectionsInitialized) {
        sectionsInitialized = true;
        if (next.deploymentStarted) context.collapse();
      }
      if (next.run.started && next.run.started !== lastDeploymentStarted) {
        lastDeploymentStarted = next.run.started;
        context.collapse();
      }
      view.validation.text =
        context.actionError ||
        (busy
          ? next.playwright?.state === 'running' ||
            context.isPending('playwright')
            ? 'Playwright tests are running. Stop the tests or wait for them to finish before deploying or changing settings.'
            : next.sql?.preparing
              ? 'Unlocking the saved SQL password. Please wait.'
              : next.sql?.state === 'running' || context.isPending('sql')
                ? 'SQL is running. Wait for it to finish before deploying or changing settings.'
                : 'Deployment is running. Wait for it to finish before changing settings or credentials.'
          : next.relaunch
            ? 'Relaunch required. Save your changes, stop this app, and start the launcher again.'
            : next.error ||
              (context.credentials.editing
                ? 'Save your credential changes before deploying.'
                : context.settings.editing
                  ? 'Settings are ready.'
                  : 'Ready to deploy.'));
      view.deploy.disabled = !next.ready || context.credentials.editing || busy;
      for (const key of [
        'save',
        'credentials',
        'stop',
        'public',
        'private',
        'id',
        'token',
        'config',
        'vm',
        'vm-account',
        'change-token',
      ])
        view[key.replaceAll('-', '_')].disabled = busy;
      view.stop.disabled =
        next.run.state === 'running' ||
        next.sql?.state === 'running' ||
        next.sql?.preparing ||
        context.isPending('sql');
      view.run_state.text = {
        idle: 'No deployment started.',
        running: 'Deployment in progress…',
        succeeded: 'Deployment completed.',
        failed:
          'Deployment failed. Review the message below, correct settings or credentials, and retry.',
      }[next.run.state];
      const log = $('log');
      const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
      log.innerHTML = ansiToHtml(next.run.log);
      applyAnsiColors(log);
      if (bottom) log.scrollTop = log.scrollHeight;
    },
  };
}`,
};
