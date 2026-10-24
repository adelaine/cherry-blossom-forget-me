import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { act } from "preact/test-utils";
import { initializeBrowser } from "../browser-harness.ts";

test("Stop app closes after five seconds only on success and explains blocked closure", async () => {
    for (const success of [true, false]) {
        const elements = new Map<string, any>();
        const element = (id: string) => {
            if (!elements.has(id))
                elements.set(id, {
                    value: "",
                    replaceChildren() {},
                    querySelectorAll: () => [],
                    addEventListener(event: string, handler: Function) {
                        this[event] = handler;
                    },
                });
            return elements.get(id);
        };
        const timers: { callback: () => void; delay: number }[] = [];
        let closes = 0;
        let requests = 0;
        const state = {
            config: '{"vms":[]}',
            certificates: {},
            run: { state: "idle", log: "" },
            ready: false,
        };
        const context = {
            document: {
                getElementById: element,
                querySelectorAll: () => [element("stop"), element("deploy")],
                addEventListener() {},
            },
            location: { hash: "", pathname: "/" },
            URLSearchParams,
            AbortSignal,
            sessionStorage: { getItem: () => "", setItem() {} },
            history: { replaceState() {} },
            setInterval() {},
            clearTimeout() {},
            setTimeout(callback: () => void, delay: number) {
                timers.push({ callback, delay });
            },
            window: {
                closed: false,
                close() {
                    closes++;
                },
            },
            fetch: async (path: string) => {
                requests++;
                return {
                    ok: path !== "/api/stop" || success,
                    json: async () =>
                        path === "/api/stop"
                            ? { error: "Deployment is running." }
                            : state,
                };
            },
        };
        initializeBrowser(context);
        await new Promise((resolve) => setImmediate(resolve));
        await element("stop").click();
        assert.equal(closes, 0);
        if (success) {
            assert.equal(timers.length, 1);
            assert.equal(timers[0]!.delay, 5000);
            assert.match(
                element("run-state").textContent,
                /Attempting to close this page/,
            );
            assert.equal(element("stop").disabled, true);
            const stoppedRequests = requests;
            await runInNewContext("refresh()", context);
            runInNewContext("render({run:{state:'idle'}})", context);
            assert.equal(requests, stoppedRequests);
            assert.match(
                element("run-state").textContent,
                /Attempting to close this page/,
            );
            act(() => timers[0]!.callback());
            assert.equal(closes, 1);
            assert.match(
                element("run-state").textContent,
                /browser kept this page open/,
            );
        } else {
            assert.equal(timers.length, 0);
            assert.equal(element("stop").disabled, false);
            assert.match(
                element("validation").textContent,
                /Deployment is running/,
            );
            const activeRequests = requests;
            await runInNewContext("refresh()", context);
            assert.equal(requests, activeRequests + 1);
            assert.match(
                element("validation").textContent,
                /Deployment is running/,
            );
        }
    }
});
