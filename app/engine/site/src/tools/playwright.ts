import type { SiteModule } from "../common/module.ts";

export const playwright: SiteModule = {
    id: "playwright", placement: "tool",
    navigation: {"target":"playwright-section","label":"Playwright"},
    html: `<article><details class="setup-section" id="playwright-section"><summary><h2>Playwright tests</h2></summary><p>Run your SuiteApp browser tests against Current VM. Configure test users and roles in your Playwright project.</p>
<label for="playwright-enabled"><input id="playwright-enabled" type="checkbox" :disabled="view.playwright_enabled.disabled" @change="changeplaywright_enabled"> Enable test runner</label>
<label for="playwright-project">Project directory inside repos</label><input id="playwright-project" spellcheck="false" placeholder="absi-nsn/test-pw" :disabled="view.playwright_project.disabled" @input="inputplaywright_project">
<label for="playwright-browser">Browser</label><select id="playwright-browser" :disabled="view.playwright_browser.disabled" @change="changeplaywright_browser"><option value="container">Container browser</option><option value="local-chrome">Local Chrome (separate window)</option></select>
<div class="grid"><div><label for="playwright-file">Test file (optional)</label><input id="playwright-file" spellcheck="false" placeholder="tests/example.spec.ts" :disabled="view.playwright_file.disabled" @input="inputplaywright_file"></div>
<div><label for="playwright-workers">Parallel workers</label><input id="playwright-workers" type="number" min="1" max="16" step="1" value="1" :disabled="view.playwright_workers.disabled" @input="inputplaywright_workers"></div></div>
<p><small>Save settings and relaunch after enabling the runner or changing the project directory or browser. Leave Test file blank to run the configured project.</small></p>
<fieldset class="grid" aria-label="Playwright actions"><button id="playwright-save" class="secondary" :disabled="view.playwright_save.disabled" @click="clickplaywright_save">Save test settings</button><button id="playwright-run" disabled :disabled="view.playwright_run.disabled" @click="clickplaywright_run">Run tests</button><button id="playwright-cancel" class="secondary outline" disabled :disabled="view.playwright_cancel.disabled" @click="clickplaywright_cancel">Stop tests</button></fieldset>
<p id="playwright-message" role="status" x-text="view.playwright_message.text"></p><pre id="playwright-log" tabindex="0" aria-label="Playwright progress"></pre></details></article>
`,
    
    script: `(context) => {
    const { $, api, refresh, render, listen, action } = context;
    let component, view;
    let playwrightEditing = false, playwrightSubmitting = false, playwrightError = '';
            function renderPlaywright(next, busy) {
          const runner = next.playwright;
          if (!playwrightEditing) {
            let settings = runner?.settings || {};
            try { settings = JSON.parse(context.settings.text).playwright || settings; } catch { /* Keep unfinished JSON edits. */ }
            $('playwright-enabled').checked = settings.enabled === true;
            $('playwright-project').value = settings.project || '';
            $('playwright-browser').value = settings.browser || 'container';
            $('playwright-file').value = settings.testFile || '';
            $('playwright-workers').value = String(settings.workers || 1);
          }
          for (const id of ['playwright-enabled','playwright-project','playwright-browser','playwright-file','playwright-workers','playwright-save']) view[id.replaceAll('-', '_')].disabled = busy;
          view.playwright_run.disabled = busy || !runner?.canRun;
          view.playwright_cancel.disabled = playwrightSubmitting || runner?.state !== 'running';
          const runnerError = playwrightError || runner?.error;
          view.playwright_message.text = runnerError ? ([next.error, context.actionError].includes(runnerError) ? '' : runnerError) : (playwrightEditing ? 'Test settings changed. Save before running tests.' : runner?.relaunch ? 'Save settings and relaunch SuiteContainer to use this test project and browser.' : !runner?.enabled ? 'Enable the runner, save settings, and relaunch SuiteContainer.' : !runner.settings.project ? 'Choose the directory containing your Playwright configuration and lockfile.' : ({idle:'Ready to run tests.',running:'Playwright tests are running…',succeeded:'Playwright tests passed.',failed:'Playwright tests failed or were stopped. Review the output.'})[runner.state]);
          const log = $('playwright-log');
          const bottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 24;
          log.innerHTML = ansiToHtml(runner?.log || '');
          applyAnsiColors(log);
          if (bottom) log.scrollTop = log.scrollHeight;
        }
        const editPlaywright = () => {
          playwrightError = '';
          try {
            const config = JSON.parse(context.settings.text);
            config.playwright = { enabled:$('playwright-enabled').checked, project:$('playwright-project').value.trim(), browser:$('playwright-browser').value, testFile:$('playwright-file').value.trim(), workers:Number($('playwright-workers').value) };
            context.settings.text = JSON.stringify(config, null, 4);
            context.settings.editing = true; playwrightEditing = true;
            context.settings.scheduleRefresh();
            view.playwright_run.disabled = true;
            view.playwright_message.text = 'Test settings changed. Save settings and relaunch if the project directory or browser changed.';
          } catch { playwrightError = 'Fix the configuration JSON in Settings before changing test settings.'; view.playwright_message.text = playwrightError; }
        };
        listen('playwright-enabled', 'change', editPlaywright);
        listen('playwright-browser', 'change', editPlaywright);
        for (const id of ['playwright-project','playwright-file','playwright-workers']) listen(id, 'input', editPlaywright);
        for (const operation of ['run','cancel','save']) listen('playwright-' + operation, 'click', async () => {
          if (playwrightSubmitting) return;
          playwrightSubmitting = true; playwrightError = '';
          if (context.state) render(context.state);
          try {
            const path = operation === 'save' ? 'settings' : 'playwright/' + operation;
            const next = await api(path, operation === 'cancel' ? {} : {config:context.settings.text});
            if (operation !== 'cancel') { context.settings.editing = false; playwrightEditing = false; }
            render(next);
          } catch (error) { playwrightError = error.message; }
          finally { playwrightSubmitting = false; if (!context.stopped && context.state) render(context.state); }
        });

    return {
      init(root) { component = root; view = root.view;  },
      render: renderPlaywright,
      pending: () => playwrightSubmitting,
      collapse() { $('playwright-section').open = false; },
    };
  }`,
};
