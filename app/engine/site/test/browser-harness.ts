import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import { SiteRuntime, type RuntimeEnvironment } from "../src/common/runtime.ts";
import { App } from "../src/layout/page.tsx";

// These DOM doubles exercise the actual Preact tree while keeping the existing
// controlled request and timer fixtures independent from external tool services.
class TestNode {
    parentNode: TestNode | null = null;
    childNodes: TestNode[] = [];
    data = "";
    nodeType: number;
    localName: string;
    namespaceURI = "http://www.w3.org/1999/xhtml";
    ownerDocument: any;
    value = "";
    checked = false;
    disabled = false;
    hidden = false;
    open = false;
    scrollTop = 0;
    scrollHeight = 0;
    clientHeight = 0;
    offsetHeight = 0;
    media = "";
    href = "";
    download = "";
    dataset: Record<string, string> = {};
    style: Record<string, unknown> = {setProperty(name: string, value: unknown) { this[name] = value; }};
    attributes = new Map<string, string>();
    listeners = new Map<string, (event: any) => unknown>();
    onclick = null;
    oninput = null;
    onchange = null;
    private identifier = "";
    private rawHtml: string | undefined;
    constructor(name: string, readonly context: any, text = false) {
        this.nodeType = text ? 3 : 1;
        this.localName = name;
        this.ownerDocument = context.document;
    }
    get nodeName() { return this.nodeType === 3 ? "#text" : this.localName.toUpperCase(); }
    get tagName() { return this.nodeName; }
    get firstChild() { return this.childNodes[0] ?? null; }
    get nextSibling(): TestNode | null {
        if (!this.parentNode) return null;
        return this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] ?? null;
    }
    get id() { return this.identifier; }
    set id(value: string) {
        this.identifier = value;
        this.attributes.set("id", value);
        this.context.nodes.set(value, this);
        const fixture = this.context.fixtureElement(value);
        if (!fixture || fixture === this) return;
        for (const key of ["value", "checked", "disabled", "hidden", "open", "textContent", "innerHTML", "id", "tagName", "href", "scrollTop", "scrollHeight", "clientHeight"]) {
            Object.defineProperty(fixture, key, {configurable: true, get: () => (this as any)[key], set: value => { (this as any)[key] = value; }});
        }
        for (const key of ["click", "input", "change", "focus", "querySelectorAll", "querySelector"])
            fixture[key] = (this as any)[key].bind(this);
    }
    insertBefore(node: TestNode, before: TestNode | null) {
        node.parentNode?.removeChild(node);
        const index = before ? this.childNodes.indexOf(before) : -1;
        if (index < 0) this.childNodes.push(node);
        else this.childNodes.splice(index, 0, node);
        node.parentNode = this;
        return node;
    }
    appendChild(node: TestNode) { return this.insertBefore(node, null); }
    removeChild(node: TestNode) {
        const index = this.childNodes.indexOf(node);
        if (index >= 0) this.childNodes.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    remove() { this.parentNode?.removeChild(this); }
    replaceChildren(...nodes: TestNode[]) { this.childNodes = []; for (const node of nodes) this.appendChild(node); }
    setAttribute(name: string, value: unknown) {
        if (name === "id") this.id = String(value);
        else {
            this.attributes.set(name, String(value));
            if (name.startsWith("data-")) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = String(value);
        }
    }
    setAttributeNS(_namespace: string, name: string, value: unknown) { this.setAttribute(name, value); }
    removeAttribute(name: string) { this.attributes.delete(name); }
    removeAttributeNS(_namespace: string, name: string) { this.removeAttribute(name); }
    getAttribute(name: string) { return this.attributes.get(name) ?? null; }
    addEventListener(name: string, listener: (event: any) => unknown) { this.listeners.set(name, listener); }
    removeEventListener(name: string) { this.listeners.delete(name); }
    private dispatch(type: string) {
        let result: unknown;
        const event = {type, target: this, currentTarget: this, isTrusted: false, preventDefault() {}, stopPropagation() {}};
        const invoke = () => { result = this.listeners.get(type)?.call(this, event); };
        const completion = type === "click"
            ? act(async () => { invoke(); await result; await Promise.allSettled([...this.context.pendingRequests]); })
            : act(invoke);
        return completion;
    }
    click() { return this.dispatch("click"); }
    input() { return this.dispatch("input"); }
    change() { return this.dispatch("change"); }
    focus() { this.ownerDocument.activeElement = this; }
    scrollIntoView() {}
    querySelectorAll(selector: string): TestNode[] {
        const matches = (node: TestNode) => selector.startsWith("#") ? node.id === selector.slice(1) : selector === "input" ? node.localName === "input" : false;
        return this.childNodes.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
    get textContent(): string { return this.nodeType === 3 ? this.data : this.rawHtml ?? this.childNodes.map(node => node.textContent).join(""); }
    set textContent(text: string) { this.rawHtml = undefined; this.childNodes = []; const node = new TestNode("", this.context, true); node.data = String(text); this.appendChild(node); }
    get innerHTML(): string { return this.rawHtml ?? this.childNodes.map(serialize).join(""); }
    set innerHTML(html: string) { this.rawHtml = html; this.childNodes = []; }
}

function escape(text: string) { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;"); }
function serialize(node: TestNode): string {
    if (node.nodeType === 3) return escape(node.data);
    const attributes = new Map(node.attributes);
    for (const key of ["value", "href"]) if ((node as any)[key]) attributes.set(key, String((node as any)[key]));
    const attrs = [...attributes].map(([key, value]) => ` ${key}="${escape(value)}"`).join("");
    const start = `<${node.localName}${attrs}>`;
    return ["input", "img", "br", "hr", "link", "meta"].includes(node.localName) ? start : start + node.innerHTML + `</${node.localName}>`;
}

export function browserHtml(context: any): string { return context.root.innerHTML; }

export function initializeBrowser(context: any): void {
    const fixtureElement = context.document.getElementById;
    context.fixtureElement = fixtureElement;
    context.nodes = new Map<string, TestNode>();
    context.document.documentElement ??= {dataset: {}};
    context.document.removeEventListener ??= () => {};
    context.document.createElement = (name: string) => new TestNode(name, context);
    context.document.createElementNS = (_namespace: string, name: string) => new TestNode(name, context);
    context.document.createTextNode = (value: string) => { const node = new TestNode("", context, true); node.data = value; return node; };
    context.document.getElementById = (id: string) => context.nodes.get(id) ?? fixtureElement(id);
    context.window ??= {};
    context.window.addEventListener ??= () => {};
    context.window.removeEventListener ??= () => {};
    context.matchMedia ??= () => ({matches: false, addEventListener() {}, removeEventListener() {}});
    Object.assign(globalThis, {document: context.document, window: context.window, sessionStorage: context.sessionStorage, matchMedia: context.matchMedia});
    const runtime = new SiteRuntime({
        ...context,
        now: () => context.Date?.now() ?? Date.now(),
        clearInterval: context.clearInterval ?? (() => {}),
        clearTimeout: context.clearTimeout ?? (() => {}),
    } as RuntimeEnvironment);
    context.runtime = runtime;
    context.pendingRequests = new Set<Promise<unknown>>();
    const api = runtime.api;
    runtime.api = ((...args: Parameters<typeof api>) => {
        const request = api(...args);
        context.pendingRequests.add(request);
        void request.then(() => context.pendingRequests.delete(request), () => context.pendingRequests.delete(request));
        return request;
    }) as typeof api;
    context.root = new TestNode("div", context);
    context.refresh = () => act(() => runtime.refresh());
    context.heartbeat = () => act(() => runtime.heartbeat());
    context.render = (next: Parameters<SiteRuntime["accept"]>[0]) => { void act(() => runtime.accept(next)); };
    Object.defineProperties(context, {
        state: {get: () => runtime.snapshot},
        editing: {get: () => runtime.editing, set: value => { runtime.editing = value; if (value) runtime.configText = fixtureElement("config").value; }},
        credentialEditing: {get: () => runtime.credentialEditing, set: value => { runtime.credentialEditing = value; }},
    });
    void act(() => render(createElement(App, {runtime}), context.root as unknown as HTMLElement));
}
