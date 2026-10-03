import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync, existsSync, lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(appDirectory, "dist");
if (dirname(outputDirectory) !== appDirectory || (existsSync(outputDirectory) && lstatSync(outputDirectory).isSymbolicLink())) {
    throw new Error("Runtime output must be the app's own dist directory.");
}
rmSync(outputDirectory, { recursive: true, force: true });
mkdirSync(join(outputDirectory, "assets"), { recursive: true });

const require = createRequire(import.meta.url);
// These packages have no runtime dependencies beyond the adapter's Hono peer.
// Preserve package metadata so Node resolves the copied imports normally.
for (const name of ["hono", "@hono/node-server"]) {
    let packageDirectory = dirname(require.resolve(name));
    while (!existsSync(join(packageDirectory, "package.json")) || JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8")).name !== name) {
        const parent = dirname(packageDirectory);
        if (parent === packageDirectory) throw new Error("Cannot locate runtime package " + name);
        packageDirectory = parent;
    }
    const destination = join(outputDirectory, "node_modules", name);
    mkdirSync(destination, { recursive: true });
    copyFileSync(join(packageDirectory, "package.json"), join(destination, "package.json"));
    copyFileSync(join(packageDirectory, "LICENSE"), join(destination, "LICENSE"));
    cpSync(join(packageDirectory, "dist"), join(destination, "dist"), { recursive: true });
}
copyFileSync(require.resolve("@alpinejs/csp/dist/cdn.min.js"), join(outputDirectory, "assets/alpine.js"));
copyFileSync(require.resolve("@picocss/pico/css/pico.min.css"), join(outputDirectory, "assets/pico.css"));
cpSync(join(appDirectory, "src/assets/fonts"), join(outputDirectory, "assets/fonts"), { recursive: true });
writeFileSync(join(outputDirectory, "package.json"), JSON.stringify({ type: "module" }) + "\n");
