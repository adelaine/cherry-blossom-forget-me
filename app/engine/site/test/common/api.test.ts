/* Copyright (c) 2026, Oracle and/or its affiliates. */
import assert from "node:assert/strict";
import test from "node:test";
import { createSiteApi, type ApiEnvironment } from "../../src/common/api.ts";

interface RequestRecord {
	url: string;
	options: RequestInit;
}

interface FixtureOptions {
	hash?: string;
	storedSession?: string;
	respond?: (request: RequestRecord) => Response | Promise<Response>;
}

const connectionMessage = "Reconnect through the launcher before continuing.";

function apiFixture(options: FixtureOptions = {}) {
	const requests: RequestRecord[] = [];
	const storage = new Map<string, string>();
	if (options.storedSession)
		storage.set("suitecloud-session", options.storedSession);
	const history: unknown[][] = [];
	let losses = 0;
	let successes = 0;
	const environment: ApiEnvironment = {
		location: {
			hash: options.hash ?? "#session=launcher-session",
			pathname: "/workspace",
		},
		sessionStorage: {
			getItem: (key) => storage.get(key) ?? null,
			setItem(key, value) {
				storage.set(key, value);
			},
		},
		history: {
			replaceState(...args) {
				history.push(args);
			},
		},
		fetch: async (input, init) => {
			const request = { url: String(input), options: init ?? {} };
			requests.push(request);
			return options.respond
				? await options.respond(request)
				: Response.json({ ready: true });
		},
	};
	const client = createSiteApi(
		environment,
		() => losses++,
		() => successes++,
		connectionMessage,
	);
	return {
		client,
		requests,
		storage,
		history,
		get losses() {
			return losses;
		},
		get successes() {
			return successes;
		},
	};
}

function awaitAbort(request: RequestRecord): Promise<Response> {
	const signal = request.options.signal;
	assert.ok(signal);
	return new Promise((_resolve, reject) => {
		if (signal.aborted) reject(signal.reason);
		else
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
	});
}

test("launcher sessions replace cached credentials and remain available after fragment removal", async (t) => {
	for (const hash of ["#session=new-session", ""]) {
		const fixture = apiFixture({ hash, storedSession: "cached-session" });
		t.after(fixture.client.dispose);
		const expected = hash ? "new-session" : "cached-session";
		assert.equal(fixture.client.session, expected);
		assert.equal(fixture.storage.get("suitecloud-session"), expected);
		assert.deepEqual(fixture.history, [[null, "", "/workspace"]]);
		await fixture.client.request("state");
		const sent = fixture.requests[0]!;
		assert.equal(
			new Headers(sent.options.headers).get("X-Session-Token"),
			expected,
		);
	}
});

test("requests send browser authentication and mutation keys without keying read-only requests", async (t) => {
	const fixture = apiFixture();
	t.after(fixture.client.dispose);
	await fixture.client.request("targets");
	const read = fixture.requests[0]!;
	assert.equal(read.url, "/api/targets");
	assert.equal(read.options.method, "GET");
	assert.equal(read.options.body, undefined);
	assert.equal(new Headers(read.options.headers).get("Content-Type"), null);
	assert.equal(new Headers(read.options.headers).get("Idempotency-Key"), null);
	for (const path of ["validate", "check", "heartbeat"]) {
		await fixture.client.request(path, { config: {} });
		const sent = fixture.requests.at(-1)!;
		assert.equal(sent.options.method, "POST");
		assert.equal(
			new Headers(sent.options.headers).get("Content-Type"),
			"application/json",
		);
		assert.equal(
			new Headers(sent.options.headers).get("Idempotency-Key"),
			null,
		);
	}
	const payload = { targetId: "selected-target", sql: "SELECT 1 FROM dual;" };
	await fixture.client.request("sql", payload, "user-request-1");
	const mutation = fixture.requests.at(-1)!;
	assert.equal(mutation.options.method, "POST");
	assert.equal(
		new Headers(mutation.options.headers).get("X-Session-Token"),
		"launcher-session",
	);
	assert.equal(
		new Headers(mutation.options.headers).get("Idempotency-Key"),
		"user-request-1",
	);
	assert.deepEqual(JSON.parse(String(mutation.options.body)), payload);
	await fixture.client.request("theme", { theme: "dark" });
	const firstKey = new Headers(fixture.requests.at(-1)!.options.headers).get(
		"Idempotency-Key",
	);
	await fixture.client.request("theme", { theme: "light" });
	const secondKey = new Headers(fixture.requests.at(-1)!.options.headers).get(
		"Idempotency-Key",
	);
	assert.ok(firstKey);
	assert.ok(secondKey);
	assert.notEqual(firstKey, secondKey);
});

test("caller cancellation and client disposal abort pending requests without reporting connection loss", async (t) => {
	for (const cancelCaller of [true, false]) {
		const fixture = apiFixture({ respond: awaitAbort });
		t.after(fixture.client.dispose);
		const caller = new AbortController();
		const pending = fixture.client.api(
			"state",
			undefined,
			undefined,
			caller.signal,
		);
		const rejected = assert.rejects(pending, { name: "AbortError" });
		if (cancelCaller) caller.abort();
		else fixture.client.dispose();
		await rejected;
		assert.equal(fixture.requests[0]!.options.signal!.aborted, true);
		assert.equal(fixture.losses, 0);
		assert.equal(fixture.successes, 0);
		assert.equal(fixture.requests.length, 1);
	}
});

test("validation errors remain actionable while lost connections notify once without replaying mutations", async (t) => {
	let mode: "validation" | "server" | "network" | "ready" = "validation";
	const fixture = apiFixture({
		respond() {
			if (mode === "network") throw new TypeError("connection reset");
			if (mode === "validation")
				return Response.json(
					{ error: "Wait for the running operation." },
					{ status: 409 },
				);
			if (mode === "server")
				return Response.json({ error: "Worker unavailable." }, { status: 503 });
			return Response.json({ ready: true });
		},
	});
	t.after(fixture.client.dispose);
	await assert.rejects(
		fixture.client.api("sql", {}),
		/Wait for the running operation/,
	);
	assert.equal(fixture.losses, 0);
	mode = "server";
	await assert.rejects(fixture.client.api("state"), {
		message: connectionMessage,
	});
	assert.equal(fixture.losses, 1);
	mode = "network";
	const previousRequests = fixture.requests.length;
	await assert.rejects(fixture.client.api("deploy", {}, "deployment-attempt"), {
		message: connectionMessage,
	});
	assert.equal(fixture.requests.length, previousRequests + 1);
	assert.equal(fixture.losses, 2);
	mode = "ready";
	assert.deepEqual(await fixture.client.api("state"), { ready: true });
	assert.equal(fixture.successes, 1);
	await fixture.client.api("heartbeat", {});
	assert.equal(fixture.successes, 1);
});

test("a timed-out mutation reports an uncertain connection without issuing another request", async (t) => {
	const deadline = new AbortController();
	t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
		assert.equal(milliseconds, 10_000);
		return deadline.signal;
	});
	const fixture = apiFixture({ respond: awaitAbort });
	t.after(fixture.client.dispose);
	const pending = fixture.client.api(
		"sql",
		{ sql: "SELECT 1 FROM dual;" },
		"timed-out-sql",
	);
	const rejected = assert.rejects(pending, { message: connectionMessage });
	deadline.abort(new DOMException("The request timed out.", "TimeoutError"));
	await rejected;
	assert.equal(fixture.losses, 1);
	assert.equal(fixture.requests.length, 1);
	assert.equal(
		new Headers(fixture.requests[0]!.options.headers).get("Idempotency-Key"),
		"timed-out-sql",
	);
});

test("an unreadable mutation response reports connection loss without replaying completed work", async (t) => {
	const fixture = apiFixture({
		respond: () => new Response("interrupted JSON", { status: 200 }),
	});
	t.after(fixture.client.dispose);
	await assert.rejects(
		fixture.client.api("deploy", {}, "completed-deployment"),
		{
			message: connectionMessage,
		},
	);
	assert.equal(fixture.losses, 1);
	assert.equal(fixture.requests.length, 1);
});
