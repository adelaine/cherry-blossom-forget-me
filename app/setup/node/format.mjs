import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(resolve("package.json"));
const prettier = resolve(
    dirname(require.resolve("prettier/package.json")),
    "bin/prettier.cjs",
);

const sourceExtensions =
    "ts,tsx,js,jsx,mjs,cjs,css,scss,less,html,json,jsonc,md,mdx,yaml,yml";
const targets = [
    `client/**/*.{${sourceExtensions}}`,
    `server/**/*.{${sourceExtensions}}`,
    "*.json",
    ".prettierrc",
    "../setup/node/**/*.{js,mjs,cjs}",
    "../setup/playwright/**/*.{js,mjs,cjs}",
    "../setup/templates/**/*.json",
    "../docs/**/*.{md,mdx,html,json,yaml,yml}",
];

const result = spawnSync(
    process.execPath,
    [
        prettier,
        "--config",
        ".prettierrc",
        "--ignore-path",
        ".prettierignore",
        ...process.argv.slice(2),
        ...targets,
    ],
    { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
