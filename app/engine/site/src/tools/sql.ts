import type { SiteModule } from "../common/module.ts";

export const sql: SiteModule = {
    id: "sql", placement: "tool",
    navigation: {"target":"sql-section","label":"SQL"},
    html: `<article><details class="setup-section" id="sql-section"><summary><h2>SQL queries</h2></summary>
<div class="grid"><div><label for="sql-account">User</label><input id="sql-account" autocomplete="off" spellcheck="false" :disabled="view.sql_account.disabled" @input="inputsql_account"></div>
<div><label for="sql-database">Service Name</label><input id="sql-database" autocomplete="off" spellcheck="false" :disabled="view.sql_database.disabled" @input="inputsql_database"></div></div>
<div class="grid"><div><label for="sql-password">Password</label><input id="sql-password" type="password" autocomplete="off" :disabled="view.sql_password.disabled" @input="inputsql_password"></div>
<div><label for="sql-unlock">Answer to password hint</label><input id="sql-unlock" type="password" autocomplete="off" aria-describedby="sql-password-hint sql-unlock-availability" :disabled="view.sql_unlock.disabled" @input="inputsql_unlock"><p id="sql-password-hint" hidden :hidden="view.sql_password_hint.hidden" x-text="view.sql_password_hint.text"></p></div></div>
<p>Enter SQL password, or answer the hint to use the default password. Entering one clears the other.</p><p id="sql-unlock-availability" hidden :hidden="view.sql_unlock_availability.hidden" x-text="view.sql_unlock_availability.text"></p>
<label for="sql-statement">SQL statement</label><textarea id="sql-statement" rows="8" spellcheck="false" placeholder="SELECT * FROM your_table;" :disabled="view.sql_statement.disabled" @input="inputsql_statement"></textarea>
<fieldset><button id="sql-run" disabled :disabled="view.sql_run.disabled" @click="clicksql_run">Run SQL</button></fieldset><p id="sql-message" role="status" x-text="view.sql_message.text"></p><pre id="sql-output" tabindex="0" aria-label="SQL results"></pre></details></article>
`,
    
    script: `(context) => {
  const { $, api, render, listen } = context;
  let view;
  let sqlSubmitting = false,
    sqlDefaultsApplied = false,
    sqlDefaultsHost,
    sqlAccountEdited = false,
    sqlDatabaseEdited = false,
    sqlRequestError = '';
  function renderSql(next, busy) {
    if (context.connectionFailed) return;
    if (next.sql) {
      const host = context.settings.targetHost();
      if (!sqlDefaultsApplied || sqlDefaultsHost !== host) {
        sqlAccountEdited = false;
        sqlDatabaseEdited = false;
      }
      if (!sqlAccountEdited) $('sql-account').value = next.sql.defaults.user;
      if (!sqlDatabaseEdited)
        $('sql-database').value = next.sql.defaults.service;
      view.sql_password_hint.text = next.sql.passwordHint;
      view.sql_password_hint.hidden = !next.sql.passwordHint;
      sqlDefaultsApplied = true;
      sqlDefaultsHost = host;
    }
    for (const id of [
      'sql-account',
      'sql-database',
      'sql-password',
      'sql-statement',
    ])
      view[id.replaceAll('-', '_')].disabled = busy;
    view.sql_unlock.disabled = busy || !next.sql?.hasDefaultPassword;
    view.sql_unlock_availability.hidden = !!next.sql?.hasDefaultPassword;
    view.sql_unlock_availability.text =
      'No saved SQL password is available to unlock. Enter your SQL password above.';
    const passwordEntered = !!$('sql-password').value;
    const unlockEntered =
      !!$('sql-unlock').value && !!next.sql?.hasDefaultPassword;
    view.sql_run.disabled =
      busy ||
      !context.settings.targetHost() ||
      !$('sql-account').value.trim() ||
      !$('sql-database').value.trim() ||
      passwordEntered === unlockEntered ||
      !$('sql-statement').value.trim();
    if (next.sql) {
      const detail = next.sql.host
        ? ' (' + next.sql.host + '/' + next.sql.database + ')'
        : '';
      if (sqlRequestError) view.sql_message.text = sqlRequestError;
      else if (next.sql.preparing)
        view.sql_message.text = 'Unlocking SQL credentials…';
      else if (next.sql.state !== 'idle')
        view.sql_message.text =
          {
            running: 'SQL is running…',
            succeeded: 'SQL completed.',
            failed: 'SQL failed. Review the output and retry.',
          }[next.sql.state] + detail;
      $('sql-output').textContent = next.sql.output;
    }
  }
  for (const key of [
    'sql-account',
    'sql-database',
    'sql-password',
    'sql-unlock',
    'sql-statement',
  ])
    listen(key, 'input', () => {
      if (key === 'sql-account') sqlAccountEdited = true;
      if (key === 'sql-database') sqlDatabaseEdited = true;
      if (key === 'sql-password' && $('sql-password').value)
        $('sql-unlock').value = '';
      if (key === 'sql-unlock' && $('sql-unlock').value)
        $('sql-password').value = '';
      if (context.state)
        renderSql(
          context.state,
          context.state.run.state === 'running' ||
            context.state.sql?.state === 'running' ||
            context.state.sql?.preparing ||
            sqlSubmitting,
        );
    });
  listen('sql-run', 'click', async () => {
    if (
      sqlSubmitting ||
      context.state?.run.state === 'running' ||
      context.state?.sql?.state === 'running' ||
      context.state?.sql?.preparing
    )
      return;
    context.actionError = '';
    sqlRequestError = '';
    sqlSubmitting = true;
    render(context.state);
    view.sql_message.text = 'Starting SQL…';
    try {
      const credentials = $('sql-password').value
        ? { password: $('sql-password').value }
        : { unlock: $('sql-unlock').value };
      const next = await api('sql', {
        config: context.settings.text,
        account: $('sql-account').value,
        database: $('sql-database').value,
        ...credentials,
        sql: $('sql-statement').value,
      });
      render(next);
    } catch (error) {
      sqlRequestError = error.message;
      view.sql_message.text = error.message;
    } finally {
      sqlSubmitting = false;
      if (!context.stopped) render(context.state);
    }
  });

  return {
    init(root) {
      view = root.view;
    },
    render: renderSql,
    pending: () => sqlSubmitting,
    collapse() {
      $('sql-section').open = false;
    },
  };
}`,
};
