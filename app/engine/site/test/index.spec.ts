import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync } from "node:fs";
import { ACTIVITY_GRACE_MS } from "../../server/src/web-inactivity.ts";
import { ansiToHtml, ansiStyles } from "../src/common/ansi.ts";
import { deploymentPage } from "../src/web-page.ts";
import { initializeBrowser } from "./browser-harness.ts";

test("ANSI converter and styles are included in the compiled browser assets", () => {
    const script = readFileSync(
        new URL("../../dist/site/assets/page.js", import.meta.url),
        "utf8",
    );
    assert.equal(
        ansiToHtml("\x1b[31m<red>"),
        '<span class="ansi-fg-1">&lt;red&gt;</span>',
    );
    assert.ok(script.includes("data-ansi-fg"));
    const styles = readFileSync(
        new URL("../public/styles.css", import.meta.url),
        "utf8",
    );
    assert.ok(
        styles.replace(/\s+/g, "").replace(/;}/g, "}").includes(ansiStyles),
    );
    assert.ok(deploymentPage.html.includes('type="module" src="/page.js"'));
});

test("browser heartbeat follows real activity, stops after fifteen minutes, and reports server loss without losing edits", async () => {
    const elements = new Map<string, any>();
    const element = (id: string) => {
        if (!elements.has(id))
            elements.set(id, {
                value: "",
                replaceChildren() {},
                querySelectorAll: () => [],
                addEventListener() {},
            });
        return elements.get(id);
    };
    const events = new Map<string, (event: { isTrusted: boolean }) => void>();
    const intervals: number[] = [],
        requests: string[] = [],
        timers: (() => void)[] = [];
    let now = 0,
        offline = false,
        closes = 0;
    const next = {
        config: '{"vms":[]}',
        certificates: {},
        run: { state: "idle", log: "" },
        ready: false,
    };
    const context = {
        document: {
            getElementById: element,
            createElement: () => ({}),
            querySelectorAll: () => [...elements.values()],
            addEventListener(
                event: string,
                handler: (event: { isTrusted: boolean }) => void,
            ) {
                events.set(event, handler);
            },
        },
        location: { hash: "", pathname: "/" },
        URLSearchParams,
        AbortSignal,
        Date: { now: () => now },
        sessionStorage: { getItem: () => "", setItem() {} },
        history: { replaceState() {} },
        setInterval(_callback: Function, delay: number) {
            intervals.push(delay);
        },
        setTimeout(callback: () => void) {
            timers.push(callback);
        },
        clearTimeout() {},
        window: {
            close() {
                closes++;
            },
        },
        fetch: async (path: string) => {
            requests.push(path);
            if (offline) throw new Error("fetch failed");
            return { ok: true, json: async () => next };
        },
    };
    initializeBrowser(context);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(intervals.includes(30_000));
    const beats = () =>
        requests.filter((path) => path === "/api/heartbeat").length;
    assert.equal(beats(), 1);
    now = ACTIVITY_GRACE_MS - 30_000;
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 2);
    now = ACTIVITY_GRACE_MS;
    await runInNewContext("refresh(); heartbeat()", context);
    assert.equal(beats(), 2);
    events.get("scroll")!({ isTrusted: false });
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 2);
    events.get("input")!({ isTrusted: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(beats(), 3);
    now += ACTIVITY_GRACE_MS;
    await runInNewContext("heartbeat()", context);
    assert.equal(beats(), 3);
    element("config").value = "unsaved edits";
    runInNewContext("editing = true", context);
    offline = true;
    await runInNewContext("refresh()", context);
    assert.equal(element("connection-error").hidden, false);
    assert.match(
        element("connection-error").textContent,
        /Start the launcher again/,
    );
    assert.equal(element("config").value, "unsaved edits");
    assert.equal(element("save").disabled, true);
    assert.equal(element("sql-run").disabled, true);
    runInNewContext("render(state)", context);
    assert.equal(element("save").disabled, true);
    assert.equal(closes, 0);
    timers[0]!();
    assert.equal(closes, 1);
    offline = false;
    await runInNewContext("refresh()", context);
    assert.equal(element("connection-error").hidden, true);
    assert.equal(element("config").value, "unsaved edits");
    assert.equal(element("save").disabled, false);
    assert.equal(element("download").disabled, false);
    offline = true;
    events.get("click")!({ isTrusted: true });
    const scheduled = timers.length;
    await runInNewContext("refresh()", context);
    assert.equal(timers.length, scheduled);
    assert.equal(element("connection-error").hidden, false);
});
