/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { SiteRuntime, type RuntimeEnvironment } from "../src/common/runtime.ts";
import type { ServerState } from "../src/common/state.ts";

type StateOverrides = Omit<
	Partial<ServerState>,
	"authentication" | "certificates" | "run" | "sql"
> & {
	authentication?: Partial<ServerState["authentication"]>;
	certificates?: Partial<ServerState["certificates"]>;
	run?: Partial<ServerState["run"]>;
	sql?: Partial<ServerState["sql"]>;
};

export interface RequestRecord {
	path: string;
	options: RequestInit | undefined;
}

export interface TestTimer {
	callback: () => void;
	delay: number;
}

interface RuntimeFixtureOptions {
	state?: ServerState;
	respond?: (request: RequestRecord) => unknown | Promise<unknown>;
}

/** Build a complete status response with explicit overrides for the scenario. */
export function serverState(overrides: StateOverrides = {}): ServerState {
	return {
		instanceId: "00000000-0000-4000-8000-000000000001",
		apiVersion: 1,
		config: '{"suiteapps":[],"vms":[]}',
		ready: false,
		blockers: [],
		error: "",
		credentialError: "",
		tokenPresent: false,
		PM_MODE: true,
		deploymentStarted: false,
		theme: undefined,
		relaunch: false,
		sftp: {
			state: "stopped",
			username: "suitecontainer",
			port: 8000,
			path: "",
			passwordPresent: false,
			hostKey: "",
			error: "",
			relaunch: false,
			tunnel: { state: "stopped", error: "" },
		},
		playwright: {
			state: "idle",
			log: "",
			project: "",
			available: false,
			error: "",
			operationId: undefined,
			canRun: false,
		},
		operations: [],
		serviceRestartPending: null,
		...overrides,
		authentication: {
			method: "browser",
			accounts: {},
			state: "idle",
			operationId: undefined,
			error: "",
			...overrides.authentication,
		},
		certificates: {
			public: "",
			private: "",
			id: "",
			canGenerate: true,
			hasExisting: false,
			error: "",
			canDownload: false,
			...overrides.certificates,
		},
		run: { state: "idle", log: "", ...overrides.run },
		sql: {
			state: "idle",
			output: "",
			defaults: { user: "", service: "" },
			passwordHint: "",
			hasDefaultPassword: false,
			preparing: false,
			...overrides.sql,
		},
	};
}

/** Supply controlled browser requests, activity, and timers without mounting UI. */
export function createRuntimeFixture(options: RuntimeFixtureOptions = {}) {
	const state = options.state ?? serverState();
	const requests: RequestRecord[] = [];
	const timers = new Map<ReturnType<typeof setTimeout>, TestTimer>();
	const intervals = new Map<ReturnType<typeof setInterval>, TestTimer>();
	const events = new Map<string, EventListenerOrEventListenerObject>();
	const windowEvents = new Map<string, EventListenerOrEventListenerObject>();
	const storage = new Map<string, string>();
	let now = 0;
	let closes = 0;
	let nextTimer = 0;
	const eventSource = (
		listeners: Map<string, EventListenerOrEventListenerObject>,
	) => ({
		addEventListener(
			name: string,
			listener: EventListenerOrEventListenerObject | null,
		) {
			if (listener) listeners.set(name, listener);
		},
		removeEventListener(name: string) {
			listeners.delete(name);
		},
	});
	const environment: RuntimeEnvironment = {
		location: { hash: "", pathname: "/" },
		history: { replaceState() {} },
		sessionStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem: (key, value) => {
				storage.set(key, value);
			},
		},
		document: eventSource(events) as RuntimeEnvironment["document"],
		window: {
			...eventSource(windowEvents),
			closed: false,
			close() {
				closes++;
			},
		} as RuntimeEnvironment["window"],
		now: () => now,
		setTimeout: ((callback: () => void, delay: number) => {
			const id = ++nextTimer as unknown as ReturnType<typeof setTimeout>;
			timers.set(id, { callback, delay });
			return id;
		}) as RuntimeEnvironment["setTimeout"],
		clearTimeout: ((id: ReturnType<typeof setTimeout>) => {
			timers.delete(id);
		}) as RuntimeEnvironment["clearTimeout"],
		setInterval: ((callback: () => void, delay: number) => {
			const id = ++nextTimer as unknown as ReturnType<typeof setInterval>;
			intervals.set(id, { callback, delay });
			return id;
		}) as RuntimeEnvironment["setInterval"],
		clearInterval: ((id: ReturnType<typeof setInterval>) => {
			intervals.delete(id);
		}) as RuntimeEnvironment["clearInterval"],
		fetch: async (input, init) => {
			const request = { path: String(input), options: init };
			requests.push(request);
			const result = options.respond ? await options.respond(request) : state;
			return result instanceof Response ? result : Response.json(result);
		},
	};
	const runtime = new SiteRuntime(environment);
	return {
		runtime,
		environment,
		state,
		requests,
		timers,
		intervals,
		events,
		get closes() {
			return closes;
		},
		setNow(value: number) {
			now = value;
		},
		activity(name: string, isTrusted: boolean) {
			const listener = events.get(name);
			const event = { isTrusted } as Event;
			if (typeof listener === "function") listener(event);
			else listener?.handleEvent(event);
		},
		cleanup() {
			runtime.dispose();
		},
	};
}

/** Let pending request and component continuations finish without advancing time. */
export async function flushRequests(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}
