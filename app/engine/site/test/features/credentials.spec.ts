import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { initializeBrowser } from "../browser-harness.ts";

test("Current VM preserves accounts and other scrumboxes, synchronizes JSON edits, and saves with credentials", async () => {
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
    const config = {
        suiteapps: [],
        vms: [
            { account: "000072", url: "old.vm.eng.netsuite.com" },
            { account: "000073", url: "second.vm.eng.netsuite.com" },
        ],
    };
    let saved: any;
    const next = {
        config: JSON.stringify(config),
        certificates: {},
        run: { state: "idle", log: "" },
        ready: false,
    };
    const context = {
        document: {
            getElementById: element,
            createElement: () => ({}),
            addEventListener() {},
        },
        location: { hash: "", pathname: "/" },
        URLSearchParams,
        AbortSignal,
        sessionStorage: { getItem: () => "", setItem() {} },
        history: { replaceState() {} },
        setInterval() {},
        setTimeout() {},
        clearTimeout() {},
        fetch: async (path: string, options: any) => {
            if (path === "/api/credentials") {
                saved = JSON.parse(options.body);
                next.config = saved.config;
            }
            return { ok: true, json: async () => next };
        },
    };
    initializeBrowser(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(element("vm").value, config.vms[0].url);
    element("vm").value = "new.vm.eng.netsuite.com";
    element("vm").input();
    const edited = JSON.parse(element("config").value);
    assert.equal(edited.vms[0].url, "new.vm.eng.netsuite.com");
    assert.equal(edited.vms[0].account, "000072");
    assert.deepEqual(edited.vms[1], config.vms[1]);
    await element("credentials").click();
    assert.deepEqual(JSON.parse(saved.config), edited);
    edited.vms[0].url = "json.vm.eng.netsuite.com";
    element("config").value = JSON.stringify(edited);
    element("config").input();
    runInNewContext("render(state)", context);
    assert.equal(element("vm").value, edited.vms[0].url);
    element("config").value = "invalid JSON";
    element("config").input();
    element("vm").input();
    assert.equal(element("config").value, "invalid JSON");
    assert.match(
        element("credential-message").textContent,
        /Fix the configuration JSON/,
    );
    runInNewContext(
        "editing = false; credentialEditing = false; render({...state,run:{state:'running',log:''}})",
        context,
    );
    assert.match(element("validation").textContent, /Deployment is running/);
    runInNewContext(
        "render({...state,run:{state:'idle',log:''},sql:{state:'running',output:'',defaults:{user:'',service:''}}})",
        context,
    );
    assert.match(element("validation").textContent, /SQL is running/);
    runInNewContext(
        "render({...state,sql:{...state.sql,state:'idle',preparing:true}})",
        context,
    );
    assert.match(
        element("validation").textContent,
        /Unlocking the saved SQL password/,
    );
});
