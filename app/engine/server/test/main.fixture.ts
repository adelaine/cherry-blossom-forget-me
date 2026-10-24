import { once } from "node:events";
import {
	mkdtempSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	rmSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer, type ServerOptions } from "../src/main.ts";

export const fixture = async (
	config = {
		suiteapps: [] as object[],
		vms: [{ account: "000071", url: "" }],
	},
	options: ServerOptions = {},
) => {
	const root = mkdtempSync(join(tmpdir(), "suitecontainer-server-test-"));
	const credentials = join(root, "credentials");
	mkdirSync(credentials);
	const authPath = join(credentials, "auth.json");
	writeFileSync(join(root, "suitecontainer.json"), JSON.stringify(config));
	writeFileSync(authPath, "{}");
	writeFileSync(
		join(credentials, "web-mounts.json"),
		JSON.stringify({
			hostRoot: "/project",
			platform: "linux",
			local: {},
			certificates: {},
		}),
	);
	const sessionFile = join(root, "session");
	const server = startWebServer({
		...options,
		configDirectory: root,
		port: 0,
		host: "127.0.0.1",
		sessionFile,
		onStop() {},
		signalHandlers: false,
	});
	await once(server, "listening");
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const headers = {
		"X-Session-Token": readFileSync(sessionFile, "utf8").split("session=")[1]!,
		"Content-Type": "application/json",
		Origin: origin,
	};
	const state = async () =>
		(await fetch(origin + "/api/state", { headers })).json();
	return {
		root,
		credentials,
		authPath,
		origin,
		async post(path: string, input: object) {
			const response = await fetch(origin + "/api/" + path, {
				method: "POST",
				headers,
				body: JSON.stringify(input),
			});
			const value = await response.json();
			if (!response.ok) throw new Error(value.error);
			return value;
		},
		async finish(kind: "run" | "sql") {
			for (let attempt = 0; attempt < 100; attempt++) {
				const next = (await state())[kind];
				if (next.state !== "running") return next;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			throw new Error("Worker did not finish.");
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(root, { recursive: true, force: true });
		},
	};
};
