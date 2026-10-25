/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { serveStatic } from "@hono/node-server/serve-static";
import { deploymentPage } from "../../../site/src/web-page.ts";
import type { ServerLifecycle } from "../main.ts";
import type { ApiApp } from "./operations.ts";

/** Register generated HTML and directory-based public asset serving. */
export function assetsApi(app: ApiApp, lifecycle: ServerLifecycle): void {
	const html =
		lifecycle.options.mode === "development"
			? deploymentPage.html.replace(
					"</head>",
					'<script type="module" src="/@vite/client"></script></head>',
				)
			: deploymentPage.html;
	app.get("/", (c) => c.html(html));
	// Keep module imports relative to their actual built directory.
	app.get("/page.js", (c) => c.redirect("/assets/page.js", 307));
	app.get("/page.css", (c) => c.redirect("/assets/page.css", 307));
	if (import.meta.url.endsWith(".ts")) {
		const require = createRequire(
			new URL("../../../package.json", import.meta.url),
		);
		app.get(
			"/pico.css",
			serveStatic({ path: require.resolve("@picocss/pico/css/pico.min.css") }),
		);
		app.use(
			"/assets/*",
			serveStatic({
				root: fileURLToPath(
					new URL("../../../dist/site/public/", import.meta.url),
				),
			}),
		);
	}
	const files = serveStatic({
		root: fileURLToPath(new URL("../../../site/public/", import.meta.url)),
	});
	app.use("*", (c, next) => {
		if (c.req.path.startsWith("/api/")) return next();
		return files(c, next);
	});
}
