/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import { once } from "node:events";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import type {
	HmrContext,
	ModuleNode,
	Plugin,
	UserConfigFnObject,
	ViteDevServer,
} from "vite";
import viteConfiguration from "../../vite.config.ts";
import { createServerLifecycle } from "../../src/main.ts";
import { createServices } from "../../src/common/services.ts";
import { createWorkspaceFixture } from "../workspace.fixture.ts";

type Middleware = (
	request: IncomingMessage,
	response: ServerResponse,
	next: (error?: unknown) => void,
) => unknown;

const engine = fileURLToPath(new URL("../../../", import.meta.url));
const source = resolve(engine, "server/src");

async function flushReload(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function reloadFixture(t: TestContext) {
	const workspace = createWorkspaceFixture();
	const owner = createServerLifecycle({
		configDirectory: workspace.root,
		mode: "development",
	});
	const previousSessionFile = process.env.SUITECONTAINER_SESSION_FILE;
	process.env.SUITECONTAINER_SESSION_FILE = resolve(workspace.root, "session");
	const middleware: Middleware[] = [];
	const loads: string[] = [];
	const applicationOwners: (typeof owner)[] = [];
	const invalidated: string[] = [];
	const reloads: unknown[] = [];
	let refresh = () => {};
	let timerCleared = false;
	const timer = { unref() {} } as unknown as ReturnType<typeof setInterval>;
	const clear = clearInterval;
	t.mock.method(globalThis, "setInterval", ((
		callback: () => void,
		delay: number,
	) => {
		assert.equal(delay, 250);
		refresh = callback;
		return timer;
	}) as typeof setInterval);
	t.mock.method(
		globalThis,
		"clearInterval",
		(value: Parameters<typeof clearInterval>[0]) => {
			if (value === timer) timerCleared = true;
			else clear(value);
		},
	);
	const httpServer = createServer((request, response) => {
		let index = 0;
		function next(error?: unknown) {
			if (error) {
				response.statusCode = 500;
				response.end(String(error));
				return;
			}
			const handler = middleware[index++];
			if (!handler) {
				response.statusCode = 404;
				response.end();
				return;
			}
			Promise.resolve(handler(request, response, next)).catch(next);
		}
		next();
	});
	const files = [
		resolve(source, "main.ts"),
		resolve(source, "common/operations.ts"),
		resolve(source, "common/services.ts"),
		resolve(source, "api/sql.ts"),
		resolve(source, "tools/sql/SqlService.ts"),
	];
	const modules = files.map((file) => ({ file }) as ModuleNode);
	let lifecycleCreations = 0;
	const server = {
		httpServer,
		watcher: { add() {} },
		middlewares: {
			use(handler: Middleware) {
				middleware.push(handler);
			},
		},
		moduleGraph: {
			idToModuleMap: new Map(modules.map((module) => [module.file, module])),
			invalidateModule(module: ModuleNode) {
				invalidated.push(module.file!);
			},
		},
		ws: {
			send(message: unknown) {
				reloads.push(message);
			},
		},
		async ssrLoadModule(path: string) {
			loads.push(path);
			if (path === resolve(source, "common/services.ts"))
				return { createServices };
			assert.equal(path, resolve(source, "main.ts"));
			return {
				createServerLifecycle() {
					lifecycleCreations++;
					return owner;
				},
				createApplication(lifecycle: typeof owner) {
					applicationOwners.push(lifecycle);
					return lifecycle.createApp();
				},
			};
		},
		ssrFixStacktrace() {},
		async restart() {},
		async close() {
			if (httpServer.listening) {
				httpServer.closeAllConnections();
				await new Promise<void>((resolve) => httpServer.close(() => resolve()));
			}
			await owner.dispose();
		},
	} as unknown as ViteDevServer;
	let disposed = false;
	async function cleanup() {
		if (disposed) return;
		disposed = true;
		await server.close();
		if (previousSessionFile === undefined)
			delete process.env.SUITECONTAINER_SESSION_FILE;
		else process.env.SUITECONTAINER_SESSION_FILE = previousSessionFile;
		workspace.close();
	}
	t.after(cleanup);
	const config = (viteConfiguration as UserConfigFnObject)({
		command: "serve",
		mode: "development",
	});
	const plugins = config.plugins as Plugin[];
	for (const plugin of plugins) {
		const configure = plugin.configureServer;
		assert.equal(typeof configure, "function");
		if (typeof configure === "function") await configure(server);
	}
	httpServer.listen(0, "127.0.0.1");
	await once(httpServer, "listening");
	const origin =
		"http://127.0.0.1:" + (httpServer.address() as AddressInfo).port;
	const hono = plugins.find(
		(plugin) => plugin.name === "@hono/vite-dev-server",
	)!;
	return {
		owner,
		server,
		loads,
		invalidated,
		reloads,
		applicationOwners,
		cleanup,
		get timerCleared() {
			return timerCleared;
		},
		get lifecycleCreations() {
			return lifecycleCreations;
		},
		async update(file: string) {
			const hook = hono.handleHotUpdate;
			assert.equal(typeof hook, "function");
			if (typeof hook === "function")
				await hook({
					file,
					server,
					modules: [],
					timestamp: Date.now(),
					read: async () => "",
				} as HmrContext);
		},
		async refresh() {
			refresh();
			await flushReload();
		},
		async state() {
			const response = await fetch(origin + "/api/state", {
				headers: { "X-Session-Token": owner.session },
			});
			assert.equal(response.status, 200);
			return response.json() as Promise<
				ReturnType<typeof owner.services.status>
			>;
		},
	};
}

test("API and worker-helper reloads rebuild the application around its existing lifecycle", async (t) => {
	const fixture = await reloadFixture(t);
	const { owner } = fixture;
	const services = owner.services;
	const session = owner.session;
	const token = owner.token;
	const operation = owner.operations.reserve("sql", ["target"]);
	owner.operations.finish(operation.id, { output: "retained" });
	assert.equal((await fixture.state()).instanceId, owner.instanceId);
	for (const file of ["api/sql.ts", "workspace/deploy.ts"]) {
		await fixture.update(resolve(source, file));
		await fixture.refresh();
		const state = await fixture.state();
		assert.equal(state.instanceId, owner.instanceId);
		assert.equal(state.operations[0]!.id, operation.id);
	}
	assert.equal(fixture.lifecycleCreations, 1);
	assert.equal(fixture.applicationOwners.length, 3);
	assert.ok(
		fixture.applicationOwners.every((lifecycle) => lifecycle === owner),
	);
	assert.equal(owner.services, services);
	assert.equal(owner.session, session);
	assert.equal(owner.token, token);
	assert.equal(owner.operations.restartPending, "");
	assert.deepEqual(fixture.reloads, [
		{ type: "full-reload" },
		{ type: "full-reload" },
	]);
});

test("service reload waits for active work and managed SFTP, then refreshes only service modules", async (t) => {
	const fixture = await reloadFixture(t);
	const { owner } = fixture;
	const original = owner.services;
	const operation = owner.operations.reserve("deployment", ["target"]);
	await fixture.update(resolve(source, "tools/sql/SqlService.ts"));
	assert.match(owner.operations.restartPending, /active operations finish/);
	await fixture.refresh();
	assert.equal(owner.services, original);
	owner.operations.finish(operation.id, { finished: true });
	Object.defineProperty(original.sftp, "active", {
		configurable: true,
		value: true,
	});
	await fixture.update(resolve(source, "tools/sql/SqlService.ts"));
	assert.match(owner.operations.restartPending, /Stop managed SFTP/);
	await fixture.refresh();
	assert.equal(owner.services, original);
	Reflect.deleteProperty(original.sftp, "active");
	await fixture.refresh();
	assert.notEqual(owner.services, original);
	assert.equal(owner.operations.restartPending, "");
	assert.equal(owner.operations.get(operation.id).state, "succeeded");
	assert.deepEqual(
		fixture.invalidated.sort(),
		[
			resolve(source, "common/services.ts"),
			resolve(source, "tools/sql/SqlService.ts"),
		].sort(),
	);
	assert.equal(fixture.lifecycleCreations, 1);
});

test("lifecycle, coordinator, and Vite configuration edits require an explicit launcher restart", async (t) => {
	for (const change of [
		"main.ts",
		"common/operations.ts",
		"Vite configuration",
	]) {
		await t.test(change, async (scenario) => {
			const fixture = await reloadFixture(scenario);
			const services = fixture.owner.services;
			if (change === "Vite configuration") await fixture.server.restart();
			else await fixture.update(resolve(source, change));
			assert.match(
				fixture.owner.operations.restartPending,
				/launcher again while idle/,
			);
			await fixture.update(resolve(source, "tools/sql/SqlService.ts"));
			await fixture.refresh();
			assert.equal(fixture.owner.services, services);
			assert.equal(fixture.lifecycleCreations, 1);
			assert.equal(
				fixture.loads.includes(resolve(source, "common/services.ts")),
				false,
			);
		});
	}
});

test("closing development releases refresh scheduling and signal listeners", async (t) => {
	const sigint = process.listenerCount("SIGINT");
	const sigterm = process.listenerCount("SIGTERM");
	const fixture = await reloadFixture(t);
	assert.equal(process.listenerCount("SIGINT"), sigint + 1);
	assert.equal(process.listenerCount("SIGTERM"), sigterm + 1);
	await fixture.cleanup();
	assert.equal(fixture.timerCleared, true);
	assert.equal(process.listenerCount("SIGINT"), sigint);
	assert.equal(process.listenerCount("SIGTERM"), sigterm);
	assert.equal(fixture.owner.stopping, true);
});
