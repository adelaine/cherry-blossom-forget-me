import { defineConfig } from "vite";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleStyles } from "./src/modules.ts";

const siteDirectory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export default defineConfig({
	root: siteDirectory,
	publicDir: resolve(siteDirectory, "public"),
	esbuild: { jsx: "automatic", jsxImportSource: "preact" },
	build: {
		outDir: resolve(siteDirectory, "../dist/site/public"),
		emptyOutDir: true,
		target: "es2022",
		rollupOptions: {
			input: resolve(siteDirectory, "src/main.tsx"),
			output: {
				entryFileNames: "assets/page.js",
				chunkFileNames: "assets/[name]-[hash].js",
				assetFileNames: "assets/[name][extname]",
			},
		},
	},
	plugins: [
		{
			name: "suitecontainer-module-styles",
			generateBundle() {
				this.emitFile({
					type: "asset",
					fileName: "pico.css",
					source: readFileSync(
						require.resolve("@picocss/pico/css/pico.min.css"),
						"utf8",
					),
				});
				this.emitFile({
					type: "asset",
					fileName: "assets/page.css",
					source: moduleStyles,
				});
			},
		},
	],
});
