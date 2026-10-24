import {
    ACTIVITY_GRACE_MS,
    HEARTBEAT_INTERVAL_MS,
} from "../../../server/src/web-inactivity.ts";

// Browser JavaScript remains source text, inserted directly into /page.js.
// Factories run before Alpine initializes; hooks receive its reactive root.
export const runtimeScript = `
const siteFactories = [];
function registerSiteModule(id, bindings, factory) {
  if (siteFactories.some(module => module.id === id)) throw new Error('Duplicate site module: ' + id);
  siteFactories.push({id, bindings, factory});
}
function createSiteRuntime() {
  const modules = [], cleanups = [], timers = new Set(), intervals = new Set();
  let component, state, stopped = false, disposed = false, initialized = false;
  let lastActivity = Date.now(), heartbeatPending = false, connectionFailed = false, idleCloseScheduled = false;
  let view = {};
  const controller = {view};
  const connectionMessage = 'Connection to the app was lost. It may have stopped automatically after inactivity. Start the launcher again to reconnect.';
  const context = {
    view,
    get component() { return component; },
    get state() { return state; },
    get stopped() { return stopped || disposed; },
    set stopped(value) { stopped = value; },
    get connectionFailed() { return connectionFailed; },
    actionError: '',
    settings: undefined,
    credentials: undefined,
    activity: () => ({busy:false, preventStop:false, active:false}),
    isPending: id => !!modules.find(module => module.id === id)?.hooks.pending?.(),
    get busy() { return context.activity(state).busy; },
    $: id => document.getElementById(id),
    cleanup(fn) { cleanups.push(fn); },
    timeout(fn, delay) {
      const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn(); }, delay);
      timers.add(timer);
      return timer;
    },
    clearTimeout(timer) { clearTimeout(timer); timers.delete(timer); },
    on(target, event, handler, options) {
      target.addEventListener(event, handler, options);
      cleanups.push(() => target.removeEventListener?.(event, handler, options));
    },
    settingsChanged() { for (const {hooks} of modules) hooks.settingsChanged?.(); },
    collapse() { for (const {hooks} of modules) hooks.collapse?.(); },
    render,
    refresh,
    heartbeat,
    dispose,
    connectionLost,
    connectionMessage,
    requestSucceeded() { connectionFailed = false; view.connection_error.hidden = true; },
    action(id, fn, messageId = 'validation') {
      return async () => {
        context.actionError = '';
        view[id.replaceAll('-', '_')].disabled = true;
        try { await fn(); }
        catch (error) {
          if (messageId === 'validation') context.actionError = error.message;
          view[messageId.replaceAll('-', '_')].text = error.message;
        } finally { if (!context.stopped) await refresh(); }
      };
    },
  };
  function connectionLost() {
    if (context.stopped) return;
    connectionFailed = true;
    view.connection_error.text = connectionMessage;
    view.connection_error.hidden = false;
    for (const {hooks} of modules) hooks.connectionLost?.();
    for (const control of document.querySelectorAll('button,input,textarea')) {
      const binding = view[control.id?.replaceAll('-', '_')];
      if (binding) binding.disabled = true;
    }
    if (!idleCloseScheduled && Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS} && !context.activity(state).active) {
      idleCloseScheduled = true;
      context.timeout(() => {
        if (!connectionFailed || Date.now() - lastActivity < ${ACTIVITY_GRACE_MS}) { idleCloseScheduled = false; return; }
        try { window.close(); } catch { /* Browsers may refuse tab closure. */ }
      }, 5000);
    }
  }
  function render(next) {
    if (context.stopped || connectionFailed) return;
    state = next;
    const busy = context.busy;
    for (const {hooks} of modules) hooks.render?.(next, busy);
  }
  async function refresh() {
    if (context.stopped) return;
    try {
      const next = context.settings.editing
        ? await context.api('check', {config:context.settings.text})
        : await context.api('state');
      render(next);
    } catch (error) {
      if (context.stopped) return;
      if (!connectionFailed) connectionLost();
      view.validation.text = error.message;
    }
  }
  async function heartbeat() {
    if (context.stopped || heartbeatPending || Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS}) return;
    heartbeatPending = true;
    try { await context.api('heartbeat', {}); }
    catch { /* Connection errors are displayed by api(). */ }
    finally { heartbeatPending = false; }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const {hooks} of modules.toReversed()) hooks.cleanup?.();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const timer of timers) clearTimeout(timer);
    for (const interval of intervals) clearInterval(interval);
    timers.clear(); intervals.clear();
  }
  function add(module) {
    const handlers = {};
    for (const id of module.bindings.ids) {
      const element = context.$(id), key = id.replaceAll('-', '_');
      if (Object.hasOwn(view, key)) throw new Error('Conflicting site binding: ' + key);
      view[key] = {hidden:element.hidden, disabled:!!element.disabled, text:['P','BLOCKQUOTE'].includes(element.tagName) ? element.textContent : ''};
    }
    const local = Object.create(context);
    local.listen = (id, event, handler) => { handlers[event + id.replaceAll('-', '_')] = handler; };
    local.action = (id, fn, messageId) => local.listen(id, 'click', context.action(id, fn, messageId));
    // Shared state stays on the context, even when a module assigns a property.
    for (const key of ['actionError','settings','credentials','activity','stopped']) {
      Object.defineProperty(local, key, {get:() => context[key], set:value => { context[key] = value; }});
    }
    const hooks = module.factory(local);
    const properties = Object.getOwnPropertyDescriptors(hooks.controller || {});
    for (const [event, name] of module.bindings.events) {
      if (Object.hasOwn(properties, name)) continue;
      properties[name] = {enumerable:true, configurable:true, writable:true, value:function(event) { return handlers[name](event); }};
    }
    for (const [key, descriptor] of Object.entries(properties)) {
      if (Object.hasOwn(controller, key)) throw new Error('Conflicting site controller property: ' + key);
      Object.defineProperty(controller, key, descriptor);
    }
    modules.push({id:module.id, hooks});
  }
  function start(root) {
    if (initialized || disposed) return;
    initialized = true;
    component = root;
    // Use Alpine's reactive bindings from this point, including async handlers.
    view = context.view = root.view;
    for (const {hooks} of modules) hooks.init?.(root);
    for (const event of ['click','input','keydown','scroll']) context.on(document, event, event => {
      if (!event.isTrusted || context.stopped) return;
      const expired = Date.now() - lastActivity >= ${ACTIVITY_GRACE_MS};
      lastActivity = Date.now();
      if (expired) void heartbeat();
    }, {capture:true,passive:true});
    context.on(window, 'pagehide', dispose);
    refresh(); intervals.add(setInterval(refresh, 2000));
    heartbeat(); intervals.add(setInterval(heartbeat, ${HEARTBEAT_INTERVAL_MS}));
  }
  return {context, controller, add, start, dispose};
}
`;
