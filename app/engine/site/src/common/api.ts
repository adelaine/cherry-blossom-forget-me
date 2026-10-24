export const apiScript = `function createSiteApi(context) {
        const fragment = new URLSearchParams(location.hash.slice(1));
        const session = fragment.get('session') || sessionStorage.getItem('suitecloud-session') || '';
        sessionStorage.setItem('suitecloud-session', session);
        history.replaceState(null, '', location.pathname);

        let requestSequence = 0;
        function requestId() {
          return globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + (++requestSequence).toString(36) + '-' + Math.random().toString(36).slice(2);
        }
        async function api(path, data, idempotencyKey) {
          // A retry of this action must retain its key. Connection loss requires
          // rediscovery before another mutation; this client never replays it.
          const mutation = data !== undefined && path !== 'check' && path !== 'validate' && path !== 'heartbeat';
          const headers = {'X-Session-Token':session, ...(data === undefined ? {} : {'Content-Type':'application/json'}), ...(mutation ? {'Idempotency-Key':idempotencyKey || requestId()} : {})};
          let response, result;
          try {
            response = await fetch('/api/' + path, { signal:AbortSignal.timeout(path === 'sftp' || path === 'playwright/cancel' ? 30000 : path === 'playwright/run' ? 20000 : 10000), method: data === undefined ? 'GET' : 'POST', headers, ...(data === undefined ? {} : {body:JSON.stringify(data)}) });
            result = await response.json();
          } catch { context.connectionLost(); throw new Error(context.connectionMessage); }
          if (response.status >= 500 || (!response.ok && result.error?.startsWith('The app is stopping'))) { context.connectionLost(); throw new Error(context.connectionMessage); }
          if (!response.ok) throw new Error(result.error || 'The request could not be completed.');
          if (path !== 'heartbeat') { context.requestSucceeded(); }
          return result;
        }

return {api, session, requestId};
}`;
