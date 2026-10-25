/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createElement, render } from "preact";
import { act } from "preact/test-utils";
import type { SiteModule } from "../src/common/module.ts";
import { App } from "../src/layout/page.tsx";
import { createRuntimeFixture, flushRequests } from "./runtime-fixture.ts";

interface TestEvent {
	type: string;
	target: TestNode;
	currentTarget: TestNode;
	isTrusted: boolean;
	defaultPrevented: boolean;
	preventDefault(): void;
	stopPropagation(): void;
}

/** Minimal DOM used to render the actual Preact components in controlled tests. */
export class TestNode {
	parentNode: TestNode | null = null;
	childNodes: TestNode[] = [];
	data = "";
	nodeType: number;
	localName: string;
	namespaceURI = "http://www.w3.org/1999/xhtml";
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
	download = "";
	scrollOptions: ScrollIntoViewOptions | boolean | undefined;
	dataset: Record<string, string> = {};
	style: Record<string, unknown> = {
		setProperty(name: string, value: unknown) {
			this[name] = value;
		},
	};
	attributes = new Map<string, string>();
	listeners = new Map<string, (event: TestEvent) => unknown>();
	onclick = null;
	oninput = null;
	onchange = null;
	private rawHtml: string | undefined;
	constructor(
		name: string,
		readonly ownerDocument: TestDocument,
		text = false,
	) {
		this.nodeType = text ? 3 : 1;
		this.localName = name;
	}
	get nodeName() {
		return this.nodeType === 3 ? "#text" : this.localName.toUpperCase();
	}
	get tagName() {
		return this.nodeName;
	}
	get firstChild() {
		return this.childNodes[0] ?? null;
	}
	get nextSibling(): TestNode | null {
		return (
			this.parentNode?.childNodes[
				this.parentNode.childNodes.indexOf(this) + 1
			] ?? null
		);
	}
	get id() {
		return this.attributes.get("id") ?? "";
	}
	set id(value: string) {
		this.attributes.set("id", value);
	}
	get href() {
		return this.attributes.get("href") ?? "";
	}
	set href(value: string) {
		this.attributes.set("href", value);
	}
	get hash() {
		const marker = this.href.indexOf("#");
		return marker < 0 ? "" : this.href.slice(marker);
	}
	closest(selector: string): TestNode | null {
		if (
			selector.startsWith("#")
				? this.id === selector.slice(1)
				: this.localName === selector
		)
			return this;
		return this.parentNode?.closest(selector) ?? null;
	}
	insertBefore(node: TestNode, before: TestNode | null) {
		node.parentNode?.removeChild(node);
		const index = before ? this.childNodes.indexOf(before) : -1;
		if (index < 0) this.childNodes.push(node);
		else this.childNodes.splice(index, 0, node);
		node.parentNode = this;
		return node;
	}
	appendChild(node: TestNode) {
		return this.insertBefore(node, null);
	}
	removeChild(node: TestNode) {
		const index = this.childNodes.indexOf(node);
		if (index >= 0) this.childNodes.splice(index, 1);
		node.parentNode = null;
		return node;
	}
	remove() {
		this.parentNode?.removeChild(this);
	}
	replaceChildren(...nodes: TestNode[]) {
		while (this.firstChild) this.removeChild(this.firstChild);
		for (const node of nodes) this.appendChild(node);
	}
	setAttribute(name: string, value: unknown) {
		this.attributes.set(name, String(value));
		if (name.startsWith("data-")) {
			this.dataset[
				name
					.slice(5)
					.replace(/-([a-z])/g, (_match, letter: string) =>
						letter.toUpperCase(),
					)
			] = String(value);
		}
	}
	setAttributeNS(_namespace: string, name: string, value: unknown) {
		this.setAttribute(name, value);
	}
	removeAttribute(name: string) {
		this.attributes.delete(name);
	}
	removeAttributeNS(_namespace: string, name: string) {
		this.removeAttribute(name);
	}
	getAttribute(name: string) {
		return this.attributes.get(name) ?? null;
	}
	addEventListener(name: string, listener: (event: TestEvent) => unknown) {
		this.listeners.set(name, listener);
	}
	removeEventListener(name: string) {
		this.listeners.delete(name);
	}
	private async dispatch(type: string) {
		let stopped = false;
		const path: TestNode[] = [this];
		for (
			let ancestor = this.parentNode;
			ancestor;
			ancestor = ancestor.parentNode
		)
			path.push(ancestor);
		const event: TestEvent = {
			type,
			target: this,
			currentTarget: this,
			isTrusted: false,
			defaultPrevented: false,
			preventDefault() {
				event.defaultPrevented = true;
			},
			stopPropagation() {
				stopped = true;
			},
		};
		await act(async () => {
			for (const node of path) {
				event.currentTarget = node;
				await node.listeners.get(type)?.call(node, event);
				if (stopped) break;
			}
			await flushRequests();
		});
		return event;
	}
	click() {
		return this.dispatch("click");
	}
	input() {
		return this.dispatch("input");
	}
	change() {
		return this.dispatch("change");
	}
	focus() {
		this.ownerDocument.activeElement = this;
	}
	scrollIntoView(options?: ScrollIntoViewOptions | boolean) {
		this.scrollOptions = options;
	}
	querySelectorAll(selector: string): TestNode[] {
		return this.childNodes.flatMap((node) => [
			...((
				selector.startsWith("#")
					? node.id === selector.slice(1)
					: node.localName === selector
			)
				? [node]
				: []),
			...node.querySelectorAll(selector),
		]);
	}
	querySelector(selector: string) {
		return this.querySelectorAll(selector)[0] ?? null;
	}
	get textContent(): string {
		return this.nodeType === 3
			? this.data
			: (this.rawHtml ??
					this.childNodes.map((node) => node.textContent).join(""));
	}
	set textContent(text: string) {
		this.rawHtml = undefined;
		this.replaceChildren(this.ownerDocument.createTextNode(String(text)));
	}
	get innerHTML(): string {
		return this.rawHtml ?? this.childNodes.map(serialize).join("");
	}
	set innerHTML(html: string) {
		this.rawHtml = html;
		this.replaceChildren();
	}
}

class TestDetailsNode extends TestNode {}

class TestDocument {
	root = new TestNode("div", this);
	documentElement = new TestNode("html", this);
	activeElement: TestNode | null = null;
	createElement(name: string) {
		return name === "details"
			? new TestDetailsNode(name, this)
			: new TestNode(name, this);
	}
	createElementNS(_namespace: string, name: string) {
		return this.createElement(name);
	}
	createTextNode(value: string) {
		const node = new TestNode("", this, true);
		node.data = value;
		return node;
	}
	getElementById(id: string) {
		return this.root.querySelector("#" + id);
	}
	querySelectorAll(selector: string) {
		return this.root.querySelectorAll(selector);
	}
}

function escape(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function serialize(node: TestNode): string {
	if (node.nodeType === 3) return escape(node.data);
	const attributes = new Map(node.attributes);
	for (const key of ["value", "href"] as const) {
		if (node[key]) attributes.set(key, node[key]);
	}
	const attrs = [...attributes]
		.map(([key, value]) => ` ${key}="${escape(value)}"`)
		.join("");
	const start = `<${node.localName}${attrs}>`;
	return ["input", "img", "br", "hr", "link", "meta"].includes(node.localName)
		? start
		: start + node.innerHTML + `</${node.localName}>`;
}

/** Mount only the requested inventory and return the actual runtime and DOM nodes. */
export async function renderSite(
	fixture: ReturnType<typeof createRuntimeFixture>,
	inventory?: readonly SiteModule[],
) {
	const document = new TestDocument();
	const globals = {
		document,
		HTMLDetailsElement: TestDetailsNode,
		window: fixture.environment.window,
		sessionStorage: fixture.environment.sessionStorage,
		matchMedia: () => ({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}),
	};
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(globals)) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	}
	let disposed = false;
	function cleanup() {
		if (disposed) return;
		disposed = true;
		try {
			act(() => render(null, document.root as unknown as HTMLElement));
		} finally {
			fixture.cleanup();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	}
	try {
		await act(async () => {
			render(
				createElement(App, { runtime: fixture.runtime, inventory }),
				document.root as unknown as HTMLElement,
			);
			await flushRequests();
		});
	} catch (error) {
		cleanup();
		throw error;
	}
	return {
		runtime: fixture.runtime,
		root: document.root,
		cleanup,
		element(id: string) {
			const node = document.getElementById(id);
			if (!node) throw new Error(`No rendered element has id ${id}.`);
			return node;
		},
	};
}

/** Flush a runtime change and the corresponding component updates. */
export async function updateSite(
	action: () => unknown | Promise<unknown>,
): Promise<void> {
	await act(async () => {
		await action();
		await flushRequests();
	});
}
