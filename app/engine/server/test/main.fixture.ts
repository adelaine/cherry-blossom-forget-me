/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { once } from "node:events";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startWebServer } from "../src/main.ts";
import { createWorkspaceFixture } from "./workspace.fixture.ts";

/** Start the production listener for transport smoke tests. */
export async function createTransportFixture() {
	const workspace = createWorkspaceFixture();
	const sessionFile = join(workspace.root, "session");
	let disposed = () => {};
	const stopped = new Promise<void>((resolve) => {
		disposed = resolve;
	});
	const server = startWebServer({
		configDirectory: workspace.root,
		port: 0,
		host: "127.0.0.1",
		sessionFile,
		onStop: disposed,
		signalHandlers: false,
	});
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const headers = {
		"X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1]!,
		"Content-Type": "application/json",
		Origin: origin,
	};
	return {
		origin,
		async close() {
			const response = await fetch(origin + "/api/stop", {
				method: "POST",
				headers,
				body: "{}",
			});
			if (!response.ok) {
				throw new Error(
					`Cannot stop the test server: ${await response.text()}`,
				);
			}
			await response.arrayBuffer();
			server.closeAllConnections();
			// onStop runs only after listener closure and service disposal complete.
			await stopped;
			workspace.close();
		},
	};
}
