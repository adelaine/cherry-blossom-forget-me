import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { moduleStyles } from "./src/modules.ts";

const siteDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: siteDirectory,
    publicDir: false,
    esbuild: { jsx: "automatic", jsxImportSource: "preact" },
    build: {
        outDir: resolve(siteDirectory, "../dist/site/assets"),
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
            input: resolve(siteDirectory, "src/main.tsx"),
            output: {
                entryFileNames: "page.js",
                chunkFileNames: "[name]-[hash].js",
                assetFileNames: "[name][extname]",
            },
        },
    },
    plugins: [
        {
            name: "suitecontainer-module-styles",
            generateBundle() {
                this.emitFile({
                    type: "asset",
                    fileName: "page.css",
                    source: moduleStyles,
                });
            },
        },
    ],
});
