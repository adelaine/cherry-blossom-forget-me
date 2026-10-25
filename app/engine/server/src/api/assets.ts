/* Copyright (c) 2026, Oracle and/or its affiliates. */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { deploymentPage } from "../../../site/src/web-page.ts";
import type { ServerLifecycle } from "../main.ts";
import type { ApiApp } from "./operations.ts";

/** Register the application page and its public static assets. */
export function assetsApi(app: ApiApp, lifecycle: ServerLifecycle): void {
	const require = createRequire(
		new URL("../../../package.json", import.meta.url),
	);
	const sourceMode = import.meta.url.endsWith(".ts");
	const html =
		lifecycle.options.mode === "development"
			? deploymentPage.html.replace(
					"</head>",
					'<script type="module" src="/@vite/client"></script></head>',
				)
			: deploymentPage.html;
	const pico = readFileSync(
		sourceMode
			? require.resolve("@picocss/pico/css/pico.min.css")
			: new URL("../../../site/public/assets/pico.css", import.meta.url),
		"utf8",
	);
	for (const [path, contentType, content] of [
		["/", "text/html", html],
		["/pico.css", "text/css", pico],
		[
			"/styles.css",
			"text/css",
			readFileSync(
				new URL("../../../site/public/styles.css", import.meta.url),
				"utf8",
			),
		],
	])
		app.get(path!, (c) => {
			c.header("Content-Type", contentType + "; charset=utf-8");
			return c.body(content!);
		});
	const frontendAssets = new URL(
		sourceMode ? "../../../dist/site/assets/" : "../../../site/assets/",
		import.meta.url,
	);
	// Redirecting the module entry preserves the base URL for generated chunks.
	// Vite serves these two public routes directly in development.
	app.get("/page.js", (c) => c.redirect("/assets/page.js", 307));
	app.get("/page.css", (c) => {
		const path = new URL("page.css", frontendAssets);
		if (!existsSync(path)) return c.notFound();
		c.header("Content-Type", "text/css; charset=utf-8");
		return c.body(readFileSync(path, "utf8"));
	});
	app.get("/assets/:name", (c) => {
		const name = c.req.param("name");
		if (!/^[A-Za-z0-9_.-]+\.(?:js|css|png|jpg|svg|woff2?|ttf)$/.test(name))
			return c.notFound();
		const path = new URL(name, frontendAssets);
		if (!existsSync(path)) return c.notFound();
		const extension = name.slice(name.lastIndexOf(".") + 1);
		const contentTypes: Record<string, string> = {
			js: "text/javascript",
			css: "text/css",
			png: "image/png",
			jpg: "image/jpeg",
			svg: "image/svg+xml",
			woff: "font/woff",
			woff2: "font/woff2",
			ttf: "font/ttf",
		};
		c.header("Content-Type", contentTypes[extension]!);
		return c.body(new Uint8Array(readFileSync(path)));
	});
	for (const name of ["netsuite-2026.css", "oracle-corporate-2026.css"]) {
		const content = readFileSync(
			new URL("../../../site/public/themes/" + name, import.meta.url),
			"utf8",
		);
		app.get("/themes/" + name, (c) => {
			c.header("Content-Type", "text/css; charset=utf-8");
			return c.body(content);
		});
	}
	for (const name of ["favicon.png", "advanced-configuration.png"]) {
		const content = readFileSync(
			new URL("../../../site/public/assets/" + name, import.meta.url),
		);
		app.get("/" + name, (c) => {
			c.header("Content-Type", "image/png");
			return c.body(new Uint8Array(content));
		});
	}
	for (const name of [
		"oracle-cover-dark.jpg",
		"oracle-cover-light.jpg",
		"netsuite-divider-dark.jpg",
	]) {
		const content = readFileSync(
			new URL("../../../site/public/themes/" + name, import.meta.url),
		);
		app.get("/themes/" + name, (c) => {
			c.header("Content-Type", "image/jpeg");
			return c.body(new Uint8Array(content));
		});
	}
	for (const name of [
		"Ubuntu-Light.ttf",
		"Ubuntu-Regular.ttf",
		"Ubuntu-Medium.ttf",
		"Ubuntu-Bold.ttf",
	]) {
		const content = readFileSync(
			new URL("../../../site/public/assets/fonts/" + name, import.meta.url),
		);
		app.get("/fonts/" + name, (c) => {
			c.header("Content-Type", "font/ttf");
			return c.body(new Uint8Array(content));
		});
	}
}
