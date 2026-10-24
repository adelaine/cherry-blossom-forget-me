import {
    copyFileSync,
    cpSync,
    mkdirSync,
    writeFileSync,
    existsSync,
    lstatSync,
    readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(
    process.argv[2] ??
        resolve(dirname(fileURLToPath(import.meta.url)), "../../engine"),
);
const outputDirectory = resolve(appDirectory, "dist");
if (
    dirname(outputDirectory) !== appDirectory ||
    (existsSync(outputDirectory) && lstatSync(outputDirectory).isSymbolicLink())
) {
    throw new Error("Runtime output must be the app's own dist directory.");
}
// Each build owns its emitted files. Do not remove another build's output.
const siteDirectory = join(appDirectory, "site");
const siteOutput = join(outputDirectory, "site", "src");
mkdirSync(join(siteOutput, "assets"), { recursive: true });

const require = createRequire(join(appDirectory, "package.json"));
// These packages have no runtime dependencies beyond the adapter's Hono peer.
// Preserve package metadata so Node resolves the copied imports normally.
for (const name of ["hono", "@hono/node-server"]) {
    let packageDirectory = dirname(require.resolve(name));
    while (
        !existsSync(join(packageDirectory, "package.json")) ||
        JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"))
            .name !== name
    ) {
        const parent = dirname(packageDirectory);
        if (parent === packageDirectory)
            throw new Error("Cannot locate runtime package " + name);
        packageDirectory = parent;
    }
    const destination = join(outputDirectory, "node_modules", name);
    mkdirSync(destination, { recursive: true });
    copyFileSync(
        join(packageDirectory, "package.json"),
        join(destination, "package.json"),
    );
    copyFileSync(
        join(packageDirectory, "LICENSE"),
        join(destination, "LICENSE"),
    );
    cpSync(join(packageDirectory, "dist"), join(destination, "dist"), {
        recursive: true,
    });
}
// Keep frontend paths identical in source and compiled server modules.
cpSync(join(siteDirectory, "src/assets"), join(siteOutput, "assets"), {
    recursive: true,
});
cpSync(join(siteDirectory, "src/themes"), join(siteOutput, "themes"), {
    recursive: true,
});
copyFileSync(
    require.resolve("@alpinejs/csp/dist/cdn.min.js"),
    join(siteOutput, "assets/alpine.js"),
);
copyFileSync(
    require.resolve("@picocss/pico/css/pico.min.css"),
    join(siteOutput, "assets/pico.css"),
);
writeFileSync(
    join(outputDirectory, "package.json"),
    JSON.stringify({ type: "module" }) + "\n",
);
// Preserve the established container and packaged helper entry paths.
writeFileSync(
    join(outputDirectory, "install.js"),
    `import { main } from "./server/src/install.js";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export { main };
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    try { process.exitCode = main(); }
    catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
`,
);
writeFileSync(
    join(outputDirectory, "web-server.js"),
    'export * from "./server/src/main.js";\nexport { mountChanges } from "./server/src/services/suiteapps.js";\n',
);
